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
}
export const noReporter: Reporter = { working() {}, idle() {}, release() {} };

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
  private stagedFinal = new Map<string, NativeItem[]>();
  private held: Array<{ id: string; input: string }> = [];
  private unacknowledged = new Map<string, string>();
  private admission: Promise<void> = Promise.resolve();
  private unsubscribers: Array<() => void> = [];

  constructor(
    readonly server: AppServer,
    readonly threadId: string,
    readonly reporter: Reporter = noReporter,
  ) {
    this.unsubscribers = [
      server.onNotification("turn/started", (p) => this.started(p)),
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
      server.onNotification("thread/compacted", () => {
        this.compacting = false;
        void this.flushHeld();
      }),
    ];
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
    this.visible.splice(0, this.visible.length, ...messages(turns));
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
    if (!input.trim()) return;
    if (input.trim() === "/compact") {
      await this.compact();
      return;
    }
    this.visible.push({
      role: "user",
      body: input,
      timestamp: timestamp(new Date().toISOString()),
    });
    this.pendingOrigin = this.visible.length - 1;
    const id = crypto.randomUUID();
    this.unacknowledged.set(id, input);
    this.reporter.working();
    this.status = "working";
    if (this.compacting) {
      this.held.push({ id, input });
      return;
    }
    const task = this.admission.then(() => this.send(input, id));
    this.admission = task.catch(() => {});
    await task;
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
        if (typeof response.turn?.id === "string")
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
        if (typeof response.turnId === "string")
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
    if (this.activeTurnId || this.compacting)
      throw new Error("Cannot compact while a turn is active");
    this.compacting = true;
    this.status = "compacting";
    this.reporter.working();
    await this.server.call("thread/compact/start", { threadId: this.threadId });
  }

  private started(params: any): void {
    const turn = params.turn as NativeTurn | undefined;
    if (!turn?.id) return;
    this.activeTurnId = turn.id;
    this.activeStartedAt = turn.startedAt;
    this.status = "working";
    this.reporter.working();
  }
  private item(params: any): void {
    const turnId =
      typeof params.turnId === "string" ? params.turnId : undefined;
    const item = params.item as NativeItem | undefined;
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
    const turn = params.turn as NativeTurn | undefined;
    if (!turn?.id) return;
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
    await this.flushHeld();
  }
  private async flushHeld(): Promise<void> {
    const values = this.held;
    this.held = [];
    for (const value of values) {
      if (this.activeTurnId || this.compacting) {
        this.held.push(value);
        continue;
      }
      await this.send(value.input, value.id);
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
    for (const unsub of this.unsubscribers.splice(0)) unsub();
    this.reporter.release();
    return this.server.close();
  }
}
