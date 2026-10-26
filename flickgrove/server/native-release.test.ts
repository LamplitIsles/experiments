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
    await expect(runtime.releaseThread(ah.threadId)).rejects.toThrow(
      "still loaded",
    );
    await ah.rename(
      "Loaded ownership remains usable after refused cold release",
    );
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
        .map((r) => ({
          threadId: r.params.threadId,
          excludeTurns: r.params.excludeTurns,
          config: Object.fromEntries(
            Object.entries(r.params.config).filter(
              ([key]) =>
                key.startsWith("agents.") || key.startsWith("features."),
            ),
          ),
        })),
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

// Real native metadata, no turn/provider/auth. Grove's saved identity models an
// older empty session; this does not establish how a live rollout went missing.
test("Close tree releases a cold metadata-only Codex thread without resuming it", async () => {
  const { CodexAppServerClient } =
    await import("@jaminzhou/codex-app-server-client");
  const { Workspace } = await import("./workspace");
  const { MixedRuntime } = await import("./mixed-runtime");
  const { FakeRuntime } = await import("./testing");
  const root = await mkdtemp(join(tmpdir(), "grove-missing-rollout-"));
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(process.env).map((key) => [key, undefined]),
  );
  Object.assign(env, {
    PATH: process.env.PATH,
    HOME: join(root, "home"),
    CODEX_HOME: join(root, "codex"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
  });
  await mkdir(env.HOME!, { recursive: true });
  await mkdir(env.CODEX_HOME!, { recursive: true });
  const client = new CodexAppServerClient({
    cwd: root,
    codexPath: process.env.GROVE_CODEX_PATH ?? "codex",
    clientInfo: {
      name: "grove-close-test",
      title: "Owned close probe",
      version: "1",
    },
    capabilities: { experimentalApi: true },
    env,
  });
  const runtime = new CodexRuntime({
    cwd: root,
    codexPath: process.env.GROVE_CODEX_PATH ?? "codex",
    origin: () => "http://127.0.0.1:1",
    env,
  });
  let app: InstanceType<typeof Workspace> | undefined;
  try {
    await client.connect();
    const fake = new FakeRuntime();
    const open = fake.open.bind(fake);
    fake.open = async (a, notify) => {
      const native = await client.threadStart({
        cwd: root,
        model: "gpt-6.1-sol",
        approvalPolicy: "never",
        sandbox: "read-only",
        historyMode: "paginated",
        config: {
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
        },
      });
      const handle = await open(a, notify);
      handle.threadId = native.thread.id;
      return handle;
    };
    const projects = async () => [
      { alias: "owned", name: "Owned", path: root },
    ];
    const directory = join(root, "workspace");
    app = new Workspace({ directory, runtime: fake, projects });
    const owner = await app.createOrc("owned");
    const token = fake.agents.get(owner.id)!.token;
    const child = (await app.tool(token, "worker_start", {
      project: "owned",
      title: "Owned worker",
      spec: "#4678",
      message: "Fixture only",
    })) as { id: string };
    fake.emit(child.id, {
      type: "completed",
      turnId: app.detail(child.id).turnId!,
      status: "completed",
    });
    app.dispose();
    await client.close();
    app = new Workspace({
      directory,
      runtime: new MixedRuntime(runtime, new FakeRuntime()),
      projects,
    });
    // Wait for the existing startup reconciliation to settle, observing its
    // real resume failure before exercising the explicit Close entry point.
    await expect(app.reconcileSettings(owner.id)).rejects.toThrow(
      "no rollout found",
    );
    await expect(app.reconcileSettings(child.id)).rejects.toThrow(
      "no rollout found",
    );
    const attempts: string[] = [];
    const realOpen = runtime.open.bind(runtime);
    runtime.open = async (a, notify) => {
      attempts.push(a.id);
      return realOpen(a, notify);
    };
    const closed = (await app.tool(token, "worker_close", {
      workerId: child.id,
    })) as { closed: boolean };
    expect(closed.closed).toBe(true);
    await app.closeTree(owner.id);
    expect(attempts).toEqual([]);
    expect(app.snapshot().agents).toEqual([]);
    app.dispose();
    app = new Workspace({ directory, runtime: fake, projects });
    expect(app.snapshot().agents).toEqual([]);
  } finally {
    app?.dispose();
    await client.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("unloaded release requires native absence and propagates uncertain outcomes", async () => {
  for (const mode of [
    "notLoaded",
    "notSubscribed",
    "unsubscribed",
    "rpc-error",
    "timeout",
    "disconnect",
  ]) {
    const root = await mkdtemp(join(tmpdir(), "grove-absence-wire-"));
    const control = join(root, ".fake-app-server-control.json");
    const runtime = new CodexRuntime({
      cwd: root,
      origin: () => "http://127.0.0.1:1",
      codexPath: fileURLToPath(
        new URL("../tests/fake-codex.mjs", import.meta.url),
      ),
      env: {
        PATH: process.env.PATH,
        HOME: join(root, "home"),
        CODEX_HOME: join(root, "codex"),
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        FAKE_SERVER_ROOT: root,
        ...(["timeout", "disconnect"].includes(mode)
          ? { FAKE_HOLD_METHOD: "thread/unsubscribe" }
          : {}),
      },
    });
    try {
      await writeFile(
        control,
        JSON.stringify(
          mode === "rpc-error"
            ? { failUnsubscribeThreads: ["owned-thread"] }
            : {
                unsubscribeStatus: [
                  "notLoaded",
                  "notSubscribed",
                  "unsubscribed",
                ].includes(mode)
                  ? mode
                  : "notSubscribed",
              },
        ),
      );
      const release = runtime.releaseThread("owned-thread");
      const outcome =
        mode === "notLoaded" ? release : expect(release).rejects.toThrow();
      if (mode === "disconnect") {
        const requests = join(root, ".fake-app-server-requests.jsonl");
        for (let i = 0; i < 100; i++) {
          if (
            (await readFile(requests, "utf8").catch(() => "")).includes(
              '"thread/unsubscribe"',
            )
          )
            break;
          await Bun.sleep(10);
        }
        await runtime.close();
      }
      await outcome;
      const requests = (
        await readFile(join(root, ".fake-app-server-requests.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        requests
          .filter((r) => r.method.startsWith("thread/"))
          .map((r) => r.method),
      ).toEqual(["thread/loaded/list", "thread/unsubscribe"]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 15_000);
