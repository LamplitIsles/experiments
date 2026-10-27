import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPiSession } from "./pi-session";
import { PiRuntime } from "./pi";
import { readPiStorage } from "./pi-storage";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

test("native Pi tool turns do not create timestamp-only assistant rows in live or history", async () => {
  if (!process.env.GROVE_CONVERSATION_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-conversation-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_CONVERSATION_CHILD: "1",
        GROVE_NO_TOOL: process.env.GROVE_NO_TOOL,
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
      for (const line of out.split("\n"))
        if (
          line.startsWith("native assistant content types") ||
          line.startsWith("conversation rows")
        )
          console.log(line);
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
  let requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      const first = ++requests === 1 && !process.env.GROVE_NO_TOOL;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-fixture",
                type: "function",
                function: {
                  name: "codemode",
                  arguments: JSON.stringify({ code: 'text("tool result")' }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Meaningful assistant text" };
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
          apiKey: "fixture-only",
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
  const agent: RuntimeAgent = {
    id: "orc",
    token: "fixture",
    role: "orc",
    ownerId: "orc",
    project: { alias: "fixture", name: "fixture", path: cwd },
    title: "New session",
    model: "fake",
    effort: "off",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
  };
  const events: RuntimeEvent[] = [];
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const handle = await openPiSession(
    agent,
    (e) => {
      events.push(e);
      if (e.type === "completed") finish();
    },
    {
      agentDir,
      sessionDir: join(agentDir, "grove-durable"),
      selection: { provider: "fixture", model: "fake", effort: "off" },
      tool: async () => ({}),
    },
  );
  try {
    await handle.send("Use a tool then answer", undefined, [], "operation");
    await done;
    const live = events
      .filter((e) => e.type === "item" && e.item.type === "agentMessage")
      .map((e) => (e as Extract<RuntimeEvent, { type: "item" }>).item.text);
    const history = (
      await new PiRuntime({ agentDir, tool: async () => ({}) }).historyMessages(
        handle.threadId,
      )
    ).messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);
    const storage = await readPiStorage(
      join(agentDir, "grove-durable", `${handle.threadId}.sqlite`),
    );
    const entries = await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID, order: "ascending" },
      100,
      undefined,
      ctx,
    );
    console.log(
      "native assistant content types",
      JSON.stringify(
        entries.items
          .filter((e) => e.kind === "pi.assistant")
          .map((e) =>
            e.model?.flatMap((m) =>
              Array.isArray(m.content) ? m.content.map((p) => p.type) : [],
            ),
          ),
      ),
    );
    await storage.close(ctx);
    console.log(
      `conversation rows live=${JSON.stringify(live)} history=${JSON.stringify(history)} requests=${requests}`,
    );
    expect(live).toEqual(["Meaningful assistant text"]);
    expect(history).toEqual(["Meaningful assistant text"]);
  } finally {
    await handle.close();
    upstream.stop(true);
  }
}, 20000);
