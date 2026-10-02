import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  Delivery,
  Detail,
  Project,
  Settings,
  Snapshot,
} from "../src/contracts";
import type {
  Runtime,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeHandle,
} from "./runtime";
import { DeliveryRejected, StaleTurn } from "./runtime";
import { z } from "zod";
import { roleTools, toolDefinitions } from "./tools";

type State = {
  agents: RuntimeAgent[];
  settings: Settings | null;
  revision: number;
};
export class Workspace {
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
  private disposed = false;
  constructor(
    private readonly options: {
      directory: string;
      runtime: Runtime;
      projects: () => Promise<Project[]>;
    },
  ) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.db = new Database(join(options.directory, "workspace.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
    );
    const row = this.db
      .query("SELECT value FROM workspace WHERE id=1")
      .get() as { value: string } | null;
    this.state = row
      ? JSON.parse(row.value)
      : { agents: [], settings: null, revision: 0 };
    for (const a of this.state.agents) {
      if (a.state === "working") {
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
  }
  private save() {
    if (this.disposed) return;
    this.state.revision++;
    this.db
      .query(
        "INSERT INTO workspace(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(this.state));
    for (const listener of this.subscribers) listener();
  }
  subscribe(listener: () => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
  private event(a: RuntimeAgent, event: RuntimeEvent) {
    if (a.closed || this.disposed) return;
    if (event.type === "working") {
      a.state = "working";
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
        a.state = event.status === "completed" ? "idle" : "error";
        a.error =
          event.status === "completed"
            ? undefined
            : (event.error ?? "Work was interrupted");
        a.turnId = undefined;
        a.workingSince = undefined;
      }
    } else {
      if (event.type === "disconnected") this.handles.delete(a.id);
      a.state = "error";
      a.error = event.error;
      a.turnId = undefined;
      a.workingSince = undefined;
    }
    this.save();
  }
  private agent(id: string) {
    const a = this.state.agents.find((a) => a.id === id);
    if (!a || a.closed) throw new Error("Session not found");
    return a;
  }
  private publicAgent(a: RuntimeAgent): Agent {
    const {
      token: _token,
      messages: _messages,
      deliveries: _deliveries,
      ...agent
    } = a;
    return structuredClone(agent);
  }
  snapshot(): Snapshot {
    return {
      agents: this.state.agents
        .filter((a) => !a.closed)
        .map((a) => this.publicAgent(a)),
      settings: structuredClone(this.state.settings),
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
  models() {
    return this.options.runtime.models();
  }
  projects() {
    return this.options.projects();
  }
  async saveSettings(settings: Settings) {
    const models = await this.models();
    for (const defaults of [settings.orc, settings.worker]) {
      if (
        !models
          .find((m) => m.id === defaults.model)
          ?.efforts.includes(defaults.effort)
      )
        throw new Error("Choose a supported model and reasoning effort");
      if (
        settings.fast &&
        !models.find((m) => m.id === defaults.model)?.fastTier
      )
        throw new Error("Fast is not available for this model");
    }
    this.state.settings = structuredClone(settings);
    this.save();
  }
  async createOrc(alias: string) {
    const project = (await this.projects()).find((p) => p.alias === alias);
    if (!project) throw new Error("Registered project not found");
    if (!this.state.settings) {
      const models = await this.models();
      const model = models.find((m) => m.isDefault) ?? models[0];
      if (!model) throw new Error("No models available");
      const defaults = {
        model: model.id,
        effort: model.defaultEffort,
      };
      this.state.settings = {
        fast: false,
        orc: { ...defaults },
        worker: { ...defaults },
      };
    }
    const a: RuntimeAgent = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      role: "orc",
      project,
      title: "New session",
      ...this.state.settings.orc,
      serviceTier: this.state.settings.fast
        ? (await this.models()).find(
            (m) => m.id === this.state.settings!.orc.model,
          )!.fastTier!
        : "default",
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
  private async handle(a: RuntimeAgent) {
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
  ) {
    if (this.disposed) throw new Error("Workspace is stopped");
    if (!text.trim()) throw new Error("Write a message first");
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
      const handle = await this.handle(a);
      const activeTurn = a.state === "working" ? a.turnId : undefined;
      a.state = "working";
      a.workingSince ??= Date.now();
      a.error = undefined;
      this.save();
      let turnId: string;
      try {
        turnId = await handle.send(text, activeTurn);
      } catch (error) {
        if (!(error instanceof StaleTurn)) throw error;
        const currentTurn =
          error.activeTurnId ??
          (a.turnId !== activeTurn ? a.turnId : undefined);
        a.turnId = currentTurn;
        turnId = await handle.send(text, currentTurn);
      }
      if (!this.completedTurns.has(`${a.id}/${turnId}`)) a.turnId = turnId;
      if (!a.messages.some((m) => m.id === requestId))
        a.messages.splice(messagePosition, 0, {
          id: requestId,
          role: "user",
          text,
          turnId,
          at: d.at,
        });
      d.status = "sent";
      for (const q of a.questions)
        if (questionIds.includes(q.id)) q.state = "answered";
      this.save();
      if (
        a.role === "orc" &&
        d.source === "user" &&
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
  send(id: string, text: string, requestId: string) {
    if (text.trim() === "/close") return this.closeTree(id);
    return this.serialize(id, () => {
      const a = this.agent(id);
      if (a.role !== "orc") throw new Error("Send instructions through Orc");
      return this.deliver(a, text, requestId, "user");
    });
  }
  private async closeTree(id: string) {
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
    a.closed = true;
    this.save();
    await this.handles.get(id)?.close();
    this.handles.delete(id);
    return { closed: true as const, id };
  }
  answer(id: string, questionId: string, answer: string) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      if (a.role !== "orc")
        throw new Error("Answer Worker questions through Orc");
      const q = a.questions.find((q) => q.id === questionId);
      if (!q) throw new Error("Question not found");
      if (q.state === "answered") return this.detail(id);
      if (!answer.trim())
        throw new Error("Choose an option or write an answer");
      const result = await this.deliver(
        a,
        `Question: ${q.text}\nAnswer: ${answer.trim()}`,
        `answer:${q.id}`,
        "question",
        [q.id],
      );
      if (
        result.questions.find((q) => q.id === questionId)?.state === "answered"
      ) {
        q.answer = answer.trim();
        this.save();
      }
      return { ...result, questions: structuredClone(a.questions) };
    });
  }
  reconcile(id: string, deliveryId: string, accepted: boolean) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      const d = a.deliveries.find((d) => d.id === deliveryId);
      if (!d || d.status !== "uncertain")
        throw new Error("Unconfirmed delivery not found");
      d.status = accepted ? "sent" : "failed";
      d.error = accepted
        ? undefined
        : "You confirmed this message was not delivered. It can be retried.";
      if (accepted) {
        if (!a.messages.some((m) => m.id === d.id))
          a.messages.push({ id: d.id, role: "user", text: d.text, at: d.at });
        for (const q of a.questions)
          if (d.questionIds.includes(q.id)) {
            q.state = "answered";
            q.answer =
              d.source === "question"
                ? d.text.slice(d.text.indexOf("\nAnswer: ") + 9)
                : d.text;
          }
      }
      this.save();
      return this.detail(id);
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
            ...this.state.settings!.worker,
            serviceTier: this.state.settings!.fast
              ? (await this.models()).find(
                  (m) => m.id === this.state.settings!.worker.model,
                )!.fastTier!
              : "default",
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
        this.assertIdle(w);
        w.closed = true;
        this.save();
        await this.handles.get(w.id)?.close();
        this.handles.delete(w.id);
        return { closed: true, workerId: w.id };
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
  private assertIdle(a: RuntimeAgent) {
    if (
      a.state === "working" ||
      this.queues.has(a.id) ||
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
