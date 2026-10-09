import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent } from "./runtime";

async function closeRetry(shutdownFailure: string) {
  const directory = await mkdtemp(join(tmpdir(), "grove-native-release-"));
  const control = join(directory, ".fake-app-server-control.json");
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://fixture.invalid",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      PATH: process.env.PATH,
      HOME: join(directory, "user-home"),
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
      CODEX_HOME: join(directory, "home"),
      FAKE_SERVER_ROOT: directory,
    },
  });
  const agent = (
    id: string,
    role: "orc" | "worker" | "researcher",
  ): RuntimeAgent => ({
    id,
    role,
    token: id,
    project: { alias: id, name: id, path: join(directory, id) },
    title: id,
    model: "fixture-model",
    effort: "low",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
  });
  const a = agent("root", "orc"),
    b = agent(
      "child",
      shutdownFailure === "TimedOut" ? "researcher" : "worker",
    );
  const loaded = async (id: string) =>
    JSON.parse(
      await readFile(join(directory, ".fake-app-server-state.json"), "utf8"),
    ).threads[id].loaded;
  try {
    await mkdir(a.project.path);
    await mkdir(b.project.path);
    const ah = await runtime.open(a, () => {}),
      bh = await runtime.open(b, () => {});
    await writeFile(control, JSON.stringify({ releaseDelayMs: 100 }));
    let settled = false;
    const close = ah.close().then(() => {
      settled = true;
    });
    await Bun.sleep(40);
    expect(settled).toBe(false);
    expect(await loaded(ah.threadId)).toBe(true); // External writer still blocked.
    await close;
    expect(await loaded(ah.threadId)).toBe(false);
    expect(await loaded(bh.threadId)).toBe(true);
    await bh.rename("Other thread stays usable");
    const other = await runtime.open({ ...a, threadId: ah.threadId }, () => {});
    await writeFile(
      control,
      JSON.stringify(
        shutdownFailure === "LateClosed"
          ? { holdClosedNotification: true }
          : { shutdownFailure },
      ),
    );
    await expect(bh.close()).rejects.toThrow("release unconfirmed");
    expect(await loaded(bh.threadId)).toBe(shutdownFailure !== "LateClosed");
    if (shutdownFailure !== "LateClosed")
      await bh.rename("Visible after timeout and retryable");
    await other.rename("Other thread usable after shutdown failure");
    const state = JSON.parse(
      await readFile(join(directory, ".fake-app-server-state.json"), "utf8"),
    );
    expect(state.threads[bh.threadId].subscribed).toBe(false);
    expect(state.threads[bh.threadId].listener).toBe(false);
    if (shutdownFailure !== "LateClosed") {
      await writeFile(control, JSON.stringify({ failResume: true }));
      await expect(bh.close()).rejects.toThrow("fixture resume rejected");
      expect(await loaded(bh.threadId)).toBe(true);
      await other.rename("Other thread usable after rejected re-subscription");
    }
    await writeFile(
      control,
      JSON.stringify({
        closeBeforeAck: true,
        releaseClosedOnLoadedList: bh.threadId,
      }),
    );
    try {
      await bh.close();
    } catch (error) {
      const state = JSON.parse(
        await readFile(join(directory, ".fake-app-server-state.json"), "utf8"),
      );
      throw new Error(
        `${(error as Error).message}; native unsubscribe outcomes: ${state.threads[bh.threadId].unsubscribeStatuses}`,
      );
    }
    expect(await loaded(bh.threadId)).toBe(false);
    expect(await loaded(other.threadId)).toBe(true);
    await other.rename("Other thread usable after Retry Close");
    const requests = (
      await readFile(join(directory, ".fake-app-server-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests
        .filter(
          (r) =>
            r.method === "thread/resume" && r.params.threadId === bh.threadId,
        )
        .map((r) => r.params),
    ).toEqual(
      shutdownFailure === "LateClosed"
        ? []
        : Array.from({ length: 2 }, () => ({
            threadId: bh.threadId,
            excludeTurns: true,
            config: {
              "agents.enabled": false,
              "features.multi_agent": false,
              "features.multi_agent_v2": false,
            },
          })),
    );
    expect(
      requests.filter(
        (r) => r.method === "thread/start" && !r.params.ephemeral,
      ),
    ).toHaveLength(2);
    await other.close();
    await bh.close(); // Idempotent close after authoritative release.
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const shutdownFailure of ["TimedOut", "SubmitFailed", "LateClosed"]) {
  test(
    `Close recovers ${shutdownFailure} through original-thread ownership and isolates another thread`,
    () => closeRetry(shutdownFailure),
    35_000,
  );
}
