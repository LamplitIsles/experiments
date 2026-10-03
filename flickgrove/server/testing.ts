import type {
  Model,
  WeeklyUsage,
  HistorySession,
  Message,
} from "../src/contracts";
import type {
  Runtime,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
} from "./runtime";

export const fixtureProjects = [
  { alias: "alpha", name: "Alpha", path: "/fixture/alpha" },
  { alias: "beta", name: "Beta", path: "/fixture/beta" },
];
export class FakeRuntime implements Runtime {
  readonly historySessions = new Map<string, HistorySession>();
  readonly historyItems = new Map<string, Message[]>();
  readonly lockedThreads = new Set<string>();
  async history(cwd: string, cursor?: string) {
    const matches = [...this.historySessions.values()].filter(
      (s) => s.cwd === cwd,
    );
    const offset = Number(cursor ?? 0);
    return {
      sessions: matches.slice(offset, offset + 30),
      nextCursor: matches.length > offset + 30 ? String(offset + 30) : null,
    };
  }
  async historyThread(threadId: string) {
    const session = this.historySessions.get(threadId);
    if (!session) throw new Error("Thread not found");
    return { ...session };
  }
  async historyMessages(threadId: string, cursor?: string) {
    const items = this.historyItems.get(threadId) ?? [];
    const end = cursor ? Number(cursor) : items.length;
    const start = Math.max(0, end - 30);
    return {
      messages: items.slice(start, end),
      nextCursor: start ? String(start) : null,
    };
  }
  readonly names = new Map<string, string>();
  closeOverride?: (id: string) => Promise<void>;
  renameOverride?: (threadId: string, title: string) => Promise<void>;
  async readTitle(threadId: string) {
    return this.names.get(threadId) ?? null;
  }
  readonly agents = new Map<string, RuntimeAgent>();
  readonly listeners = new Map<string, (e: RuntimeEvent) => void>();
  readonly inputs: { agentId: string; text: string; turnId?: string }[] = [];
  sendOverride?: (
    agentId: string,
    text: string,
    turnId?: string,
  ) => Promise<string>;
  readonly interruptions: { agentId: string; turnId: string }[] = [];
  interruptOverride?: (id: string, turnId: string) => Promise<void>;
  async weekly(): Promise<WeeklyUsage> {
    return {
      remaining: 72,
      fetchedAt: Date.now(),
      accountId: "fixture-account",
      resetsAt: 1791252000,
    };
  }
  async models(): Promise<Model[]> {
    return [
      {
        id: "sol",
        name: "Sol",
        efforts: ["medium", "high"],
        defaultEffort: "medium",
        isDefault: true,
        fastTier: "priority",
      },
      {
        id: "luna",
        name: "Luna",
        efforts: ["low"],
        defaultEffort: "low",
        isDefault: false,
        fastTier: null,
      },
    ];
  }
  async skills() {
    return [
      {
        name: "to-orc-impl",
        description: "Implement one spec with one Worker",
      },
    ];
  }
  async open(
    agent: RuntimeAgent,
    notify: (e: RuntimeEvent) => void,
  ): Promise<RuntimeHandle> {
    if (agent.threadId && this.lockedThreads.has(agent.threadId))
      throw new Error(
        "This session is in use by another Codex instance. Close it there, then retry.",
      );
    const threadId = agent.threadId ?? `thread-${agent.id}`;
    if (!this.historySessions.has(threadId))
      this.historySessions.set(threadId, {
        threadId,
        title: agent.title,
        preview: "",
        cwd: agent.project.path,
        role: agent.role,
        source: "appServer",
        archived: false,
        updatedAt: Date.now(),
      });
    this.agents.set(agent.id, structuredClone(agent));
    this.listeners.set(agent.id, notify);
    return {
      threadId: agent.threadId ?? `thread-${agent.id}`,
      threadName: await this.readTitle(agent.threadId ?? `thread-${agent.id}`),
      historyCursor: this.historyItems.get(threadId)?.length
        ? String(this.historyItems.get(threadId)!.length)
        : undefined,
      model: agent.model || "sol",
      effort: agent.effort || "medium",
      serviceTier: agent.serviceTier,
      rename: async (title) => {
        const id = agent.threadId ?? `thread-${agent.id}`;
        await this.renameOverride?.(id, title);
        this.names.set(id, title);
      },
      send: async (text, turnId) => {
        this.inputs.push({ agentId: agent.id, text, turnId });
        return this.sendOverride
          ? this.sendOverride(agent.id, text, turnId)
          : (turnId ?? `turn-${this.inputs.length}`);
      },
      interrupt: async (turnId) => {
        this.interruptions.push({ agentId: agent.id, turnId });
        if (this.interruptOverride)
          await this.interruptOverride(agent.id, turnId);
      },
      title: async () => undefined,
      close: async () => {
        await this.closeOverride?.(agent.id);
        this.listeners.delete(agent.id);
      },
    };
  }
  emit(id: string, event: RuntimeEvent) {
    this.listeners.get(id)?.(event);
  }
  async close() {
    this.listeners.clear();
  }
}
