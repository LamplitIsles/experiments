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
  clientId?: string;
  images?: import("../src/contracts").MessageImage[];
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
export type RuntimeEvent = { threadId?: string; replayed?: boolean } & (
  | { type: "working"; turnId: string }
  | {
      type: "submission";
      operationId: string;
      status: "queued" | "placed" | "done" | "unanswered";
      turnId: string;
      itemId?: string;
      reason?: string;
    }
  | { type: "item"; turnId: string; item: RuntimeItem }
  | {
      type: "completed";
      turnId: string;
      status: string;
      recoveredActivityAt?: number;
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
  orcPromptSnapshot?: string;
  researcherSnapshot?: import("./reviewer-config").ReviewerSnapshot;
  reviewerSnapshot?: import("./reviewer-config").ReviewerSnapshot;
  workerDefaults?: ExecutionSettings & {
    backend?: import("../src/contracts").Backend;
    provider?: string;
  };
  inheritSettings?: boolean;
  restoreArchived?: boolean;
  turnEnded?: boolean;
}
export type ExecutionSettings = {
  provider?: string;
  model: string;
  effort: string;
  serviceTier: string;
};
export interface RuntimeHandle {
  threadId: string;
  threadName: string | null;
  historyCursor?: string;
  model?: string;
  effort?: string;
  serviceTier?: string;
  readSettings(): Promise<ExecutionSettings>;
  updateSettings(
    settings: ExecutionSettings | { serviceTier: string },
  ): Promise<ExecutionSettings>;
  rename(title: string): Promise<void>;
  send(
    text: string,
    turnId?: string,
    images?: string[],
    clientId?: string,
    envelope?: string,
  ): Promise<string>;
  interrupt(turnId: string): Promise<void>;
  title(input: string): Promise<string | undefined>;
  close(): Promise<void>;
}
export type WindowRead =
  | { operation: string; turnId?: string }
  | { cursor: string; direction: "older" | "newer" };
export interface Runtime {
  // Codex can confirm an unloaded thread without acquiring a writer handle.
  releaseThread?(threadId: string): Promise<void>;
  history(
    cwd: string,
    cursor?: string,
    environment?: import("../src/contracts").ProjectEnvironment,
  ): Promise<HistoryPage>;
  historyThread(threadId: string): Promise<HistorySession>;
  historyImage?(threadId: string, imageId: string): Promise<File | null>;
  messageWindow?(
    threadId: string,
    read: WindowRead,
  ): Promise<import("../src/contracts").MessageWindow>;
  historyMessages(threadId: string, cursor?: string): Promise<HistoryMessages>;
  readTitle(threadId: string): Promise<string | null>;
  weekly(): Promise<WeeklyUsage>;
  models(): Promise<Model[]>;
  skills(
    cwd: string,
    backend?: import("../src/contracts").Backend,
    environment?: import("../src/contracts").ProjectEnvironment,
  ): Promise<Skill[]>;
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
