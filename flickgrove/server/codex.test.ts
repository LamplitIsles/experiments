import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import { Workspace } from "./workspace";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

test("the SDK adapter initializes isolated role configuration, discovers enabled skills and resumes threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flickgrove-sdk-"));
  const argsPath = join(directory, "args.json");
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://127.0.0.1:14318",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
      FAKE_SERVER_ARGS: argsPath,
    },
  });
  try {
    expect(await runtime.models()).toEqual([
      {
        id: "fixture-model",
        name: "Fixture model",
        efforts: ["medium"],
        defaultEffort: "medium",
        isDefault: true,
        fastTier: "priority",
      },
    ]);
    expect(await runtime.skills(directory)).toEqual([
      { name: "review-code", description: "Review code" },
    ]);
    const agent: RuntimeAgent = {
      id: "orc",
      token: "test-token",
      role: "orc",
      project: { alias: "fixture", name: "Fixture", path: directory },
      title: "New session",
      model: "fixture-model",
      effort: "medium",
      serviceTier: "priority",
      state: "idle",
      closed: false,
      questions: [],
      messages: [],
      deliveries: [],
    };
    const events: RuntimeEvent[] = [];
    const completed = Promise.withResolvers<void>();
    const handle = await runtime.open(agent, (event) => {
      events.push(event);
      if (event.type === "completed") completed.resolve();
    });
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args).toContain(
      'mcp_servers.flickgrove.env.FLICKGROVE_AGENT_TOKEN="test-token"',
    );
    expect(args).toContain(
      'mcp_servers.flickgrove.env.FLICKGROVE_ORIGIN="http://127.0.0.1:14318"',
    );
    expect(args).toContain("features.multi_agent=false");
    expect(
      args.some(
        (arg) =>
          arg.startsWith("mcp_servers.flickgrove.args=") &&
          arg.includes("/flickgrove/server/mcp.ts"),
      ),
    ).toBe(true);
    await handle.send("Build a reader");
    await Promise.race([
      completed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("No completed turn")), 3000),
      ),
    ]);
    expect(events.some((e) => e.type === "working")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "item" && e.item.phase === "final_answer" && !!e.item.text,
      ),
    ).toBe(true);
    expect(
      events.find((e) => e.type === "item" && e.item.id === "async-question"),
    ).toMatchObject({
      type: "item",
      item: {
        delivery: "async",
        questions: [
          {
            question: "Which color?",
            options: [{ label: "Blue" }, { label: "Green" }],
          },
          { question: "Any context?" },
        ],
      },
    });
    const title = await handle.title("Build a reader");
    expect(title).toBeTruthy();
    await handle.close();
    const resumed = await runtime.open(
      { ...agent, threadId: handle.threadId },
      () => {},
    );
    expect(resumed.threadId).toBe(handle.threadId);
    await resumed.close();
    const requests = (
      await readFile(join(directory, ".fake-app-server-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.find(
        (r) =>
          r.method === "turn/start" && r.params.threadId === handle.threadId,
      ).params.serviceTier,
    ).toBe("priority");
    expect(
      requests.some(
        (r) =>
          r.method === "thread/resume" && r.params.threadId === handle.threadId,
      ),
    ).toBe(true);
    expect(
      requests.find((r) => r.method === "thread/start" && !r.params.ephemeral)
        .params,
    ).toMatchObject({
      model: "fixture-model",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      serviceTier: "priority",
    });
    expect(
      requests.find((r) => r.method === "thread/start" && !r.params.ephemeral)
        .params.developerInstructions,
    ).toContain("worker_send");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

async function wireWorkspace(directory: string, env: NodeJS.ProcessEnv = {}) {
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://127.0.0.1:14318",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
      ...env,
    },
  });
  const app = new Workspace({
    directory: join(directory, "state"),
    runtime,
    projects: async () => [
      { alias: "fixture", name: "Fixture", path: directory },
    ],
  });
  return { app, runtime };
}

async function requests(directory: string) {
  return (
    await readFile(join(directory, ".fake-app-server-requests.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("real expected-turn mismatch wording retries steer on the current turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flickgrove-stale-wire-"));
  await writeFile(
    join(directory, ".fake-app-server-control.json"),
    JSON.stringify({ hold: true }),
  );
  const { app, runtime } = await wireWorkspace(directory, {
    FAKE_STEER_MISMATCH_COUNT: "1",
  });
  try {
    const a = await app.createOrc("fixture");
    await app.send(a.id, "Begin", "first");
    const turnId = app.detail(a.id).turnId;
    await app.send(a.id, "Follow up", "second");
    expect(app.detail(a.id).deliveries.at(-1)?.status).toBe("sent");
    const log = (await requests(directory)).filter(
      (r) => r.params?.threadId === app.detail(a.id).threadId,
    );
    expect(log.filter((r) => r.method === "turn/start")).toHaveLength(1);
    expect(
      log
        .filter((r) => r.method === "turn/steer")
        .map((r) => r.params.expectedTurnId),
    ).toEqual([turnId, turnId]);
  } finally {
    app.dispose();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);

test("app-server exit stops Working and an explicit message resumes the same thread without replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flickgrove-crash-wire-"));
  const { app, runtime } = await wireWorkspace(directory, {
    FAKE_EXIT_AFTER_ACCEPT: "true",
  });
  try {
    const a = await app.createOrc("fixture");
    const disconnected = Promise.withResolvers<void>();
    const unsubscribe = app.subscribe(() => {
      if (app.detail(a.id).state === "error") disconnected.resolve();
    });
    await app.send(a.id, "Begin", "first");
    const threadId = app.detail(a.id).threadId;
    await Promise.race([
      disconnected.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Exit was not surfaced")), 3000),
      ),
    ]);
    unsubscribe();
    expect(app.detail(a.id)).toMatchObject({ state: "error", threadId });
    expect(app.detail(a.id).turnId).toBeUndefined();
    expect(app.detail(a.id).error).toContain("disconnected");
    await app.send(a.id, "Resume explicitly", "second");
    expect(app.detail(a.id).deliveries.at(-1)?.status).toBe("sent");
    const log = await requests(directory);
    expect(
      log.some(
        (r) => r.method === "thread/resume" && r.params.threadId === threadId,
      ),
    ).toBe(true);
    expect(
      log
        .filter(
          (r) => r.method === "turn/start" && r.params.threadId === threadId,
        )
        .map((r) => r.params.input[0].text),
    ).toEqual(["Begin", "Resume explicitly"]);
  } finally {
    app.dispose();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
