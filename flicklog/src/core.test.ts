import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import {
  configText,
  extractContext,
  loadState,
  messageId,
  plistText,
  prepareSetup,
  scan,
  searchFilters,
  setupPaths,
} from "./core";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(
  options: { source?: string; omitThreadSource?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "flicklog-test-"));
  roots.push(root);
  const home = join(root, "codex"),
    sessions = join(home, "sessions", "2026");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(home, "session_index.jsonl"),
    JSON.stringify({
      id: "s1",
      thread_name: "named",
      updated_at: "2026-01-01T00:00:00Z",
    }) + "\n",
  );
  const path = join(sessions, "s1.jsonl");
  const record = (x: unknown) => JSON.stringify(x) + "\n";
  const meta = {
    type: "session_meta",
    payload: {
      id: "s1",
      session_id: "s1",
      cwd: "/project",
      source: options.source ?? "cli",
      ...(options.omitThreadSource ? {} : { thread_source: "user" }),
      timestamp: "2026-01-01T00:00:00Z",
    },
  };
  const user = {
    type: "response_item",
    timestamp: "2026-01-01T00:00:00Z",
    payload: {
      type: "message",
      id: "msg_01a0",
      role: "user",
      content: [{ type: "input_text", text: "你好 mixed code" }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["user.text"],
      },
    },
  };
  const commentary = {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "working" }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["unknown"],
      },
    },
  };
  const reasoning = {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "analysis",
      content: [{ type: "output_text", text: "secret" }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["unknown"],
      },
    },
  };
  const final = {
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "done" }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["unknown"],
      },
    },
  };
  await writeFile(
    path,
    [meta, user, commentary, reasoning, final].map(record).join(""),
  );
  return { root, home, path, final, record };
}
describe("incremental Codex projection", () => {
  test("indexes app-server vscode sessions with no thread source", async () => {
    const f = await fixture({ source: "vscode", omitThreadSource: true });
    const env = {
      CODEX_HOME: f.home,
      FLICKLOG_STATE_DIR: join(f.root, "state"),
    };
    const batches: any[] = [];
    expect(
      (
        await scan(env, async (items) => {
          batches.push(items);
        })
      ).indexed,
    ).toBe(3);
    expect(batches[0].map((item: any) => item.sessionId)).toEqual([
      "s1",
      "s1",
      "s1",
    ]);
  });
  test("indexes only eligible records, preserves source ordinals, and appends", async () => {
    const f = await fixture(),
      batches: any[] = [];
    const env = {
      CODEX_HOME: f.home,
      FLICKLOG_STATE_DIR: join(f.root, "state"),
    };
    expect(
      (
        await scan(env, async (x) => {
          batches.push(x);
        })
      ).indexed,
    ).toBe(3);
    expect(
      batches[0].map((x: any) => [
        x.kind,
        x.role,
        x.phase,
        x.sourceRecordIndex,
      ]),
    ).toEqual([
      ["message", "user", undefined, 1],
      ["message", "assistant", "commentary", 2],
      ["message", "assistant", "final_answer", 4],
    ]);
    expect(batches[0][0].sourceId).toBe("msg_01a0");
    expect(batches[0][0].id).toBe(
      messageId("msg_01a0", batches[0][0].deviceId, f.path, 1),
    );
    expect(
      (
        await scan(env, async (x) => {
          batches.push(x);
        })
      ).indexed,
    ).toBe(0);
    await writeFile(f.path, f.record(f.final), { flag: "a" });
    expect(
      (
        await scan(env, async (x) => {
          batches.push(x);
        })
      ).indexed,
    ).toBe(1);
  });
  test("preserves source timestamps and adds Unix seconds only when valid", async () => {
    const f = await fixture(),
      batches: any[] = [];
    const env = {
      CODEX_HOME: f.home,
      FLICKLOG_STATE_DIR: join(f.root, "state"),
    };
    await scan(env, async (items) => {
      batches.push(items);
    });
    expect(batches[0][0]).toMatchObject({
      createdAt: "2026-01-01T00:00:00Z",
      createdAtEpoch: 1767225600,
    });
    expect(batches[0][1].createdAtEpoch).toBeUndefined();
    await writeFile(
      f.path,
      f.record({
        type: "response_item",
        timestamp: "not a timestamp",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "bad timestamp" }],
          internal_chat_message_metadata_passthrough: {
            content_item_kinds: ["user.text"],
          },
        },
      }),
      { flag: "a" },
    );
    await scan(env, async (items) => {
      batches.push(items);
    });
    expect(batches[1][0].createdAt).toBeUndefined();
    expect(batches[1][0].createdAtEpoch).toBeUndefined();
  });
  test("does not commit an incomplete trailing record", async () => {
    const f = await fixture(),
      env = { CODEX_HOME: f.home, FLICKLOG_STATE_DIR: join(f.root, "state") };
    await writeFile(f.path, '{"type":', { flag: "a" });
    await scan(env, async () => {});
    const state = await loadState(
      join(env.FLICKLOG_STATE_DIR, "scan-state.json"),
    );
    const committed = state.sources[f.path].offset;
    expect(committed).toBeLessThan(
      (await (await import("node:fs/promises")).stat(f.path)).size,
    );
  });
  test("plans and completes each pending source, including incomplete logs", async () => {
    const f = await fixture();
    const partial = join(f.home, "sessions", "2026", "partial.jsonl");
    await writeFile(partial, '{"type":');
    const observed: string[] = [];
    const env = {
      CODEX_HOME: f.home,
      FLICKLOG_STATE_DIR: join(f.root, "state"),
    };
    await scan(env, async () => {}, {
      plan: (pending) => observed.push(`plan:${pending}`),
      source: (indexed) => observed.push(`source:${indexed}`),
    });
    expect(observed).toEqual(["plan:2", "source:0", "source:3"]);
    observed.length = 0;
    await scan(env, async () => {}, {
      plan: (pending) => observed.push(`plan:${pending}`),
      source: (indexed) => observed.push(`source:${indexed}`),
    });
    expect(observed).toEqual(["plan:1", "source:0"]);
  });
});
test("normal storage IDs depend on device and source ID, not provenance", () => {
  const first = messageId("msg_01a0", "device-a", "/one.jsonl", 1);
  expect(first).toBe(messageId("msg_01a0", "device-a", "/other.jsonl", 9));
  expect(first).not.toBe(messageId("msg_01a0", "device-b", "/one.jsonl", 1));
});
test("fallback document IDs cannot collide across devices", () => {
  expect(messageId(undefined, "device-a", "/same/session.jsonl", 7)).not.toBe(
    messageId(undefined, "device-b", "/same/session.jsonl", 7),
  );
});
test("does not index image-only user messages", async () => {
  const f = await fixture(),
    batches: any[] = [];
  const env = { CODEX_HOME: f.home, FLICKLOG_STATE_DIR: join(f.root, "state") };
  await scan(env, async (items) => {
    batches.push(items);
  });
  const image = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ["user.image"],
      },
    },
  };
  await writeFile(f.path, f.record(image), { flag: "a" });
  expect(
    (
      await scan(env, async (items) => {
        batches.push(items);
      })
    ).indexed,
  ).toBe(0);
  expect(batches).toHaveLength(1);
});
test("skips empty native compactions", async () => {
  const f = await fixture(),
    env = { CODEX_HOME: f.home, FLICKLOG_STATE_DIR: join(f.root, "state") };
  await scan(env, async () => {});
  await writeFile(
    f.path,
    f.record({
      type: "compacted",
      payload: { message: "", replacement_history: "must not index" },
    }),
    { flag: "a" },
  );
  expect((await scan(env, async () => {})).indexed).toBe(0);
});
test("indexes plaintext compaction only", async () => {
  const f = await fixture(),
    batches: any[] = [];
  const env = { CODEX_HOME: f.home, FLICKLOG_STATE_DIR: join(f.root, "state") };
  await scan(env, async () => {});
  await writeFile(
    f.path,
    f.record({
      type: "compacted",
      payload: {
        message: "  checkpoint summary  ",
        replacement_history: "do not leak",
      },
    }),
    { flag: "a" },
  );
  expect(
    (
      await scan(env, async (items) => {
        batches.push(items);
      })
    ).indexed,
  ).toBe(1);
  expect(batches[0][0]).toMatchObject({
    kind: "compaction",
    content: "  checkpoint summary  ",
  });
  expect(batches[0][0].content).not.toContain("do not leak");
  expect(batches[0][0].sourceId).toBeUndefined();
});
test("compaction fallback IDs remain device-safe", () => {
  expect(messageId(undefined, "device-a", "/same/session.jsonl", 7)).not.toBe(
    messageId(undefined, "device-b", "/same/session.jsonl", 7),
  );
});
describe("source context and setup contract", () => {
  test("counts eligible items, not source records, on both sides of the match", () => {
    const message = (content: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["user.text"],
        },
      },
    });
    const tool = {
      type: "response_item",
      payload: { type: "function_call_output", output: "ok" },
    };
    const records: unknown[] = [];
    for (let i = 0; i < 10; i++) records.push(message(`before ${i}`), tool);
    const target = records.length;
    records.push(message("match"));
    for (let i = 0; i < 10; i++) records.push(tool, message(`after ${i}`));
    const text =
      records.map((record) => JSON.stringify(record)).join("\n") + "\n";

    const defaultContext = extractContext(text, target, false);
    expect(defaultContext.items.map((item) => item.sourceRecordIndex)).toEqual([
      4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36,
    ]);
    expect(defaultContext.items.every((item) => item.kind === "message")).toBe(
      true,
    );
    expect(defaultContext.truncated).toBe(false);

    const withTools = extractContext(text, target, true);
    expect(withTools.items.map((item) => item.sourceRecordIndex)).toEqual(
      Array.from({ length: 17 }, (_, index) => target - 8 + index),
    );
    expect(withTools.items.filter((item) => item.kind === "tool")).toHaveLength(
      8,
    );
  });
  test("counts plaintext compactions as neighbours", () => {
    const message = (content: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["user.text"],
        },
      },
    });
    const tool = {
      type: "response_item",
      payload: { type: "function_call_output", output: "ok" },
    };
    const records = [
      message("before"),
      { type: "compacted", payload: { message: "summary" } },
      tool,
      message("match"),
      tool,
      message("after"),
    ];
    const text =
      records.map((record) => JSON.stringify(record)).join("\n") + "\n";
    expect(
      extractContext(text, 3, false, 1).items.map(
        (item) => item.sourceRecordIndex,
      ),
    ).toEqual([1, 3, 5]);
    expect(
      extractContext(text, 3, true, 1).items.map(
        (item) => item.sourceRecordIndex,
      ),
    ).toEqual([2, 3, 4]);
  });
  test("excludes reasoning, controls tools, and marks truncation", () => {
    const text =
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "question" }],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["user.text"],
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "analysis",
            content: [{ type: "output_text", text: "secret" }],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["unknown"],
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "function_call_output", output: "x".repeat(40) },
        }),
      ].join("\n") + "\n";
    expect(extractContext(text, 0, false).items.map((x) => x.kind)).toEqual([
      "message",
    ]);
    const items = extractContext(text, 0, true, 8, 35).items;
    expect(items.some((x) => x.kind === "tool" && x.truncated)).toBe(true);
    expect(items.some((x) => x.content.includes("secret"))).toBe(false);
  });
  test("includes current Codex custom tool calls and results in source order", () => {
    const text =
      [
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec_command",
            arguments: '{"cmd":"bun test"}',
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "analysis",
            content: [
              { type: "output_text", text: "reasoning must stay hidden" },
            ],
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["unknown"],
            },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_1",
            output: "tests passed",
          },
        }),
      ].join("\n") + "\n";
    const items = extractContext(text, 0, true).items;
    expect(items.map((item) => [item.kind, item.sourceRecordIndex])).toEqual([
      ["tool", 0],
      ["tool", 2],
    ]);
    expect(items[0].content).toContain("custom_tool_call");
    expect(items[1].content).toContain("custom_tool_call_output");
    expect(
      items.some((item) => item.content.includes("reasoning must stay hidden")),
    ).toBe(false);
  });
  test("returns plaintext compaction without replacement history", () => {
    const text =
      JSON.stringify({
        type: "compacted",
        payload: {
          message: "checkpoint summary",
          replacement_history: "private old history",
        },
      }) + "\n";
    const context = extractContext(text, 0, true);
    expect(context.items).toEqual([
      {
        sourceRecordIndex: 0,
        kind: "compaction",
        content: "checkpoint summary",
      },
    ]);
    expect(JSON.stringify(context.items)).not.toContain("private old history");
  });
  test("uses one budget, preserves target, and clips head and tail", () => {
    const target = `😀TARGET_HEAD_${"x".repeat(30)}_TARGET_TAIL`;
    const nearby = `NEARBY_HEAD_${"y".repeat(30)}_NEARBY_TAIL`;
    const message = (text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["user.text"],
        },
      },
    });
    const context = extractContext(
      [message(nearby), message(target)]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
      1,
      false,
      8,
      52,
    );
    expect(context.items).toHaveLength(1);
    expect(context.items[0].sourceRecordIndex).toBe(1);
    expect(context.items[0].content).toContain("TARGET_HEAD");
    expect(context.items[0].content).toContain("TARGET_TAIL");
    const marker = context.items[0].content.match(/…(\d+) chars truncated…/);
    expect(marker).not.toBeNull();
    expect(Number(marker![1])).toBe(
      Array.from(target).length -
        Array.from(context.items[0].content.replace(marker![0], "")).length,
    );
    expect(context.items[0].truncated).toBe(true);
    expect(context.truncated).toBe(true);
    expect(
      context.items.reduce((n, item) => n + Array.from(item.content).length, 0),
    ).toBeLessThanOrEqual(52);
    expect(context.items[0].content).toContain("😀");
  });
  test("shares the context budget in Unicode code points", () => {
    const message = (text: string) => ({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["user.text"],
        },
      },
    });
    const nearest = "B".repeat(5999);
    const target = "😀".repeat(6001);
    const context = extractContext(
      [message(nearest), message(target)]
        .map((item) => JSON.stringify(item))
        .join("\n") + "\n",
      1,
      false,
    );
    expect(context.items.map((item) => item.sourceRecordIndex)).toEqual([0, 1]);
    expect(context.items[1].content).toBe(target);
    expect(context.items[0].content).toBe(nearest);
    expect(context.truncated).toBe(false);
    expect(
      context.items.reduce(
        (total, item) => total + Array.from(item.content).length,
        0,
      ),
    ).toBeLessThanOrEqual(12000);
  });
  test("combines half-open time windows with device and working-directory scope", () => {
    expect(searchFilters("/project", false, { from: 100, until: 200 })).toEqual(
      [
        `deviceId = ${JSON.stringify(hostname())}`,
        'cwd = "/project"',
        "createdAtEpoch >= 100",
        "createdAtEpoch < 200",
      ],
    );
    expect(searchFilters("/project", true, { from: 100 })).toEqual([
      `deviceId = ${JSON.stringify(hostname())}`,
      "createdAtEpoch >= 100",
    ]);
  });
  test("renders a dedicated loopback LaunchAgent", async () => {
    const root = await mkdtemp(join(tmpdir(), "flicklog-setup-"));
    roots.push(root);
    const env = {
      FLICKLOG_STATE_DIR: root,
      FLICKLOG_LAUNCH_AGENTS_DIR: join(root, "agents"),
    };
    const p = await prepareSetup(env, "/opt/homebrew/bin/meilisearch");
    expect(configText(p, await readFile(p.key, "utf8"))).toContain(
      "127.0.0.1:7701",
    );
    expect(plistText(p, "/opt/homebrew/bin/meilisearch")).toContain(
      "dev.flicklog.meilisearch",
    );
    expect(plistText(p, "/opt/homebrew/bin/meilisearch")).toContain(
      `<key>WorkingDirectory</key><string>${root}</string>`,
    );
    expect(setupPaths(env).database).toContain("meilisearch-data");
  });
});
