import type {
  Runtime,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
} from "./runtime";
import type { Backend, HistoryPage, Model } from "../src/contracts";
import { piThread, threadIdentity } from "./backend";

/** Routes native identities, including cursors, before touching either backend. */
export class MixedRuntime implements Runtime {
  private readonly catalogues = new Map<Backend, Model[]>();
  constructor(
    private readonly codex: Runtime,
    private readonly pi: Runtime,
  ) {}
  private runtime(backend: Backend) {
    return backend === "pi" ? this.pi : this.codex;
  }
  async models(): Promise<Model[]> {
    const targets: Backend[] = ["codex", "pi"];
    const results = await Promise.allSettled(
      targets.map(async (b) => {
        const models = (await this.runtime(b).models()).map((m) => ({
          ...m,
          backend: b,
        }));
        this.catalogues.set(b, models);
        return models;
      }),
    );
    const available = targets.flatMap((b) => this.catalogues.get(b) ?? []);
    if (!available.length) {
      const failed = results.find((r) => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    return available;
  }
  weekly() {
    return this.codex.weekly();
  }
  skills(cwd: string, backend: Backend = "codex") {
    return this.runtime(backend).skills(cwd);
  }
  async history(cwd: string, cursor?: string): Promise<HistoryPage> {
    const state: Partial<Record<Backend, string | null>> = cursor
      ? JSON.parse(Buffer.from(cursor, "base64url").toString())
      : {};
    const results = await Promise.allSettled(
      (["codex", "pi"] as const).map(async (backend) => {
        if (state[backend] === null) return { sessions: [], nextCursor: null };
        const page = await this.runtime(backend).history(
          cwd,
          state[backend] ?? undefined,
        );
        state[backend] = page.nextCursor;
        return {
          sessions: page.sessions.map((s) => ({
            ...s,
            backend,
            threadId: backend === "pi" ? piThread(s.threadId) : s.threadId,
            ownerThreadId:
              s.ownerThreadId && backend === "pi"
                ? piThread(s.ownerThreadId)
                : s.ownerThreadId,
          })),
          nextCursor: page.nextCursor,
        };
      }),
    );
    const sessions = results
      .flatMap((r) => (r.status === "fulfilled" ? r.value.sessions : []))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (results.every((r) => r.status === "rejected"))
      throw (results[0] as PromiseRejectedResult).reason;
    return {
      sessions,
      nextCursor: Object.values(state).some((v) => v !== null)
        ? Buffer.from(JSON.stringify(state)).toString("base64url")
        : null,
    };
  }
  async historyThread(threadId: string) {
    const native = threadIdentity(threadId);
    const value = await this.runtime(native.backend).historyThread(native.id);
    return { ...value, backend: native.backend, threadId };
  }
  historyMessages(threadId: string, cursor?: string) {
    const native = threadIdentity(threadId);
    return this.runtime(native.backend).historyMessages(native.id, cursor);
  }
  historyImage(threadId: string, imageId: string) {
    const native = threadIdentity(threadId);
    return (
      this.runtime(native.backend).historyImage?.(native.id, imageId) ??
      Promise.resolve(null)
    );
  }
  readTitle(threadId: string) {
    const native = threadIdentity(threadId);
    return this.runtime(native.backend).readTitle(native.id);
  }
  async open(
    agent: RuntimeAgent,
    notify: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    const backend = agent.backend ?? "codex";
    const native = agent.threadId ? threadIdentity(agent.threadId) : undefined;
    if (native && native.backend !== backend)
      throw new Error("Session backend cannot change");
    const handle = await this.runtime(backend).open(
      { ...agent, threadId: native?.id },
      (event) =>
        notify({
          ...event,
          threadId:
            event.threadId && backend === "pi"
              ? piThread(event.threadId)
              : event.threadId,
        }),
    );
    return {
      ...handle,
      threadId: backend === "pi" ? piThread(handle.threadId) : handle.threadId,
    };
  }
  async close() {
    await Promise.all([this.codex.close(), this.pi.close()]);
    this.catalogues.clear();
  }
}
