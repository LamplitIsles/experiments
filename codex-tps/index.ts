import { open, opendir, lstat, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, sep } from "node:path";

export type Tier = "fast" | "standard";
export function tier(value: unknown): Tier | null {
  return value === "priority" || value === "fast"
    ? "fast"
    : value === "default"
      ? "standard"
      : null;
}
export type Selection = { model: string; tier: Tier };
export type Window = { tps: number | null; samples: number };
export type Summary = { hour: Window; fourHours: Window; week: Window };
type Sample = Selection & {
  id: string;
  completedAt: number;
  seconds: number;
  output: number;
};
const LIMIT = {
  files: 10000,
  entries: 20000,
  samples: 100000,
  bytes: 512 * 1024 * 1024,
  line: 1024 * 1024,
  cache: 256,
};
type Row = { timestamp?: unknown; type?: string; payload?: any };
const label = (value: unknown): string =>
  typeof value === "string" && value.length <= 200 ? value : "";

// A rollout has no upstream request-start timestamp. Its effective response
// window begins at the latest input boundary and ends at the last generated
// item, as in the documented codex-tps rule. Never use turn duration.
export class ResponseParser {
  readonly samples: Sample[] = [];
  private session = "";
  private turn = "";
  private model = "";
  private speed: Tier | null = null;
  private start: number | null = null;
  private end: number | null = null;
  private input: number | null = null;
  private total = 0;
  private seen = new Set<string>();
  private active = false;
  private acceptSettings = false;
  invalidate() {
    this.active = false;
    this.start = this.end = this.input = null;
  }
  private inputBoundary(at: number) {
    this.input = at;
    if (this.end === null) this.start = at;
  }
  push(row: Row) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      this.invalidate();
      return;
    }
    const at =
      typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    const p = row.payload;
    if (!Number.isFinite(at) || !p || typeof p !== "object") {
      this.invalidate();
      return;
    }
    if (row.type === "session_meta") {
      this.session = label(p.session_id ?? p.id);
    } else if (row.type === "turn_context") {
      this.model = label(p.model);
      this.turn = label(p.turn_id);
      // Do not carry a prior turn's tier past a missing settings snapshot.
      this.speed = tier(p.service_tier);
      this.acceptSettings = true;
      if (this.end === null) this.start = at;
    } else if (row.type === "event_msg") {
      if (p.type === "task_started") {
        this.active = true;
        this.start = at;
        this.end = null;
        this.input = at;
        this.model = "";
        this.speed = null;
        this.turn = label(p.turn_id);
        this.acceptSettings = false;
      } else if (p.type === "thread_settings_applied") {
        if (
          !this.acceptSettings ||
          (p.thread_id && p.thread_id !== this.session)
        )
          return;
        this.model = label(p.thread_settings?.model);
        this.speed = tier(p.thread_settings?.service_tier);
        this.acceptSettings = false;
      } else if (p.type === "user_message") this.inputBoundary(at);
      else if (p.type === "token_count") {
        const total = p.info?.total_token_usage?.output_tokens;
        if (Number.isSafeInteger(total) && total > this.total) {
          this.emit(
            `${this.session}:${this.turn}:total:${total}`,
            p.info?.last_token_usage?.output_tokens,
            at,
          );
          this.total = total;
        }
      } else if (p.type === "task_complete" || p.type === "turn_aborted") {
        this.active = false;
        this.start = this.end = this.input = null;
      } else if (p.type === "item_completed" && p.item?.type === "UserMessage")
        this.inputBoundary(at);
    } else if (row.type === "response_item") {
      if (
        (p.type === "message" && p.role === "assistant") ||
        p.type === "reasoning" ||
        [
          "function_call",
          "custom_tool_call",
          "local_shell_call",
          "web_search_call",
          "tool_search_call",
          "image_generation_call",
        ].includes(p.type)
      ) {
        if (this.active) this.end = at;
      } else if (
        [
          "function_call_output",
          "custom_tool_call_output",
          "tool_search_output",
        ].includes(p.type) ||
        (p.type === "message" &&
          ["user", "developer", "system"].includes(p.role))
      )
        this.inputBoundary(at);
    } else if (row.type === "token_usage_record") {
      if (
        p.thread_id !== this.session ||
        p.turn_id !== this.turn ||
        !label(p.response_id)
      )
        return;
      const id = `${this.session}:${p.response_id}`;
      if (this.seen.has(id)) return;
      const total = p.thread_token_usage?.output_tokens;
      if (!Number.isSafeInteger(total) || total < 0) return;
      this.emit(id, p.usage?.output_tokens, at);
      this.total = total;
      this.seen.add(id);
      if (this.seen.size > LIMIT.samples)
        throw new Error("Sample budget exceeded");
    }
  }
  private emit(id: string, output: unknown, recordedAt: number) {
    if (
      this.active &&
      this.session &&
      this.turn &&
      this.model &&
      this.speed &&
      this.start !== null &&
      this.end !== null &&
      this.end > this.start &&
      Number.isSafeInteger(output) &&
      (output as number) > 0
    ) {
      this.samples.push({
        id,
        model: this.model,
        tier: this.speed,
        completedAt: this.end,
        seconds: (this.end - this.start) / 1000,
        output: output as number,
      });
      if (this.samples.length > LIMIT.samples)
        throw new Error("Sample budget exceeded");
    }
    // Tool output may have arrived before deferred token_count. Preserve its
    // boundary, not the token_count timestamp after that output.
    this.start =
      this.input !== null && this.end !== null && this.input > this.end
        ? this.input
        : recordedAt;
    this.end = null;
  }
}

export function summarize(
  samples: readonly Sample[],
  selection: Selection,
  now: number,
): Summary {
  const one = (ms: number): Window => {
    let output = 0,
      seconds = 0,
      count = 0;
    const seen = new Set<string>();
    for (const s of samples) {
      if (
        s.model !== selection.model ||
        s.tier !== selection.tier ||
        s.completedAt < now - ms ||
        s.completedAt > now ||
        seen.has(s.id)
      )
        continue;
      seen.add(s.id);
      output += s.output;
      seconds += s.seconds;
      count++;
    }
    return { tps: seconds > 0 ? output / seconds : null, samples: count };
  };
  return { hour: one(3600000), fourHours: one(14400000), week: one(604800000) };
}

type Cached = { stamp: string; samples: Sample[] };
export class LogAnalyzer {
  private cache = new Map<string, Cached>();
  async analyze(root: string, selection: Selection, now = Date.now()) {
    root = await realpath(root);
    const started = performance.now();
    const metrics = { files: 0, bytes: 0, reused: 0, elapsedMs: 0 };
    const samples: Sample[] = [];
    const live = new Set<string>();
    let entries = 0;
    const visit = async (directory: string): Promise<void> => {
      let dir;
      try {
        dir = await opendir(directory);
      } catch (error: any) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for await (const entry of dir) {
        if (++entries > LIMIT.entries)
          throw new Error("Directory budget exceeded");
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (!(await realpath(path)).startsWith(root + sep)) continue;
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          if (++metrics.files > LIMIT.files)
            throw new Error("File budget exceeded");
          const stat = await lstat(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          live.add(path);
          let parsed = this.cache.get(path);
          if (parsed?.stamp === stamp) metrics.reused++;
          else {
            const parser = new ResponseParser();
            // O_NOFOLLOW closes the final-component lstat/open symlink race.
            const file = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
              const opened = await file.stat();
              if (
                !opened.isFile() ||
                opened.ino !== stat.ino ||
                opened.dev !== stat.dev
              )
                throw new Error("Log changed during open");
              const buffer = Buffer.allocUnsafe(65536);
              let pending = Buffer.alloc(0),
                skip = false,
                offset = 0;
              // Snapshot size excludes unbounded appends; trailing partial JSON
              // is deferred until a subsequent changed-file scan.
              while (offset < stat.size) {
                const { bytesRead } = await file.read(
                  buffer,
                  0,
                  Math.min(buffer.length, stat.size - offset),
                  offset,
                );
                if (!bytesRead) break;
                metrics.bytes += bytesRead;
                offset += bytesRead;
                if (metrics.bytes > LIMIT.bytes)
                  throw new Error("Read budget exceeded");
                const chunk = buffer.subarray(0, bytesRead);
                let from = 0;
                for (let i = 0; i < chunk.length; i++)
                  if (chunk[i] === 10) {
                    const line = chunk.subarray(from, i);
                    if (!skip && pending.length + line.length <= LIMIT.line) {
                      try {
                        parser.push(
                          JSON.parse(
                            Buffer.concat([pending, line]).toString("utf8"),
                          ),
                        );
                      } catch (error) {
                        if (!(error instanceof SyntaxError)) throw error;
                        parser.invalidate();
                      }
                    } else parser.invalidate();
                    pending = Buffer.alloc(0);
                    skip = false;
                    from = i + 1;
                  }
                if (!skip) {
                  const rest = chunk.subarray(from);
                  if (pending.length + rest.length > LIMIT.line) {
                    pending = Buffer.alloc(0);
                    skip = true;
                  } else pending = Buffer.concat([pending, rest]);
                }
                await Bun.sleep(1);
              }
              const after = await file.stat();
              parsed = {
                stamp:
                  after.size === stat.size && after.mtimeMs === stat.mtimeMs
                    ? stamp
                    : "changed",
                samples: parser.samples,
              };
            } finally {
              await file.close();
            }
            this.cache.delete(path);
            this.cache.set(path, parsed);
            while (this.cache.size > LIMIT.cache)
              this.cache.delete(this.cache.keys().next().value!);
            let retained = 0;
            for (const [cachedPath, value] of [...this.cache].reverse()) {
              retained += value.samples.length;
              if (retained > LIMIT.samples) this.cache.delete(cachedPath);
            }
          }
          for (const sample of parsed.samples) {
            samples.push(sample);
            if (samples.length > LIMIT.samples)
              throw new Error("Sample budget exceeded");
          }
        }
      }
    };
    // Only trusted host-provided roots. Neither tree follows symlink entries.
    for (const name of ["sessions", "archived_sessions"]) {
      const path = join(root, name);
      try {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      } catch (error: any) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      await visit(path);
    }
    let cachedSamples = 0;
    for (const [path, value] of [...this.cache].reverse()) {
      cachedSamples += value.samples.length;
      if (
        !live.has(path) ||
        this.cache.size > LIMIT.cache ||
        cachedSamples > LIMIT.samples
      )
        this.cache.delete(path);
    }
    metrics.elapsedMs = performance.now() - started;
    return { summary: summarize(samples, selection, now), metrics };
  }
}
