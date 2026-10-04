import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);
export type BranchReader = (
  path: string,
  signal: AbortSignal,
) => Promise<string | null>;

// Read local metadata only. Errors retain the previous value; only Git's
// explicit non-repository result clears it. No shell or browser-supplied path.
export const readDirectoryBranch: BranchReader = async (path, signal) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: "C",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
  ])
    delete env[key];
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", path, ...args], {
        signal,
        timeout: 1500,
        killSignal: "SIGKILL",
        maxBuffer: 65536,
        env,
      })
    ).stdout.trim();
  try {
    // symbolic-ref also works before the first commit.
    return (await git("symbolic-ref", "--quiet", "HEAD")).replace(
      /^refs\/heads\//,
      "",
    );
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (
      failure.code === 128 &&
      /^fatal: not a git repository \(or any of the parent directories\): \.git\s*$/.test(
        failure.stderr ?? "",
      )
    )
      return null;
    if (failure.code !== 1) throw error;
    return "@" + (await git("rev-parse", "--short", "HEAD"));
  }
};

type Directory = {
  path: string;
  value?: string | null;
  controller?: AbortController;
};
function key(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export class DirectoryBranches {
  private directories = new Map<string, Directory>();
  private keys = new Map<string, string>();
  private queue: Directory[] = [];
  private running = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly changed: () => void,
    private readonly options: {
      read?: BranchReader;
      intervalMs?: number;
    } = {},
  ) {}
  value(path: string) {
    return (
      this.directories.get(this.keys.get(path) ?? path)?.value ?? undefined
    );
  }
  shares(left: string, right: string) {
    return this.keys.has(left) && this.keys.get(left) === this.keys.get(right);
  }
  update(paths: string[]) {
    if (this.disposed) return;
    const nextKeys = new Map(
      paths.map((path) => [path, this.keys.get(path) ?? key(path)]),
    );
    this.keys = nextKeys;
    const wanted = new Set(nextKeys.values());
    for (const [path, entry] of this.directories)
      if (!wanted.has(path)) {
        this.directories.delete(path);
        entry.controller?.abort();
      }
    for (const path of wanted)
      if (!this.directories.has(path)) {
        const entry = { path };
        this.directories.set(path, entry);
        this.queue.push(entry);
      }
    if (!wanted.size && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.queue.length && !this.running) void this.poll();
  }
  private async poll() {
    if (this.disposed || this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.running = true;
    const worker = async () => {
      for (;;) {
        const entry = this.queue.shift();
        if (!entry || this.disposed) return;
        if (this.directories.get(entry.path) !== entry) continue;
        entry.controller = new AbortController();
        try {
          const value = await (this.options.read ?? readDirectoryBranch)(
            entry.path,
            entry.controller.signal,
          );
          if (
            !this.disposed &&
            this.directories.get(entry.path) === entry &&
            value !== entry.value
          ) {
            const previous = entry.value;
            entry.value = value;
            if ((value ?? undefined) !== (previous ?? undefined))
              this.changed();
          }
        } catch {
          /* Preserve last successful value, independently of Peer health. */
        } finally {
          entry.controller = undefined;
        }
      }
    };
    await Promise.all([worker(), worker()]);
    this.running = false;
    if (!this.disposed && this.directories.size)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.queue.push(...this.directories.values());
        void this.poll();
      }, this.options.intervalMs ?? 5000);
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const entry of this.directories.values()) entry.controller?.abort();
    this.directories.clear();
    this.keys.clear();
    this.queue = [];
  }
}
