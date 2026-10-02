import type { Detail, Model, Skill, WeeklyUsage } from "../src/contracts";

export interface RuntimeItem {
  id: string;
  type: string;
  text?: string;
  phase?: string | null;
  delivery?: string | null;
  questions?:
    | {
        header?: string;
        question: string;
        options?: { label: string; description?: string }[] | null;
      }[]
    | null;
}
export type RuntimeEvent =
  | { type: "working"; turnId: string }
  | { type: "item"; turnId: string; item: RuntimeItem }
  | { type: "completed"; turnId: string; status: string; error?: string }
  | { type: "error"; error: string }
  | { type: "disconnected"; error: string };
export interface RuntimeAgent extends Detail {
  token: string;
}
export interface RuntimeHandle {
  threadId: string;
  send(text: string, turnId?: string): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  title(input: string): Promise<string | undefined>;
  close(): Promise<void>;
}
export interface Runtime {
  weekly(): Promise<WeeklyUsage>;
  models(): Promise<Model[]>;
  skills(cwd: string): Promise<Skill[]>;
  open(
    agent: RuntimeAgent,
    notify: (event: RuntimeEvent) => void,
  ): Promise<RuntimeHandle>;
  close(): Promise<void>;
}
export class StaleTurn extends Error {
  constructor(
    message: string,
    readonly activeTurnId?: string,
  ) {
    super(message);
  }
}
export class DeliveryRejected extends Error {}
