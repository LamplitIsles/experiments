import { test, expect } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPiSession } from "./pi-session";
import { PiRuntime } from "./pi";
import sharp from "sharp";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";
test("official codemode executes official MCP direct/deferred/codemode tools and Grove identity bridge", async () => {
  if (!process.env.GROVE_PI_NATIVE_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-pi-native-home-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PI_OFFLINE: "1",
          GROVE_PI_NATIVE_CHILD: "1",
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
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo"),
    log = join(home, "mcp.log");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(log, "");
  await writeFile(join(cwd, "AGENTS.md"), "Owned project instruction marker");
  const plans = [
    {
      name: "codemode",
      args: {
        code: 'text(await tools.bash({command:"printf fixture > tool-proof.txt"})); text(await tools.read({path:"tool-proof.txt"})); text(await tools.mcp__direct__echo({value:"direct"})); text(await tools.mcp__code__echo({value:"code"})); text((await searchTools("echo", {namespace:"deferred"})).length); text(await tools.worker_report({message:"fixture report"})); if (ALL_TOOLS.some(t => t.name === "worker_start")) throw new Error("Worker acquired Orc tools");',
      },
    },
    { name: "tool_search", args: { query: "echo", limit: 10 } },
    { name: "mcp__deferred__echo", args: { value: "deferred" } },
  ];
  const png = join(cwd, "owned.png");
  await writeFile(
    png,
    await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 4,
        background: { r: 40, g: 80, b: 120, alpha: 1 },
      },
    })
      .png()
      .toBuffer(),
  );
  let requests = 0;
  const requestedModels: string[] = [];
  let releaseFirst!: () => void, startedFirst!: () => void;
  const firstGate = new Promise<void>((r) => (releaseFirst = r)),
    firstStarted = new Promise<void>((r) => (startedFirst = r));
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string; messages: unknown[] };
      requestedModels.push(body.model);
      const plan = plans[requests++];
      if (requests === 1) {
        expect(JSON.stringify(body.messages)).toContain(
          "Owned project instruction marker",
        );
        startedFirst();
        await firstGate;
      }
      const delta = plan
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${requests}`,
                type: "function",
                function: {
                  name: plan.name,
                  arguments: JSON.stringify(plan.args),
                },
              },
            ],
          }
        : { role: "assistant", content: "Fixture complete" };
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) +
          chunk({}, plan ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "owned-fixture-only",
          models: [
            {
              id: "next",
              name: "Vision fixture",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
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
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: Object.fromEntries(
        ["direct", "deferred", "code"].map((name) => [
          name,
          {
            command: process.execPath,
            args: [join(import.meta.dir, "../tests/pi-mcp-fixture.ts")],
            env: { GROVE_MCP_LOG: log },
            exposure: name === "code" ? "codemode" : name,
          },
        ]),
      ),
    }),
  );
  const agent: RuntimeAgent = {
    id: "worker",
    token: "worker-token",
    role: "worker",
    ownerId: "owner",
    project: { alias: "fixture", name: "Fixture", path: cwd },
    title: "Fixture",
    model: "fake",
    effort: "off",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
  };
  const events: RuntimeEvent[] = [],
    reports: unknown[] = [];
  let settled!: () => void;
  const done = new Promise<void>((r) => (settled = r));
  const handle = await openPiSession(
    agent,
    (e) => {
      events.push(e);
      if (e.type === "completed") settled();
    },
    {
      agentDir,
      sessionDir: SessionManager.create(cwd).getSessionDir(),
      selection: { provider: "fixture", model: "fake", effort: "off" },
      tool: async (token, name, args) => {
        reports.push({ token, name, args });
        return { ok: true };
      },
    },
  );
  try {
    await handle.send("Exercise configured tools", undefined, [], "operation");
    await firstStarted;
    await expect(
      handle.send("", undefined, [png], "unsupported-image"),
    ).rejects.toThrow("does not support images");
    await handle.updateSettings({
      provider: "fixture",
      model: "next",
      effort: "off",
      serviceTier: "default",
    });
    releaseFirst();
    await done;
    expect(requestedModels).toEqual(["fake", "fake", "fake", "fake"]);
    expect(await readFile(join(cwd, "tool-proof.txt"), "utf8")).toBe("fixture");
    await expect(
      handle.updateSettings({
        provider: "fixture",
        model: "absent",
        effort: "off",
        serviceTier: "default",
      }),
    ).rejects.toThrow("unavailable");
    expect(reports).toEqual([
      {
        token: "worker-token",
        name: "worker_report",
        args: { message: "fixture report" },
      },
    ]);
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.filter((x) => x.event === "start")).toHaveLength(3);
    expect(lines.filter((x) => x.event === "echo")).toHaveLength(3);
    expect(
      events.some((e) => e.type === "item" && e.item.clientId === "operation"),
    ).toBe(true);
    expect(events.filter((e) => e.type === "completed")).toHaveLength(1);
    plans[4] = {
      name: "codemode",
      args: { code: 'text(await tools.mcp__direct__echo({value:"hold"}));' },
    };
    await handle.send(
      "Cancel a native MCP call",
      undefined,
      [png],
      "image-operation",
    );
    for (let i = 0; i < 1000; i++) {
      if ((await readFile(log, "utf8")).includes('"event":"hold"')) break;
      await Bun.sleep(5);
    }
    expect(await readFile(log, "utf8")).toContain('"event":"hold"');
    expect(requestedModels.at(-1)).toBe("next");
  } finally {
    releaseFirst();
    const firstClose = handle.close(),
      secondClose = handle.close();
    await secondClose;
    const pids = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((item) => item.event === "start");
    for (const child of pids)
      expect(() => process.kill(child.pid, 0)).toThrow();
    await firstClose;
    upstream.stop(true);
  }
  const started = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((x) => x.event === "start");
  for (const child of started)
    expect(() => process.kill(child.pid, 0)).toThrow();
  const calls = requests,
    previousLog = await readFile(log, "utf8");
  const readonly = new PiRuntime({
    agentDir,
    tool: async () => {
      throw Error("Readonly invoked tools");
    },
  });
  const history = await readonly.historyMessages(handle.threadId);
  await readonly.skills(cwd);
  expect(history.messages.some((m) => m.clientId === "operation")).toBe(true);
  const imageMessage = history.messages.find(
    (m) => m.clientId === "image-operation",
  )!;
  expect(imageMessage.images).toHaveLength(1);
  const image = await readonly.historyImage(
    handle.threadId,
    imageMessage.images![0].id,
  );
  expect(image?.type).toBe("image/png");
  expect(image?.size).toBeGreaterThan(0);
  expect(requests).toBe(calls);
  expect(await readFile(log, "utf8")).toBe(previousLog);
  const long = SessionManager.create(cwd);
  for (let i = 0; i < 251; i++)
    long.appendMessage({
      role: "user",
      content: `owned page ${i}`,
      timestamp: i,
    });
  const lastPage = await readonly.historyMessages(long.getSessionId());
  const middlePage = await readonly.historyMessages(
    long.getSessionId(),
    lastPage.nextCursor!,
  );
  const firstPage = await readonly.historyMessages(
    long.getSessionId(),
    middlePage.nextCursor!,
  );
  expect([
    lastPage.messages.length,
    middlePage.messages.length,
    firstPage.messages.length,
  ]).toEqual([100, 100, 51]);
  expect(firstPage.nextCursor).toBeNull();
  expect(firstPage.messages[0].text).toBe("owned page 0");
  const nativePath = (await SessionManager.findById(
    cwd,
    handle.threadId,
    SessionManager.create(cwd).getSessionDir(),
  ))!;
  const nativeContent = await readFile(nativePath, "utf8");
  await writeFile(nativePath, "");
  await expect(readonly.historyMessages(handle.threadId)).rejects.toThrow();
  await expect(
    openPiSession({ ...agent, threadId: handle.threadId }, () => {}, {
      agentDir,
      sessionDir: SessionManager.create(cwd).getSessionDir(),
      sessionPath: nativePath,
      selection: { provider: "fixture", model: "fake", effort: "off" },
      tool: async () => {
        throw Error("Missing session invoked tools");
      },
    }),
  ).rejects.toThrow("original Pi session");
  expect(await readFile(nativePath, "utf8")).toBe("");
  await writeFile(nativePath, nativeContent);
  await rename(nativePath, `${nativePath}.owned-backup`);
  await expect(readonly.historyMessages(handle.threadId)).rejects.toThrow();
  await rename(`${nativePath}.owned-backup`, nativePath);
  expect(requests).toBe(calls);
  expect(await readFile(log, "utf8")).toBe(previousLog);
  await readonly.close();
  // Exercise official file credential locking and refresh with fake tokens only.
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "oauth-fixture": {
        type: "oauth",
        access: "expired-owned-token",
        refresh: "owned-refresh",
        expires: 0,
      },
    }),
  );
  const makeAuthRuntime = () =>
    ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
  const [authA, authB] = await Promise.all([
    makeAuthRuntime(),
    makeAuthRuntime(),
  ]);
  let refreshes = 0;
  const config = {
    name: "Owned OAuth",
    baseUrl: "http://127.0.0.1:1",
    api: "openai-completions" as const,
    models: [],
    oauth: {
      name: "Owned OAuth",
      login: async () => {
        throw Error("Login must not run");
      },
      refreshToken: async () => {
        refreshes++;
        return {
          access: "refreshed-owned-token",
          refresh: "owned-refresh-next",
          expires: Date.now() + 3600000,
        };
      },
      getApiKey: (credential: { access: string }) => credential.access,
    },
  };
  authA.registerProvider("oauth-fixture", config);
  authB.registerProvider("oauth-fixture", config);
  const authenticated = await Promise.all([
    authA.getAuth("oauth-fixture"),
    authB.getAuth("oauth-fixture"),
  ]);
  expect(refreshes).toBe(1);
  expect(authenticated.map((value) => value?.auth.apiKey)).toEqual([
    "refreshed-owned-token",
    "refreshed-owned-token",
  ]);
  expect(
    JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"))[
      "oauth-fixture"
    ].access,
  ).toBe("refreshed-owned-token");
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      "oauth-fixture": {
        type: "oauth",
        access: "expired",
        refresh: "owned",
        expires: 0,
      },
    }),
  );
  authA.registerProvider("oauth-fixture", {
    ...config,
    oauth: {
      ...config.oauth,
      refreshToken: async () => {
        throw Error("Owned refresh failure");
      },
    },
  });
  await expect(authA.getAuth("oauth-fixture")).rejects.toThrow();

  // A low-level agent_end preceding SDK automatic retry is not completion.
  let retryRequests = 0;
  const retryUpstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      retryRequests++;
      if (retryRequests === 1)
        return Response.json(
          {
            error: {
              message: "server overloaded owned-fixture-only",
              type: "overloaded_error",
            },
          },
          { status: 400 },
        );
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "retry-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk({ role: "assistant", content: "Retry fixture recovered" }, null) +
          chunk({}, "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const retryConfig = JSON.parse(
    await readFile(join(agentDir, "models.json"), "utf8"),
  );
  retryConfig.providers.fixture.baseUrl = `http://127.0.0.1:${retryUpstream.port}/v1`;
  await writeFile(join(agentDir, "models.json"), JSON.stringify(retryConfig));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }),
  );
  await writeFile(join(agentDir, "mcp.json"), "{}");
  const retryEvents: RuntimeEvent[] = [];
  let retrySettled!: () => void;
  const retryDone = new Promise<void>((r) => (retrySettled = r));
  const retryHandle = await openPiSession(
    agent,
    (event) => {
      retryEvents.push(event);
      if (event.type === "completed") retrySettled();
    },
    {
      agentDir,
      sessionDir: SessionManager.create(cwd).getSessionDir(),
      selection: { provider: "fixture", model: "fake", effort: "off" },
      tool: async () => ({}),
    },
  );
  try {
    await retryHandle.send("Retry safely", undefined, [], "retry-operation");
    await retryDone;
    expect(retryRequests).toBe(2);
    expect(
      retryEvents.some(
        (e) => e.type === "error" && e.willRetry && e.errorKind === "capacity",
      ),
    ).toBe(true);
    expect(retryEvents.filter((e) => e.type === "completed")).toEqual([
      expect.objectContaining({ status: "completed" }),
    ]);
    expect(
      retryEvents.filter(
        (e) => e.type === "item" && e.item.type === "userMessage",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(retryEvents)).not.toContain("owned-fixture-only");
  } finally {
    await retryHandle.close();
    retryUpstream.stop(true);
  }
}, 20000);
