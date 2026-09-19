import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;
type Json = Record<string, unknown>;
export type Message = {
  id: string;
  sourceId?: string;
  kind: "message" | "compaction";
  agent: "codex";
  deviceId: string;
  sessionId: string;
  sessionName?: string;
  cwd: string;
  role?: "user" | "assistant";
  phase?: "commentary" | "final_answer";
  content: string;
  createdAt?: string;
  sourcePath: string;
  sourceRecordIndex: number;
};
export type Checkpoint = {
  offset: number;
  nextRecordIndex: number;
  size: number;
  sessionId?: string;
  cwd?: string;
};
export type State = { sources: Record<string, Checkpoint> };
export type ContextItem = {
  sourceRecordIndex: number;
  kind: "message" | "compaction" | "tool";
  role?: "user" | "assistant";
  phase?: string;
  content: string;
  truncated?: boolean;
};

const USER_PHASES = new Set(["commentary", "final_answer"]);
const IGNORED = new Set([
  "agents_md.instructions",
  "collaboration_mode.instructions",
  "compaction.auto_fallback_prompt",
  "environments.environment_context",
  "generic.developer_instructions",
  "generic.turn_aborted",
  "goal.internal_context",
  "hooks.additional_context",
  "host_skills.instructions",
  "multi_agent.mode_instructions",
  "multi_agent.subagent_notification",
  "multi_agent.usage_hint",
  "permissions.instructions",
  "shell.user_command",
  "skills.selected_skill_instructions",
  "token_budget.context_window",
  "token_budget.context_window_guidance",
  "token_budget.reminder",
]);
export const normalizeCwd = (value: string) =>
  process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
const object = (x: unknown): x is Json =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const string = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0;
const validTime = (x: unknown): x is string =>
  string(x) && Number.isFinite(Date.parse(x));
export const messageId = (
  sourceId: unknown,
  deviceId: string,
  path: string,
  record: number,
) =>
  createHash("sha256")
    .update(
      string(sourceId)
        ? `${deviceId}\0${sourceId}`
        : `${deviceId}\0${path}\0${record}`,
    )
    .digest("hex");

export function statePath(env: Env): string {
  return join(
    env.FLICKLOG_STATE_DIR?.trim() || join(homedir(), ".flicklog"),
    "scan-state.json",
  );
}
export async function loadState(path: string): Promise<State> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return object(value) && object(value.sources)
      ? { sources: value.sources as Record<string, Checkpoint> }
      : { sources: {} };
  } catch {
    return { sources: {} };
  }
}
export async function saveState(path: string, value: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rename(temporary, path);
}

async function files(root: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && path.endsWith(".jsonl")) result.push(path);
    }
  }
  try {
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return result.sort();
}
async function names(home: string): Promise<Map<string, string>> {
  const result = new Map<string, { name: string; updated: number }>();
  try {
    for (const line of (
      await readFile(join(home, "session_index.jsonl"), "utf8")
    ).split("\n")) {
      try {
        const x: unknown = JSON.parse(line);
        if (
          object(x) &&
          string(x.id) &&
          string(x.thread_name) &&
          validTime(x.updated_at)
        ) {
          const next = {
            name: x.thread_name,
            updated: Date.parse(x.updated_at),
          };
          if (!result.get(x.id) || next.updated >= result.get(x.id)!.updated)
            result.set(x.id, next);
        }
      } catch {}
    }
  } catch {}
  return new Map([...result].map(([id, value]) => [id, value.name]));
}
type Meta = { id: string; cwd: string };
function meta(x: unknown): Meta | undefined {
  if (!object(x) || x.type !== "session_meta" || !object(x.payload)) return;
  const p = x.payload;
  if (
    !string(p.id) ||
    p.id !== p.session_id ||
    !validTime(p.timestamp) ||
    !string(p.cwd) ||
    !isAbsolute(p.cwd) ||
    !["cli", "exec"].includes(String(p.source)) ||
    p.thread_source !== "user"
  )
    return;
  return { id: p.id, cwd: normalizeCwd(p.cwd) };
}
function message(
  x: unknown,
  path: string,
  record: number,
  m: Meta,
  sessionName?: string,
): Message | undefined {
  if (!object(x)) return;
  const deviceId = hostname();
  if (x.type === "compacted" && object(x.payload)) {
    const content =
      typeof x.payload.message === "string" && x.payload.message.trim()
        ? x.payload.message
        : "";
    if (!content) return;
    return {
      id: messageId(undefined, deviceId, path, record),
      kind: "compaction",
      agent: "codex",
      deviceId,
      sessionId: m.id,
      ...(sessionName ? { sessionName } : {}),
      cwd: m.cwd,
      content,
      ...(validTime(x.timestamp) ? { createdAt: x.timestamp } : {}),
      sourcePath: path,
      sourceRecordIndex: record,
    };
  }
  if (
    x.type !== "response_item" ||
    !object(x.payload) ||
    x.payload.type !== "message"
  )
    return;
  const p = x.payload;
  if (
    (p.role !== "user" && p.role !== "assistant") ||
    !Array.isArray(p.content) ||
    !object(p.internal_chat_message_metadata_passthrough) ||
    !Array.isArray(
      p.internal_chat_message_metadata_passthrough.content_item_kinds,
    )
  )
    return;
  const kinds = p.internal_chat_message_metadata_passthrough.content_item_kinds;
  if (kinds.length !== p.content.length) return;
  let role: "user" | "assistant";
  let phase: "commentary" | "final_answer" | undefined;
  if (p.role === "assistant") {
    if (!USER_PHASES.has(String(p.phase))) return;
    role = "assistant";
    phase = p.phase as "commentary" | "final_answer";
  } else role = "user";
  const parts: string[] = [];
  for (let i = 0; i < p.content.length; i++) {
    const kind = kinds[i],
      part = p.content[i];
    if (
      kind === "user.text" &&
      role === "user" &&
      object(part) &&
      part.type === "input_text" &&
      typeof part.text === "string"
    )
      parts.push(part.text);
    else if (
      kind === "unknown" &&
      role === "assistant" &&
      object(part) &&
      part.type === "output_text" &&
      typeof part.text === "string"
    )
      parts.push(part.text);
    else if (kind === "user.image" && role === "user") continue;
    else if (typeof kind === "string" && !IGNORED.has(kind)) return;
  }
  if (!parts.length) return;
  return {
    id: messageId(p.id, deviceId, path, record),
    ...(string(p.id) ? { sourceId: p.id } : {}),
    kind: "message",
    agent: "codex",
    deviceId,
    sessionId: m.id,
    ...(sessionName ? { sessionName } : {}),
    cwd: m.cwd,
    role,
    ...(phase ? { phase } : {}),
    content: parts.join(""),
    ...(validTime(x.timestamp) ? { createdAt: x.timestamp } : {}),
    sourcePath: path,
    sourceRecordIndex: record,
  };
}

export async function scan(
  env: Env,
  publish: (items: Message[]) => Promise<void>,
): Promise<{ indexed: number; sources: number }> {
  const home = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const stateFile = statePath(env),
    state = await loadState(stateFile),
    sessionNames = await names(home);
  let indexed = 0,
    sources = 0;
  for (const path of await files(join(home, "sessions"))) {
    sources++;
    const info = await stat(path);
    let cp = state.sources[path];
    if (cp && info.size === cp.size) continue;
    if (!cp || info.size < cp.offset)
      cp = { offset: 0, nextRecordIndex: 0, size: 0 };
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      bytes = Buffer.alloc(info.size - cp.offset);
      await file.read(bytes, 0, bytes.length, cp.offset);
    } finally {
      await file.close();
    }
    const text = bytes.toString("utf8"),
      complete = text.lastIndexOf("\n");
    if (complete < 0) continue;
    const consumed = Buffer.byteLength(text.slice(0, complete + 1));
    const items: Message[] = [];
    let current: Meta | undefined =
      cp.sessionId && cp.cwd ? { id: cp.sessionId, cwd: cp.cwd } : undefined;
    let record = cp.nextRecordIndex;
    for (const line of text.slice(0, complete + 1).split("\n")) {
      if (!line) continue;
      try {
        const x: unknown = JSON.parse(line);
        const candidate = meta(x);
        if (candidate) current = candidate;
        else if (current) {
          const item = message(
            x,
            path,
            record,
            current,
            sessionNames.get(current.id),
          );
          if (item) items.push(item);
        }
      } catch {}
      record++;
    }
    if (items.length) await publish(items);
    state.sources[path] = {
      offset: cp.offset + consumed,
      nextRecordIndex: record,
      size: cp.offset + consumed,
      ...(current ? { sessionId: current.id, cwd: current.cwd } : {}),
    };
    indexed += items.length;
  }
  await saveState(stateFile, state);
  return { indexed, sources };
}

export function extractContext(
  text: string,
  target: number,
  includeTools: boolean,
  radius = 8,
  maxToolChars = 12000,
): ContextItem[] {
  const parsed = text
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line)
    .map(({ line, index }) => {
      try {
        return { x: JSON.parse(line) as unknown, index };
      } catch {
        return undefined;
      }
    })
    .filter((v): v is { x: unknown; index: number } => Boolean(v));
  const selected = parsed.filter((v) => Math.abs(v.index - target) <= radius);
  const output: ContextItem[] = [];
  for (const { x, index } of selected) {
    if (object(x) && x.type === "compacted") {
      const m = message(x, "context", index, {
        id: "context",
        cwd: "/context",
      });
      if (m)
        output.push({
          sourceRecordIndex: index,
          kind: "compaction",
          content: m.content,
        });
      continue;
    }
    if (
      object(x) &&
      x.type === "response_item" &&
      object(x.payload) &&
      x.payload.type === "message"
    ) {
      const p = x.payload;
      if (p.role === "assistant" && !USER_PHASES.has(String(p.phase))) continue;
      if (p.role !== "user" && p.role !== "assistant") continue;
      const m = message(x, "context", index, {
        id: "context",
        cwd: "/context",
      });
      if (m)
        output.push({
          sourceRecordIndex: index,
          kind: "message",
          role: m.role,
          ...(m.phase ? { phase: m.phase } : {}),
          content: m.content,
        });
      continue;
    }
    if (
      !includeTools ||
      !object(x) ||
      x.type !== "response_item" ||
      !object(x.payload)
    )
      continue;
    const p = x.payload;
    if (
      ![
        "function_call",
        "function_call_output",
        "custom_tool_call",
        "custom_tool_call_output",
      ].includes(String(p.type))
    )
      continue;
    let content = JSON.stringify(p);
    const truncated = content.length > maxToolChars;
    if (truncated) content = `${content.slice(0, maxToolChars)}…`;
    output.push({
      sourceRecordIndex: index,
      kind: "tool",
      content,
      ...(truncated ? { truncated: true } : {}),
    });
  }
  return output.sort((a, b) => a.sourceRecordIndex - b.sourceRecordIndex);
}

export type Meili = {
  configure(): Promise<void>;
  add(items: Message[]): Promise<void>;
  search(query: string, cwd: string, all: boolean): Promise<unknown>;
  get(id: string): Promise<Message | undefined>;
};
export function searchFilters(cwd: string, all: boolean): string[] {
  return [
    `deviceId = ${JSON.stringify(hostname())}`,
    ...(all ? [] : [`cwd = ${JSON.stringify(cwd)}`]),
  ];
}
async function task(base: string, key: string, uid: number): Promise<void> {
  for (let n = 0; n < 100; n++) {
    const r = await fetch(`${base}/tasks/${uid}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const v = (await r.json()) as {
      status: string;
      error?: { message: string };
    };
    if (v.status === "succeeded") return;
    if (v.status === "failed")
      throw new Error(v.error?.message || "Meilisearch task failed");
    await Bun.sleep(50);
  }
  throw new Error("timed out waiting for Meilisearch task");
}
export function meili(env: Env): Meili {
  const base = (
      env.FLICKLOG_MEILI_URL ||
      "http://127.0.0.1:" + (env.FLICKLOG_MEILI_PORT || "7701")
    ).replace(/\/$/, ""),
    key =
      env.FLICKLOG_MEILI_KEY ||
      (!env.FLICKLOG_MEILI_URL
        ? readFileSync(setupPaths(env).key, "utf8")
        : "");
  async function request(path: string, init: RequestInit = {}) {
    const r = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`Meilisearch ${r.status}: ${await r.text()}`);
    return r;
  }
  async function write(path: string, body: unknown) {
    const r = await request(path, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const v = (await r.json()) as { taskUid: number };
    await task(base, key, v.taskUid);
  }
  async function ensureIndex() {
    const r = await fetch(`${base}/indexes`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uid: "flicklog_messages", primaryKey: "id" }),
    });
    if (r.status === 409) return;
    if (!r.ok) throw new Error(`Meilisearch ${r.status}: ${await r.text()}`);
    await task(base, key, ((await r.json()) as { taskUid: number }).taskUid);
  }
  return {
    async configure() {
      await ensureIndex();
      await write("/indexes/flicklog_messages/settings", {
        searchableAttributes: ["content"],
        filterableAttributes: ["deviceId", "agent", "cwd", "sessionId", "role"],
        sortableAttributes: ["createdAt"],
      });
    },
    async add(items) {
      if (!items.length) return;
      const r = await request(
        "/indexes/flicklog_messages/documents?primaryKey=id",
        {
          method: "POST",
          body: JSON.stringify(items),
        },
      );
      await task(base, key, ((await r.json()) as { taskUid: number }).taskUid);
    },
    async search(query, cwd, all) {
      const r = await request("/indexes/flicklog_messages/search", {
        method: "POST",
        body: JSON.stringify({
          q: query,
          filter: searchFilters(cwd, all),
          sort: ["createdAt:desc"],
        }),
      });
      return r.json();
    },
    async get(id) {
      const r = await fetch(
        `${base}/indexes/flicklog_messages/documents/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${key}` } },
      );
      if (r.status === 404) return;
      if (!r.ok) throw new Error(`Meilisearch ${r.status}: ${await r.text()}`);
      return r.json() as Promise<Message>;
    },
  };
}

export type SetupPaths = {
  root: string;
  config: string;
  database: string;
  key: string;
  plist: string;
  port: number;
  binary?: string;
};
export function setupPaths(env: Env): SetupPaths {
  const root = env.FLICKLOG_STATE_DIR?.trim() || join(homedir(), ".flicklog");
  return {
    root,
    config: join(root, "meilisearch.toml"),
    database: join(root, "meilisearch-data"),
    key: join(root, "master-key"),
    plist: env.FLICKLOG_LAUNCH_AGENTS_DIR?.trim()
      ? join(env.FLICKLOG_LAUNCH_AGENTS_DIR, "dev.flicklog.meilisearch.plist")
      : join(
          homedir(),
          "Library",
          "LaunchAgents",
          "dev.flicklog.meilisearch.plist",
        ),
    port: Number(env.FLICKLOG_MEILI_PORT || 7701),
  };
}
export function configText(paths: SetupPaths, key: string) {
  return `db_path = ${JSON.stringify(paths.database)}\nhttp_addr = ${JSON.stringify(`127.0.0.1:${paths.port}`)}\nmaster_key = ${JSON.stringify(key)}\n`;
}
export function plistText(paths: SetupPaths, binary: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>dev.flicklog.meilisearch</string><key>ProgramArguments</key><array><string>${binary}</string><string>--config-file-path</string><string>${paths.config}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
}
export async function prepareSetup(
  env: Env,
  binary: string,
): Promise<SetupPaths> {
  const p = setupPaths(env);
  await mkdir(p.root, { recursive: true });
  await mkdir(dirname(p.plist), { recursive: true });
  let key: string;
  try {
    key = await readFile(p.key, "utf8");
  } catch {
    key = randomBytes(32).toString("hex");
    await writeFile(p.key, key, { mode: 0o600 });
  }
  await chmod(p.key, 0o600);
  await writeFile(p.config, configText(p, key), { mode: 0o600 });
  await writeFile(p.plist, plistText(p, binary));
  return { ...p, binary };
}
