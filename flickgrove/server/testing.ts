import type { Model, WeeklyUsage } from "../src/contracts";
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
    this.agents.set(agent.id, structuredClone(agent));
    this.listeners.set(agent.id, notify);
    return {
      threadId: agent.threadId ?? `thread-${agent.id}`,
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
