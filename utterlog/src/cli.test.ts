import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { discoverSessions, parseTranscript, run, type NamedSession, type TranscriptMessage } from "./cli";
import type { RendererFactory } from "./reader";

const ids = {
  newest: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  oldest: "33333333-3333-4333-8333-333333333333",
  selected: "44444444-4444-4444-8444-444444444444",
  parent: "55555555-5555-4555-8555-555555555555",
  unnamed: "88888888-8888-4888-8888-888888888888",
  subagent: "99999999-9999-4999-8999-999999999999",
  malformed: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

type Fixture = {
  root: string;
  codexHome: string;
  sessions: string;
  cwd: string;
  indexEntries: Array<Record<string, unknown>>;
};

type SessionOptions = {
  id: string;
  cwd: string;
  name?: string;
  source?: string | Record<string, unknown>;
  threadSource?: string;
  createdAt?: string;
  activityAt?: string;
  records?: Array<Record<string, unknown>>;
  indexUpdatedAt?: string;
  trailing?: string;
};

type CapturedOutput = {
  write(chunk: string | Uint8Array): boolean;
  text(): string;
};

async function withFixture<T>(callback: (fixture: Fixture) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "utterlog-test-"));
  const fixture: Fixture = {
    root,
    codexHome: join(root, "codex"),
    sessions: join(root, "codex", "sessions"),
    cwd: join(root, "project"),
    indexEntries: [],
  };
  await mkdir(fixture.sessions, { recursive: true });
  await mkdir(fixture.cwd, { recursive: true });

  try {
    return await callback(fixture);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function captureOutput(): CapturedOutput {
  let value = "";
  return {
    write(chunk) {
      value += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    },
    text() {
      return value;
    },
  };
}

function sessionMessage(options: {
  role: "user" | "assistant";
  phase?: string;
  kinds: string[];
  content: Array<Record<string, unknown>>;
  timestamp?: string;
  ordinal?: number;
}): Record<string, unknown> {
  return {
    type: "response_item",
    timestamp: options.timestamp ?? "2026-09-12T12:00:00.000Z",
    ordinal: options.ordinal ?? 1,
    payload: {
      type: "message",
      role: options.role,
      ...(options.phase ? { phase: options.phase } : {}),
      content: options.content,
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: options.kinds,
        create_time: 1,
        turn_id: "turn-1",
      },
    },
  };
}

function userText(text: string, timestamp = "2026-09-12T12:00:00.000Z", ordinal = 1): Record<string, unknown> {
  return sessionMessage({
    role: "user",
    kinds: ["user.text"],
    content: [{ type: "input_text", text }],
    timestamp,
    ordinal,
  });
}

function assistantText(
  text: string,
  phase: "commentary" | "final_answer" = "final_answer",
  timestamp = "2026-09-12T12:00:00.000Z",
  ordinal = 2,
): Record<string, unknown> {
  return sessionMessage({
    role: "assistant",
    phase,
    kinds: ["unknown"],
    content: [{ type: "output_text", text }],
    timestamp,
    ordinal,
  });
}

async function writeSession(fixture: Fixture, options: SessionOptions): Promise<string> {
  const createdAt = options.createdAt ?? "2026-09-12T08:00:00.000Z";
  const activityAt = options.activityAt ?? createdAt;
  const meta = {
    type: "session_meta",
    timestamp: createdAt,
    ordinal: 0,
    payload: {
      id: options.id,
      session_id: options.id,
      timestamp: createdAt,
      cwd: options.cwd,
      source: options.source ?? "cli",
      thread_source: options.threadSource ?? "user",
    },
  };
  const records = options.records ?? [userText(`session ${options.id}`, activityAt, 1), assistantText("done", "final_answer", activityAt, 2)];
  const directory = join(fixture.sessions, "2026", "09", "12");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${options.id}.jsonl`);
  const text = [meta, ...records].map((record) => JSON.stringify(record)).join("\n") + "\n" + (options.trailing ?? "");
  await writeFile(path, text, "utf8");
  if (options.name !== undefined) {
    fixture.indexEntries.push({
      id: options.id,
      thread_name: options.name,
      updated_at: options.indexUpdatedAt ?? activityAt,
    });
  }
  return path;
}

async function writeIndex(fixture: Fixture): Promise<void> {
  await writeFile(
    join(fixture.codexHome, "session_index.jsonl"),
    fixture.indexEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8",
  );
}

function environment(fixture: Fixture): Record<string, string> {
  return { CODEX_HOME: fixture.codexHome, TZ: "Asia/Taipei" };
}

async function waitFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt++) {
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
    await Bun.sleep(5);
  }
  throw new Error(`Missing frame: ${text}`);
}

async function runTool(
  fixture: Fixture,
  env: Record<string, string | undefined>,
  options: { interactive?: boolean; rendererFactory?: RendererFactory } = {},
) {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const code = await run({
    cwd: fixture.cwd,
    env,
    interactive: options.interactive ?? true,
    stdout,
    stderr,
    rendererFactory: options.rendererFactory,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function expectedSession(fixture: Fixture, id = ids.selected): NamedSession {
  return {
    id,
    name: "Selected",
    cwd: fixture.cwd,
    path: join(fixture.sessions, "2026", "09", "12", `rollout-${id}.jsonl`),
    activityMs: 0,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function collectPtyStream(stream: ReadableStream<Uint8Array>, onChunk?: (text: string) => void): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      output += text;
      onChunk?.(text);
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

describe("utterlog picker and session reader integration", () => {
  test("keeps exact-cwd activity ordering and ignores unrelated sessions", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, { id: ids.newest, cwd: fixture.cwd, name: "Repeated name", activityAt: "2026-09-12T12:00:00.000Z", indexUpdatedAt: "2026-09-12T09:00:00.000Z" });
      await writeSession(fixture, { id: ids.other, cwd: fixture.cwd, name: "Different name", activityAt: "2026-09-12T11:00:00.000Z" });
      const oldestPath = await writeSession(fixture, { id: ids.oldest, cwd: fixture.cwd, name: "Repeated name", activityAt: "2026-09-12T10:00:00.000Z", indexUpdatedAt: "2026-09-12T14:00:00.000Z" });
      await writeSession(fixture, { id: ids.parent, cwd: fixture.root, name: "Parent session", activityAt: "2026-09-12T15:00:00.000Z" });
      await writeSession(fixture, { id: ids.unnamed, cwd: fixture.cwd, activityAt: "2026-09-12T18:00:00.000Z" });
      await writeSession(fixture, { id: ids.subagent, cwd: fixture.cwd, name: "Subagent session", source: { subagent: {} }, threadSource: "subagent", activityAt: "2026-09-12T19:00:00.000Z" });
      await writeSession(fixture, { id: ids.malformed, cwd: fixture.cwd, name: "Malformed human candidate", createdAt: "not-a-source-time", activityAt: "2026-09-12T18:00:00.000Z" });
      await writeIndex(fixture);
      const before = await readFile(oldestPath);
      const result = await discoverSessions(fixture.cwd, environment(fixture));
      expect(result.candidates.map((session) => session.id)).toEqual([ids.newest, ids.other, ids.oldest]);
      expect(result.unnamedCount).toBe(1);
      expect(result.warnings.join("\n")).toContain(ids.malformed);
      expect(await readFile(oldestPath)).toEqual(before);
    });
  });

  test("sorts a complete tail record and ignores an unfinished append", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, {
        id: ids.newest,
        cwd: fixture.cwd,
        name: "Newest",
        records: [
          userText("hello", "2026-09-12T10:00:00Z"),
          { type: "response_item", timestamp: "2026-09-12T15:00:00Z", payload: { type: "custom_tool_call_output", output: "x".repeat(96 * 1024) } },
        ],
        trailing: `{"timestamp":"2026-09-12T23:00:00Z","unfinished":"${"x".repeat(96 * 1024)}`,
      });
      await writeSession(fixture, { id: ids.oldest, cwd: fixture.cwd, name: "Older", activityAt: "2026-09-12T14:00:00Z", indexUpdatedAt: "2026-09-12T23:59:00Z" });
      await writeIndex(fixture);
      const result = await discoverSessions(fixture.cwd, environment(fixture));
      expect(result.candidates.map((session) => session.id)).toEqual([ids.newest, ids.oldest]);
      expect(result.candidates[0].activityMs).toBe(Date.parse("2026-09-12T15:00:00Z"));
      expect(result.warnings).toEqual([]);
    });
  });

  test("preserves faithful user and assistant extraction, order, repetition, and source times", async () => {
    await withFixture(async (fixture) => {
      const userBody = "Keep this literal: <agents_md.instructions> $()\n# User heading\n```sh\necho '[link](https://example.test)'\n```";
      const records: Array<Record<string, unknown>> = [
        sessionMessage({
          role: "user",
          kinds: ["agents_md.instructions", "user.text", "user.image", "user.text"],
          content: [
            { type: "input_text", text: "Injected harness text" },
            { type: "input_text", text: userBody },
            { type: "input_image", image_url: "data:image/png;base64,SECRET_IMAGE_PAYLOAD" },
            { type: "input_text", text: "\nAfter image" },
          ],
          timestamp: "2026-09-12T12:00:00.000Z",
          ordinal: 1,
        }),
        { type: "event_msg", timestamp: "2026-09-12T12:01:00.000Z", payload: { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "output_text", text: "MIRRORED ACTIVITY" }] } } },
        { type: "response_item", timestamp: "2026-09-12T12:02:00.000Z", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "PRIVATE REASONING" }] } },
        { type: "response_item", timestamp: "2026-09-12T12:02:30.000Z", payload: { type: "message", role: "assistant", phase: "analysis", content: [{ type: "output_text", text: "PRIVATE ANALYSIS" }] } },
        assistantText("Progress update — same text", "commentary", "2026-09-12T12:05:00.000Z", 7),
        assistantText("Progress update — same text", "commentary", "2026-09-12T12:06:00.000Z", 8),
        assistantText("final answer", "final_answer", "2026-09-12T12:07:00.000Z", 9),
        sessionMessage({ role: "assistant", phase: "commentary", kinds: ["unknown"], content: [{ type: "output_text", text: "No trustworthy source time" }], timestamp: "not-a-source-time", ordinal: 10 }),
        sessionMessage({ role: "user", kinds: ["shell.user_command"], content: [{ type: "input_text", text: "PRIVATE SHELL COMMAND" }], timestamp: "2026-09-12T12:08:00.000Z", ordinal: 11 }),
      ];
      const path = await writeSession(fixture, { id: ids.selected, cwd: fixture.cwd, name: "Selected", records });
      const parsed = parseTranscript(await readFile(path, "utf8"), expectedSession(fixture));

      expect(parsed.errors).toEqual([]);
      expect(parsed.messages).toHaveLength(5);
      expect(parsed.messages.map((entry) => entry.role)).toEqual(["user", "assistant", "assistant", "assistant", "assistant"]);
      expect(parsed.messages[0].body).toContain(userBody);
      expect(parsed.messages[0].body).toContain("After image");
      expect(parsed.messages[0].body).toContain("*[image omitted]*");
      expect(parsed.messages[1].body).toBe("Progress update — same text");
      expect(parsed.messages[2].body).toBe("Progress update — same text");
      expect(parsed.messages[3].body).toBe("final answer");
      expect(parsed.messages[4].timestampLabel).toBe("unknown time");
      expect(parsed.messages.map((entry) => entry.body).join("\n")).not.toContain("Injected harness text");
      expect(parsed.messages.map((entry) => entry.body).join("\n")).not.toContain("PRIVATE");
      expect(parsed.messages.map((entry) => entry.body).join("\n")).not.toContain("SECRET_IMAGE_PAYLOAD");
    });
  });

  test("reuses the terminal across reader and refreshed picker, preserving selection and filter", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, { id: ids.selected, cwd: fixture.cwd, name: "Can switch" });
      await writeIndex(fixture);
      const setup = await createTestRenderer({ width: 100, height: 12 });
      let creations = 0;
      const running = runTool(fixture, environment(fixture), { rendererFactory: async () => { creations++; return setup.renderer; } });
      try {
        await waitFrame(setup, "Sessions ·");
        setup.mockInput.pressKey("/");
        await setup.mockInput.typeText("SWITCH");
        setup.mockInput.pressEnter();
        await waitFrame(setup, "/SWITCH");
        setup.mockInput.pressEnter();
        await waitFrame(setup, "message 2");
        await writeSession(fixture, { id: ids.newest, cwd: fixture.cwd, name: "New switch", activityAt: "2026-09-12T22:00:00Z" });
        await writeIndex(fixture);
        setup.mockInput.pressKey("b");
        const frame = await waitFrame(setup, "2/2 sessions");
        expect(frame).toContain("New switch");
        expect(frame).toContain("/SWITCH");
        expect(frame).not.toContain("message 2");
        setup.mockInput.pressEnter();
        await waitFrame(setup, ids.selected);
        setup.mockInput.pressKey("/");
        await setup.mockInput.typeText("cancel");
        setup.mockInput.pressEscape();
        await Bun.sleep(30);
        const readerFrame = await waitFrame(setup, "message 2");
        expect(readerFrame).not.toContain("Sessions ·");
        setup.mockInput.pressEscape();
        await Bun.sleep(30);
        await waitFrame(setup, "2/2 sessions");
        setup.mockInput.pressKey("q");
        const result = await running;
        expect(result.code).toBe(0);
        expect(creations).toBe(1);
        expect(setup.renderer.isDestroyed).toBe(true);
      } finally {
        if (!setup.renderer.isDestroyed) setup.renderer.destroy();
        await running;
      }
    });
  });

  test("reports no sessions, renderer failures and noninteractive use", async () => {
    await withFixture(async (fixture) => {
      await writeIndex(fixture);
      const empty = await runTool(fixture, environment(fixture));
      expect(empty.code).toBe(0);
      expect(empty.stdout).toContain("No named Codex sessions");
      await writeSession(fixture, { id: ids.selected, cwd: fixture.cwd, name: "Failure cases" });
      await writeIndex(fixture);
      const failing = await runTool(fixture, environment(fixture), { rendererFactory: async () => { throw new Error("synthetic renderer failure"); } });
      expect(failing.code).toBe(1);
      expect(failing.stderr).toContain("synthetic renderer failure");
      const noninteractive = await runTool(fixture, environment(fixture), { interactive: false });
      expect(noninteractive.code).toBe(1);
      expect(noninteractive.stderr).toMatch(/interactive terminal/i);
    });
  });

  test("keeps valid records around a partial tail and rejects corrupt complete records", async () => {
    await withFixture(async (fixture) => {
      const selected = expectedSession(fixture);
      const partial = [
        JSON.stringify({ type: "session_meta", timestamp: "2026-09-12T08:00:00Z", payload: { id: ids.selected, session_id: ids.selected, timestamp: "2026-09-12T08:00:00Z", cwd: fixture.cwd, source: "cli", thread_source: "user" } }),
        JSON.stringify(userText("before partial", "2026-09-12T12:00:00Z", 1)),
        JSON.stringify(assistantText("still readable", "final_answer", "2026-09-12T12:01:00Z", 2)),
        '{"type":"response_item","payload":{"type":"message"}',
      ].join("\n");
      const parsedPartial = parseTranscript(partial, selected);
      expect(parsedPartial.errors).toEqual([]);
      expect(parsedPartial.messages.map((entry) => entry.body)).toEqual(["before partial", "still readable"]);
      expect(parsedPartial.warnings).toHaveLength(1);

      const parsedCorrupt = parseTranscript(`${partial}\nnot-json\n`, selected);
      expect(parsedCorrupt.errors.some((error) => /invalid JSON/.test(error))).toBe(true);
    });
  });

  test("opens and exits through a real terminal fixture", async () => {
    await withFixture(async (fixture) => {
      const smokeText = "terminal smoke: native OpenTUI reader";
      await writeSession(fixture, {
        id: ids.selected,
        cwd: fixture.cwd,
        name: "Terminal smoke",
        records: [userText("open the reader"), assistantText(smokeText)],
      });
      await writeIndex(fixture);

      const cliPath = join(import.meta.dir, "cli.ts");
      const command = `${shellQuote(process.execPath)} ${shellQuote(cliPath)}`;
      const child = Bun.spawn({
        cmd: ["script", "-qefc", command, "/dev/null"],
        cwd: fixture.cwd,
        env: {
          HOME: fixture.root,
          XDG_CONFIG_HOME: join(fixture.root, "config"),
          XDG_CACHE_HOME: join(fixture.root, "cache"),
          CODEX_HOME: fixture.codexHome,
          PATH: "/run/current-system/sw/bin",
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: "C.UTF-8",
          TZ: "Asia/Taipei",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });

      let ptyOutput = "";
      let sentQuit = false;
      let sentOpen = false;
      const stdoutPromise = collectPtyStream(child.stdout, (chunk) => {
        ptyOutput += chunk;
        if (!sentOpen && ptyOutput.includes("Enter open")) { sentOpen = true; child.stdin.write("\r"); }
        if (!sentQuit && ptyOutput.includes(smokeText)) {
          sentQuit = true;
          child.stdin.write("q");
        }
      });
      const stderrPromise = collectPtyStream(child.stderr);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const status = await new Promise<number>((resolve, reject) => {
          timer = setTimeout(() => {
            child.kill();
            reject(new Error("real terminal fixture did not exit within 5 seconds"));
          }, 5000);
          child.exited.then(resolve, reject);
        });
        const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        expect(status).toBe(0);
        expect(stdout).toContain(smokeText);
        expect(stderr).toBe("");
        expect(sentQuit).toBe(true);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (!sentQuit) child.kill();
        await child.exited.catch(() => {});
      }
    });
  });
});
