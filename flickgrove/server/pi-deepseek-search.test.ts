import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPiSession } from "./pi-session";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

test("vendored DeepSeek tools execute in an isolated Grove Pi session", async () => {
  if (!process.env.GROVE_DEEPSEEK_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-deepseek-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          GROVE_DEEPSEEK_CHILD: "1",
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
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const marker = join(home, "extension-ran");
  await writeFile(
    join(cwd, ".pi", "unrelated.ts"),
    `import {writeFileSync} from "node:fs"; export default function(){writeFileSync(${JSON.stringify(marker)}, "bad")}`,
  );
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      extensions: ["./unrelated.ts"],
      packages: ["npm:pi-deepseek-search"],
    }),
  );
  const secret = "test-owned-deepseek-key";
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ deepseek: { type: "api_key", key: secret } }),
  );
  const modelBodies: any[] = [],
    providerCalls: any[] = [];
  let nextTool: { name: string; args: object } | undefined;
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as any;
      modelBodies.push(body);
      const plan = nextTool;
      nextTool = undefined;
      const delta = plan
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${modelBodies.length}`,
                type: "function",
                function: {
                  name: plan.name,
                  arguments: JSON.stringify(plan.args),
                },
              },
            ],
          }
        : { role: "assistant", content: "Done" };
      const chunk = (d: object, reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: d, finish_reason: reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) +
          chunk({}, plan ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          apiKey: "model-only-key",
          models: [
            {
              id: "fake",
              name: "Fake",
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
  const originalFetch = globalThis.fetch;
  let hold = false,
    started!: () => void,
    aborted = false;
  let startedPromise = new Promise<void>((r) => {
    started = r;
  });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.startsWith(`http://127.0.0.1:${model.port}/`))
      return originalFetch(input, init);
    if (!url.startsWith("https://api.deepseek.com/"))
      throw new Error("Unexpected network request");
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body));
    providerCalls.push({
      url,
      body,
      authorization: headers.get("authorization"),
      apiKey: headers.get("x-api-key"),
    });
    if (hold) {
      started();
      return await new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    if (body.query === "provider error")
      return Response.json(
        { error: { message: `rejected ${secret}` } },
        { status: 400 },
      );
    if (url.endsWith("/search"))
      return Response.json({
        results: [
          {
            title: "Owned result",
            url: "https://example.test/page",
            summary: "Owned summary",
            snippet: "",
            site_name: null,
            date: null,
          },
        ],
      });
    if (url.endsWith("/fetch"))
      return Response.json({ title: "Owned page", content: "Owned markdown" });
    return Response.json({
      model: "fake-search-model",
      content: [
        {
          type: "web_search_tool_result",
          content: [
            {
              type: "web_search_result",
              title: "Server result",
              url: "https://example.test/server",
            },
          ],
        },
      ],
    });
  }) as typeof fetch;
  const agent: RuntimeAgent = {
    id: "worker",
    token: "owned",
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
  let completed!: () => void;
  let done = new Promise<void>((r) => {
    completed = r;
  });
  const notify = (event: RuntimeEvent) => {
    if (event.type === "completed") completed();
  };
  const options = {
    agentDir,
    sessionDir: join(agentDir, "grove-durable"),
    selection: { provider: "fixture", model: "fake", effort: "off" },
    tool: async () => ({ ok: true }),
  };
  let handle = await openPiSession(agent, notify, options);
  const run = async (name: string, args: object) => {
    done = new Promise<void>((r) => {
      completed = r;
    });
    nextTool = { name, args };
    await handle.send(
      "Use the requested tool",
      undefined,
      [],
      crypto.randomUUID(),
    );
    await done;
    return JSON.stringify(modelBodies.at(-1).messages);
  };
  try {
    process.env.DEEPSEEK_API_KEY = "unused-environment-key";
    let output = await run("web_search", {
      query: "owned query",
      allowed_domains: ["example.test"],
    });
    expect(output).toContain("Owned result");
    expect(providerCalls[0]).toMatchObject({
      authorization: `Bearer ${secret}`,
      body: { query: "owned query site:example.test" },
    });
    expect(modelBodies[0].model).toBe("fake");
    const names = modelBodies[0].tools.map((t: any) => t.function.name);
    expect(names).toContain("web_search");
    expect(names).toContain("web_fetch");
    expect(names).not.toContain("worker_start");
    output = await run("web_fetch", { url: "https://example.test/page" });
    expect(output).toContain("Owned markdown");
    expect(providerCalls[1].body).toEqual({ url: "https://example.test/page" });
    output = await run("web_search", { query: "provider error" });
    expect(output).toContain("Search failed");
    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
    output = await run("web_search", {
      query: "invalid",
      allowed_domains: ["bad/path"],
    });
    expect(output).toContain("plain domain names");
    expect(providerCalls).toHaveLength(3);
    hold = true;
    nextTool = {
      name: "web_fetch",
      args: { url: "https://example.test/hold" },
    };
    const turn = await handle.send(
      "Stop this call",
      undefined,
      [],
      crypto.randomUUID(),
    );
    await startedPromise;
    await handle.interrupt(turn);
    expect(aborted).toBe(true);
    hold = false;
    await handle.close();
    delete process.env.DEEPSEEK_API_KEY;
    await writeFile(join(agentDir, "auth.json"), "{}");
    handle = await openPiSession({ ...agent, id: "missing" }, notify, options);
    output = await run("web_fetch", { url: "https://example.test/page" });
    expect(output).toContain("No DeepSeek API key found");
    process.env.DEEPSEEK_API_KEY = "test-environment-key";
    output = await run("web_fetch", { url: "https://example.test/page" });
    expect(output).toContain("Owned markdown");
    expect(providerCalls.at(-1).authorization).toBe(
      "Bearer test-environment-key",
    );
    delete process.env.DEEPSEEK_API_KEY;
    await handle.close();
    await writeFile(
      join(agentDir, "auth.json"),
      JSON.stringify({ deepseek: { type: "api_key", key: secret } }),
    );
    process.env.DEEPSEEK_SEARCH_BACKEND = "server";
    process.env.DEEPSEEK_SEARCH_MODEL = "fake-search-model";
    handle = await openPiSession({ ...agent, id: "server" }, notify, options);
    output = await run("web_search", {
      query: "server search",
      blocked_domains: ["bad.test"],
    });
    expect(output).toContain("Server result");
    expect(providerCalls.at(-1)).toMatchObject({
      apiKey: secret,
      body: { model: "fake-search-model" },
    });
    expect(JSON.stringify(providerCalls.at(-1).body)).toContain(
      "server search -site:bad.test",
    );
    output = await run("web_fetch", { url: "https://example.test/page" });
    expect(output).toContain("Owned markdown");
    hold = true;
    aborted = false;
    startedPromise = new Promise<void>((r) => {
      started = r;
    });
    nextTool = {
      name: "web_fetch",
      args: { url: "https://example.test/close" },
    };
    await handle.send("Close this call", undefined, [], crypto.randomUUID());
    await startedPromise;
    await handle.close();
    expect(aborted).toBe(true);
    await expect(readFile(marker)).rejects.toThrow();
  } finally {
    await handle.close();
    globalThis.fetch = originalFetch;
    model.stop(true);
  }
}, 30000);
