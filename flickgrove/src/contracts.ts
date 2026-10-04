export type Role = "orc" | "worker";
export type WorkState = "idle" | "working" | "stopping" | "error";
export type Effort = string;
export interface Project {
  alias: string;
  name: string;
  path: string;
}
export interface Model {
  id: string;
  name: string;
  efforts: Effort[];
  defaultEffort: Effort;
  isDefault: boolean;
  fastTier: string | null;
}
export interface Defaults {
  model: string;
  effort: Effort;
}
export interface Settings {
  fast: boolean;
  orc: Defaults;
  worker: Defaults;
}
export interface Message {
  id: string;
  turnId?: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}
export interface HistorySession {
  threadId: string;
  title: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  source: string;
  archived: boolean;
  role: Role | "session";
  agentId?: string;
  ownerThreadId?: string;
  ownerProject?: string;
  closed?: boolean;
  model?: string;
  effort?: string;
}
export interface HistoryPage {
  sessions: HistorySession[];
  nextCursor: string | null;
}
export interface HistoryMessages {
  messages: Message[];
  nextCursor: string | null;
}
export interface QuestionOption {
  label: string;
  description?: string;
}
export interface Question {
  id: string;
  itemId: string;
  index: number;
  title: string;
  text: string;
  options: QuestionOption[];
  state: "unanswered" | "delegated" | "answered";
  answer?: string;
  at: number;
}
export type Answer = { questionId: string; answer: string };
export interface Delivery {
  answers?: Answer[];
  turnId?: string;
  id: string;
  text: string;
  status: "queued" | "sending" | "sent" | "failed" | "uncertain";
  source: "user" | "worker" | "question";
  reportingWorkerId?: string;
  questionIds: string[];
  error?: string;
  at: number;
}
export interface Agent {
  historyCursor?: string;
  historyMessageCount?: number;
  closeRequest?: {
    reason: string;
  };
  hostId?: string;
  hostName?: string;
  stop?: {
    turnId: string;
    status: "pending" | "unknown" | "confirmed" | "completed";
  };
  serviceTier: string;
  id: string;
  role: Role;
  ownerId?: string;
  project: Project;
  title: string;
  model: string;
  effort: Effort;
  state: WorkState;
  workingSince?: number;
  threadId?: string;
  turnId?: string;
  error?: string;
  closed: boolean;
  questions: Question[];
}
export interface Detail extends Agent {
  messages: Message[];
  deliveries: Delivery[];
}
export interface Host {
  id: string;
  name: string;
  url: string;
  role: "hub" | "execution";
  connected: boolean;
  lastSeen?: number;
  defaults: "synced" | "pending" | "failed";
  error?: string;
}
export interface WeeklyUsage {
  remaining: number | null;
  resetsAt?: number;
  accountId?: string;
  fetchedAt: number;
  hostId?: string;
  source?: string;
}
export interface Snapshot {
  hubId?: string;
  hosts?: Host[];
  agents: Agent[];
  settings: Settings | null;
  revision: number;
}
export interface Skill {
  name: string;
  description: string;
  shortDescription?: string;
}
