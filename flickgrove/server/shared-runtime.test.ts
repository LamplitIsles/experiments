import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

async function until(check: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error("Shared runtime condition did not settle");
}

test("one managed process isolates concurrent threads, native requests, Stop/Close, catalog/title and explicit recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-shared-native-"));
  const processLog = join(directory, "processes");
  const controlPath = join(directory, ".fake-app-server-control.json");
  const requestPath = join(directory, ".fake-app-server-requests.jsonl");
  const requests = async () =>
    (await readFile(requestPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const processes = async () =>
    (await readFile(processLog, "utf8")).trim().split("\n").map(Number);
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://fixture.invalid",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
      FAKE_SERVER_PROCESS_LOG: processLog,
    },
  });
  const agent = (id: string, role: "orc" | "worker"): RuntimeAgent => ({
    id,
    role,
    token: `${id}-token`,
    project: { alias: id, name: id, path: join(directory, id) },
    title: id,
    model: "fixture-model",
    effort: role === "orc" ? "medium" : "low",
    serviceTier: role === "orc" ? "priority" : "default",
    state: "idle",
    closed: false,
    messages: [],
    deliveries: [],
    questions: [],
  });
  const a = agent("a", "orc"),
    b = agent("b", "worker");
  const ae: RuntimeEvent[] = [],
    be: RuntimeEvent[] = [];
  await Promise.all([mkdir(a.project.path), mkdir(b.project.path)]);
  await writeFile(
    controlPath,
    JSON.stringify({ hold: true, nativeRequests: true }),
  );
  try {
    const [ah, bh] = await Promise.all([
      runtime.open(a, (e) => ae.push(e)),
      runtime.open(b, (e) => be.push(e)),
      runtime.models(),
    ]);
    expect(ah.threadId).not.toBe(bh.threadId);
    expect(await processes()).toHaveLength(1);
    const [at, bt] = await Promise.all([
      ah.send("a input"),
      bh.send("b input"),
    ]);
    await until(
      async () => (await requests()).filter((r) => r.error).length === 4,
    );
    const replies = (await requests()).filter((r) => r.error);
    expect(replies.filter((r) => r.error.code === -32601)).toHaveLength(2);
    expect(replies.filter((r) => r.error.code === -32602)).toHaveLength(2);
    expect(ae.filter((e) => e.type === "working")).toEqual([
      { type: "working", turnId: at },
    ]);
    expect(be.filter((e) => e.type === "working")).toEqual([
      { type: "working", turnId: bt },
    ]);
    expect(await bh.send("b steer", bt)).toBe(bt);
    await ah.interrupt(at);
    await until(() => ae.some((e) => e.type === "completed"));
    expect(
      be.some((e) => e.type === "completed" || e.type === "disconnected"),
    ).toBe(false);
    await ah.close();
    expect(await processes()).toHaveLength(1);
    expect(await bh.send("b after a close", bt)).toBe(bt);
    await writeFile(controlPath, "{}");
    await until(() => be.some((e) => e.type === "completed"));
    expect(
      be.some((e) => e.type === "item" && e.item.text?.includes(bh.threadId)),
    ).toBe(true);
    expect(
      ae.some((e) => e.type === "item" && e.item.text?.includes(bh.threadId)),
    ).toBe(false);
    await bh.title("Name b");
    await runtime.history(directory);
    await runtime.skills(a.project.path);
    expect(await processes()).toHaveLength(1);
    const restored = await runtime.open({ ...a, threadId: ah.threadId }, (e) =>
      ae.push(e),
    );
    expect(restored.threadId).toBe(ah.threadId);
    const configCalls = (await requests()).filter(
      (r) =>
        ["thread/start", "thread/resume"].includes(r.method) &&
        !r.params.ephemeral,
    );
    for (const r of configCalls) {
      const owned = r.params.cwd === a.project.path ? a : b;
      expect(
        r.params.config["mcp_servers.flickgrove"].env.FLICKGROVE_AGENT_TOKEN,
      ).toBe(owned.token);
      expect(r.params.config.model_reasoning_effort).toBe(owned.effort);
      expect(r.params.serviceTier).toBe(owned.serviceTier);
      expect(r.params.developerInstructions).toContain(
        owned.role === "orc" ? "Orchestrator (Orc)" : "You are a Worker",
      );
    }
    await writeFile(
      controlPath,
      JSON.stringify({ hold: true, dropTurnResponse: true }),
    );
    const pendingA = restored.send("unknown a").then(
      () => "accepted",
      (error) => error.name,
    );
    const pendingB = bh.send("unknown b").then(
      () => "accepted",
      (error) => error.name,
    );
    await until(
      () =>
        ae.filter((e) => e.type === "working").length === 2 &&
        be.filter((e) => e.type === "working").length === 2,
    );
    const before = (await requests()).filter((r) =>
      ["turn/start", "turn/steer"].includes(r.method),
    ).length;
    // Only the PID written by this test-owned fake is terminated.
    process.kill((await processes())[0], "SIGTERM");
    await until(
      () =>
        ae.some((e) => e.type === "disconnected") &&
        be.some((e) => e.type === "disconnected"),
    );
    expect(await pendingA).toBe("AppServerConnectionClosedError");
    expect(await pendingB).toBe("AppServerConnectionClosedError");
    await writeFile(controlPath, "{}");
    await Bun.sleep(50);
    expect(await processes()).toHaveLength(1);
    const [ar, br] = await Promise.all([
      runtime.open({ ...a, threadId: restored.threadId }, () => {}),
      runtime.open({ ...b, threadId: bh.threadId }, () => {}),
    ]);
    expect(await processes()).toHaveLength(2);
    expect(
      (await requests()).filter((r) =>
        ["turn/start", "turn/steer"].includes(r.method),
      ),
    ).toHaveLength(before);
    expect(ar.threadId).toBe(ah.threadId);
    expect(br.threadId).toBe(bh.threadId);
    await restored.close(); // Stale handle cannot unsubscribe the replacement.
    await bh.close();
    await br.rename("Still independently open");
    await ar.close();
    await br.close();
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
