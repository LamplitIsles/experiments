/**
 * Reader-first projection adapted from Codex-for-Love's native lifecycle
 * reconciliation.  It deliberately owns only disposable presentation state.
 */
export type Role = "user" | "assistant";
export type VisibleMessage = {
  role: Role;
  body: string;
  timestamp: string;
  workedMs?: number;
};
export type NativeItem = {
  id?: string;
  type?: string;
  clientId?: string;
  text?: string;
  content?: Array<{ text?: string }>;
  role?: string;
  phase?: string;
};
export type NativeTurn = {
  id: string;
  status?: string;
  startedAt?: string | number;
  completedAt?: string | number;
  items?: NativeItem[];
  error?: { message?: string; codexErrorInfo?: unknown };
};
export type TokenUsage = {
  last?: { totalTokens?: number };
  modelContextWindow?: number;
};
export type ThreadRuntime = { name?: string; model?: string; effort?: string };
export type Skill = { name: string; description?: string };

export interface AppServer {
  call(method: string, params?: Record<string, unknown>): Promise<any>;
  listSkills(cwd: string): Promise<Skill[]>;
  onNotification(method: string, listener: (params: any) => void): () => void;
  close(): Promise<void>;
}

export interface Reporter {
  working(): void;
  idle(): void;
  release(): void;
  blocked?(message: string): void;
}
export const noReporter: Reporter = { working() {}, idle() {}, release() {} };

export interface ConversationClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}
const realClock: ConversationClock = {
  now: Date.now,
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

function text(item: NativeItem): string {
  if (typeof item.text === "string") return item.text;
  return (item.content ?? [])
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
    .join("");
}
function milliseconds(value: string | number | undefined): number | undefined {
  const parsed =
    typeof value === "number"
      ? value < 10_000_000_000
        ? value * 1000
        : value
      : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : undefined;
}
function timestamp(value: string | number | undefined): string {
  const parsed = milliseconds(value);
  if (parsed === undefined) return "unknown time";
  const d = new Date(parsed);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function duration(
  start?: string | number,
  end?: string | number,
): number | undefined {
  const value = (milliseconds(end) ?? NaN) - (milliseconds(start) ?? NaN);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
function messages(turns: NativeTurn[]): VisibleMessage[] {
  const out: VisibleMessage[] = [];
  for (const turn of turns) {
    const final = (turn.items ?? [])
      .filter(
        (item) =>
          (item.type === "agentMessage" || item.role === "assistant") &&
          item.phase === "final_answer",
      )
      .map(text)
      .filter(Boolean)
      .join("\n");
    for (const item of turn.items ?? []) {
      if (item.type === "userMessage" || item.role === "user") {
        const body = text(item);
        if (body)
          out.push({
            role: "user",
            body,
            timestamp: timestamp(turn.startedAt),
          });
      }
    }
    if (turn.status === "completed" && final)
      out.push({
        role: "assistant",
        body: final,
        timestamp: timestamp(turn.completedAt),
        workedMs: duration(turn.startedAt, turn.completedAt),
      });
  }
  return out;
}

export class ReaderConversation {
  readonly visible: VisibleMessage[] = [];
  activeTurnId: string | undefined;
  compacting = false;
  tokenUsage: TokenUsage | undefined;
  readonly runtime: ThreadRuntime = {};
  private skillsInvalid = true;
  skillVersion = 0;
  private cachedSkills: Skill[] = [];
  private pendingOrigin: number | undefined;
  activeStartedAt: string | number | undefined;
  status = "idle";
  notice = "";
  private manualCompact = false;
  private compactItem: string | undefined;
  private closed = false;
  private finishedTurns = new Set<string>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAt: number | undefined;
  private retryAttempts = 0;
  private retryGeneration = 0;
  private stagedFinal = new Map<string, NativeItem[]>();
  private held: Array<{ id: string; input: string }> = [];
  private unacknowledged = new Map<string, VisibleMessage>();
  private admission: Promise<void> = Promise.resolve();
  private unsubscribers: Array<() => void> = [];

  constructor(
    readonly server: AppServer,
    readonly threadId: string,
    readonly reporter: Reporter = noReporter,
    private readonly clock: ConversationClock = realClock,
  ) {
    this.unsubscribers = [
      server.onNotification("turn/started", (p) => this.started(p)),
      server.onNotification("item/started", (p) => {
        if (
          !this.owns(p) ||
          p.turnId !== this.activeTurnId ||
          p.item?.type !== "contextCompaction"
        )
          return;
        this.compacting = true;
        this.compactItem = p.item.id;
        this.status = "compacting";
      }),
      server.onNotification("item/completed", (p) => this.item(p)),
      server.onNotification("turn/completed", (p) => void this.completed(p)),
      server.onNotification("thread/tokenUsage/updated", (p) => {
        if (p.threadId === undefined || p.threadId === this.threadId)
          this.tokenUsage = p.tokenUsage;
      }),
      server.onNotification("thread/name/updated", (p) => {
        if (
          p.threadId === this.threadId &&
          typeof (p.threadName ?? p.name) === "string"
        )
          this.runtime.name = p.threadName ?? p.name;
      }),
      server.onNotification("thread/settings/updated", (p) => {
        if (p.threadId !== this.threadId) return;
        const settings = p.threadSettings ?? p.settings ?? p;
        if (typeof settings.model === "string")
          this.runtime.model = settings.model;
        if (typeof (settings.effort ?? settings.reasoningEffort) === "string")
          this.runtime.effort = settings.effort ?? settings.reasoningEffort;
      }),
      server.onNotification("skills/changed", () => {
        this.skillsInvalid = true;
        this.skillVersion += 1;
      }),
    ];
    this.reporter.idle();
  }

  private owns(params: any): boolean {
    return (
      !this.closed &&
      (params.threadId === undefined || params.threadId === this.threadId)
    );
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const task = this.admission.then(async () => {
      if (!this.closed) await action();
    });
    this.admission = task.catch((error) => {
      this.notice = error instanceof Error ? error.message : String(error);
      if (!this.activeTurnId && !this.closed) {
        this.status = "idle";
        this.reporter.idle();
      }
    });
    return task;
  }

  cancelRecovery(): void {
    if (this.retryTimer !== undefined) this.clock.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = undefined;
    this.retryAttempts = 0;
    this.retryGeneration++;
    if (this.status === "capacity wait") {
      this.status = "idle";
      this.reporter.idle();
    }
  }

  recoveryLabel(): string {
    if (this.retryAt === undefined) return "";
    const seconds = Math.max(
      0,
      Math.ceil((this.retryAt - this.clock.now()) / 1000),
    );
    return `capacity retry ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · /cancel-retry`;
  }

  private scheduleRecovery(compact: boolean): void {
    if (this.retryTimer !== undefined || this.closed) return;
    const delay = (this.retryAttempts++ === 0 ? 15 : 30) * 60_000;
    const generation = this.retryGeneration;
    this.retryAt = this.clock.now() + delay;
    this.status = "capacity wait";
    this.reporter.blocked?.(
      `Capacity; retry at ${new Date(this.retryAt).toISOString()}`,
    );
    this.retryTimer = this.clock.setTimeout(() => {
      this.retryTimer = undefined;
      this.retryAt = undefined;
      void this.enqueue(async () => {
        if (
          generation !== this.retryGeneration ||
          this.activeTurnId ||
          this.compacting
        )
          return;
        this.reporter.working();
        this.status = "working";
        this.notice = "";
        try {
          if (compact) await this.startCompact();
          else {
            // A new native turn continues existing history without replaying accepted input.
            const response = await this.server.call("turn/start", {
              threadId: this.threadId,
              input: [],
            });
            if (response.turn?.id && !this.finishedTurns.has(response.turn.id))
              this.activeTurnId = response.turn.id;
          }
        } catch (error) {
          this.cancelRecovery();
          throw error;
        }
      }).catch(() => {});
    }, delay);
  }

  async loadHistory(): Promise<void> {
    const turns: NativeTurn[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await this.server.call("thread/turns/list", {
        threadId: this.threadId,
        cursor,
        limit: 100,
        itemsView: "full",
        sortDirection: "asc",
      });
      turns.push(...(response.data ?? []));
      cursor = response.nextCursor;
    } while (cursor);
    this.acknowledge(turns);
    this.visible.splice(
      0,
      this.visible.length,
      ...messages(turns),
      ...this.unacknowledged.values(),
    );
  }

  seedTokenUsage(
    value: { totalTokens: number; modelContextWindow: number } | undefined,
  ): void {
    if (value)
      this.tokenUsage = {
        last: { totalTokens: value.totalTokens },
        modelContextWindow: value.modelContextWindow,
      };
  }

  setRuntime(value: ThreadRuntime): void {
    Object.assign(this.runtime, value);
  }

  async listSkills(cwd: string): Promise<Skill[]> {
    if (!this.skillsInvalid) return this.cachedSkills;
    this.cachedSkills = await this.server.listSkills(cwd);
    this.skillsInvalid = false;
    return this.cachedSkills;
  }

  /** Only an official userMessage client ID confirms a locally admitted input. */
  private acknowledge(turns: readonly NativeTurn[]): void {
    for (const turn of turns)
      for (const item of turn.items ?? [])
        if (item.type === "userMessage" && typeof item.clientId === "string")
          this.unacknowledged.delete(item.clientId);
  }

  async submit(input: string): Promise<void> {
    if (!input.trim() || this.closed) return;
    this.cancelRecovery();
    if (input.trim() === "/cancel-retry") {
      this.notice = "Automatic capacity retry cancelled";
      return;
    }
    this.notice = "";
    if (input.trim() === "/compact") {
      await this.compact();
      return;
    }
    const message: VisibleMessage = {
      role: "user",
      body: input,
      timestamp: timestamp(new Date().toISOString()),
    };
    this.visible.push(message);
    this.pendingOrigin = this.visible.length - 1;
    const id = crypto.randomUUID();
    this.unacknowledged.set(id, message);
    this.reporter.working();
    this.status = "working";
    this.held.push({ id, input });
    await this.enqueue(() => this.flushHeld());
  }

  consumeReadingOrigin(): number | undefined {
    const origin = this.pendingOrigin;
    this.pendingOrigin = undefined;
    return origin;
  }
  private async send(input: string, id: string): Promise<void> {
    const params = {
      threadId: this.threadId,
      input: [{ type: "text", text: input }],
      clientUserMessageId: id,
    };
    if (this.activeTurnId) {
      await this.steer(params, id);
    } else {
      try {
        const response = await this.server.call("turn/start", params);
        if (
          typeof response.turn?.id === "string" &&
          !this.finishedTurns.has(response.turn.id)
        )
          this.activeTurnId = response.turn.id;
      } catch (error) {
        // A lost response is not evidence of rejection: consult authority once.
        await this.loadHistory();
        if (this.unacknowledged.has(id)) throw error;
      }
    }
  }

  private async steer(
    params: {
      threadId: string;
      input: Array<{ type: string; text: string }>;
      clientUserMessageId: string;
    },
    id: string,
  ): Promise<void> {
    let expected = this.activeTurnId;
    let retriedMismatch = false;
    while (expected) {
      try {
        const response = await this.server.call("turn/steer", {
          ...params,
          expectedTurnId: expected,
        });
        // TurnSteerResponse is { turnId }, unlike TurnStartResponse.
        if (
          typeof response.turnId === "string" &&
          !this.finishedTurns.has(response.turnId)
        )
          this.activeTurnId = response.turnId;
        return;
      } catch (error) {
        await this.loadHistory();
        if (!this.unacknowledged.has(id)) return;
        const message = error instanceof Error ? error.message : String(error);
        const actual = /but found [`']([^`']+)[`']/.exec(message)?.[1];
        if (actual && !retriedMismatch) {
          retriedMismatch = true;
          expected = actual;
          this.activeTurnId = actual;
          continue;
        }
        if (/no active turn/i.test(message)) {
          this.activeTurnId = undefined;
          await this.send(params.input.map((part) => part.text).join(""), id);
          return;
        }
        throw error;
      }
    }
  }

  async compact(): Promise<void> {
    this.cancelRecovery();
    await this.enqueue(() => this.startCompact());
  }
  private async startCompact(): Promise<void> {
    if (this.activeTurnId || this.compacting)
      throw new Error("Cannot compact while a turn is active");
    this.compacting = true;
    this.manualCompact = true;
    this.status = "compacting";
    this.reporter.working();
    try {
      await this.server.call("thread/compact/start", {
        threadId: this.threadId,
      });
    } catch (error) {
      this.compacting = false;
      this.manualCompact = false;
      throw error;
    }
  }

  private started(params: any): void {
    if (!this.owns(params)) return;
    const turn = params.turn as NativeTurn | undefined;
    if (!turn?.id || this.finishedTurns.has(turn.id)) return;
    this.activeTurnId = turn.id;
    this.activeStartedAt = turn.startedAt;
    this.status = "working";
    this.reporter.working();
  }
  private item(params: any): void {
    if (!this.owns(params)) return;
    const turnId =
      typeof params.turnId === "string" ? params.turnId : undefined;
    const item = params.item as NativeItem | undefined;
    if (
      item?.type === "contextCompaction" &&
      turnId === this.activeTurnId &&
      item.id === this.compactItem
    ) {
      this.compactItem = undefined;
      if (!this.manualCompact) {
        this.compacting = false;
        this.status = "working";
        void this.enqueue(() => this.flushHeld()).catch(() => {});
      }
      return;
    }
    if (item?.type === "userMessage" && typeof item.clientId === "string") {
      this.unacknowledged.delete(item.clientId);
      return;
    }
    if (
      !turnId ||
      !item ||
      item.type !== "agentMessage" ||
      item.phase !== "final_answer"
    )
      return;
    this.stagedFinal.set(turnId, [
      ...(this.stagedFinal.get(turnId) ?? []),
      item,
    ]);
  }
  private async completed(params: any): Promise<void> {
    if (!this.owns(params)) return;
    const turn = params.turn as NativeTurn | undefined;
    if (
      !turn?.id ||
      turn.id !== this.activeTurnId ||
      this.finishedTurns.has(turn.id)
    )
      return;
    this.finishedTurns.add(turn.id);
    const wasManualCompact = this.manualCompact;
    this.manualCompact = false;
    this.compacting = false;
    this.compactItem = undefined;
    this.acknowledge([turn]);
    const pieces =
      this.stagedFinal.get(turn.id) ??
      (turn.items ?? []).filter(
        (item) => item.type === "agentMessage" && item.phase === "final_answer",
      );
    this.stagedFinal.delete(turn.id);
    if (turn.status === "completed") {
      const body = pieces.map(text).filter(Boolean).join("");
      if (body)
        this.visible.push({
          role: "assistant",
          body,
          timestamp: timestamp(turn.completedAt),
          workedMs: duration(turn.startedAt, turn.completedAt),
        });
    }
    this.activeTurnId = undefined;
    this.activeStartedAt = undefined;
    this.status = "idle";
    this.reporter.idle();
    if (
      turn.status === "failed" &&
      turn.error?.codexErrorInfo === "serverOverloaded"
    ) {
      this.notice = turn.error.message ?? "Selected model is at capacity";
      this.scheduleRecovery(wasManualCompact);
      return;
    }
    this.cancelRecovery();
    if (turn.status === "completed") this.notice = "";
    if (turn.status === "failed" || turn.status === "interrupted")
      this.notice = turn.error?.message ?? `Turn ${turn.status}`;
    await this.enqueue(() => this.flushHeld()).catch(() => {});
  }
  private async flushHeld(): Promise<void> {
    while (
      !this.closed &&
      !this.compacting &&
      this.retryAt === undefined &&
      this.held.length
    ) {
      const value = this.held[0];
      if (this.status !== "working") {
        this.status = "working";
        this.reporter.working();
      }
      await this.send(value.input, value.id);
      this.held.shift();
    }
  }
  contextLabel(): string {
    const total = this.tokenUsage?.last?.totalTokens,
      max = this.tokenUsage?.modelContextWindow;
    return typeof total === "number" && typeof max === "number" && max > 0
      ? `context ${total} / ${max}`
      : "context unavailable";
  }
  workingDurationMs(now = Date.now()): number | undefined {
    const start = milliseconds(this.activeStartedAt);
    return start === undefined ? undefined : Math.max(0, now - start);
  }
  close(): Promise<void> {
    this.closed = true;
    this.cancelRecovery();
    for (const unsub of this.unsubscribers.splice(0)) unsub();
    this.reporter.release();
    return this.server.close();
  }
}
