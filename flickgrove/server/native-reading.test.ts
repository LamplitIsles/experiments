import { expect, test } from "bun:test";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import type { v2 } from "@jaminzhou/codex-app-server-client/protocol";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("installed native history excludes deltas, exposes completed commentary during work and preserves client IDs/cursors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-native-wire-"));
  const env = {
    PATH: process.env.PATH!,
    HOME: join(directory, "home"),
    CODEX_HOME: join(directory, "codex"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
  };
  for (const p of Object.values(env).slice(1))
    await mkdir(p, { recursive: true });
  let providers = 0;
  const ready = Promise.withResolvers<void>();
  const finishItem = Promise.withResolvers<void>();
  const finishResponse = Promise.withResolvers<void>();
  let deltaSeen = false;
  let messageCompleted = false;
  const startedMessages = new Set<string>();
  let completedMessageId = "";
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      providers++;
      await ready.promise;
      const message = {
        id: `msg_test_${providers}`,
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: "Fixture reply", annotations: [] },
        ],
        status: "completed",
        phase: "commentary",
      };
      const response = {
        id: "resp_test",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: "fixture",
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      };
      const events = [
        {
          type: "response.created",
          response: { ...response, status: "in_progress", output: [] },
        },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...message, content: [], status: "in_progress" },
        },
        {
          type: "response.content_part.added",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: message.id,
          output_index: 0,
          content_index: 0,
          delta: "Fixture reply",
        },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response },
      ];
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (event: object) =>
              controller.enqueue(
                new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            events.slice(0, 4).forEach(send);
            await finishItem.promise;
            send(events[4]);
            await finishResponse.promise;
            send(events[5]);
            controller.close();
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    },
  });
  const client = new CodexAppServerClient({
    cwd: directory,
    env,
    codexPath: "codex",
    capabilities: { experimentalApi: true },
    clientInfo: { name: "grove-native-wire", title: "Fixture", version: "1" },
    protocolValidation: "strict",
  });
  let completed = false;
  const users: Extract<
    v2.ThreadItem,
    {
      type: "userMessage";
    }
  >[] = [];
  client.onNotification("item/started", (p) => {
    if (p.item.type === "agentMessage") startedMessages.add(p.item.id);
  });
  client.onNotification("item/agentMessage/delta", () => {
    deltaSeen = true;
  });
  client.onNotification("item/completed", (p) => {
    if (p.item.type === "agentMessage") {
      messageCompleted = true;
      completedMessageId = p.item.id;
    }
    if (p.item.type === "userMessage") users.push(p.item);
  });
  client.onNotification("turn/completed", () => {
    completed = true;
  });
  try {
    await client.connect();
    const config = {
      model_provider: "fixture",
      "model_providers.fixture": {
        name: "fixture",
        base_url: `http://127.0.0.1:${provider.port}/v1`,
        wire_api: "responses",
        requires_openai_auth: false,
      },
      "agents.enabled": false,
      "features.multi_agent": false,
      "features.multi_agent_v2": false,
    };
    const a = await client.threadStart({
      cwd: directory,
      model: "fixture",
      historyMode: "paginated",
      config,
    });
    const turn = await client.turnStart({
      threadId: a.thread.id,
      clientUserMessageId: "first-operation",
      input: [{ type: "text", text: "Synthetic one", text_elements: [] }],
    });
    await client.turnSteer({
      threadId: a.thread.id,
      expectedTurnId: turn.turn.id,
      clientUserMessageId: "second-operation",
      input: [{ type: "text", text: "Synthetic one", text_elements: [] }],
    });
    ready.resolve();
    for (let i = 0; i < 200 && !deltaSeen; i++) await Bun.sleep(20);
    expect(deltaSeen).toBe(true);
    const partial = await client.call("thread/items/list", {
      threadId: a.thread.id,
      sortDirection: "desc",
      limit: 100,
    });
    expect(
      partial.data.some(
        (e) => ("item" in e ? e.item : e).type === "agentMessage",
      ),
    ).toBe(false);
    finishItem.resolve();
    for (let i = 0; i < 200 && !messageCompleted; i++) await Bun.sleep(20);
    expect(messageCompleted).toBe(true);
    expect(startedMessages.has(completedMessageId)).toBe(true);
    expect(completed).toBe(false);
    const active = await client.call("thread/items/list", {
      threadId: a.thread.id,
      sortDirection: "desc",
      limit: 100,
    });
    expect(
      active.data
        .map((e) => ("item" in e ? e.item : e))
        .filter((i) => i.type === "agentMessage"),
    ).toMatchObject([{ text: "Fixture reply", phase: "commentary" }]);
    finishResponse.resolve();
    for (let i = 0; i < 500 && !completed; i++) await Bun.sleep(20);
    expect(completed).toBe(true);
    expect(users.map((i) => i.clientId)).toEqual([
      "first-operation",
      "second-operation",
    ]);
    expect(users[0].id).not.toBe(users[1].id);
    let cursor: string | undefined;
    const seen: v2.ThreadItem[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await client.call("thread/items/list", {
        threadId: a.thread.id,
        sortDirection: "desc",
        limit: 1,
        cursor,
      });
      expect(page.data.length).toBeLessThanOrEqual(1);
      seen.push(...page.data.map((e) => ("item" in e ? e.item : e)));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(
      seen.filter((e) => e.type === "userMessage").map((e) => e.clientId),
    ).toEqual(["second-operation", "first-operation"]);
    const cursorBeforeRestart = seen.map((e) => e.id);
    await client.call("thread/unsubscribe", { threadId: a.thread.id });
    await client.threadResume({
      threadId: a.thread.id,
      excludeTurns: true,
      config,
    });
    const restored = await client.call("thread/items/list", {
      threadId: a.thread.id,
      sortDirection: "desc",
      limit: 100,
    });
    expect(restored.data.map((e) => ("item" in e ? e.item.id : e.id))).toEqual(
      cursorBeforeRestart,
    );
    console.log(
      `installed native: start+steer, ${users.length} client-bound user events, ${seen.length} individually paginated items, ${providers} local fake provider requests`,
    );
  } finally {
    ready.resolve();
    finishItem.resolve();
    finishResponse.resolve();
    await client.close();
    provider.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
