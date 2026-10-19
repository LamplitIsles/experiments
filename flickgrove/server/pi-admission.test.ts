import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { PiAdmission } from "./pi-admission";

test("native persistence, exact operation identities, volatile steer, settled and readonly reopen", async () => {
  if (!process.env.GROVE_PI_OWNED_FIXTURE) {
    const home = await mkdtemp(join(tmpdir(), "grove-pi-home-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PI_OFFLINE: "1",
          GROVE_PI_OWNED_FIXTURE: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "grove-pi-admission-"));
  const agentDir = join(root, "agent"),
    cwd = join(root, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  let requests = 0,
    release!: () => void,
    arrived!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (arrived = r));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      requests++;
      arrived();
      await gate;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ role: "assistant", content: "Fixture reply" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  let bridge: PiAdmission | undefined;
  try {
    await writeFile(join(agentDir, "auth.json"), "{}");
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
            apiKey: "test-owned-key",
            models: [
              {
                id: "fake",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 1000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
      extensionFactories: [
        (pi) => {
          pi.on("input", (event) => {
            if (event.text === "owned handled input")
              return { action: "handled" };
          });
        },
      ],
    });
    await resourceLoader.reload();
    const manager = SessionManager.create(cwd, join(root, "sessions"));
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: modelRuntime.getModel("fixture", "fake")!,
      settingsManager,
      resourceLoader,
      sessionManager: manager,
      tools: [],
    }));
    await session.bindExtensions({});
    const accepted: string[] = [];
    let settled = 0;
    session.subscribe((e) => {
      if (e.type === "agent_settled") settled++;
    });
    bridge = new PiAdmission(session, manager, (r) =>
      accepted.push(r.operation),
    );
    await expect(
      bridge.send("handled", "owned handled input", [], "handled-run"),
    ).rejects.toThrow("without durable admission");
    expect(requests).toBe(0);
    expect(accepted).toEqual([]);
    await expect(
      bridge.send("handled", "owned handled input", [], "handled-run"),
    ).rejects.toThrow("unknown");
    const first = bridge.send("first", "same text", [], "run-1");
    await started;
    await first;
    const before = await readFile(manager.getSessionFile()!, "utf8");
    expect(before).toContain('"role":"user"');
    expect(before).not.toContain('"role":"assistant"');
    expect(settled).toBe(0);
    const second = bridge.send("second", "same text", [], "run-1"),
      third = bridge.send("third", "same text", [], "run-1");
    expect(accepted).toEqual(["first"]);
    release();
    const [a, b] = await Promise.all([second, third]);
    await session.waitForIdle();
    expect(a.itemId).not.toBe(b.itemId);
    expect(accepted).toEqual(["first", "second", "third"]);
    expect(settled).toBe(1);
    expect(requests).toBe(3);
    expect(await bridge.send("second", "same text", [], "run-1")).toEqual(a);
    await expect(bridge.send("second", "changed", [], "run-1")).rejects.toThrow(
      "different content",
    );
    const calls = requests;
    const readonly = SessionManager.open(manager.getSessionFile()!);
    expect(
      readonly
        .getEntries()
        .filter(
          (e) => e.type === "custom" && e.customType === "grove-accepted",
        ),
    ).toHaveLength(3);
    expect(requests).toBe(calls);
    // A native write failure after the public message callback must not admit.
    const brokenManager = SessionManager.create(
      cwd,
      join(root, "fault-sessions"),
    );
    await mkdir(brokenManager.getSessionFile()!);
    const { session: broken } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model: modelRuntime.getModel("fixture", "fake")!,
      settingsManager,
      resourceLoader,
      sessionManager: brokenManager,
      tools: [],
    });
    let falseAcceptance = 0;
    const brokenBridge = new PiAdmission(
      broken,
      brokenManager,
      () => falseAcceptance++,
    );
    try {
      await expect(
        brokenBridge.send(
          "write-failure",
          "must stay unknown",
          [],
          "broken-run",
        ),
      ).rejects.toThrow();
      expect(falseAcceptance).toBe(0);
      expect(requests).toBe(calls);
    } finally {
      brokenBridge.dispose();
      await broken.abort();
      broken.dispose();
    }
  } finally {
    bridge?.dispose();
    release();
    await session?.abort();
    session?.dispose();
    upstream.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
