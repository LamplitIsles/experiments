import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { and, eq, ne, sql } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import type { Delivery, Question } from "../src/contracts";
import type { RuntimeAgent } from "./runtime";
import * as s from "./schema";
import { threadIdentity } from "./backend";
const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const sessionKeys = [
  "backend",
  "provider",
  "role",
  "ownerId",
  "threadId",
  "title",
  "token",
  "closed",
  "state",
  "project",
  "model",
  "effort",
  "serviceTier",
  "turnId",
  "turnEnded",
  "stop",
  "closeRequest",
  "reviewTarget",
  "researchQuestion",
  "error",
  "execution",
  "treeFastError",
  "treeFast",
] as const;
const configKeys = [
  "orcPromptSnapshot",
  "reviewerSnapshot",
  "researcherSnapshot",
  "workerDefaults",
] as const;
const deliveryKeys = [
  "attemptId",
  "images",
  "answers",
  "turnId",
  "text",
  "status",
  "source",
  "reportingResearcherId",
  "researchQuestion",
  "reportingReviewerId",
  "reviewTarget",
  "reportingWorkerId",
  "questionIds",
  "error",
  "at",
] as const;
const questionKeys = [
  "itemId",
  "index",
  "title",
  "text",
  "options",
  "state",
  "answer",
  "at",
] as const;
function pick<T extends object, K extends keyof T>(
  v: T,
  keys: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(
    keys.filter((k) => v[k] !== undefined).map((k) => [k, v[k]]),
  ) as Pick<T, K>;
}
function optional<T extends object>(
  v: T,
): { [K in keyof T]?: Exclude<T[K], null> } {
  return Object.fromEntries(
    Object.entries(v).filter(([, v]) => v !== null),
  ) as { [K in keyof T]?: Exclude<T[K], null> };
}
function sessionRow(a: RuntimeAgent) {
  return {
    id: a.id,
    backend: a.backend ?? "codex",
    ...pick(a, ["role", "title", "token", "closed", "state", "project"]),
    ownerId: a.ownerId ?? null,
    threadId: a.threadId ?? null,
    settings: pick(a, ["model", "effort", "serviceTier", "provider"]),
    recovery: pick(a, ["turnId", "turnEnded", "stop", "closeRequest"]),
    task: pick(a, ["reviewTarget", "researchQuestion"]),
    diagnostics: pick(a, ["error", "execution", "treeFastError"]),
    treeFast: a.treeFast ?? null,
  };
}
// Observe entities in place: local references and native callbacks keep the same
// identity. A mutation queues its row, never a whole-ledger diff or snapshot.
function observe<T extends object>(
  o: T,
  keys: readonly (keyof T)[],
  changed: () => void,
) {
  for (const k of keys) {
    let v = o[k];
    const nested = (value: unknown) => {
      if (value && typeof value === "object")
        for (const key of Object.keys(value)) {
          let child = (value as Record<string, unknown>)[key];
          Object.defineProperty(value, key, {
            configurable: true,
            enumerable: true,
            get: () => child,
            set: (next) => {
              if (child !== next) {
                child = next;
                changed();
              }
            },
          });
        }
    };
    nested(v);
    Object.defineProperty(o, k, {
      configurable: true,
      enumerable: v !== undefined,
      get: () => v,
      set: (next) => {
        if (v === next) return;
        v = next;
        nested(v);
        Object.defineProperty(o, k, { enumerable: next !== undefined });
        changed();
      },
    });
  }
}
function ledger<T>(
  rows: T[],
  added: (row: T) => void,
  removed: (row: T) => void,
) {
  Object.defineProperties(rows, {
    push: {
      configurable: true,
      value: (...items: T[]) => {
        items.forEach((item) => added(item));
        return Array.prototype.push.apply(rows, items);
      },
    },
    splice: {
      configurable: true,
      value: (start: number, count: number, ...items: T[]) => {
        const deleted = Array.prototype.splice.call(
          rows,
          start,
          count,
          ...items,
        ) as T[];
        deleted.forEach(removed);
        items.forEach((item) => added(item));
        return deleted;
      },
    },
  });
}
export class WorkspaceStore {
  readonly sqlite: Database;
  readonly db: ReturnType<typeof drizzle>;
  readonly windows = new Set<RuntimeAgent>();
  private sessions = new Map<string, RuntimeAgent>();
  private configs = new Map<string, RuntimeAgent>();
  private deliveries = new Map<
    string,
    { a: RuntimeAgent; d: Delivery; position: number }
  >();
  private questions = new Map<
    string,
    { a: RuntimeAgent; q: Question; position: number }
  >();
  private deleted = new Map<string, { sessionId: string; id: string }>();
  private tracked = new WeakSet<RuntimeAgent>();
  private positions = new WeakMap<object, number>();
  userMessageOutline(
    id: string,
  ): import("../src/contracts").UserMessageAnchor[] {
    return this.db
      .select({
        operation: s.deliveries.operationId,
        summary: sql<string>`substr(${s.deliveries.text}, 1, 240)`,
        images: sql<number>`coalesce(json_array_length(${s.deliveries.images}), 0)`,
        status: s.deliveries.status,
      })
      .from(s.deliveries)
      .where(
        and(eq(s.deliveries.sessionId, id), eq(s.deliveries.source, "user")),
      )
      .orderBy(s.deliveries.position)
      .all();
  }
  constructor(path: string) {
    this.sqlite = new Database(path);
    this.db = drizzle(this.sqlite);
    try {
      this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
      const files = readMigrationFiles({ migrationsFolder });
      if (
        this.sqlite
          .query(
            "SELECT name FROM sqlite_master WHERE name='__drizzle_migrations'",
          )
          .get()
      ) {
        const applied = this.sqlite
          .query("SELECT hash,created_at FROM __drizzle_migrations")
          .all() as { hash: string; created_at: number }[];
        if (
          applied.some(
            (row) =>
              !files.some(
                (f) => f.hash === row.hash && f.folderMillis === row.created_at,
              ),
          )
        )
          throw new Error("Workspace has unknown migrations; refusing startup");
      }
      // Drizzle owns the transaction including legacy SQL conversion and log insert.
      migrate(this.db, { migrationsFolder });
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }
  historyProjects() {
    return this.db
      .select({ id: s.sessions.id, project: s.sessions.project })
      .from(s.sessions)
      .all();
  }
  openAgents() {
    return this.db
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.closed, false))
      .all()
      .map((row) => this.hydrate(row));
  }
  byId(id: string) {
    const row = this.db
      .select()
      .from(s.sessions)
      .where(eq(s.sessions.id, id))
      .get();
    return row && this.hydrate(row);
  }
  byThread(id: string) {
    const row = this.db
      .select()
      .from(s.sessions)
      .where(
        and(
          eq(s.sessions.backend, threadIdentity(id).backend),
          eq(s.sessions.threadId, id),
        ),
      )
      .get();
    return row && this.hydrate(row);
  }
  private hydrate(row: typeof s.sessions.$inferSelect): RuntimeAgent {
    const id = row.id,
      associations = this.db
        .select()
        .from(s.deliveryQuestions)
        .where(eq(s.deliveryQuestions.sessionId, id))
        .orderBy(s.deliveryQuestions.position)
        .all();
    const grouped = new Map<string, typeof associations>();
    for (const q of associations) {
      const list = grouped.get(q.operationId) ?? [];
      list.push(q);
      grouped.set(q.operationId, list);
    }
    const config = this.db
      .select()
      .from(s.sessionConfig)
      .where(eq(s.sessionConfig.sessionId, id))
      .get();
    return {
      id,
      role: row.role,
      backend: row.backend,
      title: row.title,
      token: row.token,
      closed: row.closed,
      state: row.state,
      project: row.project,
      ...row.settings,
      ...optional(row.recovery),
      ...optional(row.task),
      ...optional(row.diagnostics),
      ...optional(config?.captured ?? {}),
      ...(row.ownerId === null ? {} : { ownerId: row.ownerId }),
      ...(row.threadId === null ? {} : { threadId: row.threadId }),
      ...(row.treeFast === null ? {} : { treeFast: row.treeFast }),
      messages: [],
      deliveries: this.db
        .select()
        .from(s.deliveries)
        .where(eq(s.deliveries.sessionId, id))
        .orderBy(s.deliveries.position)
        .all()
        .map((d) => {
          const qs = grouped.get(d.operationId) ?? [],
            answers = qs
              .filter((q) => q.answer !== null)
              .map((q) => ({ questionId: q.questionId, answer: q.answer! }));
          const delivery = {
            id: d.operationId,
            text: d.text,
            source: d.source,
            status: d.status,
            at: d.at,
            ...optional(d.report),
            ...optional({
              attemptId: d.attemptId,
              turnId: d.turnId,
              error: d.error,
              images: d.images,
            }),
            questionIds: qs.map((q) => q.questionId),
            ...(answers.length ? { answers } : {}),
          };
          this.positions.set(delivery, d.position);
          return delivery;
        }),
      questions: this.db
        .select()
        .from(s.questions)
        .where(eq(s.questions.sessionId, id))
        .orderBy(s.questions.position)
        .all()
        .map((q) => ({
          id: q.id,
          itemId: q.itemId,
          index: q.itemIndex,
          title: q.title,
          text: q.text,
          options: q.options,
          state: q.state,
          at: q.at,
          ...(q.answer === null ? {} : { answer: q.answer }),
        })),
    };
  }
  track(a: RuntimeAgent, fresh = false) {
    if (this.tracked.has(a)) return a;
    this.tracked.add(a);
    observe(a, sessionKeys, () => this.sessions.set(a.id, a));
    observe(a, configKeys, () => this.configs.set(a.id, a));
    let dp = a.deliveries.reduce(
        (n, d) => Math.max(n, (this.positions.get(d) ?? -1) + 1),
        a.deliveries.length,
      ),
      qp = a.questions.length;
    const positions = new WeakMap<Delivery, number>();
    const td = (d: Delivery, position = dp++) => {
      const key = JSON.stringify([a.id, d.id]);
      if (!positions.has(d)) {
        positions.set(d, position);
        observe(d, deliveryKeys, () =>
          this.deliveries.set(key, { a, d, position: positions.get(d)! }),
        );
      }
      this.deleted.delete(key);
      this.deliveries.set(key, { a, d, position: positions.get(d)! });
    };
    const tq = (q: Question, position = qp++) => {
      const key = JSON.stringify([a.id, q.id]);
      observe(q, questionKeys, () =>
        this.questions.set(key, { a, q, position }),
      );
      this.questions.set(key, { a, q, position });
    };
    a.deliveries.forEach((d, i) => td(d, this.positions.get(d) ?? i));
    a.questions.forEach((q, i) => tq(q, i));
    ledger(a.deliveries, td, (d) => {
      const key = JSON.stringify([a.id, d.id]);
      this.deliveries.delete(key);
      this.deleted.set(key, { sessionId: a.id, id: d.id });
    });
    ledger(a.questions, tq, () => {
      throw new Error("Questions cannot be removed");
    });
    let messages = a.messages;
    const watch = () =>
      ledger(
        messages,
        () => this.windows.add(a),
        () => this.windows.add(a),
      );
    watch();
    Object.defineProperty(a, "messages", {
      enumerable: true,
      configurable: true,
      get: () => messages,
      set: (next) => {
        messages = next;
        watch();
        this.windows.add(a);
      },
    });
    if (fresh) {
      this.sessions.set(a.id, a);
      this.configs.set(a.id, a);
    } else {
      for (const d of a.deliveries)
        this.deliveries.delete(JSON.stringify([a.id, d.id]));
      for (const q of a.questions)
        this.questions.delete(JSON.stringify([a.id, q.id]));
    }
    return a;
  }
  flush() {
    if (
      !this.sessions.size &&
      !this.configs.size &&
      !this.deliveries.size &&
      !this.questions.size &&
      !this.deleted.size
    )
      return;
    this.db.transaction((tx) => {
      for (const a of this.sessions.values()) {
        const row = sessionRow(a);
        tx.insert(s.sessions)
          .values(row)
          .onConflictDoUpdate({ target: s.sessions.id, set: row })
          .run();
      }
      for (const a of this.configs.values()) {
        const row = { sessionId: a.id, captured: pick(a, configKeys) };
        tx.insert(s.sessionConfig)
          .values(row)
          .onConflictDoUpdate({ target: s.sessionConfig.sessionId, set: row })
          .run();
      }
      for (const { a, q, position } of this.questions.values()) {
        const row = {
          sessionId: a.id,
          id: q.id,
          position,
          itemId: q.itemId,
          itemIndex: q.index,
          title: q.title,
          text: q.text,
          options: q.options,
          state: q.state,
          answer: q.answer ?? null,
          at: q.at,
        };
        tx.insert(s.questions)
          .values(row)
          .onConflictDoUpdate({
            target: [s.questions.sessionId, s.questions.id],
            set: row,
          })
          .run();
      }
      for (const { a, d, position } of this.deliveries.values()) {
        const row = {
          sessionId: a.id,
          operationId: d.id,
          position,
          ...pick(d, ["text", "source", "status", "at"]),
          attemptId: d.attemptId ?? null,
          turnId: d.turnId ?? null,
          error: d.error ?? null,
          images: d.images ?? null,
          report: pick(d, [
            "reportingWorkerId",
            "reportingReviewerId",
            "reportingResearcherId",
            "reviewTarget",
            "researchQuestion",
          ]),
        };
        tx.insert(s.deliveries)
          .values(row)
          .onConflictDoUpdate({
            target: [s.deliveries.sessionId, s.deliveries.operationId],
            set: row,
          })
          .run();
        // Immutable associations insert once; status confirmation never rewrites them.
        for (const [i, questionId] of d.questionIds.entries())
          tx.insert(s.deliveryQuestions)
            .values({
              sessionId: a.id,
              operationId: d.id,
              questionId,
              position: i,
              answer:
                d.answers?.find((v) => v.questionId === questionId)?.answer ??
                null,
            })
            .onConflictDoNothing()
            .run();
      }
      for (const d of this.deleted.values())
        tx.delete(s.deliveries)
          .where(
            and(
              eq(s.deliveries.sessionId, d.sessionId),
              eq(s.deliveries.operationId, d.id),
            ),
          )
          .run();
    });
    this.sessions.clear();
    this.configs.clear();
    this.questions.clear();
    this.deliveries.clear();
    this.deleted.clear();
  }
  hasOperationElsewhere(id: string, operation: string) {
    return !!this.db
      .select({ id: s.deliveries.operationId })
      .from(s.deliveries)
      .where(
        and(
          eq(s.deliveries.operationId, operation),
          ne(s.deliveries.sessionId, id),
        ),
      )
      .limit(1)
      .get();
  }
  close() {
    this.windows.clear();
    this.sessions.clear();
    this.configs.clear();
    this.deliveries.clear();
    this.questions.clear();
    this.deleted.clear();
    this.sqlite.close();
  }
}
