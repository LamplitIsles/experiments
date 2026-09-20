/** Adapted narrowly from FlickLog's JSONL session metadata scanner. */
import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { NamedSession } from "./types";
const normal = (v: string) =>
  process.platform === "win32" ? resolve(v).toLowerCase() : resolve(v);
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
async function prefix(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const b = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(b, 0, b.length, 0);
    return b.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
  } finally {
    await file.close();
  }
}
export async function discoverSessions(
  cwd: string,
  home = process.env.CODEX_HOME ?? join(homedir(), ".codex"),
): Promise<NamedSession[]> {
  const out: NamedSession[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.name.endsWith(".jsonl"))
        try {
          const x = JSON.parse(await prefix(path)) as {
            type?: string;
            payload?: {
              id?: string;
              cwd?: string;
              timestamp?: unknown;
              thread_name?: string;
            };
          };
          const p = x.payload;
          if (
            x.type === "session_meta" &&
            p?.id &&
            p.cwd &&
            normal(p.cwd) === normal(cwd)
          )
            out.push({
              id: p.id,
              name: p.thread_name ?? "Untitled session",
              cwd: p.cwd,
              path,
              activityMs: epoch(p.timestamp) ?? 0,
            });
        } catch {}
    }
  };
  await walk(join(home, "sessions"));
  return out.sort((a, b) => b.activityMs - a.activityMs);
}
