#!/usr/bin/env bun

import { chmod, mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type Environment = Record<string, string | undefined>;

type Output = {
  write(chunk: string): unknown;
};

export type RunOptions = {
  argv?: string[];
  cwd?: string;
  env?: Environment;
  interactive?: boolean;
  stdout?: Output;
  stderr?: Output;
  tempRoot?: string;
};

type JsonObject = Record<string, unknown>;

type SessionMeta = {
  id: string;
  cwd: string;
  source: string;
  threadSource: string;
  timestampMs: number;
};

type NamedSession = {
  id: string;
  name: string;
  cwd: string;
  path: string;
  activityMs: number;
};

type DiscoveryResult = {
  candidates: NamedSession[];
  unnamedCount: number;
  warnings: string[];
};

type TranscriptMessage = {
  role: "user" | "assistant";
  phase?: string;
  timestampLabel: string;
  body: string;
};

type ParsedTranscript = {
  messages: TranscriptMessage[];
  errors: string[];
  warnings: string[];
};

class CliError extends Error {}

const FZF_COMMAND = "fzf";
const TOP_LEVEL_SOURCES = new Set(["cli", "exec"]);
const USER_FACING_ASSISTANT_PHASES = new Set(["commentary", "final_answer"]);
const NON_USER_FACING_ASSISTANT_PHASES = new Set(["analysis", "reasoning"]);
const IGNORED_PROVENANCE = new Set([
  "agents_md.instructions",
  "collaboration_mode.instructions",
  "compaction.auto_fallback_prompt",
  "environments.environment_context",
  "generic.developer_instructions",
  "generic.turn_aborted",
  "goal.internal_context",
  "hooks.additional_context",
  "host_skills.instructions",
  "model_switch.instructions",
  "multi_agent.mode_instructions",
  "multi_agent.subagent_notification",
  "multi_agent.usage_hint",
  "permissions.instructions",
  "plugins.usage_instructions",
  "shell.user_command",
  "skills.selected_skill_instructions",
  "token_budget.context_window",
  "token_budget.context_window_guidance",
  "token_budget.reminder",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function normalizedCwd(value: string): string {
  const result = resolve(value);
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function concreteEnvironment(environment: Environment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function print(output: Output, message: string): void {
  output.write(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTimestamp(timestampMs: number): string {
  return new Date(timestampMs).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
}

function messageTimestamp(value: unknown): string {
  if (!validTimestamp(value)) return "unknown time";
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}`;
}

function shortIdentity(id: string, length: number): string {
  return id.slice(0, length);
}

function pickerName(name: string): string {
  return name.replace(/[\t\r\n]/g, " ");
}

function metadataValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").replaceAll("`", "\\`");
}

function parseJsonLine(line: string): unknown {
  return JSON.parse(line);
}

async function firstLine(path: string): Promise<string> {
  const file = await open(path, "r");
  const chunks: Buffer[] = [];
  let position = 0;

  try {
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        return Buffer.concat(chunks).toString("utf8");
      }
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(Buffer.from(chunk));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
}

function parseSessionMeta(value: unknown, location: string): SessionMeta {
  if (!isObject(value) || value.type !== "session_meta" || !isObject(value.payload)) {
    throw new CliError(`${location}: missing current-schema session_meta payload`);
  }
  const payload = value.payload;
  if (!nonEmptyString(payload.id) || !nonEmptyString(payload.session_id) || payload.id !== payload.session_id) {
    throw new CliError(`${location}: session_meta id and session_id do not agree`);
  }
  if (!validTimestamp(payload.timestamp)) {
    throw new CliError(`${location}: session_meta timestamp is missing or invalid`);
  }
  if (!nonEmptyString(payload.cwd) || !isAbsolute(payload.cwd)) {
    throw new CliError(`${location}: session_meta cwd is not an absolute path`);
  }
  if (!nonEmptyString(payload.source) || !nonEmptyString(payload.thread_source)) {
    throw new CliError(`${location}: session_meta source fields are missing or invalid`);
  }
  return {
    id: payload.id,
    cwd: normalizedCwd(payload.cwd),
    source: payload.source,
    threadSource: payload.thread_source,
    timestampMs: Date.parse(payload.timestamp),
  };
}

function isSpawnedSessionMeta(value: unknown): boolean {
  if (!isObject(value) || value.type !== "session_meta" || !isObject(value.payload)) return false;
  const source = value.payload.source;
  return value.payload.thread_source === "subagent" && isObject(source) && "subagent" in source;
}

type NameEntry = {
  name: string;
  updatedAtMs: number;
};

async function readSessionNames(codexHome: string): Promise<{ names: Map<string, NameEntry>; warnings: string[] }> {
  const indexPath = join(codexHome, "session_index.jsonl");
  let text: string;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    throw new CliError(`cannot read Codex session index at ${indexPath}: ${errorMessage(error)}`);
  }

  const names = new Map<string, NameEntry>();
  const warnings: string[] = [];
  const lines = text.split("\n");
  const hasTrailingNewline = text.endsWith("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) continue;
    const lineNumber = index + 1;
    const isUnfinishedTrailingLine = index === lines.length - 1 && !hasTrailingNewline;
    let value: unknown;
    try {
      value = parseJsonLine(line);
    } catch {
      if (!isUnfinishedTrailingLine) {
        warnings.push(`session index line ${lineNumber} is invalid JSON`);
      }
      continue;
    }
    if (!isObject(value)) {
      warnings.push(`session index line ${lineNumber} is not an object`);
      continue;
    }
    if (!nonEmptyString(value.id) || !nonEmptyString(value.thread_name) || !validTimestamp(value.updated_at)) {
      warnings.push(`session index line ${lineNumber} has no valid id, thread_name, and updated_at`);
      continue;
    }
    const entry: NameEntry = {
      name: value.thread_name,
      updatedAtMs: Date.parse(value.updated_at),
    };
    const previous = names.get(value.id);
    if (!previous || entry.updatedAtMs > previous.updatedAtMs || entry.updatedAtMs === previous.updatedAtMs) {
      names.set(value.id, entry);
    }
  }
  return { names, warnings };
}

async function sessionFiles(sessionsRoot: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new CliError(`cannot read Codex sessions at ${directory}: ${errorMessage(error)}`);
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }
  await visit(sessionsRoot);
  return files.sort();
}

function trailingLineIsUnfinished(lines: string[], index: number, hasTrailingNewline: boolean): boolean {
  return index === lines.length - 1 && !hasTrailingNewline;
}

async function logActivity(path: string, meta: SessionMeta): Promise<number> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    let length = Math.min(size, 64 * 1024);
    while (length > 0) {
      const buffer = Buffer.allocUnsafe(length);
      const start = size - length;
      const { bytesRead } = await file.read(buffer, 0, length, start);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      // The first fragment may start inside a JSON record or UTF-8 character.
      const lines = (start === 0 ? text : text.slice(text.indexOf("\n") + 1)).split("\n");
      if (start === 0 || text.includes("\n")) {
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          try {
            const value = parseJsonLine(lines[index]);
            if (isObject(value) && validTimestamp(value.timestamp)) return Date.parse(value.timestamp);
          } catch {
            // A running writer can leave an incomplete last record.
          }
        }
      }
      if (start === 0) break;
      length = Math.min(size, length * 2);
    }
    return meta.timestampMs;
  } finally {
    await file.close();
  }
}

async function discoverSessions(cwd: string, environment: Environment): Promise<DiscoveryResult> {
  const configuredCodexHome = environment.CODEX_HOME?.trim();
  const codexHome = normalizedCwd(configuredCodexHome || join(homedir(), ".codex"));
  const sessionsRoot = join(codexHome, "sessions");
  const { names, warnings } = await readSessionNames(codexHome);
  const files = await sessionFiles(sessionsRoot);
  const unnamedIds = new Set<string>();
  const candidatesById = new Map<string, NamedSession>();

  async function inspectSession(path: string): Promise<void> {
    let meta: SessionMeta;
    try {
      const line = await firstLine(path);
      if (line.length === 0) {
        warnings.push(`ignored empty session log ${path}`);
        return;
      }
      const value = parseJsonLine(line);
      // Scope first: unrelated history is not an input to this invocation.
      if (isObject(value) && value.type === "session_meta" && isObject(value.payload)
        && nonEmptyString(value.payload.cwd) && normalizedCwd(value.payload.cwd) !== cwd) return;
      if (isSpawnedSessionMeta(value)) return;
      meta = parseSessionMeta(value, path);
    } catch (error) {
      warnings.push(`ignored session log ${path}: ${errorMessage(error)}`);
      return;
    }
    if (!TOP_LEVEL_SOURCES.has(meta.source) || meta.threadSource !== "user") return;
    if (meta.cwd !== cwd) return;

    const name = names.get(meta.id);
    if (!name || name.name.trim().length === 0) {
      unnamedIds.add(meta.id);
      return;
    }

    let activityMs: number;
    try {
      activityMs = await logActivity(path, meta);
    } catch (error) {
      warnings.push(`ignored unreadable session log ${path}: ${errorMessage(error)}`);
      return;
    }
    const candidate: NamedSession = {
      id: meta.id,
      name: name.name,
      cwd: meta.cwd,
      path,
      activityMs,
    };
    const previous = candidatesById.get(candidate.id);
    if (!previous || candidate.activityMs > previous.activityMs || (candidate.activityMs === previous.activityMs && candidate.path > previous.path)) {
      candidatesById.set(candidate.id, candidate);
    }
  }

  // Bound open files while overlapping header reads across the local history.
  for (let offset = 0; offset < files.length; offset += 16) {
    await Promise.all(files.slice(offset, offset + 16).map(inspectSession));
  }

  const candidates = [...candidatesById.values()].sort(
    (left, right) => right.activityMs - left.activityMs || left.id.localeCompare(right.id),
  );
  return { candidates, unnamedCount: unnamedIds.size, warnings };
}

function identityTokenLength(candidates: NamedSession[]): number {
  const minimum = Math.min(8, ...candidates.map((candidate) => candidate.id.length));
  const maximum = Math.max(...candidates.map((candidate) => candidate.id.length));
  for (let length = minimum; length <= maximum; length += 1) {
    const tokens = candidates.map((candidate) => shortIdentity(candidate.id, length));
    if (new Set(tokens).size === tokens.length) return length;
  }
  throw new CliError("session identities are not unique");
}

function pickerRows(candidates: NamedSession[]): Map<string, NamedSession> {
  const length = identityTokenLength(candidates);
  const rows = new Map<string, NamedSession>();
  for (const candidate of candidates) {
    rows.set(shortIdentity(candidate.id, length), candidate);
  }
  return rows;
}

async function pickSession(candidates: NamedSession[], cwd: string, environment: Environment): Promise<NamedSession | null | undefined> {
  const rowsByToken = pickerRows(candidates);
  const rows = [...rowsByToken.entries()].map(([token, candidate]) => {
    return `${pickerName(candidate.name)}\t${formatTimestamp(candidate.activityMs)}\t${token}`;
  });
  const pickerEnvironment = concreteEnvironment({
    ...environment,
    FZF_DEFAULT_COMMAND: "",
    FZF_DEFAULT_OPTS: "",
    FZF_DEFAULT_OPTS_FILE: "",
  });
  let processHandle: Bun.PipedSubprocess;
  try {
    processHandle = Bun.spawn({
      cmd: [FZF_COMMAND, "--no-sort", "--delimiter=\t", "--nth=1", "--accept-nth=3"],
      cwd,
      env: pickerEnvironment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    processHandle.stdin.write(`${rows.join("\n")}\n`);
    processHandle.stdin.end();
  } catch (error) {
    throw new CliError(`cannot start fzf: ${errorMessage(error)}`);
  }

  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  const [status, output, errorOutput] = await Promise.all([
    processHandle.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  if (status === 1) return null;
  if (status === 130) return undefined;
  if (status !== 0) {
    const detail = errorOutput.trim();
    throw new CliError(`fzf failed with status ${status}${detail ? `: ${detail}` : ""}`);
  }

  const selectedLines = output.split(/\r?\n/).filter((line) => line.length > 0);
  if (selectedLines.length !== 1) {
    throw new CliError("fzf returned no session selection");
  }
  const token = selectedLines[0].trim();
  const selected = rowsByToken.get(token);
  if (!selected) throw new CliError("fzf returned an unknown session identity");
  return selected;
}

export function parseEditorCommand(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let hasToken = false;

  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
      hasToken = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      hasToken = true;
    } else if (/\s/.test(character)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
    } else {
      current += character;
      hasToken = true;
    }
  }
  if (escaped) throw new CliError("EDITOR ends with an incomplete escape");
  if (quote) throw new CliError("EDITOR contains an unfinished quote");
  if (hasToken) args.push(current);
  if (args.length === 0 || args[0].length === 0) throw new CliError("EDITOR does not contain an executable");
  return args;
}

function lineParts(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  return { lines: text.split("\n"), hasTrailingNewline: text.endsWith("\n") };
}

function contentKinds(payload: JsonObject, lineNumber: number, errors: string[]): string[] | undefined {
  if (!Array.isArray(payload.content)) {
    errors.push(`line ${lineNumber}: message content is not an array`);
    return undefined;
  }
  const passthrough = payload.internal_chat_message_metadata_passthrough;
  if (!isObject(passthrough) || !Array.isArray(passthrough.content_item_kinds)) {
    errors.push(`line ${lineNumber}: message content_item_kinds are missing`);
    return undefined;
  }
  if (passthrough.content_item_kinds.length !== payload.content.length) {
    errors.push(`line ${lineNumber}: content_item_kinds do not align with content parts`);
    return undefined;
  }
  if (!passthrough.content_item_kinds.every((kind) => typeof kind === "string")) {
    errors.push(`line ${lineNumber}: content_item_kinds contain a non-string value`);
    return undefined;
  }
  return passthrough.content_item_kinds;
}

function userMessage(
  payload: JsonObject,
  kinds: string[],
  timestampLabel: string,
  lineNumber: number,
  errors: string[],
): TranscriptMessage | undefined {
  if (!Array.isArray(payload.content)) return undefined;
  const parts: string[] = [];
  for (let index = 0; index < payload.content.length; index += 1) {
    const kind = kinds[index];
    const part = payload.content[index];
    if (kind === "user.text") {
      if (!isObject(part) || part.type !== "input_text" || typeof part.text !== "string") {
        errors.push(`line ${lineNumber}: user.text content part is unsupported`);
      } else {
        parts.push(part.text);
      }
    } else if (kind === "user.image") {
      if (!isObject(part) || part.type !== "input_image") {
        errors.push(`line ${lineNumber}: user.image content part is unsupported`);
      } else {
        parts.push("\n*[image omitted]*\n");
      }
    } else if (!IGNORED_PROVENANCE.has(kind)) {
      errors.push(`line ${lineNumber}: unsupported user content provenance ${JSON.stringify(kind)}`);
    }
  }
  if (parts.length === 0) return undefined;
  return { role: "user", timestampLabel, body: parts.join("") };
}

function assistantMessage(
  payload: JsonObject,
  kinds: string[],
  timestampLabel: string,
  lineNumber: number,
  errors: string[],
): TranscriptMessage | undefined {
  if (typeof payload.phase !== "string") {
    errors.push(`line ${lineNumber}: assistant message phase is missing`);
    return undefined;
  }
  if (NON_USER_FACING_ASSISTANT_PHASES.has(payload.phase)) return undefined;
  if (!USER_FACING_ASSISTANT_PHASES.has(payload.phase)) {
    errors.push(`line ${lineNumber}: unsupported assistant message phase ${JSON.stringify(payload.phase)}`);
    return undefined;
  }
  if (!Array.isArray(payload.content)) return undefined;
  const parts: string[] = [];
  for (let index = 0; index < payload.content.length; index += 1) {
    const kind = kinds[index];
    const part = payload.content[index];
    if (kind !== "unknown" || !isObject(part) || part.type !== "output_text" || typeof part.text !== "string") {
      if (!IGNORED_PROVENANCE.has(kind)) {
        errors.push(`line ${lineNumber}: assistant content part is unsupported`);
      }
      continue;
    }
    parts.push(part.text);
  }
  if (parts.length === 0) return undefined;
  return { role: "assistant", phase: payload.phase, timestampLabel, body: parts.join("") };
}

function parseTranscript(text: string, expected: NamedSession): ParsedTranscript {
  const messages: TranscriptMessage[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const { lines, hasTrailingNewline } = lineParts(text);
  let metadataSeen = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.length === 0) continue;
    const lineNumber = index + 1;
    const unfinishedTrailingLine = trailingLineIsUnfinished(lines, index, hasTrailingNewline);
    let value: unknown;
    try {
      value = parseJsonLine(line);
    } catch {
      if (unfinishedTrailingLine) {
        warnings.push(`ignored incomplete trailing record at line ${lineNumber}`);
      } else {
        errors.push(`line ${lineNumber}: invalid JSON`);
      }
      continue;
    }
    if (!isObject(value)) {
      errors.push(`line ${lineNumber}: record is not an object`);
      continue;
    }

    if (value.type === "session_meta" && !metadataSeen) {
      metadataSeen = true;
      try {
        const meta = parseSessionMeta(value, expected.path);
        if (meta.id !== expected.id) errors.push(`line ${lineNumber}: selected session identity changed`);
        if (meta.cwd !== expected.cwd) errors.push(`line ${lineNumber}: selected session cwd changed`);
        if (!TOP_LEVEL_SOURCES.has(meta.source) || meta.threadSource !== "user") {
          errors.push(`line ${lineNumber}: selected session is not a top-level user session`);
        }
      } catch (error) {
        errors.push(`line ${lineNumber}: ${errorMessage(error)}`);
      }
      continue;
    }

    if (value.type !== "response_item" || !isObject(value.payload) || value.payload.type !== "message") continue;
    const payload = value.payload;
    if (payload.role === "developer" || payload.role === "system") continue;
    if (payload.role !== "user" && payload.role !== "assistant") {
      errors.push(`line ${lineNumber}: unsupported message role ${JSON.stringify(payload.role)}`);
      continue;
    }
    if (payload.role === "assistant") {
      if (typeof payload.phase === "string" && NON_USER_FACING_ASSISTANT_PHASES.has(payload.phase)) continue;
      if (typeof payload.phase !== "string" || !USER_FACING_ASSISTANT_PHASES.has(payload.phase)) {
        assistantMessage(payload, [], messageTimestamp(value.timestamp), lineNumber, errors);
        continue;
      }
    }
    const kinds = contentKinds(payload, lineNumber, errors);
    if (!kinds) continue;
    const message =
      payload.role === "user"
        ? userMessage(payload, kinds, messageTimestamp(value.timestamp), lineNumber, errors)
        : assistantMessage(payload, kinds, messageTimestamp(value.timestamp), lineNumber, errors);
    if (message) messages.push(message);
  }

  if (!metadataSeen) errors.push("selected log has no current-schema session_meta record");
  return { messages, errors, warnings };
}

function renderTranscript(session: NamedSession, messages: TranscriptMessage[]): string {
  let output = [
    "# Utterlog transcript",
    "",
    `- Session name: \`${metadataValue(session.name)}\``,
    `- Session ID: \`${metadataValue(session.id)}\``,
    `- Working directory: \`${metadataValue(session.cwd)}\``,
    `- Message times: local time (${localTimeZone()})`,
    "",
    "> Read-only snapshot captured when this session was selected.",
    "",
    "---",
    "",
    "",
  ].join("\n");

  messages.forEach((message, index) => {
    const ordinal = index + 1;
    const phase = message.phase ? `; phase=${message.phase}` : "";
    const role = message.role === "user" ? "User" : "Assistant";
    output += `<!-- utterlog: message ${ordinal}; role=${message.role}; time=${message.timestampLabel}${phase} -->\n`;
    output += `## ${role} · ${message.timestampLabel} · message ${ordinal}\n\n`;
    output += message.body;
    output += message.body.endsWith("\n") ? "" : "\n";
    output += "\n---\n\n";
  });
  return output;
}

function helpText(): string {
  return [
    "Usage: utterlog",
    "",
    "Select a named Codex session for the current directory with fzf, then open",
    "a read-only Markdown transcript in $EDITOR.",
    "",
    "The picker searches session names only. Sessions are ordered by the last",
    "complete timestamp in their local session log. fzf and $EDITOR are required.",
  ].join("\n") + "\n";
}

function parseArguments(argv: string[]): { help: boolean } {
  if (argv.length === 0) return { help: false };
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  throw new CliError(`unknown argument${argv.length === 1 ? `: ${argv[0]}` : "s"}; try --help`);
}

async function openSnapshot(
  transcript: string,
  cwd: string,
  environment: Environment,
  tempRoot: string,
): Promise<void> {
  const editorSpec = environment.EDITOR;
  if (!editorSpec || editorSpec.trim().length === 0) throw new CliError("EDITOR is required");
  const editor = parseEditorCommand(editorSpec);
  const temporaryDirectory = await mkdtemp(join(tempRoot, "utterlog-"));
  const snapshotPath = join(temporaryDirectory, "transcript.md");
  try {
    await chmod(temporaryDirectory, 0o700);
    await writeFile(snapshotPath, transcript, { encoding: "utf8", mode: 0o600 });
    await chmod(snapshotPath, 0o400);
    let processHandle: Bun.Subprocess;
    try {
      processHandle = Bun.spawn({
        cmd: [...editor, snapshotPath],
        cwd,
        env: concreteEnvironment(environment),
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      throw new CliError(`cannot start editor: ${errorMessage(error)}`);
    }
    const status = await processHandle.exited;
    if (status !== 0) throw new CliError(`editor exited with status ${status}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function run(options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment: Environment = options.env ?? process.env;
  try {
    const { help } = parseArguments(options.argv ?? process.argv.slice(2));
    if (help) {
      print(stdout, helpText());
      return 0;
    }
    const interactive = options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
    if (!interactive) throw new CliError("an interactive terminal is required to choose a session with fzf");

    const cwd = normalizedCwd(options.cwd ?? process.cwd());
    const discovery = await discoverSessions(cwd, environment);
    for (const warning of discovery.warnings) print(stderr, `utterlog: warning: ${warning}\n`);
    if (discovery.candidates.length === 0) {
      print(stdout, `No named Codex sessions found for ${cwd}.\n`);
      if (discovery.unnamedCount > 0) {
        print(stdout, `${discovery.unnamedCount} unnamed session log${discovery.unnamedCount === 1 ? "" : "s"} omitted.\n`);
      }
      return 0;
    }
    print(stdout, `Select a named Codex session for ${cwd} (newest activity first).\n`);
    if (discovery.unnamedCount > 0) {
      print(stdout, `${discovery.unnamedCount} unnamed session log${discovery.unnamedCount === 1 ? "" : "s"} omitted.\n`);
    }
    const selected = await pickSession(discovery.candidates, cwd, environment);
    if (selected === undefined) {
      print(stdout, "Selection cancelled.\n");
      return 0;
    }
    if (selected === null) {
      print(stdout, "No session matched the picker query.\n");
      return 0;
    }

    let logText: string;
    try {
      logText = await readFile(selected.path, "utf8");
    } catch (error) {
      throw new CliError(`cannot read selected session log: ${errorMessage(error)}`);
    }
    const parsed = parseTranscript(logText, selected);
    for (const warning of parsed.warnings) print(stderr, `utterlog: warning: ${warning}\n`);
    if (parsed.errors.length > 0) {
      throw new CliError(`selected session is unsupported or corrupt:\n${parsed.errors.map((error) => `  ${error}`).join("\n")}`);
    }
    if (parsed.messages.length === 0) throw new CliError("selected session has no user-facing transcript");
    const transcript = renderTranscript(selected, parsed.messages);
    await openSnapshot(transcript, cwd, environment, options.tempRoot ?? tmpdir());
    return 0;
  } catch (error) {
    print(stderr, `utterlog: ${errorMessage(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await run();
}
