import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Selection, Summary } from "@experiments/codex-tps";
import type { OutputSpeed } from "../src/contracts";

type Entry = {
  at: number;
  summary: Summary | null;
  status: OutputSpeed["status"];
};
export class OutputSpeedService {
  private readonly cache = new Map<string, Entry>();
  private child?: ChildProcessWithoutNullStreams;
  private task?: {
    key: string;
    entry: Entry;
    timer: ReturnType<typeof setTimeout>;
  };
  private idle?: ReturnType<typeof setTimeout>;
  private disposed = false;
  // Diagnostic numbers only; never projected to browser snapshots or the API.
  readonly diagnostics = {
    starts: 0,
    tasks: 0,
    pid: 0,
    lastMetrics: null as null | {
      files: number;
      bytes: number;
      reused: number;
      elapsedMs: number;
    },
  };
  constructor(
    private readonly options: {
      root?: string;
      command?: string[];
      timeoutMs?: number;
      ttlMs?: number;
    } = {},
  ) {}
  read(selection: Selection, refresh = false): OutputSpeed {
    const key = JSON.stringify(selection);
    let entry = this.cache.get(key);
    if (!entry) {
      entry = { at: 0, summary: null, status: "loading" };
      this.cache.set(key, entry);
      while (this.cache.size > 16) {
        const old = [...this.cache.keys()].find(
          (k) => k !== this.task?.key && k !== key,
        );
        if (!old) break;
        this.cache.delete(old);
      }
    }
    if (
      !this.disposed &&
      !this.task &&
      (refresh || Date.now() - entry.at >= (this.options.ttlMs ?? 60000))
    )
      this.start(key, entry, selection);
    const waiting =
      this.task &&
      (entry.at === 0 ||
        refresh ||
        Date.now() - entry.at >= (this.options.ttlMs ?? 60000));
    return {
      ...selection,
      summary: entry.summary,
      status: this.disposed
        ? "unavailable"
        : waiting
          ? "loading"
          : entry.status,
    };
  }
  private start(key: string, entry: Entry, selection: Selection) {
    entry.status = "loading";
    const timer = setTimeout(
      () => this.fail(),
      this.options.timeoutMs ?? 20000,
    );
    this.task = { key, entry, timer };
    this.diagnostics.tasks++;
    clearTimeout(this.idle);
    try {
      if (!this.child) {
        const command = this.options.command ?? [
          process.execPath,
          "--smol",
          fileURLToPath(new URL("./tps-child.ts", import.meta.url)),
          this.options.root ??
            process.env.CODEX_HOME ??
            join(homedir(), ".codex"),
        ];
        const child = spawn(command[0], command.slice(1), {
          stdio: ["pipe", "pipe", "pipe"],
          env: { PATH: process.env.PATH },
          cwd: import.meta.dir,
        });
        this.child = child;
        this.diagnostics.starts++;
        this.diagnostics.pid = child.pid ?? 0;
        child.stderr.resume();
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          if (this.child !== child || !this.task) return;
          if (line.length > 4096) {
            this.fail();
            return;
          }
          try {
            const result = JSON.parse(line);
            if (result.error || !validSummary(result.summary)) {
              this.fail();
              return;
            }
            const task = this.task;
            clearTimeout(task.timer);
            const numeric = (w: Summary["hour"]) => ({
              tps: w.tps,
              samples: w.samples,
            });
            task.entry.summary = {
              hour: numeric(result.summary.hour),
              fourHours: numeric(result.summary.fourHours),
              week: numeric(result.summary.week),
            };
            task.entry.status = "ready";
            task.entry.at = Date.now();
            this.diagnostics.lastMetrics = result.metrics;
            this.task = undefined;
            // No scanner survives indefinitely after Usage is closed.
            this.idle = setTimeout(() => this.release(), 90000);
            this.idle.unref();
          } catch {
            this.fail();
          }
        });
        child.once("error", () => {
          if (this.child === child) this.fail();
        });
        child.once("exit", () => {
          if (this.child === child) this.fail();
          lines.close();
        });
        child.stdin.on("error", () => {
          if (this.child === child) this.fail();
        });
      }
      this.child.stdin.write(
        JSON.stringify({ ...selection, now: Date.now() }) + "\n",
      );
    } catch {
      this.fail();
    }
  }
  private fail() {
    if (this.task) {
      clearTimeout(this.task.timer);
      this.task.entry.at = Date.now();
      this.task.entry.status = "unavailable";
      this.task = undefined;
    }
    this.release();
  }
  private release() {
    clearTimeout(this.idle);
    const child = this.child;
    this.child = undefined;
    this.diagnostics.pid = 0;
    if (!child) return;
    child.stdin.destroy();
    child.kill("SIGKILL"); // Only the direct process we created, never a process group.
  }
  dispose() {
    this.disposed = true;
    this.fail();
    this.cache.clear();
  }
}
function validSummary(value: any): value is Summary {
  return (
    value &&
    ["hour", "fourHours", "week"].every((key) => {
      const w = value[key];
      return (
        w &&
        Number.isSafeInteger(w.samples) &&
        w.samples >= 0 &&
        (w.tps === null ||
          (typeof w.tps === "number" && Number.isFinite(w.tps) && w.tps > 0))
      );
    })
  );
}
