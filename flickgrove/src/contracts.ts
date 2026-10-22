export type Backend = "codex" | "pi";
export type Role = "orc" | "worker" | "reviewer" | "researcher";
export type ReviewerProfile =
  | "standards"
  | "spec"
  | "high_risk_spec"
  | "penpot";
export interface ReviewTarget {
  profile: ReviewerProfile;
  spec: string;
  fixedPoint: string;
  reviewedHead: string;
}
export type WorkState = "idle" | "working" | "stopping" | "error";
export type Effort = string;
export interface ProjectEnvironment {
  id: string;
  name: string;
  /** Captured non-secret administrator target identity. */
  target: string;
}
export interface Project {
  environment?: ProjectEnvironment;
  owner?: string | null;
  alias: string;
  name: string;
  path: string;
}
export interface Model {
  backend?: Backend;
  provider?: string;
  id: string;
  name: string;
  efforts: Effort[];
  defaultEffort: Effort;
  isDefault: boolean;
  fastTier: string | null;
}
export interface Defaults {
  backend?: Backend;
  provider?: string;
  model: string;
  effort: Effort;
}
export interface Settings {
  fast: boolean;
  orc: Defaults;
  worker: Defaults;
}
export interface MessageImage {
  id: string;
  name: string;
  width: number;
  height: number;
  bytes: number;
  mediaType: string;
  availability?: "missing";
}
export interface Message {
  questionItemId?: string;
  provisional?: boolean;
  clientId?: string;
  delivery?: Delivery;
  bodyRef?: string;
  localImageIds?: string[];
  images?: MessageImage[];
  id: string;
  turnId?: string;
  role: "user" | "assistant";
  text: string;
  at: number;
}
export interface HistorySession {
  environmentId?: string;
  environmentTarget?: string;
  backend?: Backend;
  provider?: string;
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
  // HTTP-only projection of the existing unresolved answer operation.
  answerOperation?: Pick<Delivery, "id" | "status">;
  id: string;
  itemId: string;
  index: number;
  title: string;
  text: string;
  options: QuestionOption[];
  state: "unanswered" | "delegated" | "answered";
  answer?: string;
  at: number;
  recoveryRef?: boolean;
}
export type Answer = { questionId: string; answer: string };
export interface Delivery {
  attemptId?: string;
  recoveryRef?: boolean;
  images?: MessageImage[];
  answers?: Answer[];
  turnId?: string;
  id: string;
  text: string;
  status: "queued" | "sending" | "sent" | "failed" | "uncertain";
  source: "user" | "worker" | "reviewer" | "researcher" | "question";
  reportingResearcherId?: string;
  researchQuestion?: string;
  reportingReviewerId?: string;
  reviewTarget?: ReviewTarget;
  reportingWorkerId?: string;
  questionIds: string[];
  error?: string;
  at: number;
}
export interface Agent {
  backend?: Backend;
  provider?: string;
  researchQuestion?: string;
  reviewTarget?: ReviewTarget;
  treeFast?: boolean;
  treeFastBusy?: boolean;
  treeFastError?: string;
  directoryBranch?: string;
  readingRevision?: number;
  historyCursor?: string;
  closeRequest?: {
    reason: string;
  };
  hostId?: string;
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
  execution?: { kind: "capacity" | "error"; retrying: boolean };
  workingSince?: number;
  threadId?: string;
  turnId?: string;
  error?: string;
  closed: boolean;
  questions: Question[];
  unansweredCount?: number;
  recoveryCount?: number;
}
export interface Detail extends Agent {
  messages: Message[];
  deliveries: Delivery[];
}
export interface Host {
  id: string;
  name: string;
  url: string;
  connected: boolean;
  lastSeen?: number;
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
  entryId?: string;
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
