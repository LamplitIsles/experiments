import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  createRegistry,
  defineExtension,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { openPiStorage } from "./pi-storage";

test("released Durable + ModelRuntime + Bun SQLite + official MCP/codemode execute in owned isolation", async () => {
  if (!process.env.GROVE_DURABLE_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-durable-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          GROVE_DURABLE_CHILD: "1",
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
    agentDir = process.env.PI_CODING_AGENT_DIR!;
  await mkdir(agentDir);
  await writeFile(join(home, "mcp.log"), "");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      const first = ++requests === 1;
      if (first) await gate;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-owned",
                type: "function",
                function: {
                  name: "codemode",
                  arguments: JSON.stringify({
                    code: 'text(await tools.mcp__owned__echo({value:"actual call"}));',
                  }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Complete" };
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) +
          chunk({}, first ? "tool_calls" : "stop") +
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
          apiKey: "owned-only",
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
  const client = new McpClient({ name: "grove-owned", version: "1" });
  const transport = new StdioTransport({
    command: process.execPath,
    args: [join(import.meta.dir, "../tests/pi-mcp-fixture.ts")],
    env: { GROVE_MCP_LOG: join(home, "mcp.log") },
  });
  const ctx = BACKGROUND_CONTEXT;
  let harness: Harness | undefined;
  try {
    await client.connect(transport);
    const discovered = await client.listTools();
    const registry = createRegistry();
    registry.install(
      createCodemodeExtension({ sandbox: new CodemodeSandbox() }),
    );
    registry.install(createToolSearchExtension());
    registry.install(
      defineExtension({
        name: "owned",
        tools: discovered.map(
          (tool) =>
            ({
              name: `mcp__owned__${tool.name}`,
              description: tool.description ?? "",
              parameters: tool.inputSchema,
              replay: "unsafe",
              async execute(args) {
                const r = await client.callTool(
                  tool.name,
                  args as Record<string, unknown>,
                );
                return { output: r.content, isError: r.isError };
              },
            }) as ToolRegistration,
        ),
      }),
    );
    const models = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    const storage = await openPiStorage(join(home, "native.sqlite"));
    harness = await Harness.open(storage, { models, registry }, ctx);
    const root = await harness.root(ctx, {
      agent: { model: { provider: "fixture", modelId: "fake" } },
    });
    const submission = await root.submit(
      { type: "input", requestId: "owned-operation", content: "Use the tool" },
      ctx,
    );
    expect((await submission.status(ctx)).status).toBe("placed");
    expect(
      (await storage.submissionByRequest(root.id, "owned-operation", ctx))?.id,
    ).toBe(submission.id);
    expect(
      (
        await root.submit(
          {
            type: "input",
            requestId: "owned-operation",
            content: "Use the tool",
          },
          ctx,
        )
      ).id,
    ).toBe(submission.id);
    release();
    expect((await submission.wait(ctx)).status).toBe("done");
    const entries = await root.entries({}, 100, undefined, ctx);
    expect(JSON.stringify(entries)).toContain("actual call");
    expect(requests).toBe(2);
  } finally {
    release();
    await harness?.close(ctx);
    await client.close();
    upstream.stop(true);
  }
}, 20000);
