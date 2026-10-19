import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  foreignKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { Agent, Delivery, Project, Question } from "../src/contracts";
import type { RuntimeAgent, ExecutionSettings } from "./runtime";

export type RecoveryContext = Pick<
  RuntimeAgent,
  "turnId" | "turnEnded" | "stop" | "closeRequest"
>;
export type TaskContext = Pick<Agent, "reviewTarget" | "researchQuestion">;
export type SessionDiagnostics = Pick<
  Agent,
  "error" | "execution" | "treeFastError"
>;
export type CapturedConfig = Pick<
  RuntimeAgent,
  | "orcPromptSnapshot"
  | "reviewerSnapshot"
  | "researcherSnapshot"
  | "workerDefaults"
>;
export type ReportContext = Pick<
  Delivery,
  | "reportingWorkerId"
  | "reportingReviewerId"
  | "reportingResearcherId"
  | "reviewTarget"
  | "researchQuestion"
>;
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    role: text("role").$type<Agent["role"]>().notNull(),
    ownerId: text("owner_id"),
    backend: text("backend").$type<"codex" | "pi">().notNull().default("codex"),
    threadId: text("thread_id"),
    title: text("title").notNull(),
    token: text("token").notNull().unique(),
    closed: integer("closed", { mode: "boolean" }).notNull(),
    state: text("state").$type<Agent["state"]>().notNull(),
    project: json<Project>("project").notNull(),
    settings: json<ExecutionSettings>("settings").notNull(),
    recovery: json<RecoveryContext>("recovery").notNull(),
    task: json<TaskContext>("task").notNull(),
    diagnostics: json<SessionDiagnostics>("diagnostics").notNull(),
    treeFast: integer("tree_fast", { mode: "boolean" }),
  },
  (t) => [
    uniqueIndex("sessions_backend_thread").on(t.backend, t.threadId),
    index("sessions_open").on(t.closed),
    index("sessions_owner").on(t.ownerId),
  ],
);
export const sessionConfig = sqliteTable("session_config", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  captured: json<CapturedConfig>("captured").notNull(),
});
export const deliveries = sqliteTable(
  "deliveries",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    source: text("source").$type<Delivery["source"]>().notNull(),
    status: text("status").$type<Delivery["status"]>().notNull(),
    attemptId: text("attempt_id"),
    turnId: text("turn_id"),
    at: integer("at").notNull(),
    error: text("error"),
    images: json<NonNullable<Delivery["images"]>>("images"),
    report: json<ReportContext>("report").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.operationId] }),
    index("deliveries_status").on(t.sessionId, t.status),
    index("deliveries_order").on(t.sessionId, t.position),
  ],
);
export const questions = sqliteTable(
  "questions",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    itemId: text("item_id").notNull(),
    itemIndex: integer("item_index").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    options: json<Question["options"]>("options").notNull(),
    state: text("state").$type<Question["state"]>().notNull(),
    answer: text("answer"),
    at: integer("at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.id] }),
    index("questions_item").on(t.sessionId, t.itemId),
    index("questions_state").on(t.sessionId, t.state),
  ],
);
export const deliveryQuestions = sqliteTable(
  "delivery_questions",
  {
    sessionId: text("session_id").notNull(),
    operationId: text("operation_id").notNull(),
    questionId: text("question_id").notNull(),
    position: integer("position").notNull(),
    answer: text("answer"),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.operationId, t.position] }),
    foreignKey({
      columns: [t.sessionId, t.operationId],
      foreignColumns: [deliveries.sessionId, deliveries.operationId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.sessionId, t.questionId],
      foreignColumns: [questions.sessionId, questions.id],
    }),
  ],
);
