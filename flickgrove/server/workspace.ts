import { splitMessages } from "../src/conversation-messages";
import { ImageStore } from "./images";
import { DirectoryBranches, type BranchReader } from "./directory-branches";
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
  ReviewTarget,
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

function reviewTargetText(target: ReviewTarget) {
  return `${target.profile} · spec ${target.spec} · fixed point ${target.fixedPoint} → reviewed HEAD ${target.reviewedHead}`;
}

type State = {
  agents: RuntimeAgent[];
  revision: number;
};
export class Workspace {
  private readonly branches: DirectoryBranches;
  readonly images: ImageStore;
  private readonly db: Database;
  private readonly state: State;
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly finalAnswers = new Map<
    string,
    Map<string, { id: string; text: string }>
  >();
  private readonly subscribers = new Set<() => void>();
  private readonly treeActions = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly opening = new Map<string, Promise<RuntimeHandle>>();
  private readonly completedTurns = new Set<string>();
  private readonly closingChildren = new Set<string>();
  private readonly failedChildCloses = new Set<string>();
  private disposed = false;
  constructor(
    private readonly options: {
      directory: string;
      runtime: Runtime;
      projects: () => Promise<Project[]>;
      orcPrompt?: () => Promise<string>;
      reviewerSnapshot?: (
        profile: import("../src/contracts").ReviewerProfile,
      ) => Promise<import("./reviewer-config").ReviewerSnapshot>;
      branches?: { read?: BranchReader; intervalMs?: number };
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
    this.branches = new DirectoryBranches(() => {
      if (this.disposed) return;
      this.state.revision++;
      for (const listener of this.subscribers) listener();
    }, options.branches);
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
        a.execution = undefined;
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
    this.advanceChildCloses();
    for (const a of this.state.agents) {
      if (a.closed || !a.threadId) continue;
      // Prefeature Orcs capture the configured prompt on explicit restoration,
      // not while startup is merely reconciling saved sessions.
      if (
        a.role === "orc" &&
        a.orcPromptSnapshot === undefined &&
        options.orcPrompt
      )
        continue;
      // Resume the original native thread without settings overrides; reconcile
      // before any queued subsequent turn, retaining the cache if unavailable.
      void this.serialize(a.id, async () => {
        await this.handle(a);
      }).catch(() => {});
    }
  }
  private save() {
    if (this.disposed) return;
    this.branches.update(
      this.state.agents.filter((a) => !a.closed).map((a) => a.project.path),
    );
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
    if (
      a.closed ||
      this.disposed ||
      (event.threadId && event.threadId !== a.threadId)
    )
      return;
    if (
      event.type !== "disconnected" &&
      this.completedTurns.has(`${a.id}/${event.turnId}`)
    )
      return;
    if (
      (event.type === "error" || event.type === "progress") &&
      event.turnId !== a.turnId
    )
      return;
    if (event.type === "working") {
      if (a.turnId === event.turnId) return;
      if (a.turnId) {
        this.completedTurns.add(`${a.id}/${a.turnId}`);
        this.finalAnswers.delete(`${a.id}/${a.turnId}`);
      }
      a.execution = undefined;
      a.workingSince = undefined;
      a.turnEnded = false;
      if (a.stop && a.stop.turnId !== event.turnId) a.stop = undefined;
      a.state =
        a.stop?.turnId === event.turnId && a.stop.status === "pending"
          ? "stopping"
          : "working";
      a.turnId = event.turnId;
      a.workingSince ??= Date.now();
      a.error = undefined;
    } else if (event.type === "progress") {
      if (!a.execution?.retrying) return;
      a.execution = undefined;
      a.error = undefined;
    } else if (event.type === "item") {
      if (event.turnId === a.turnId && a.execution?.retrying) {
        a.execution = undefined;
        a.error = undefined;
        // Publish recovery even when the item is buffered or omitted below.
        this.save();
      }
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
              state: a.role !== "orc" ? "delegated" : "unanswered",
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
        if (a.role !== "orc" && newQuestions.length) {
          const questions = a.questions.filter((q) =>
            newQuestions.includes(q.id),
          );
          const text =
            `${a.role === "reviewer" ? "Reviewer" : "Worker"} “${a.title}” needs a decision. Agent ID: ${a.id}\n\n` +
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
            : (event.error ?? a.error ?? "Work was interrupted");
        a.execution =
          a.state === "idle"
            ? undefined
            : {
                kind: event.errorKind ?? a.execution?.kind ?? "error",
                retrying: false,
              };
        a.turnId = undefined;
        a.workingSince = undefined;
      }
    } else if (event.type === "error") {
      if (
        event.willRetry &&
        a.state === "error" &&
        a.execution &&
        !a.execution.retrying
      )
        return;
      a.execution = {
        kind: event.errorKind ?? "error",
        retrying: event.willRetry,
      };
      a.error = event.error;
      if (!event.willRetry) {
        a.state = "error";
        a.workingSince = undefined;
      }
    } else {
      a.execution = undefined;
      a.turnEnded = false;
      if (event.type === "disconnected") this.handles.delete(a.id);
      if (a.stop?.status === "pending") a.stop.status = "unknown";
      a.state = "error";
      a.error = event.error;
      if (event.type === "disconnected") a.turnId = undefined;
      a.workingSince = undefined;
    }
    this.save();
    this.advanceChildCloses();
  }
  previewDirectory(id: string) {
    const agent = this.state.agents.find((a) => a.id === id);
    if (!agent) throw new Error("Session not found");
    return agent.project.path;
  }
  private agent(id: string) {
    const a = this.state.agents.find((a) => a.id === id);
    if (!a || a.closed) throw new Error("Session not found");
    return a;
  }
  private publicAgent(a: RuntimeAgent): Agent {
    const {
      token: _token,
      reviewerSnapshot: _reviewerSnapshot,
      orcPromptSnapshot: _orcPromptSnapshot,
      inheritSettings: _inheritSettings,
      restoreArchived: _restoreArchived,
      turnEnded: _turnEnded,
      messages: _messages,
      deliveries: _deliveries,
      workerDefaults: _workerDefaults,
      ...agent
    } = a;
    const owner = this.state.agents.find((o) => o.id === a.ownerId);
    const sharedDirectory =
      owner && this.branches.shares(owner.project.path, a.project.path);
    return structuredClone({
      ...agent,
      treeFast: (owner ?? a).treeFast ?? (owner ?? a).serviceTier !== "default",
      treeFastError: (owner ?? a).treeFastError,
      treeFastBusy: this.treeActions.has(owner?.id ?? a.id),
      directoryBranch: sharedDirectory
        ? undefined
        : this.branches.value(a.project.path),
    });
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
  async reconcileSettings(id: string) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      const handle = await this.handle(a, false);
      const value = await handle.readSettings();
      if (this.disposed || a.closed || this.handles.get(id) !== handle) return;
      if (
        a.model === value.model &&
        a.effort === value.effort &&
        a.serviceTier === value.serviceTier
      )
        return;
      Object.assign(a, value);
      this.save();
    });
  }
  private root(a: RuntimeAgent) {
    return a.ownerId ? this.agent(a.ownerId) : a;
  }
  async updateSettings(id: string, value: { model: string; effort: string }) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      if (a.role === "reviewer")
        throw new Error(
          "Reviewer model and effort belong to its captured profile",
        );
      if (a.closeRequest) throw new Error("Session is closing");
      const handle = await this.handle(a, false);
      const current = await handle.readSettings();
      const model = (await this.models()).find((m) => m.id === value.model);
      if (!model?.efforts.includes(value.effort))
        throw new Error("Choose a supported model and reasoning effort");
      const root = this.root(a);
      if (
        this.disposed ||
        a.closed ||
        a.closeRequest ||
        this.handles.get(id) !== handle
      )
        throw new Error("Session is no longer editable");
      // An explicit model save retains the initial policy even if the owner's
      // new model cannot use Fast; startup never initializes this stored field.
      root.treeFast ??=
        (root.id === a.id ? current.serviceTier : root.serviceTier) !==
        "default";
      this.save();
      const serviceTier = root.treeFast
        ? (model.fastTier ?? "default")
        : "default";
      const requested = { ...value, serviceTier };
      const settings =
        current.model === value.model &&
        current.effort === value.effort &&
        current.serviceTier === serviceTier
          ? current
          : await handle.updateSettings(requested);
      if (
        this.disposed ||
        a.closed ||
        a.closeRequest ||
        this.handles.get(id) !== handle
      )
        throw new Error("Session changed. Settings outcome unknown.");
      Object.assign(a, settings);
      this.save();
      return this.detail(id);
    });
  }
  async updateTreeFast(id: string, fast: boolean, retry = false) {
    const root = this.root(this.agent(id));
    if (this.treeActions.has(root.id))
      throw new Error("Tree settings are being saved");
    if (root.treeFastError && !retry)
      throw new Error("Retry the previous tree settings operation first");
    if (retry && root.treeFastError && root.treeFast !== fast)
      throw new Error("Retry the saved tree policy first");
    this.treeActions.add(root.id);
    this.save();
    try {
      // Drain already admitted operations; later starts/settings/closure are refused.
      await Promise.allSettled(
        this.state.agents
          .filter((a) => a.id === root.id || a.ownerId === root.id)
          .map((a) => this.queues.get(a.id)),
      );
      if (this.disposed || root.closed || root.closeRequest)
        throw new Error("Tree is no longer editable");
      const members = this.state.agents.filter(
        (a) =>
          !a.closed &&
          !a.closeRequest &&
          (a.id === root.id || a.ownerId === root.id),
      );
      const models = await this.models();
      root.treeFast = fast;
      root.treeFastError = undefined;
      this.save();
      const failures: string[] = [];
      for (const a of members) {
        try {
          if (a.closed || a.closeRequest) continue;
          const handle = await this.handle(a, false);
          // Explicit retry always reads the original native authority before any update.
          const current = await handle.readSettings();
          if (this.disposed || a.closed || a.closeRequest)
            throw new Error("Session changed");
          Object.assign(a, current);
          this.save();
          const model = models.find((m) => m.id === current.model);
          if (!model) throw new Error("Model is unavailable");
          const serviceTier = fast ? (model.fastTier ?? "default") : "default";
          if (current.serviceTier !== serviceTier) {
            const confirmed = await handle.updateSettings({ serviceTier });
            if (this.disposed || a.closed || a.closeRequest)
              throw new Error("Settings outcome unknown");
            Object.assign(a, confirmed);
            this.save();
          }
        } catch (e) {
          failures.push(
            `${a.title}: ${e instanceof Error ? e.message : "Settings outcome unknown"}`,
          );
        }
      }
      root.treeFastError = failures.length ? failures.join("; ") : undefined;
      this.save();
      return this.detail(id);
    } finally {
      this.treeActions.delete(root.id);
      this.save();
      this.advanceChildCloses();
    }
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
      title: agent.role !== "orc" ? agent.title : session.title,
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
    for (const message of splitMessages(agent).historical) {
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
      if (existing && existing.role !== "orc")
        throw new Error("Continue this owned agent through its original Orc");
      const restore = async () => {
        if (existing && !existing.closed) {
          if (
            existing.orcPromptSnapshot === undefined &&
            this.options.orcPrompt
          )
            await this.handle(existing);
          return this.publicAgent(existing);
        }
        const session = await this.historySession(alias, threadId);
        if (session.role !== "orc" && session.role !== "session")
          throw new Error("Continue this owned agent through its original Orc");
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
      orcPromptSnapshot: await this.options.orcPrompt?.(),
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
        if (
          a.role === "orc" &&
          a.orcPromptSnapshot === undefined &&
          this.options.orcPrompt
        ) {
          a.orcPromptSnapshot = await this.options.orcPrompt();
          this.save();
        }
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
        a.historyCursor = handle.historyCursor;
        a.historyBoundaryId = handle.historyCursor
          ? a.messages.at(-1)?.id
          : undefined;
        a.model = handle.model ?? a.model;
        a.effort = handle.effort ?? a.effort;
        a.serviceTier = handle.serviceTier ?? a.serviceTier;
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
    const a = this.state.agents.find((a) => a.id === id);
    if (a && this.treeActions.has(a.ownerId ?? a.id))
      return Promise.reject(new Error("Tree settings are being saved"));
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(id, next);
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
        this.advanceChildCloses();
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
      throw new Error(
        "Owned agent is awaiting closure and cannot accept new tasks",
      );
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
      const activeTurn = !a.turnEnded ? a.turnId : undefined;
      a.turnEnded = false;
      if (!activeTurn && !a.error) {
        a.state = "working";
        a.workingSince ??= Date.now();
      }
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
      if (!this.completedTurns.has(`${a.id}/${turnId}`)) {
        if (turnId !== activeTurn)
          this.event(a, { type: "working", turnId, threadId: handle.threadId });
        a.turnId = turnId;
      }
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
        // Delivery feedback belongs to the message; retain any native cause.
        a.workingSince = undefined;
      }
      this.save();
    }
    return this.detail(a.id);
  }
  retryDelivery(id: string, deliveryId: string) {
    if (this.agent(id).role === "reviewer")
      throw new Error("Continue Reviewer instructions through Orc");
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
    if (!d || (d.status !== "sent" && d.status !== "failed")) return null;
    return {
      operationId,
      state:
        d.status === "sent" ? ("accepted" as const) : ("rejected" as const),
      turnId: d.turnId ?? null,
      error: d.error ?? null,
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
      if (a.role !== "orc")
        throw new Error("Only Orc can close Workers and Reviewers");
      const workers = this.state.agents.filter(
        (w) => w.ownerId === id && !w.closed,
      );
      if (workers.length)
        throw new Error(
          `Ask Orc to close its Workers and Reviewers first: ${workers.map((w) => w.title).join(", ")}`,
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
        throw new Error("Answer owned agent questions through Orc");
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
  private ownedChild(
    owner: RuntimeAgent,
    id: string,
    role: "worker" | "reviewer",
  ) {
    const w = this.agent(id);
    if (w.role !== role || w.ownerId !== owner.id)
      throw new Error(
        `${role === "reviewer" ? "Reviewer" : "Worker"} does not belong to this Orc`,
      );
    return w;
  }
  async tool(token: string, name: string, args: unknown): Promise<unknown> {
    const a = this.authenticated(token);
    if (!(roleTools[a.role] as readonly string[]).includes(name))
      throw new Error("Tool is not available to this role");
    switch (name) {
      case "reviewer_start":
      case "worker_start": {
        const isReviewer = name === "reviewer_start";
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const review = isReviewer
          ? z.object(toolDefinitions.reviewer_start.shape).parse(args)
          : undefined;
        return this.serialize(a.id, async () => {
          this.agent(a.id);
          const project = (await this.projects()).find(
            (p) => p.alias === input.project,
          );
          if (!project) throw new Error("Registered project not found");
          const w: RuntimeAgent = {
            id: crypto.randomUUID(),
            token: crypto.randomUUID(),
            role: isReviewer ? "reviewer" : "worker",
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
          if (review) {
            if (!this.options.reviewerSnapshot)
              throw new Error("Reviewer configuration is unavailable");
            const snapshot = await this.options.reviewerSnapshot(
              review.profile,
            );
            w.reviewerSnapshot = snapshot;
            w.model = snapshot.model;
            w.effort = snapshot.effort;
            w.reviewTarget = {
              profile: review.profile,
              spec: review.spec,
              fixedPoint: review.fixedPoint,
              reviewedHead: review.reviewedHead,
            };
          }
          {
            const model = (await this.models()).find((m) => m.id === w.model);
            if (!model || !model.efforts.includes(w.effort))
              throw new Error(
                "Assigned model or reasoning effort is unavailable",
              );
            w.serviceTier =
              (a.treeFast ?? a.serviceTier !== "default")
                ? (model.fastTier ?? "default")
                : "default";
          }
          const assignment = `Assigned spec: ${input.spec}\n${review ? `Review target: ${reviewTargetText(w.reviewTarget!)}\n` : ""}\n${input.message}`;
          if (assignment.length > 100_000)
            throw new Error(
              "Message is too long, including the assignment target",
            );
          this.state.agents.push(w);
          this.save();
          try {
            await this.handle(w);
          } catch (error) {
            if (isReviewer) {
              w.state = "error";
              w.error = `Reviewer thread startup unconfirmed: ${String(error)}. Inspect this Reviewer before replacing the axis; do not replay start.`;
              this.save();
              return this.detail(w.id);
            }
            w.closed = true;
            this.save();
            throw error;
          }
          await this.deliver(w, assignment, crypto.randomUUID(), "worker");
          return this.detail(w.id);
        });
      }
      case "reviewer_list":
      case "worker_list": {
        z.object(toolDefinitions[name].shape).parse(args);
        return this.state.agents
          .filter(
            (w) =>
              w.role === (name === "reviewer_list" ? "reviewer" : "worker") &&
              w.ownerId === a.id &&
              !w.closed,
          )
          .map((w) => this.publicAgent(w));
      }
      case "reviewer_read":
      case "worker_read": {
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const w = this.ownedChild(
          a,
          "workerId" in input ? input.workerId : input.reviewerId,
          name === "worker_read" ? "worker" : "reviewer",
        );
        const end = input.before
          ? w.messages.findIndex((m) => m.id === input.before)
          : w.messages.length;
        if (end < 0) throw new Error("History cursor not found");
        const start = Math.max(0, end - (input.limit ?? 20));
        const messages = structuredClone(w.messages.slice(start, end));
        return {
          [w.role]: this.publicAgent(w),
          messages,
          hasMore: start > 0,
          nextBefore: start > 0 ? messages[0]?.id : null,
        };
      }
      case "reviewer_send":
      case "worker_send": {
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const w = this.ownedChild(
          a,
          "workerId" in input ? input.workerId : input.reviewerId,
          name === "worker_send" ? "worker" : "reviewer",
        );
        for (const id of input.questionIds ?? [])
          if (!w.questions.some((q) => q.id === id && q.state === "delegated"))
            throw new Error("Delegated question not found");
        return this.serialize(w.id, async () => {
          this.agent(w.id);
          if (w.role === "reviewer" && !w.threadId)
            throw new Error(
              "Reviewer thread startup is unconfirmed; inspect native history before replacing this axis",
            );
          const previous = w.reviewTarget;
          let text = input.message;
          if ("reviewedHead" in input) {
            const target = {
              profile: previous!.profile,
              spec: input.spec,
              fixedPoint: input.fixedPoint,
              reviewedHead: input.reviewedHead,
            };
            if (
              w.closeRequest &&
              JSON.stringify(target) !== JSON.stringify(previous)
            )
              throw new Error(
                "Closing Reviewer cannot accept a new review target",
              );
            if (w.closeRequest && !input.questionIds?.length)
              throw new Error(
                "Closing Reviewer only accepts delegated answers",
              );
            text = `Review target: ${reviewTargetText(target)}\n\n${input.message}`;
            if (text.length > 100_000)
              throw new Error(
                "Message is too long, including the review target",
              );
            w.reviewTarget = target;
            this.save();
          }
          await this.deliver(
            w,
            text,
            crypto.randomUUID(),
            "worker",
            input.questionIds,
          );
          if (w.deliveries.at(-1)?.status === "failed") {
            w.reviewTarget = previous;
            this.save();
          }
          return this.detail(w.id);
        });
      }
      case "reviewer_close":
      case "worker_close": {
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const w = this.ownedChild(
          a,
          "workerId" in input ? input.workerId : input.reviewerId,
          name === "worker_close" ? "worker" : "reviewer",
        );
        if (this.treeActions.has(a.id))
          throw new Error("Tree settings are being saved");
        if (input.confirmInterrupted && (w.state !== "error" || w.turnId))
          throw new Error(
            "Only an interrupted owned agent with no observed active turn can be confirmed",
          );
        w.closeRequest ??= {
          reason: "Waiting for current work to finish",
        };
        if (input.confirmInterrupted) w.turnEnded = true;
        this.failedChildCloses.delete(w.id);
        this.save();
        await this.advanceChildCloses();
        return {
          closed: w.closed,
          closing: !w.closed,
          [w.role === "worker" ? "workerId" : "reviewerId"]: w.id,
          reason: w.closed ? undefined : w.closeRequest.reason,
        };
      }
      case "reviewer_report": {
        const input = z
          .object(toolDefinitions.reviewer_report.shape)
          .parse(args);
        if (
          input.reviewedHead !== a.reviewTarget?.reviewedHead ||
          input.fixedPoint !== a.reviewTarget?.fixedPoint ||
          input.spec !== a.reviewTarget?.spec
        )
          throw new Error(
            "Report HEAD/spec/fixed point does not match current review target",
          );
        return this.report(
          a,
          `Reviewer “${a.title}” reports (${reviewTargetText(a.reviewTarget!)}):\n\n${input.message}`,
          crypto.randomUUID(),
        );
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
      throw new Error("Message is too long, including the report header");
    const owner = this.agent(worker.ownerId!);
    owner.deliveries.push({
      id: requestId,
      text,
      source: worker.role === "reviewer" ? "reviewer" : "worker",
      ...(worker.role === "reviewer"
        ? {
            reportingReviewerId: worker.id,
            reviewTarget: structuredClone(worker.reviewTarget),
          }
        : { reportingWorkerId: worker.id }),
      status: "queued",
      questionIds: [],
      at: Date.now(),
    });
    this.save();
    return this.serialize(owner.id, () =>
      this.deliver(
        this.agent(owner.id),
        text,
        requestId,
        worker.role === "reviewer" ? "reviewer" : "worker",
      ),
    );
  }
  private async advanceChildCloses() {
    if (this.disposed) return;
    let changed = false;
    const releases: Promise<void>[] = [];
    for (const w of this.state.agents) {
      if (
        w.role === "orc" ||
        w.closed ||
        !w.closeRequest ||
        this.closingChildren.has(w.id) ||
        this.failedChildCloses.has(w.id)
      )
        continue;
      let reason: string | undefined;
      if (
        this.treeActions.has(w.ownerId!) ||
        this.queues.has(w.id) ||
        this.opening.has(w.id)
      )
        reason = "Waiting for in-flight owned agent operations";
      else if (
        w.deliveries.some((d) =>
          ["queued", "sending", "uncertain"].includes(d.status),
        )
      )
        reason = "Waiting for owned agent delivery confirmation";
      else if (
        this.state.agents
          .find((a) => a.id === w.ownerId)
          ?.deliveries.some(
            (d) =>
              (d.reportingWorkerId ?? d.reportingReviewerId) === w.id &&
              d.status !== "sent",
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
            : "Current turn outcome is unconfirmed; inspect the owned agent before resolving closure";
      if (reason) {
        if (w.closeRequest.reason !== reason) {
          w.closeRequest.reason = reason;
          changed = true;
        }
        continue;
      }
      this.closingChildren.add(w.id);
      releases.push(
        (async () => {
          try {
            const handle = w.threadId
              ? await this.handle(w, false)
              : this.handles.get(w.id);
            await handle?.close();
            if (this.disposed) return;
            this.handles.delete(w.id);
            w.closed = true;
          } catch (error) {
            if (this.disposed) return;
            this.failedChildCloses.add(w.id);
            w.closeRequest!.reason = `Native thread release failed: ${String(error)}. Retry ${w.role} close.`;
          } finally {
            this.closingChildren.delete(w.id);
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
      a.role !== "orc" &&
      this.agent(a.ownerId!).deliveries.some(
        (d) =>
          (d.reportingWorkerId ?? d.reportingReviewerId) === a.id &&
          d.status !== "sent",
      )
    )
      throw new Error(`${a.title} has an undelivered report to Orc`);
    if (a.questions.some((q) => q.state !== "answered"))
      throw new Error(`${a.title} has unanswered questions`);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.branches.dispose();
    this.subscribers.clear();
    void this.options.runtime.close();
    this.db.close();
  }
}
