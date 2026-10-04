import { ImageStore } from "./images";
import type { MessageImage } from "../src/contracts";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  Answer,
  Delivery,
  Detail,
  Project,
  Settings,
  Snapshot,
  HistorySession,
  Message,
} from "../src/contracts";
import type {
  Runtime,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
} from "./runtime";
import { sameDirectory } from "./directory";
import { DeliveryRejected, StaleTurn } from "./runtime";
import { z } from "zod";
import { roleTools, toolDefinitions, sessionTitle } from "./tools";

type State = {
  agents: RuntimeAgent[];
  revision: number;
};
export class Workspace {
  readonly images: ImageStore;
  private readonly db: Database;
  private readonly state: State;
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly finalAnswers = new Map<
    string,
    Map<string, { id: string; text: string }>
  >();
  private readonly subscribers = new Set<() => void>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly opening = new Map<string, Promise<RuntimeHandle>>();
  private readonly completedTurns = new Set<string>();
  private readonly closingWorkers = new Set<string>();
  private readonly failedWorkerCloses = new Set<string>();
  private disposed = false;
  constructor(
    private readonly options: {
      directory: string;
      runtime: Runtime;
      projects: () => Promise<Project[]>;
    },
  ) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.images = new ImageStore(join(options.directory, "media"));
    this.db = new Database(join(options.directory, "workspace.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    const row = this.db
      .query("SELECT value FROM workspace WHERE id=1")
      .get() as { value: string } | null;
    const stored: State = row
      ? JSON.parse(row.value)
      : { agents: [], revision: 0 };
    this.state = { agents: stored.agents, revision: stored.revision };
    for (const a of this.state.agents) {
      if (
        a.state === "working" ||
        a.state === "stopping" ||
        (a.state === "error" && a.turnId)
      ) {
        a.turnEnded = false;
        if (a.stop?.status === "pending") a.stop.status = "unknown";
        a.state = "error";
        a.error = "Backend restarted. Send a message to resume.";
        a.turnId = undefined;
        a.workingSince = undefined;
      }
      for (const d of a.deliveries)
        if (d.status === "sending" || d.status === "queued") {
          d.status = "uncertain";
          d.error =
            "Backend restarted before delivery was confirmed. Check the conversation before sending again.";
        }
    }
    this.save();
    this.advanceWorkerCloses();
    for (const a of this.state.agents) {
      if (a.role !== "orc" || a.closed || !a.threadId) continue;
      void this.serialize(a.id, async () => {
        const title = await this.options.runtime.readTitle(a.threadId!);
        if (!this.disposed && !a.closed) {
          a.title = title ?? "New session";
          this.save();
        }
      }).catch(() => {});
    }
  }
  private save() {
    if (this.disposed) return;
    this.state.revision++;
    this.db
      .query(
        "INSERT INTO workspace(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify(this.state, (key, value) =>
          key === "inheritSettings" || key === "restoreArchived"
            ? undefined
            : value,
        ),
      );
    for (const listener of this.subscribers) listener();
  }
  subscribe(listener: () => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
  private event(a: RuntimeAgent, event: RuntimeEvent) {
    if (a.closed || this.disposed) return;
    if (event.type === "working") {
      a.turnEnded = false;
      if (a.stop && a.stop.turnId !== event.turnId) a.stop = undefined;
      a.state =
        a.stop?.turnId === event.turnId && a.stop.status === "pending"
          ? "stopping"
          : "working";
      a.turnId = event.turnId;
      a.workingSince ??= Date.now();
      a.error = undefined;
    } else if (event.type === "item") {
      const item = event.item;
      if (item.type !== "agentMessage") return;
      if (item.delivery === "async" && item.questions?.length) {
        const newQuestions: string[] = [];
        item.questions.forEach((q, index) => {
          const id = `${item.id}:${index}`;
          if (!a.questions.some((q) => q.id === id)) {
            a.questions.push({
              id,
              itemId: item.id,
              index,
              title: q.header ?? "Question",
              text: q.question,
              options: q.options ?? [],
              state: a.role === "worker" ? "delegated" : "unanswered",
              at: Date.now(),
            });
            newQuestions.push(id);
          }
        });
        if (item.text && !a.messages.some((m) => m.id === item.id))
          a.messages.push({
            id: item.id,
            role: "assistant",
            text: item.text,
            turnId: event.turnId,
            at: Date.now(),
          });
        if (a.role === "worker" && newQuestions.length) {
          const questions = a.questions.filter((q) =>
            newQuestions.includes(q.id),
          );
          const text =
            `Worker “${a.title}” needs a decision. Worker ID: ${a.id}\n\n` +
            (item.text ? `${item.text}\n\n` : "") +
            questions
              .map(
                (q) =>
                  `Question ID: ${q.id}\n${q.text}\n${q.options.map((o) => o.label).join("; ")}`,
              )
              .join("\n\n");
          void this.report(a, text, `report:${a.id}:${item.id}`).catch(
            (error) => {
              a.error =
                error instanceof Error
                  ? error.message
                  : "Could not forward the question to Orc";
              this.save();
            },
          );
        }
      } else if (item.phase === "final_answer" && item.text) {
        const key = `${a.id}/${event.turnId}`;
        const answers = this.finalAnswers.get(key) ?? new Map();
        answers.set(item.id, { id: item.id, text: item.text });
        this.finalAnswers.set(key, answers);
        return;
      } else return;
    } else if (event.type === "completed") {
      const key = `${a.id}/${event.turnId}`;
      this.completedTurns.add(key);
      for (const item of this.finalAnswers.get(key)?.values() ?? []) {
        if (!a.messages.some((m) => m.id === item.id))
          a.messages.push({
            ...item,
            role: "assistant",
            turnId: event.turnId,
            at: Date.now(),
          });
      }
      this.finalAnswers.delete(key);
      if (a.turnId === event.turnId) {
        a.turnEnded = true;
        const stopped =
          a.stop?.turnId === event.turnId && event.status === "interrupted";
        if (a.stop?.turnId === event.turnId)
          a.stop.status = stopped ? "confirmed" : "completed";
        a.state = stopped || event.status === "completed" ? "idle" : "error";
        a.error =
          a.state === "idle"
            ? undefined
            : (event.error ?? "Work was interrupted");
        a.turnId = undefined;
        a.workingSince = undefined;
      }
    } else {
      a.turnEnded = false;
      if (event.type === "disconnected") this.handles.delete(a.id);
      if (a.stop?.status === "pending") a.stop.status = "unknown";
      a.state = "error";
      a.error = event.error;
      if (event.type === "disconnected") a.turnId = undefined;
      a.workingSince = undefined;
    }
    this.save();
    this.advanceWorkerCloses();
  }
  private agent(id: string) {
    const a = this.state.agents.find((a) => a.id === id);
    if (!a || a.closed) throw new Error("Session not found");
    return a;
  }
  private publicAgent(a: RuntimeAgent): Agent {
    const {
      token: _token,
      inheritSettings: _inheritSettings,
      restoreArchived: _restoreArchived,
      turnEnded: _turnEnded,
      messages: _messages,
      deliveries: _deliveries,
      workerDefaults: _workerDefaults,
      ...agent
    } = a;
    return structuredClone(agent);
  }
  snapshot(): Snapshot {
    return {
      agents: this.state.agents
        .filter((a) => !a.closed)
        .map((a) => this.publicAgent(a)),
      settings: null,
      revision: this.state.revision,
    };
  }
  detail(id: string): Detail {
    const a = this.agent(id);
    return {
      ...this.publicAgent(a),
      messages: structuredClone(a.messages),
      deliveries: structuredClone(a.deliveries),
    };
  }
  async rename(id: string, title: string) {
    const a = this.agent(id);
    if (a.role !== "orc") throw new Error("Only Orc titles can be edited");
    const name = sessionTitle.parse(title);
    return this.serialize(id, async () => {
      const handle = await this.handle(a, false);
      await handle.rename(name);
      a.title = name;
      this.save();
      return this.detail(id);
    });
  }
  async weekly() {
    try {
      return await this.options.runtime.weekly();
    } catch {
      return { remaining: null, fetchedAt: Date.now() };
    }
  }
  async stop(id: string, turnId: string) {
    const a = this.agent(id);
    if (
      a.role !== "orc" ||
      a.state !== "working" ||
      !turnId ||
      a.turnId !== turnId
    )
      throw new Error(
        "The observed Orc turn is no longer Working. Refresh before stopping.",
      );
    const handle = this.handles.get(id);
    if (!handle) throw new Error("Turn connection unavailable");
    a.stop = { turnId, status: "pending" };
    a.state = "stopping";
    this.save();
    try {
      await handle.interrupt(turnId);
    } catch {
      if (a.stop?.turnId === turnId && a.stop.status === "pending") {
        a.stop.status = "unknown";
        this.save();
      }
    }
    return this.detail(id);
  }
  models() {
    return this.options.runtime.models();
  }
  projects() {
    return this.options.projects();
  }
  private async historyProject(alias: string) {
    const project = (await this.projects()).find((p) => p.alias === alias);
    if (!project) throw new Error("Registered project not found");
    return project;
  }
  private historyIdentity(session: HistorySession): HistorySession {
    const agent = this.state.agents.find(
      (a) => a.threadId === session.threadId,
    );
    if (!agent) return session;
    const owner = this.state.agents.find((a) => a.id === agent.ownerId);
    return {
      ...session,
      title: agent.role === "worker" ? agent.title : session.title,
      role: agent.role,
      agentId: agent.id,
      closed: agent.closed,
      ownerThreadId: owner?.threadId,
      ownerProject: owner?.project.alias,
    };
  }
  async history(alias: string, query: string, cursor?: string) {
    const project = await this.historyProject(alias);
    const schema = z.object({
      cwd: z.string(),
      query: z.string(),
      cursor: z.string(),
    });
    const position = cursor ? schema.parse(JSON.parse(cursor)) : undefined;
    if (position && (position.cwd !== project.path || position.query !== query))
      throw new Error("Search changed. Start a new history search.");
    let nextCursor = position?.cursor;
    const sessions: HistorySession[] = [];
    for (let scan = 0; scan < 8 && sessions.length < 30; scan++) {
      const page = await this.options.runtime.history(project.path, nextCursor);
      for (const entry of page.sessions) {
        const session = this.historyIdentity(entry);
        if (
          sameDirectory(session.cwd, project.path) &&
          `${session.title} ${session.preview}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
        )
          sessions.push(session);
      }
      if (page.nextCursor && page.nextCursor === nextCursor)
        throw new Error("History returned a repeated page");
      nextCursor = page.nextCursor ?? undefined;
      if (!nextCursor) break;
    }
    sessions.sort(
      (a, b) =>
        b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId),
    );
    return {
      sessions,
      nextCursor: nextCursor
        ? JSON.stringify({ cwd: project.path, query, cursor: nextCursor })
        : null,
    };
  }
  async historySession(alias: string, threadId: string) {
    const project = await this.historyProject(alias);
    const session = await this.options.runtime.historyThread(threadId);
    if (!sameDirectory(session.cwd, project.path))
      throw new Error("Session does not belong to this project directory");
    return this.historyIdentity(session);
  }
  async historyMessages(alias: string, threadId: string, cursor?: string) {
    await this.historySession(alias, threadId);
    return this.options.runtime.historyMessages(threadId, cursor);
  }
  async agentHistory(id: string, cursor?: string) {
    const agent = this.agent(id);
    if (!agent.threadId || !agent.historyCursor)
      return { messages: [], nextCursor: null };
    const page = await this.options.runtime.historyMessages(
      agent.threadId,
      cursor ?? agent.historyCursor,
    );
    const captured = new Map<string, Message[]>();
    for (const message of agent.messages.slice(
      0,
      agent.historyMessageCount ?? 0,
    )) {
      if (!message.turnId) continue;
      const group = captured.get(message.turnId) ?? [];
      group.push(message);
      captured.set(message.turnId, group);
    }
    const messages: Message[] = [],
      inserted = new Set<string>();
    for (const message of page.messages) {
      const group = message.turnId ? captured.get(message.turnId) : undefined;
      if (!group) messages.push(message);
      else if (!inserted.has(message.turnId!)) {
        messages.push(...group);
        inserted.add(message.turnId!);
      }
    }
    for (const message of messages) {
      if (!message.images?.length || !this.options.runtime.historyImage)
        continue;
      const restored: MessageImage[] = [];
      for (const image of message.images) {
        if (image.availability !== "missing") {
          restored.push(image);
          continue;
        }
        try {
          const file = await this.options.runtime.historyImage(
            agent.threadId,
            image.id,
          );
          if (!file) {
            restored.push(image);
            continue;
          }
          const operation = `history-${image.id}`;
          const refs = await this.images.upload(agent.id, operation, "", [
            file,
          ]);
          this.images.commit(agent.id, operation, "", refs);
          restored.push(...refs);
        } catch {
          restored.push(image);
        }
      }
      message.images = restored;
    }
    return { ...page, messages };
  }
  async resumeHistory(
    alias: string,
    threadId: string,
    archived: boolean,
    settings?: Settings,
  ) {
    return this.serialize(`history:${threadId}`, async () => {
      const project = await this.historyProject(alias);
      const existing = this.state.agents.find((a) => a.threadId === threadId);
      if (
        existing?.project.path !== undefined &&
        !sameDirectory(existing.project.path, project.path)
      )
        throw new Error("Session does not belong to this project directory");
      if (existing?.role === "worker")
        throw new Error("Continue this Worker through its original Orc");
      const restore = async () => {
        if (existing && !existing.closed) return this.publicAgent(existing);
        const session = await this.historySession(alias, threadId);
        if (session.role === "worker")
          throw new Error("Continue this Worker through its original Orc");
        const workerDefaults = existing
          ? existing.workerDefaults
          : (await this.executionSettings(settings)).worker;
        const agent: RuntimeAgent = existing ?? {
          id: crypto.randomUUID(),
          token: crypto.randomUUID(),
          role: "orc",
          project,
          title: session.title,
          model: session.model ?? "",
          effort: session.effort ?? "",
          serviceTier: "default",
          state: "idle",
          closed: true,
          threadId,
          questions: [],
          messages: [],
          deliveries: [],
          inheritSettings: true,
          workerDefaults,
        };
        agent.restoreArchived = archived;
        try {
          const handle = await this.handle(agent);
          agent.title = handle.threadName ?? session.title;
          if (!existing) {
            agent.model = handle.model ?? agent.model;
            agent.effort = handle.effort ?? agent.effort;
            agent.serviceTier = handle.serviceTier ?? agent.serviceTier;
            this.state.agents.push(agent);
          }
          agent.historyCursor = handle.historyCursor;
          agent.historyMessageCount = handle.historyCursor
            ? agent.messages.length
            : undefined;
          agent.closed = false;
          agent.state = "idle";
          agent.error = undefined;
          agent.turnEnded = true;
          delete agent.inheritSettings;
          this.save();
          return this.publicAgent(agent);
        } finally {
          delete agent.restoreArchived;
        }
      };
      return existing ? this.serialize(existing.id, restore) : restore();
    });
  }
  private async executionSettings(settings?: Settings) {
    const models = await this.models();
    const first = models.find((m) => m.isDefault) ?? models[0];
    if (!first) throw new Error("No models available");
    const value = settings ?? {
      fast: false,
      orc: { model: first.id, effort: first.defaultEffort },
      worker: { model: first.id, effort: first.defaultEffort },
    };
    const capture = (defaults: Settings["orc"]) => {
      const model = models.find((m) => m.id === defaults.model);
      if (!model?.efforts.includes(defaults.effort))
        throw new Error("Choose a supported model and reasoning effort");
      if (value.fast && !model.fastTier)
        throw new Error("Fast is not available for this model");
      return {
        ...defaults,
        serviceTier: value.fast ? model.fastTier! : "default",
      };
    };
    return { orc: capture(value.orc), worker: capture(value.worker) };
  }
  async createOrc(alias: string, settings?: Settings) {
    const project = (await this.projects()).find((p) => p.alias === alias);
    if (!project) throw new Error("Registered project not found");
    const captured = await this.executionSettings(settings);
    const a: RuntimeAgent = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      role: "orc",
      project,
      title: "New session",
      ...captured.orc,
      workerDefaults: captured.worker,
      state: "idle",
      closed: false,
      questions: [],
      messages: [],
      deliveries: [],
    };
    this.state.agents.push(a);
    this.save();
    try {
      await this.handle(a);
    } catch (error) {
      a.closed = true;
      this.save();
      throw error;
    }
    return this.publicAgent(a);
  }
  private async handle(a: RuntimeAgent, refreshTitle = true) {
    let handle = this.handles.get(a.id);
    if (!handle) {
      let opening = this.opening.get(a.id);
      if (!opening) {
        let disconnected = false;
        opening = this.options.runtime
          .open(a, (event) => {
            if (disconnected) return;
            this.event(a, event);
            if (event.type === "disconnected") disconnected = true;
          })
          .then(async (handle) => {
            if (disconnected) {
              await handle.close();
              throw new Error(
                "App-server disconnected while opening the thread",
              );
            }
            return handle;
          });
        this.opening.set(a.id, opening);
      }
      try {
        handle = await opening;
        a.threadId = handle.threadId;
        if (refreshTitle && a.role === "orc")
          a.title = handle.threadName ?? "New session";
        this.handles.set(a.id, handle);
        this.save();
      } finally {
        this.opening.delete(a.id);
      }
    }
    return handle;
  }
  private serialize<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(id, next);
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
        this.advanceWorkerCloses();
      })
      .catch(() => {});
    return next;
  }
  private async deliver(
    a: RuntimeAgent,
    text: string,
    requestId: string,
    source: Delivery["source"],
    questionIds: string[] = [],
    answers?: Answer[],
    images?: MessageImage[],
  ) {
    if (this.disposed) throw new Error("Workspace is stopped");
    if (a.closeRequest && !questionIds.length)
      throw new Error("Worker is awaiting closure and cannot accept new tasks");
    if (a.state === "stopping") {
      const queued = a.deliveries.find(
        (d) => d.id === requestId && d.status === "queued",
      );
      if (queued) {
        queued.status = "failed";
        queued.error =
          "Orc is stopping. Report retained; retry after its observed turn outcome.";
        this.save();
      }
      return this.detail(a.id);
    }
    if (!text.trim() && !images?.length)
      throw new Error("Write a message first");
    if (text.length > 100_000) throw new Error("Message is too long");
    let d = a.deliveries.find((d) => d.id === requestId);
    if (d && d.status !== "failed" && d.status !== "queued")
      return this.detail(a.id);
    if (!d) {
      d = {
        id: requestId,
        text,
        source,
        status: "sending",
        questionIds,
        ...(answers ? { answers: structuredClone(answers) } : {}),
        ...(images?.length ? { images: structuredClone(images) } : {}),
        at: Date.now(),
      };
      a.deliveries.push(d);
    } else {
      d.status = "sending";
      d.error = undefined;
    }
    // Retries use the persisted envelope, including its delegated question IDs.
    text = d.text;
    questionIds = d.questionIds;
    const previousState = a.state;
    this.save();
    const messagePosition = a.messages.length;
    try {
      let paths: string[] = [];
      try {
        paths = d.images?.length
          ? this.images.commit(a.id, requestId, text, d.images)
          : [];
      } catch (error) {
        throw new DeliveryRejected((error as Error).message);
      }
      const handle = await this.handle(a);
      const activeTurn = a.state === "working" ? a.turnId : undefined;
      a.turnEnded = false;
      a.state = "working";
      a.workingSince ??= Date.now();
      a.error = undefined;
      this.save();
      let turnId: string;
      try {
        turnId = await handle.send(text, activeTurn, paths);
      } catch (error) {
        if (!(error instanceof StaleTurn)) throw error;
        if (
          a.stop &&
          a.stop.turnId === activeTurn &&
          (a.stop.status === "pending" || a.stop.status === "unknown")
        )
          throw new DeliveryRejected(
            "Observed Orc turn is stopping. Delivery retained; retry explicitly after its authoritative outcome.",
          );
        const currentTurn =
          error.activeTurnId ??
          (a.turnId !== activeTurn ? a.turnId : undefined);
        a.turnId = currentTurn;
        turnId = await handle.send(text, currentTurn, paths);
      }
      if (!this.completedTurns.has(`${a.id}/${turnId}`)) a.turnId = turnId;
      if (a.stop && a.stop.turnId !== turnId) a.stop = undefined;
      if (!a.messages.some((m) => m.id === requestId))
        a.messages.splice(messagePosition, 0, {
          id: requestId,
          role: "user",
          text,
          turnId,
          at: d.at,
          ...(d.images?.length ? { images: d.images } : {}),
        });
      d.status = "sent";
      d.turnId = turnId;
      for (const q of a.questions)
        if (questionIds.includes(q.id)) {
          q.state = "answered";
          const answer = d.answers?.find((a) => a.questionId === q.id);
          if (answer) q.answer = answer.answer;
        }
      this.save();
      if (
        a.role === "orc" &&
        d.source === "user" &&
        text.trim() &&
        a.title === "New session" &&
        a.messages.filter((m) => m.role === "user").length === 1
      ) {
        void handle
          .title(text)
          .then((title) => {
            if (title && a.title === "New session") {
              a.title = title;
              this.save();
            }
          })
          .catch(() => {});
      }
    } catch (error) {
      d.status = error instanceof DeliveryRejected ? "failed" : "uncertain";
      d.error = error instanceof Error ? error.message : "Delivery failed";
      // A rejected steer does not stop the turn already running. Runtime
      // completion/disconnection events remain authoritative for its lifecycle.
      if (
        (a.state === "working" && !a.turnId) ||
        (previousState !== "working" && a.state === "idle")
      ) {
        a.state = "error";
        a.error = d.error;
        a.workingSince = undefined;
      }
      this.save();
    }
    return this.detail(a.id);
  }
  retryDelivery(id: string, deliveryId: string) {
    const delivery = this.agent(id).deliveries.find((d) => d.id === deliveryId);
    if (delivery?.source === "question" && delivery.status === "failed") {
      if (!delivery.answers)
        throw new Error("Answer batch has no persisted envelope");
      return this.answerBatch(id, delivery.answers, deliveryId);
    }
    return this.serialize(id, async () => {
      const a = this.agent(id);
      const d = a.deliveries.find((d) => d.id === deliveryId);
      if (!d || d.source === "user" || d.status !== "failed")
        throw new Error("Only a rejected report or answer can be retried");
      return this.deliver(a, d.text, d.id, d.source, d.questionIds);
    });
  }
  lookup(id: string, operationId: string) {
    const a = this.state.agents.find((a) => a.id === id);
    if (!a) throw new Error("Agent not found");
    const d = a.deliveries.find((d) => d.id === operationId);
    return {
      operationId,
      state: !d
        ? ("missing" as const)
        : d.status === "sent"
          ? ("accepted" as const)
          : d.status === "failed"
            ? ("rejected" as const)
            : d.status === "uncertain"
              ? ("uncertain" as const)
              : ("pending" as const),
      turnId: d?.turnId ?? null,
      error: d?.error ?? null,
    };
  }
  send(id: string, text: string, requestId: string, images?: MessageImage[]) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      if (a.role !== "orc") throw new Error("Send instructions through Orc");
      const previous = a.deliveries.find((d) => d.id === requestId);
      if (previous) {
        if (
          previous.text !== text ||
          previous.source !== "user" ||
          JSON.stringify(previous.images ?? []) !== JSON.stringify(images ?? [])
        )
          throw new Error("Operation ID is bound to different content");
        return this.detail(id);
      }
      if (images?.length) this.images.validate(a.id, requestId, text, images);
      if (a.state === "stopping") {
        a.deliveries.push({
          id: requestId,
          text,
          source: "user",
          status: "failed",
          questionIds: [],
          images,
          at: Date.now(),
          error: "Wait for the observed turn outcome before sending",
        });
        this.save();
        return this.detail(id);
      }
      return this.deliver(a, text, requestId, "user", [], undefined, images);
    });
  }
  closeTree(id: string) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      if (a.role !== "orc") throw new Error("Only Orc can close Workers");
      const workers = this.state.agents.filter(
        (w) => w.ownerId === id && !w.closed,
      );
      if (workers.length)
        throw new Error(
          `Ask Orc to close its Workers first: ${workers.map((w) => w.title).join(", ")}`,
        );
      this.assertIdle(a);
      const handle = this.handles.get(id);
      await handle?.close();
      this.handles.delete(id);
      a.closed = true;
      this.save();
      return { closed: true as const, id };
    });
  }
  answerBatch(id: string, answers: Answer[], operationId: string) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      if (a.role !== "orc")
        throw new Error("Answer Worker questions through Orc");
      const frozen = answers.map((answer) => ({
        questionId: answer.questionId,
        answer: answer.answer.trim(),
      }));
      const prior = a.deliveries.find((d) => d.id === operationId);
      if (prior) {
        if (
          prior.source !== "question" ||
          JSON.stringify(prior.answers) !== JSON.stringify(frozen)
        )
          throw new Error("Operation ID is bound to different content");
        if (prior.status !== "failed") return this.detail(id);
      }
      if (a.state === "stopping")
        throw new Error("Wait for the observed turn outcome before answering");
      if (
        !frozen.length ||
        new Set(frozen.map((answer) => answer.questionId)).size !==
          frozen.length
      )
        throw new Error("Choose a non-empty batch of distinct questions");
      const questions = frozen.map((answer) => {
        const q = a.questions.find((q) => q.id === answer.questionId);
        if (!q || q.state !== "unanswered")
          throw new Error(
            "Every submitted question must belong to this Orc and remain unanswered",
          );
        if (!answer.answer || answer.answer.length > 100_000)
          throw new Error("Write a valid answer for every question");
        if (
          a.deliveries.some(
            (d) =>
              d.source === "question" &&
              d.questionIds.includes(q.id) &&
              ["sending", "queued", "uncertain"].includes(d.status),
          )
        )
          throw new Error(
            "Check the original answer batch before another submission",
          );
        return q;
      });
      const text = frozen
        .map(
          (answer, i) =>
            `Question: ${questions[i].text}\nAnswer: ${answer.answer}`,
        )
        .join("\n\n");
      return this.deliver(
        a,
        text,
        operationId,
        "question",
        frozen.map((answer) => answer.questionId),
        frozen,
      );
    });
  }
  skills(id: string) {
    return this.options.runtime.skills(this.agent(id).project.path);
  }
  private authenticated(token: string) {
    const a = this.state.agents.find((a) => a.token === token && !a.closed);
    if (!a) throw new Error("Agent authorization failed");
    return a;
  }
  identity(token: string) {
    const a = this.authenticated(token);
    return { id: a.id, role: a.role, tools: [...roleTools[a.role]] };
  }
  private ownedWorker(owner: RuntimeAgent, id: string) {
    const w = this.agent(id);
    if (w.role !== "worker" || w.ownerId !== owner.id)
      throw new Error("Worker does not belong to this Orc");
    return w;
  }
  async tool(token: string, name: string, args: unknown): Promise<unknown> {
    const a = this.authenticated(token);
    if (!(roleTools[a.role] as readonly string[]).includes(name))
      throw new Error("Tool is not available to this role");
    switch (name) {
      case "worker_start": {
        const input = z.object(toolDefinitions.worker_start.shape).parse(args);
        return this.serialize(a.id, async () => {
          this.agent(a.id);
          const project = (await this.projects()).find(
            (p) => p.alias === input.project,
          );
          if (!project) throw new Error("Registered project not found");
          const w: RuntimeAgent = {
            id: crypto.randomUUID(),
            token: crypto.randomUUID(),
            role: "worker",
            ownerId: a.id,
            project,
            title: input.title,
            ...(a.workerDefaults ?? {
              model: a.model,
              effort: a.effort,
              serviceTier: a.serviceTier,
            }),
            state: "idle",
            closed: false,
            questions: [],
            messages: [],
            deliveries: [],
          };
          this.state.agents.push(w);
          this.save();
          try {
            await this.handle(w);
          } catch (error) {
            w.closed = true;
            this.save();
            throw error;
          }
          await this.deliver(
            w,
            `Assigned spec: ${input.spec}\n\n${input.message}`,
            crypto.randomUUID(),
            "worker",
          );
          return this.detail(w.id);
        });
      }
      case "worker_list": {
        z.object(toolDefinitions.worker_list.shape).parse(args);
        return this.state.agents
          .filter((w) => w.role === "worker" && w.ownerId === a.id && !w.closed)
          .map((w) => this.publicAgent(w));
      }
      case "worker_read": {
        const input = z.object(toolDefinitions.worker_read.shape).parse(args);
        const w = this.ownedWorker(a, input.workerId);
        const end = input.before
          ? w.messages.findIndex((m) => m.id === input.before)
          : w.messages.length;
        if (end < 0) throw new Error("History cursor not found");
        const start = Math.max(0, end - (input.limit ?? 20));
        const messages = structuredClone(w.messages.slice(start, end));
        return {
          worker: this.publicAgent(w),
          messages,
          hasMore: start > 0,
          nextBefore: start > 0 ? messages[0]?.id : null,
        };
      }
      case "worker_send": {
        const input = z.object(toolDefinitions.worker_send.shape).parse(args);
        const w = this.ownedWorker(a, input.workerId);
        for (const id of input.questionIds ?? [])
          if (!w.questions.some((q) => q.id === id && q.state === "delegated"))
            throw new Error("Delegated question not found");
        return this.serialize(w.id, () =>
          this.deliver(
            this.agent(w.id),
            input.message,
            crypto.randomUUID(),
            "worker",
            input.questionIds,
          ),
        );
      }
      case "worker_close": {
        const input = z.object(toolDefinitions.worker_close.shape).parse(args);
        const w = this.ownedWorker(a, input.workerId);
        if (input.confirmInterrupted && (w.state !== "error" || w.turnId))
          throw new Error(
            "Only an interrupted Worker with no observed active turn can be confirmed",
          );
        w.closeRequest ??= {
          reason: "Waiting for current work to finish",
        };
        if (input.confirmInterrupted) w.turnEnded = true;
        this.failedWorkerCloses.delete(w.id);
        this.save();
        await this.advanceWorkerCloses();
        return {
          closed: w.closed,
          closing: !w.closed,
          workerId: w.id,
          reason: w.closed ? undefined : w.closeRequest.reason,
        };
      }
      case "worker_report": {
        const input = z.object(toolDefinitions.worker_report.shape).parse(args);
        return this.report(
          a,
          `Worker “${a.title}” reports:\n\n${input.message}`,
          crypto.randomUUID(),
        );
      }
    }
  }
  private async report(worker: RuntimeAgent, text: string, requestId: string) {
    if (text.length > 100_000)
      throw new Error(
        "Message is too long, including the Worker report header",
      );
    const owner = this.agent(worker.ownerId!);
    owner.deliveries.push({
      id: requestId,
      text,
      source: "worker",
      reportingWorkerId: worker.id,
      status: "queued",
      questionIds: [],
      at: Date.now(),
    });
    this.save();
    return this.serialize(owner.id, () =>
      this.deliver(this.agent(owner.id), text, requestId, "worker"),
    );
  }
  private async advanceWorkerCloses() {
    if (this.disposed) return;
    let changed = false;
    const releases: Promise<void>[] = [];
    for (const w of this.state.agents) {
      if (
        w.role !== "worker" ||
        w.closed ||
        !w.closeRequest ||
        this.closingWorkers.has(w.id) ||
        this.failedWorkerCloses.has(w.id)
      )
        continue;
      let reason: string | undefined;
      if (this.queues.has(w.id) || this.opening.has(w.id))
        reason = "Waiting for in-flight Worker operations";
      else if (
        w.deliveries.some((d) =>
          ["queued", "sending", "uncertain"].includes(d.status),
        )
      )
        reason = "Waiting for Worker delivery confirmation";
      else if (
        this.state.agents
          .find((a) => a.id === w.ownerId)
          ?.deliveries.some(
            (d) => d.reportingWorkerId === w.id && d.status !== "sent",
          )
      )
        reason =
          "Waiting for report delivery to Orc; retry rejected reports or inspect unconfirmed delivery";
      else if (w.questions.some((q) => q.state !== "answered"))
        reason = "Waiting for answers to delegated questions";
      else if (
        w.state === "working" ||
        w.state === "stopping" ||
        (w.state !== "idle" && !w.turnEnded)
      )
        reason =
          w.state === "working"
            ? "Waiting for current work to finish"
            : "Current turn outcome is unconfirmed; inspect the Worker before resolving closure";
      if (reason) {
        if (w.closeRequest.reason !== reason) {
          w.closeRequest.reason = reason;
          changed = true;
        }
        continue;
      }
      this.closingWorkers.add(w.id);
      releases.push(
        (async () => {
          try {
            await this.handles.get(w.id)?.close();
            if (this.disposed) return;
            this.handles.delete(w.id);
            w.closed = true;
          } catch (error) {
            if (this.disposed) return;
            this.failedWorkerCloses.add(w.id);
            w.closeRequest!.reason = `Native thread release failed: ${String(error)}. Retry Worker close.`;
          } finally {
            this.closingWorkers.delete(w.id);
            this.save();
          }
        })(),
      );
    }
    if (changed) this.save();
    await Promise.all(releases);
  }
  private assertIdle(a: RuntimeAgent) {
    if (
      a.state !== "idle" ||
      this.opening.has(a.id) ||
      a.deliveries.some(
        (d) =>
          d.status === "queued" ||
          d.status === "sending" ||
          d.status === "uncertain",
      )
    )
      throw new Error(
        `${a.title} is still working or has an unconfirmed delivery`,
      );
    if (
      a.role === "worker" &&
      this.agent(a.ownerId!).deliveries.some(
        (d) => d.reportingWorkerId === a.id && d.status !== "sent",
      )
    )
      throw new Error(`${a.title} has an undelivered report to Orc`);
    if (a.questions.some((q) => q.state !== "answered"))
      throw new Error(`${a.title} has unanswered questions`);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.subscribers.clear();
    void this.options.runtime.close();
    this.db.close();
  }
}
