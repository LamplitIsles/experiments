import type {
  Detail,
  HistoryPage,
  HistorySession,
  HistoryMessages,
  Model,
  Skill,
  WeeklyUsage,
} from "../src/contracts";

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
export type RuntimeEvent = { threadId?: string } & (
  | { type: "working"; turnId: string }
  | { type: "item"; turnId: string; item: RuntimeItem }
  | {
      type: "completed";
      turnId: string;
      status: string;
      error?: string;
      errorKind?: "capacity" | "error";
    }
  | { type: "progress"; turnId: string }
  | {
      type: "error";
      turnId: string;
      error: string;
      willRetry: boolean;
      errorKind?: "capacity" | "error";
    }
  | { type: "disconnected"; error: string }
);
export interface RuntimeAgent extends Detail {
  token: string;
  workerDefaults?: { model: string; effort: string; serviceTier: string };
  inheritSettings?: boolean;
  restoreArchived?: boolean;
  turnEnded?: boolean;
}
export interface RuntimeHandle {
  threadId: string;
  threadName: string | null;
  historyCursor?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  rename(title: string): Promise<void>;
  send(text: string, turnId?: string, images?: string[]): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  title(input: string): Promise<string | undefined>;
  close(): Promise<void>;
}
export interface Runtime {
  history(cwd: string, cursor?: string): Promise<HistoryPage>;
  historyThread(threadId: string): Promise<HistorySession>;
  historyImage?(threadId: string, imageId: string): Promise<File | null>;
  historyMessages(threadId: string, cursor?: string): Promise<HistoryMessages>;
  readTitle(threadId: string): Promise<string | null>;
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
