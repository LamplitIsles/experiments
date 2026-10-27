import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { PiRuntime } from "./pi";
import { titlePrompt } from "./thread-title";

test("Pi Orc title uses its selected model in an isolated best-effort request", async () => {
  if (!process.env.GROVE_TITLE_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-title-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_TITLE_CHILD: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code) console.log(out + err);
      expect(code).toBe(0);
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  const requests: { path: string; body: any }[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let releaseSame!: () => void;
  const sameGate = new Promise<void>((r) => (releaseSame = r));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as any;
      const path = new URL(req.url).pathname;
      requests.push({ path, body });
      const title = JSON.stringify(body.messages).includes(
        "Return only a JSON object",
      );
      const input = JSON.stringify(body.messages);
      if (title && input.includes("race prompt")) await gate;
      if (title && input.includes("same-title prompt")) await sameGate;
      if (title && input.includes("failure prompt"))
        return new Response("failure", { status: 500 });
      const content = title ? '{"title":"Generated title"}' : "Normal answer";
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ role: "assistant", content }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const model = {
    id: "selected",
    name: "Selected",
    reasoning: false,
    input: ["text"],
    contextWindow: 32000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        selectedProvider: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/selected`,
          apiKey: "fixture-only",
          models: [model],
        },
      },
    }),
  );
  let app: Workspace;
  const runtime = new PiRuntime({
    agentDir,
    tool: (token, name, args) => app.tool(token, name, args),
  });
  app = new Workspace({
    directory: join(home, "workspace"),
    runtime,
    projects: async () => [{ alias: "owned", name: "Owned", path: cwd }],
  });
  const settings = {
    fast: false,
    orc: {
      backend: "pi" as const,
      provider: "selectedProvider",
      model: "selected",
      effort: "off",
    },
    worker: {
      backend: "pi" as const,
      provider: "selectedProvider",
      model: "selected",
      effort: "off",
    },
  };
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error("condition did not settle");
  };
  try {
    const success = await app.createOrc("owned", settings);
    await app.send(success.id, "success prompt", "success-op");
    await until(
      () =>
        app.detail(success.id).title === "Generated title" &&
        app.detail(success.id).state === "idle",
    );
    const titleRequest = requests.find((r) =>
      r.body.messages.some(
        (m: any) => m.content === titlePrompt("success prompt"),
      ),
    )!;
    expect(titleRequest.path).toContain("/selected/");
    expect(titleRequest.body.model).toBe("selected");
    expect(titleRequest.body.tools ?? []).toEqual([]);
    expect(titleRequest.body.messages).toHaveLength(2);
    const transcript = await runtime.historyMessages(
      app.detail(success.id).threadId!,
    );
    expect(transcript.messages.map((m) => m.text)).toEqual([
      "success prompt",
      "Normal answer",
    ]);
    expect(
      (await runtime.history(cwd)).sessions.find(
        (s) => s.threadId === app.detail(success.id).threadId,
      )?.title,
    ).toBe("Generated title");

    const race = await app.createOrc("owned", settings);
    await app.send(race.id, "race prompt", "race-op");
    await until(() =>
      requests.some((r) =>
        r.body.messages.some(
          (m: any) => m.content === titlePrompt("race prompt"),
        ),
      ),
    );
    await app.rename(race.id, "Manual title");
    release();
    await until(() => app.detail(race.id).state === "idle");
    await Bun.sleep(100);
    expect(app.detail(race.id).title).toBe("Manual title");
    expect(
      (await runtime.history(cwd)).sessions.find(
        (s) => s.threadId === app.detail(race.id).threadId,
      )?.title,
    ).toBe("Manual title");

    const same = await app.createOrc("owned", settings);
    await app.send(same.id, "same-title prompt", "same-op");
    await until(() =>
      requests.some((r) =>
        r.body.messages.some(
          (m: any) => m.content === titlePrompt("same-title prompt"),
        ),
      ),
    );
    await app.rename(same.id, "New session");
    releaseSame();
    await until(() => app.detail(same.id).state === "idle");
    await Bun.sleep(100);
    expect(app.detail(same.id).title).toBe("New session");

    const failure = await app.createOrc("owned", settings);
    await app.send(failure.id, "failure prompt", "failure-op");
    await until(
      () =>
        requests.some((r) =>
          r.body.messages.some(
            (m: any) => m.content === titlePrompt("failure prompt"),
          ),
        ) && app.detail(failure.id).state === "idle",
    );
    expect(app.detail(failure.id).title).toBe("New session");
    expect(
      app.detail(failure.id).messages.some((m) => m.text === "Normal answer"),
    ).toBe(true);
  } finally {
    release();
    releaseSame();
    app.dispose();
    await runtime.close();
    upstream.stop(true);
  }
}, 30000);
