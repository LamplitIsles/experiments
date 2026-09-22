/** Read Codex's indexed metadata, never scan rollout bodies for the picker. */
import { Database } from "bun:sqlite";
import { open, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NamedSession } from "./types";
import { noTrace, type Trace } from "./tracing";
export function epoch(v: unknown): number | undefined {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string" && /^\d+(\.\d+)?$/.test(v)
        ? Number(v)
        : Date.parse(String(v));
  if (!Number.isFinite(n)) return undefined;
  const ms = n < 1e10 ? n * 1000 : n > 1e16 ? n / 1e6 : n > 1e13 ? n / 1e3 : n;
  return Number.isFinite(new Date(ms).valueOf()) ? ms : undefined;
}
export async function discoverSessions(
  cwd: string,
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  performance: Trace = noTrace,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NamedSession[]> {
  let config: Record<string, unknown> = {};
  try {
    config = Bun.TOML.parse(
      await readFile(join(home, "config.toml"), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const sqliteHome =
    typeof config.sqlite_home === "string"
      ? resolve(home, config.sqlite_home)
      : env.CODEX_SQLITE_HOME?.trim()
        ? resolve(cwd, env.CODEX_SQLITE_HOME.trim())
        : home;
  const databasePath = join(sqliteHome, "state_5.sqlite");
  try {
    await stat(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return performance.measure("discovery.sqlite_query", (span) => {
    const db = new Database(databasePath, { readonly: true });
    try {
      const sessions = db
        .query<NamedSession, [string]>(`
        SELECT id, COALESCE(NULLIF(name, ''), NULLIF(title, ''), 'Untitled session') AS name,
               cwd, rollout_path AS path, updated_at_ms AS activityMs
        FROM threads
        WHERE archived = 0 AND cwd = ?
          AND source IN ('cli', 'exec', 'vscode')
          AND (thread_source IS NULL OR thread_source = 'user')
        ORDER BY updated_at_ms DESC, id DESC
      `)
        .all(resolve(cwd));
      span.setAttribute("sessions", sessions.length);
      return sessions;
    } finally {
      db.close();
    }
  });
}

/** Reads one bounded suffix; rollout history stays authoritative and untouched. */
export async function latestTokenUsage(path: string): Promise<
  | {
      totalTokens: number;
      modelContextWindow: number;
    }
  | undefined
> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, "r");
    const size = (await file.stat()).size;
    const length = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (size > length) lines.shift(); // first record is a truncated suffix
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]);
        const payload =
          record?.type === "event_msg" ? record.payload : undefined;
        if (payload?.type !== "token_count") continue;
        // Native rollout observations put the context total under the last
        // per-turn usage, not the cumulative lifetime total_token_usage.
        const totalTokens = payload?.info?.last_token_usage?.total_tokens;
        const modelContextWindow = payload?.info?.model_context_window;
        if (
          Number.isFinite(totalTokens) &&
          totalTokens >= 0 &&
          Number.isFinite(modelContextWindow) &&
          modelContextWindow > 0
        )
          return { totalTokens, modelContextWindow };
      } catch {}
    }
  } catch {
    return undefined;
  } finally {
    await file?.close();
  }
  return undefined;
}
