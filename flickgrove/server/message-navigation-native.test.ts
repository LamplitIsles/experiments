import { createHash } from "node:crypto";
import sharp from "sharp";
import { CodexRuntime } from "./codex";
import { expect, test } from "bun:test";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import type { v2 } from "@jaminzhou/codex-app-server-client/protocol";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Opaque hashes audit only this test's native files. They are never parsed or
// used to resolve messages, cursors or any navigation fallback.
async function nativeBytes(
  path: string,
  prefix = "",
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const name = prefix + entry.name,
      file = join(path, entry.name);
    if (entry.isDirectory())
      Object.assign(result, await nativeBytes(file, name + "/"));
    else if (entry.isFile())
      result[name] = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
  }
  return result;
}
test("outline cross-turn cursor probe", async () => {
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
  // Keep native background catalogues inside the fake-provider boundary too.
  await writeFile(
    join(env.CODEX_HOME, "config.toml"),
    "[features]\nplugins = false\nremote_plugin = false\nplugin_sharing = false\napps = false\n",
  );
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
    codexPath: process.env.GROVE_CODEX_PATH ?? "codex",
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
    const png = join(directory, "owned.png");
    await writeFile(
      png,
      await sharp({
        create: { width: 2, height: 2, channels: 4, background: "#355d98" },
      })
        .png()
        .toBuffer(),
    );
    await client.turnSteer({
      threadId: a.thread.id,
      expectedTurnId: turn.turn.id,
      clientUserMessageId: "image-operation",
      input: [
        { type: "text", text: "Long fixture ".repeat(1000), text_elements: [] },
        { type: "localImage", path: png },
      ],
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
      "image-operation",
    ]);
    expect(users[0].id).not.toBe(users[1].id);
    for (let k = 0; k < 110; k++) {
      completed = false;
      await client.turnStart({
        threadId: a.thread.id,
        clientUserMessageId: `later-${k}`,
        input: [{ type: "text", text: `Later ${k}`, text_elements: [] }],
      });
      for (let i = 0; i < 500 && !completed; i++) await Bun.sleep(20);
      expect(completed).toBe(true);
    }
    const before = providers;
    // Cold catalogue process: no thread resume or turn on the navigation path.
    await client.close();
    let beforeCold = await nativeBytes(env.CODEX_HOME);
    const proxy = join(directory, "native-proxy"),
      log = join(directory, "methods.log");
    await writeFile(
      proxy,
      `#!${process.execPath}
import {spawn} from "node:child_process";
import {appendFileSync} from "node:fs";
const child=spawn(${JSON.stringify(process.env.GROVE_CODEX_PATH ?? "codex")},process.argv.slice(2),{stdio:["pipe","pipe","pipe"]});
let pending="";
process.stdin.on("data",chunk=>{pending+=chunk;let n;while((n=pending.indexOf("\\n"))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const value=JSON.parse(line);if(value.method)appendFileSync(${JSON.stringify(log)},value.method+"\\n");}catch{}}});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
process.on("SIGTERM",()=>child.kill("SIGTERM"));process.on("SIGINT",()=>child.kill("SIGINT"));
child.on("exit",code=>process.exit(code??1));
`,
      { mode: 0o700 },
    );
    // Control: initialization/close of the unchanged native catalogue without
    // any thread read distinguishes native lifecycle housekeeping from lookup.
    const control = new CodexAppServerClient({
      cwd: directory,
      env,
      codexPath: proxy,
      capabilities: { experimentalApi: true },
      protocolValidation: "strict",
      clientInfo: {
        name: "grove-catalogue-control",
        title: "Fixture",
        version: "1",
      },
    });
    try {
      await control.connect();
    } finally {
      await control.close();
    }
    const afterControl = await nativeBytes(env.CODEX_HOME);
    console.log(
      "native initialize-only file changes",
      JSON.stringify(
        [
          ...new Set([
            ...Object.keys(beforeCold),
            ...Object.keys(afterControl),
          ]),
        ].filter((name) => beforeCold[name] !== afterControl[name]),
      ),
    );
    beforeCold = afterControl;
    const runtime = new CodexRuntime({
      cwd: directory,
      env,
      codexPath: proxy,
      origin: () => "http://127.0.0.1:1",
    });
    try {
      const target = await runtime.messageWindow(a.thread.id, {
        operation: "second-operation",
        turnId: turn.turn.id,
      });
      expect(
        target.messages.find((m) => m.id === target.target)?.clientId,
      ).toBe("second-operation");
      const image = target.messages.find(
        (m) => m.clientId === "image-operation",
      )!;
      expect(image.text).toBe("Long fixture ".repeat(1000));
      expect(image.images).toHaveLength(1);
      expect(
        (await runtime.historyImage(a.thread.id, image.images![0].id))?.size,
      ).toBeGreaterThan(0);
      expect(
        await runtime.historyImage("foreign-thread", image.images![0].id),
      ).toBeNull();
      const seen = new Map(target.messages.map((m) => [m.id, m]));
      let cursor = target.newerCursor;
      let pages = 0;
      while (cursor && pages++ < 10) {
        const page = await runtime.messageWindow(a.thread.id, {
          cursor,
          direction: "newer",
        });
        for (const m of page.messages) seen.set(m.id, m);
        cursor = page.newerCursor;
      }
      expect(pages).toBeGreaterThan(2);
      expect(
        [...seen.values()]
          .filter((m) => m.role === "user")
          .map((m) => m.clientId),
      ).toEqual([
        "first-operation",
        "second-operation",
        "image-operation",
        ...Array.from({ length: 110 }, (_, k) => `later-${k}`),
      ]);
      const latest = await runtime.historyMessages(a.thread.id);
      const lastUser = latest.messages
        .slice()
        .reverse()
        .find((m) => m.clientId === "later-109")!;
      const oldTarget = await runtime.messageWindow(a.thread.id, {
        operation: "later-109",
        turnId: lastUser.turnId,
      });
      let older = oldTarget.olderCursor;
      const backwards = new Map(oldTarget.messages.map((m) => [m.id, m]));
      let oldPages = 0;
      while (older && oldPages++ < 10) {
        const page = await runtime.messageWindow(a.thread.id, {
          cursor: older,
          direction: "older",
        });
        for (const m of page.messages) backwards.set(m.id, m);
        older = page.olderCursor;
      }
      expect(
        [...backwards.values()].filter((m) => m.role === "user"),
      ).toHaveLength(113);
      expect(providers).toBe(before);
      const methods = (await readFile(log, "utf8")).trim().split("\n");
      expect(
        methods.filter(
          (m) =>
            m.startsWith("turn/") ||
            m === "thread/resume" ||
            m === "thread/start",
        ),
      ).toEqual([]);
      expect(
        methods.filter((m) => m === "thread/items/list").length,
      ).toBeGreaterThan(5);
      console.log("cold methods", [...new Set(methods)].join(","));
      console.log(
        `native cold navigation: ${seen.size} items, ${pages} newer pages, ${oldPages} older pages; preparation provider calls ${before}; reading provider delta 0`,
      );
    } finally {
      await runtime.close();
    }
    const afterCold = await nativeBytes(env.CODEX_HOME);
    const changed = [
      ...new Set([...Object.keys(beforeCold), ...Object.keys(afterCold)]),
    ].filter((name) => beforeCold[name] !== afterCold[name]);
    console.log("native cold file changes", JSON.stringify(changed));
    expect(changed.filter((name) => name.endsWith(".jsonl"))).toEqual([]);
    expect(
      changed.filter((name) =>
        /^(state_|thread_history_).*\.sqlite(?:-wal)?$/.test(name),
      ),
    ).toEqual([]);
    expect(changed.filter((name) => name.startsWith(".tmp/"))).toEqual([]);
  } finally {
    ready.resolve();
    finishItem.resolve();
    finishResponse.resolve();
    await client.close();
    provider.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
