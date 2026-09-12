import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { run } from "./cli";

const ids = {
  newest: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  oldest: "33333333-3333-4333-8333-333333333333",
  selected: "44444444-4444-4444-8444-444444444444",
  parent: "55555555-5555-4555-8555-555555555555",
  child: "66666666-6666-4666-8666-666666666666",
  sibling: "77777777-7777-4777-8777-777777777777",
  unnamed: "88888888-8888-4888-8888-888888888888",
  subagent: "99999999-9999-4999-8999-999999999999",
  malformed: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

type Fixture = {
  root: string;
  codexHome: string;
  sessions: string;
  cwd: string;
  bin: string;
  emptyBin: string;
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
    bin: join(root, "bin"),
    emptyBin: join(root, "empty-bin"),
    indexEntries: [],
  };
  await mkdir(fixture.sessions, { recursive: true });
  await mkdir(fixture.cwd, { recursive: true });
  await mkdir(fixture.bin, { recursive: true });
  await mkdir(fixture.emptyBin, { recursive: true });

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

function userText(text: string, timestamp?: string, ordinal?: number): Record<string, unknown> {
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
  phase: "commentary" | "final_answer",
  timestamp?: string,
  ordinal?: number,
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
  const records = [
    meta,
    ...(options.records ?? [
      userText(`session ${options.id}`, activityAt, 1),
      assistantText("done", "final_answer", activityAt, 2),
    ]),
  ];
  const directory = join(fixture.sessions, "2026", "09", "12");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${options.id}.jsonl`);
  const text = records.map((record) => JSON.stringify(record)).join("\n") + "\n" + (options.trailing ?? "");
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

async function installFzf(fixture: Fixture): Promise<void> {
  const path = join(fixture.bin, "fzf");
  const script = [
    "#!/bin/sh",
    "printf '%s\\n' \"$@\" > \"$UTTERLOG_FZF_ARGS\"",
    "printf '%s\\n' \"$FZF_DEFAULT_OPTS\" \"$FZF_DEFAULT_OPTS_FILE\" \"$FZF_DEFAULT_COMMAND\" > \"$UTTERLOG_FZF_ENV\"",
    "input=$(cat)",
    "printf '%s' \"$input\" > \"$UTTERLOG_FZF_INPUT\"",
    "if [ \"${UTTERLOG_FZF_STATUS:-0}\" -ne 0 ]; then",
    "  echo \"synthetic fzf failure\" >&2",
    "  exit \"$UTTERLOG_FZF_STATUS\"",
    "fi",
    "if [ -n \"${UTTERLOG_FZF_TOKEN:-}\" ]; then",
    "  printf '%s\\n' \"$UTTERLOG_FZF_TOKEN\"",
    "else",
    "  printf '%s\\n' \"$input\" | awk -F '\\t' 'NF >= 3 { print $3; exit }'",
    "fi",
  ].join("\n") + "\n";
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
}

async function installEditor(fixture: Fixture): Promise<string> {
  const path = join(fixture.bin, "fake editor");
  const script = [
    "#!/bin/sh",
    "snapshot=\"\"",
    "for argument in \"$@\"; do snapshot=\"$argument\"; done",
    "printf '%s\\n' \"$@\" > \"$UTTERLOG_EDITOR_ARGS\"",
    "cp \"$snapshot\" \"$UTTERLOG_EDITOR_CAPTURE\"",
    "stat -c '%a' \"$snapshot\" > \"$UTTERLOG_EDITOR_MODE\"",
    "sleep 0.05",
    "exit \"${UTTERLOG_EDITOR_STATUS:-0}\"",
  ].join("\n") + "\n";
  await writeFile(path, script, "utf8");
  await chmod(path, 0o755);
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function environment(fixture: Fixture, editorPath: string, overrides: Record<string, string> = {}) {
  return {
    CODEX_HOME: fixture.codexHome,
    EDITOR: `${shellQuote(editorPath)} --wait-flag "argument with spaces"`,
    PATH: `${fixture.bin}:/run/current-system/sw/bin`,
    TZ: "Asia/Taipei",
    FZF_DEFAULT_COMMAND: "ambient-command",
    FZF_DEFAULT_OPTS: "--sort",
    FZF_DEFAULT_OPTS_FILE: "ambient-options-file",
    UTTERLOG_FZF_ARGS: join(fixture.root, "fzf-args"),
    UTTERLOG_FZF_ENV: join(fixture.root, "fzf-env"),
    UTTERLOG_FZF_INPUT: join(fixture.root, "fzf-input"),
    UTTERLOG_EDITOR_ARGS: join(fixture.root, "editor-args"),
    UTTERLOG_EDITOR_CAPTURE: join(fixture.root, "editor-capture.md"),
    UTTERLOG_EDITOR_MODE: join(fixture.root, "editor-mode"),
    ...overrides,
  };
}

async function runTool(
  fixture: Fixture,
  env: Record<string, string | undefined>,
  options: { interactive?: boolean } = {},
) {
  const stdout = captureOutput();
  const stderr = captureOutput();
  const code = await run({
    cwd: fixture.cwd,
    env,
    interactive: options.interactive ?? true,
    stdout,
    stderr,
    tempRoot: fixture.root,
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

async function fileIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

describe("utterlog CLI", () => {
  test("orders by log activity, scopes cwd, and returns fzf's stable identity", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, {
        id: ids.newest,
        cwd: fixture.cwd,
        name: "Repeated name",
        activityAt: "2026-09-12T12:00:00.000Z",
        indexUpdatedAt: "2026-09-12T09:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.other,
        cwd: fixture.cwd,
        name: "Different name",
        activityAt: "2026-09-12T11:00:00.000Z",
        indexUpdatedAt: "2026-09-12T11:00:00.000Z",
      });
      const oldestPath = await writeSession(fixture, {
        id: ids.oldest,
        cwd: fixture.cwd,
        name: "Repeated name",
        activityAt: "2026-09-12T10:00:00.000Z",
        indexUpdatedAt: "2026-09-12T14:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.parent,
        cwd: fixture.root,
        name: "Parent session",
        activityAt: "2026-09-12T15:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.child,
        cwd: join(fixture.cwd, "child"),
        name: "Child session",
        activityAt: "2026-09-12T16:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.sibling,
        cwd: join(fixture.root, "sibling"),
        name: "Sibling session",
        activityAt: "2026-09-12T17:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.unnamed,
        cwd: fixture.cwd,
        activityAt: "2026-09-12T18:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.subagent,
        cwd: fixture.cwd,
        name: "Subagent session",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: ids.newest,
              depth: 1,
              agent_path: null,
              agent_nickname: "worker",
              agent_role: null,
            },
          },
        },
        threadSource: "subagent",
        activityAt: "2026-09-12T19:00:00.000Z",
      });
      await writeSession(fixture, {
        id: ids.malformed,
        cwd: fixture.cwd,
        name: "Malformed human candidate",
        createdAt: "not-a-source-time",
        activityAt: "2026-09-12T18:00:00.000Z",
      });
      // Historical logs outside the requested directory are not candidates.
      const unrelated = join(fixture.sessions, "unrelated-old.jsonl");
      await writeFile(unrelated, JSON.stringify({
        type: "session_meta", payload: { id: "old-session", cwd: fixture.root, source: "cli" },
      }) + "\n");
      await writeIndex(fixture);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);
      const before = await readFile(oldestPath);
      const result = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_TOKEN: ids.oldest.slice(0, 8) }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("1 unnamed");
      expect(result.stdout).not.toContain("Parent session");
      expect(result.stdout).not.toContain("Subagent session");
      expect(result.stderr).not.toContain("unrelated-old.jsonl");
      expect(result.stderr).not.toContain(ids.subagent);
      expect(result.stderr).toContain(ids.malformed);
      expect(await readFile(oldestPath)).toEqual(before);

      const rows = (await readFile(join(fixture.root, "fzf-input"), "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain("Repeated name\t2026-09-12 12:00:00Z\t11111111");
      expect(rows[1]).toContain("Different name\t2026-09-12 11:00:00Z\t22222222");
      expect(rows[2]).toContain("Repeated name\t2026-09-12 10:00:00Z\t33333333");

      const args = (await readFile(join(fixture.root, "fzf-args"), "utf8")).split("\n").filter(Boolean);
      expect(args).toContain("--no-sort");
      expect(args).toContain("--nth=1");
      expect(args).toContain("--accept-nth=3");
      expect(args).toContain("--delimiter=\t");
      expect((await readFile(join(fixture.root, "fzf-env"), "utf8"))).toBe("\n\n\n");
      expect(await fileIfExists(join(fixture.root, "editor-capture.md"))).toContain("session 33333333");
    });
  });

  test("sorts by a complete tail record across read blocks and ignores a partial append", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, {
        id: ids.newest, cwd: fixture.cwd, name: "Newest", records: [
          userText("hello", "2026-09-12T10:00:00Z"),
          { type: "response_item", timestamp: "2026-09-12T15:00:00Z",
            payload: { type: "custom_tool_call_output", output: "x".repeat(96 * 1024) } },
        ],
        trailing: '{"timestamp":"2026-09-12T23:00:00Z","unfinished":"' + "x".repeat(96 * 1024),
      });
      await writeSession(fixture, {
        id: ids.oldest, cwd: fixture.cwd, name: "Older", activityAt: "2026-09-12T14:00:00Z",
        indexUpdatedAt: "2026-09-12T23:59:00Z",
      });
      await writeIndex(fixture);
      await installFzf(fixture);
      const editor = await installEditor(fixture);
      const result = await runTool(fixture, environment(fixture, editor, { UTTERLOG_FZF_STATUS: "130" }));
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      const rows = (await readFile(join(fixture.root, "fzf-input"), "utf8")).split("\n");
      expect(rows[0]).toStartWith("Newest\t2026-09-12 15:00:00Z");
      expect(rows[1]).toStartWith("Older\t2026-09-12 14:00:00Z");
    });
  });

  test("renders faithful user and assistant messages without mirrored activity", async () => {
    await withFixture(async (fixture) => {
      const userBody =
        "Keep this literal: <agents_md.instructions> $()\n# User heading\n```sh\necho '[link](https://example.test)'\n```";
      const longBody = `long-${"x".repeat(5000)}-end`;
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
          ordinal: 1,
        }),
        {
          type: "event_msg",
          timestamp: "2026-09-12T12:01:00.000Z",
          ordinal: 2,
          payload: {
            type: "item_completed",
            item: { type: "AgentMessage", content: [{ type: "output_text", text: "MIRRORED ACTIVITY" }] },
          },
        },
        {
          type: "response_item",
          timestamp: "2026-09-12T12:02:00.000Z",
          ordinal: 3,
          payload: { type: "reasoning", summary: [{ type: "summary_text", text: "PRIVATE REASONING" }] },
        },
        {
          type: "response_item",
          timestamp: "2026-09-12T12:02:30.000Z",
          ordinal: 4,
          payload: {
            type: "message",
            role: "assistant",
            phase: "analysis",
            content: [{ type: "output_text", text: "PRIVATE ANALYSIS" }],
          },
        },
        {
          type: "response_item",
          timestamp: "2026-09-12T12:03:00.000Z",
          ordinal: 5,
          payload: { type: "custom_tool_call_output", output: "PRIVATE TOOL OUTPUT" },
        },
        {
          type: "response_item",
          timestamp: "2026-09-12T12:04:00.000Z",
          ordinal: 6,
          payload: {
            type: "agent_message",
            content: [{ type: "output_text", text: "PRIVATE AGENT MESSAGE" }],
          },
        },
        assistantText("Progress update — same text", "commentary", "2026-09-12T12:05:00.000Z", 7),
        assistantText("Progress update — same text", "commentary", "2026-09-12T12:06:00.000Z", 8),
        assistantText(longBody, "final_answer", "2026-09-12T12:07:00.000Z", 9),
        sessionMessage({
          role: "assistant",
          phase: "commentary",
          kinds: ["unknown"],
          content: [{ type: "output_text", text: "No trustworthy source time" }],
          timestamp: "not-a-source-time",
          ordinal: 10,
        }),
        sessionMessage({
          role: "user",
          kinds: ["shell.user_command"],
          content: [{ type: "input_text", text: "PRIVATE SHELL COMMAND" }],
          timestamp: "2026-09-12T12:08:00.000Z",
          ordinal: 11,
        }),
      ];
      await writeSession(fixture, {
        id: ids.selected,
        cwd: fixture.cwd,
        name: "Faithful session",
        activityAt: "2026-09-12T12:07:00.000Z",
        records,
      });
      await writeIndex(fixture);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);
      const result = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_TOKEN: ids.selected.slice(0, 8) }),
      );
      const transcript = await readFile(join(fixture.root, "editor-capture.md"), "utf8");

      expect(result.code).toBe(0);
      expect(transcript).toContain("Session name: `Faithful session`");
      expect(transcript).toContain("Message times: local time (Asia/Taipei)");
      expect(transcript).toContain("## User · 2026-09-12 20:00 · message 1");
      expect(transcript).toContain("## Assistant · 2026-09-12 20:05 · message 2");
      expect(transcript).toContain("## Assistant · 2026-09-12 20:06 · message 3");
      expect(transcript).toContain("## Assistant · 2026-09-12 20:07 · message 4");
      expect(transcript).toContain("## Assistant · unknown time · message 5");
      expect(transcript).toContain(userBody);
      expect(transcript).toContain("After image");
      expect(transcript).toContain("*[image omitted]*");
      expect(transcript).toContain(longBody);
      expect(transcript).not.toContain("Injected harness text");
      expect(transcript).not.toContain("MIRRORED ACTIVITY");
      expect(transcript).not.toContain("PRIVATE REASONING");
      expect(transcript).not.toContain("PRIVATE ANALYSIS");
      expect(transcript).not.toContain("PRIVATE TOOL OUTPUT");
      expect(transcript).not.toContain("PRIVATE AGENT MESSAGE");
      expect(transcript).not.toContain("PRIVATE SHELL COMMAND");
      expect(transcript).not.toContain("SECRET_IMAGE_PAYLOAD");
      expect(transcript).toContain("No trustworthy source time");
      expect(transcript.split("Progress update — same text")).toHaveLength(3);
      expect(transcript.indexOf(userBody)).toBeLessThan(transcript.indexOf("Progress update — same text"));
      expect(transcript.indexOf(longBody)).toBeGreaterThan(transcript.lastIndexOf("Progress update — same text"));

      const editorArgs = (await readFile(join(fixture.root, "editor-args"), "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(editorArgs[0]).toBe("--wait-flag");
      expect(editorArgs[1]).toBe("argument with spaces");
      const snapshotPath = editorArgs.at(-1) as string;
      expect(snapshotPath).not.toBe(join(fixture.root, "editor-capture.md"));
      expect(await fileIfExists(snapshotPath)).toBeUndefined();
      expect(await stat(join(fixture.root, "editor-capture.md"))).toBeTruthy();
      expect(await readFile(join(fixture.root, "editor-mode"), "utf8")).toBe("400\n");
    });
  });

  test("cancels cleanly and explains a cwd with no named sessions", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, {
        id: ids.selected,
        cwd: fixture.cwd,
        name: "Can cancel",
      });
      await writeSession(fixture, {
        id: ids.parent,
        cwd: fixture.root,
        name: "Not in this cwd",
      });
      await writeIndex(fixture);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);
      const result = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_STATUS: "130" }),
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Selection cancelled");
      expect(await fileIfExists(join(fixture.root, "editor-capture.md"))).toBeUndefined();

      const noMatch = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_STATUS: "1" }),
      );
      expect(noMatch.code).toBe(0);
      expect(noMatch.stdout).toContain("No session matched");
      expect(await fileIfExists(join(fixture.root, "editor-capture.md"))).toBeUndefined();

      const noCwdSessions = await runTool(
        { ...fixture, cwd: join(fixture.root, "missing") },
        environment(fixture, editorPath),
      );
      expect(noCwdSessions.code).toBe(0);
      expect(noCwdSessions.stdout).toContain("No named Codex sessions found");
      expect(noCwdSessions.stdout).toContain("missing");
    });
  });

  test("reports missing or failing fzf and a failing editor", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, { id: ids.selected, cwd: fixture.cwd, name: "Failure cases" });
      await writeIndex(fixture);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);

      const missingFzf = await runTool(
        fixture,
        { ...environment(fixture, editorPath), PATH: fixture.emptyBin },
      );
      expect(missingFzf.code).toBe(1);
      expect(missingFzf.stderr).toMatch(/fzf/i);

      const failingFzf = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_STATUS: "2" }),
      );
      expect(failingFzf.code).toBe(1);
      expect(failingFzf.stderr).toContain("synthetic fzf failure");

      const failingEditor = await runTool(
        fixture,
        environment(fixture, editorPath, {
          UTTERLOG_FZF_TOKEN: ids.selected.slice(0, 8),
          UTTERLOG_EDITOR_STATUS: "7",
        }),
      );
      expect(failingEditor.code).toBe(1);
      expect(failingEditor.stderr).toContain("status 7");
      const editorArgs = (await readFile(join(fixture.root, "editor-args"), "utf8"))
        .split("\n")
        .filter(Boolean);
      expect(await fileIfExists(editorArgs.at(-1) as string)).toBeUndefined();
    });
  });

  test("keeps preceding records when the selected log ends with an incomplete record", async () => {
    await withFixture(async (fixture) => {
      const sourcePath = await writeSession(fixture, {
        id: ids.selected,
        cwd: fixture.cwd,
        name: "Partial log",
        records: [
          userText("before partial", "2026-09-12T12:00:00.000Z", 1),
          assistantText("still readable", "final_answer", "2026-09-12T12:01:00.000Z", 2),
        ],
        trailing: '{"type":"response_item","payload":{"type":"message"}',
      });
      await writeIndex(fixture);
      const before = await readFile(sourcePath);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);
      const result = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_TOKEN: ids.selected.slice(0, 8) }),
      );
      const transcript = await readFile(join(fixture.root, "editor-capture.md"), "utf8");

      expect(result.code).toBe(0);
      expect(transcript).toContain("before partial");
      expect(transcript).toContain("still readable");
      expect(transcript).not.toContain('"type":"response_item"');
      expect(await readFile(sourcePath)).toEqual(before);
    });
  });

  test("reports corrupt complete records and provenance alignment failures", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, {
        id: ids.selected,
        cwd: fixture.cwd,
        name: "Corrupt log",
        records: [userText("valid first", "2026-09-12T12:00:00.000Z", 1)],
        trailing: "not-json\n",
      });
      await writeIndex(fixture);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);
      const corrupt = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_TOKEN: ids.selected.slice(0, 8) }),
      );
      expect(corrupt.code).toBe(1);
      expect(corrupt.stderr).toMatch(/line \d+.*invalid JSON/i);
      expect(await fileIfExists(join(fixture.root, "editor-capture.md"))).toBeUndefined();

      const alignedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      await writeSession(fixture, {
        id: alignedId,
        cwd: fixture.cwd,
        name: "Misaligned log",
        records: [
          sessionMessage({
            role: "user",
            kinds: ["user.text"],
            content: [
              { type: "input_text", text: "one" },
              { type: "input_text", text: "two" },
            ],
          }),
        ],
      });
      await writeIndex(fixture);
      const alignment = await runTool(
        fixture,
        environment(fixture, editorPath, { UTTERLOG_FZF_TOKEN: alignedId.slice(0, 8) }),
      );
      expect(alignment.code).toBe(1);
      expect(alignment.stderr).toMatch(/content_item_kinds.*content parts/i);
      expect(await fileIfExists(join(fixture.root, "editor-capture.md"))).toBeUndefined();
    });
  });

  test("rejects noninteractive invocation before starting the picker", async () => {
    await withFixture(async (fixture) => {
      await writeSession(fixture, { id: ids.selected, cwd: fixture.cwd, name: "Interactive only" });
      await writeIndex(fixture);
      await installFzf(fixture);
      const editorPath = await installEditor(fixture);
      const result = await runTool(fixture, environment(fixture, editorPath), { interactive: false });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/interactive terminal/i);
      expect(await fileIfExists(join(fixture.root, "fzf-input"))).toBeUndefined();
    });
  });
});
