import {
  associate,
  questionEntry,
  recentWindow,
  readingPage,
  nativeBody,
  deliveryMetadata,
} from "./conversation-reading";
import { ImageStore } from "./images";
import {
  DirectoryBranches,
  readDirectoryBranch,
  type BranchReader,
} from "./directory-branches";
import type { MessageImage } from "../src/contracts";
import { WorkspaceStore } from "./workspace-store";
import { mkdirSync, realpathSync } from "node:fs";
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
import {
  environmentId,
  parseProjectReference,
  projectDirectoryKey,
} from "../src/project-identity";
import type { ProjectEnvironments } from "./project-environments";
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
  private readonly store: WorkspaceStore;
  private readonly state: State;
  private readonly handles = new Map<string, RuntimeHandle>();
  private readonly subscribers = new Set<() => void>();
  private readonly treeActions = new Set<string>();
  private readonly closingTrees = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly opening = new Map<string, Promise<RuntimeHandle>>();
  private readonly completedTurns = new Set<string>();
  // IDs only: retain live publication identity until this active turn ends, even
  // after the bounded reading window has evicted the corresponding bodies.
  private readonly completedItems = new Map<
    string,
    { turnId: string; ids: Set<string> }
  >();
  private readonly closingChildren = new Set<string>();
  private readonly failedChildCloses = new Set<string>();
  private disposed = false;
  private writeFailure: unknown;
  constructor(
    private readonly options: {
      directory: string;
      runtime: Runtime;
      projects: (environment?: string) => Promise<Project[]>;
      environments?: ProjectEnvironments;
      orcPrompt?: () => Promise<string>;
      researcherSnapshot?: () => Promise<
        import("./reviewer-config").ReviewerSnapshot
      >;
      reviewerSnapshot?: (
        profile: import("../src/contracts").ReviewerProfile,
      ) => Promise<import("./reviewer-config").ReviewerSnapshot>;
      branches?: { read?: BranchReader; intervalMs?: number };
    },
  ) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.images = new ImageStore(join(options.directory, "media"));
    this.store = new WorkspaceStore(
      join(options.directory, "workspace.sqlite"),
    );
    this.state = {
      agents: this.store.openAgents().map((a) => this.store.track(a)),
      revision: 0,
    };
    this.branches = new DirectoryBranches(
      () => {
        if (this.disposed) return;
        this.state.revision++;
        for (const listener of this.subscribers) listener();
      },
      {
        ...options.branches,
        canonicalize: (key, previous) =>
          key.startsWith("remote:") ? key : this.localBranchKey(key, previous),
        read: (key, signal) =>
          key.startsWith("remote:")
            ? this.options.environments!.branch(
                this.remoteBranchProject(key),
                signal,
              )
            : (options.branches?.read ?? readDirectoryBranch)(key, signal),
      },
    );
    for (const a of this.state.agents) {
      if (
        a.backend !== "pi" &&
        (a.state === "working" ||
          a.state === "stopping" ||
          (a.state === "error" && a.turnId))
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
  private localBranchKey(path: string, previous = path) {
    try {
      return realpathSync(path);
    } catch {
      return previous;
    }
  }
  private remoteBranchProject(key: string): Project {
    const [id, target, path] = JSON.parse(key.slice(7));
    return { alias: "", name: "", path, environment: { id, target, name: id } };
  }
  private branchKey(project: Project) {
    return environmentId(project) === "local"
      ? project.path
      : "remote:" + projectDirectoryKey(project);
  }
  private save() {
    if (this.disposed) return;
    for (const a of this.store.windows) {
      this.rememberCompletedItems(a, a.messages);
      a.messages = recentWindow(a.messages, []);
    }
    this.store.windows.clear();
    try {
      this.store.flush();
    } catch (error) {
      this.writeFailure = error;
      throw error;
    }
    this.state.agents = this.state.agents.filter((a) => !a.closed);
    this.branches.update(
      this.state.agents.map((a) => this.branchKey(a.project)),
    );
    this.state.revision++;
    for (const listener of this.subscribers) listener();
  }
  subscribe(listener: () => void) {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }
  private confirmNative(a: RuntimeAgent, clientId?: string, turnId?: string) {
    const d = clientId
      ? a.deliveries.find((d) => d.id === clientId)
      : undefined;
    if (!d) return;
    // Re-reading an accepted receipt must retain its later native outcome.
    if (d.status !== "sent") d.error = undefined;
    d.status = "sent";
    d.turnId = turnId ?? d.turnId;
    for (const q of a.questions)
      if (d.questionIds.includes(q.id)) {
        q.state = "answered";
        q.answer =
          d.answers?.find((v) => v.questionId === q.id)?.answer ?? d.text;
      }
    return d;
  }
  private async orderNativeItems(a: RuntimeAgent, itemId: string) {
    if (!a.threadId) return;
    const page = await readingPage(
      this.options.runtime,
      a.threadId,
      undefined,
      [],
      256 * 1024,
    );
    if (
      a.closed ||
      this.disposed ||
      !page.messages.some((m) => m.id === itemId)
    )
      return;
    const positions = new Map(page.messages.map((m, index) => [m.id, index]));
    const ordered = a.messages
      .filter((m) => positions.has(m.id))
      .sort((a, b) => positions.get(a.id)! - positions.get(b.id)!);
    a.messages = a.messages.map((m) =>
      positions.has(m.id) ? ordered.shift()! : m,
    );
    this.save();
  }
  private rememberCompletedItems(a: RuntimeAgent, messages: Message[]) {
    if (!a.turnId || a.closed || this.disposed) {
      this.completedItems.delete(a.id);
      return;
    }
    let completed = this.completedItems.get(a.id);
    if (completed?.turnId !== a.turnId) {
      completed = { turnId: a.turnId, ids: new Set() };
      this.completedItems.set(a.id, completed);
    }
    for (const message of messages)
      if (message.role === "assistant" && message.turnId === a.turnId)
        completed.ids.add(message.id);
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
      !(event.type === "item" && event.item.type === "userMessage") &&
      this.completedTurns.has(`${a.id}/${event.turnId}`)
    )
      return;
    if (
      (event.type === "error" || event.type === "progress") &&
      event.turnId !== a.turnId
    )
      return;
    if (event.type === "submission") {
      const delivery = this.confirmNative(a, event.operationId, event.turnId);
      if (delivery && event.status === "unanswered")
        delivery.error =
          event.reason === "aborted"
            ? "Accepted input was cancelled by Stop."
            : "Accepted input ended without an answer. Inspect the conversation before continuing.";
      this.save();
      return;
    } else if (event.type === "working") {
      if (a.turnId === event.turnId) return;
      this.completedItems.delete(a.id);
      if (a.turnId) {
        this.completedTurns.add(`${a.id}/${a.turnId}`);
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
      if (
        event.item.type !== "userMessage" &&
        event.turnId === a.turnId &&
        a.execution?.retrying
      ) {
        a.execution = undefined;
        a.error = undefined;
        // Publish recovery even when the item has no visible content below.
        this.save();
      }
      const item = event.item;
      if (item.type === "userMessage") {
        const d = item.clientId
          ? a.deliveries.find((d) => d.id === item.clientId)
          : undefined;
        const matched = a.messages.findIndex(
          (m) =>
            m.id === item.id ||
            (m.provisional && item.clientId && m.clientId === item.clientId),
        );
        const message: Message = {
          id: item.id,
          clientId: item.clientId,
          turnId: event.turnId,
          role: "user",
          text: item.text ?? "",
          at: d?.at ?? Date.now(),
          ...(d?.images?.length ? { images: d.images } : {}),
        };
        if (matched >= 0) a.messages.splice(matched, 1, message);
        else a.messages.push(message);
        // Only native item positions can correct an out-of-order notification.
        if (
          matched < 0 &&
          a.messages.some(
            (m) => m.role === "assistant" && m.turnId === event.turnId,
          )
        )
          void this.orderNativeItems(a, item.id).catch(() => {});
        this.confirmNative(a, item.clientId, event.turnId);
        this.save();
        return;
      }
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
        // Persisted question identities already prove an evicted repeat.
        if (!newQuestions.length && !a.messages.some((m) => m.id === item.id))
          return;
        if (!a.messages.some((m) => m.id === item.id))
          a.messages.push({
            id: item.id,
            role: "assistant",
            text: item.text ?? "",
            turnId: event.turnId,
            at: Date.now(),
          });
        if (a.role !== "orc" && newQuestions.length) {
          const questions = a.questions.filter((q) =>
            newQuestions.includes(q.id),
          );
          const text =
            `${a.role === "reviewer" ? "Reviewer" : a.role === "researcher" ? "Researcher" : "Worker"} “${a.title}” needs a decision. Agent ID: ${a.id}\n\n` +
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
      } else if (item.text) {
        if (a.messages.some((m) => m.id === item.id)) return;
        if (this.completedItems.get(a.id)?.ids.has(item.id)) return;
        const message: Message = {
          id: item.id,
          text: item.text,
          role: "assistant",
          turnId: event.turnId,
          at: Date.now(),
        };
        a.messages.push(message);
      } else return;
    } else if (event.type === "completed") {
      this.completedTurns.add(`${a.id}/${event.turnId}`);
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
    const agent =
      this.state.agents.find((a) => a.id === id) ?? this.store.byId(id);
    if (!agent) throw new Error("Session not found");
    return agent.project.path;
  }
  previewProject(id: string) {
    const agent = this.readableAgent(
      this.state.agents.find((a) => a.id === id) ?? this.store.byId(id),
    );
    if (!agent) throw new Error("Session not found");
    return agent.project;
  }
  remoteProjectRead(project: Project, request: Record<string, unknown>) {
    if (!project.environment || !this.options.environments)
      throw new Error("Project device reader is unavailable");
    return this.options.environments.operation(project.environment, request);
  }
  projectForThread(threadId: string) {
    return this.readableAgent(
      this.state.agents.find((a) => a.threadId === threadId) ??
        this.store.byThread(threadId),
    )?.project;
  }
  historyProjects() {
    const projects = new Map<string, Project>();
    for (const { id, project } of this.store.historyProjects()) {
      const key = JSON.stringify([project.alias, projectDirectoryKey(project)]);
      if (!projects.has(key))
        projects.set(key, { ...project, historyRef: `@saved:${id}` });
    }
    return [...projects.values()];
  }
  async environmentCatalogue() {
    const entries = await (this.options.environments?.list() ??
      Promise.resolve([
        { id: "local", name: "This machine", target: "local" },
      ]));
    for (const project of this.historyProjects()) {
      if (
        project.environment &&
        !entries.some((e) => e.id === project.environment!.id)
      )
        entries.push(project.environment);
    }
    return entries;
  }
  private async assertProject(project: Project, backend?: string) {
    if (environmentId(project) !== "local" && backend === "pi")
      throw new Error(
        "Pi supports this machine only. Change the corresponding backend in Settings.",
      );
    await this.options.environments?.assert(project.environment);
  }
  private readableAgent(a: RuntimeAgent | undefined) {
    if (this.writeFailure && a && this.state.agents.includes(a))
      throw new Error(
        "Workspace storage failed. Resolve the write failure and restart before reading active state.",
      );
    return a;
  }
  private agent(id: string) {
    const a = this.readableAgent(
      this.state.agents.find((a) => a.id === id) ?? this.store.byId(id),
    );
    if (!a || a.closed) throw new Error("Session not found");
    return a;
  }
  private publicAgent(a: RuntimeAgent): Agent {
    this.readableAgent(a);
    const {
      token: _token,
      reviewerSnapshot: _reviewerSnapshot,
      researcherSnapshot: _researcherSnapshot,
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
      owner &&
      this.branches.shares(
        this.branchKey(owner.project),
        this.branchKey(a.project),
      );
    return structuredClone({
      ...agent,
      unansweredCount: a.questions.filter((q) => q.state === "unanswered")
        .length,
      recoveryCount: a.deliveries.filter((d) => d.status !== "sent").length,
      error: agent.error?.slice(0, 8000),
      questions: agent.questions.slice(-100).map((q) => ({
        ...q,
        text: "",
        title: q.title.slice(0, 200),
        options: [],
        answer: undefined,
        recoveryRef: true,
      })),
      treeFast: (owner ?? a).treeFast ?? (owner ?? a).serviceTier !== "default",
      treeFastError: (owner ?? a).treeFastError,
      treeFastBusy: this.treeActions.has(owner?.id ?? a.id),
      directoryBranch: sharedDirectory
        ? undefined
        : this.branches.value(this.branchKey(a.project)),
    });
  }
  snapshot(): Snapshot {
    if (this.writeFailure) throw this.writeFailure;
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
      messages: structuredClone(
        recentWindow(a.messages, a.deliveries, a.questions),
      ),
      deliveries: a.deliveries
        .filter(
          (d) =>
            d.status !== "sent" ||
            d.source === "question" ||
            a.messages.some((m) => m.clientId === d.id),
        )
        .slice(-100)
        .map(deliveryMetadata),
    };
  }
  async synchronizeDetail(id: string) {
    const a = this.agent(id);
    if (!a.threadId) return this.detail(id);
    const arriving: Message[] = [];
    const stop = this.subscribe(() => {
      for (const m of a.messages)
        if (!arriving.some((v) => v.id === m.id)) arriving.push(m);
    });
    const initial = new Set(a.messages.map((m) => m.id));
    try {
      const page = await readingPage(
        this.options.runtime,
        a.threadId,
        undefined,
        a.deliveries,
        256 * 1024,
        (m) => this.restoreNativeImages(a, questionEntry(m, a.questions)),
      );
      const nativeClients = new Set(page.messages.map((m) => m.clientId));
      for (const m of page.messages)
        this.confirmNative(a, m.clientId, m.turnId);
      const additions = arriving.filter(
        (m) =>
          !initial.has(m.id) &&
          !page.messages.some((v) => v.id === m.id) &&
          !nativeClients.has(m.id),
      );
      this.rememberCompletedItems(a, page.messages);
      a.messages = recentWindow([...page.messages, ...additions], []);
      a.historyCursor = page.nextCursor ?? undefined;
      a.readingRevision = (a.readingRevision ?? 0) + 1;
      this.save();
      return this.detail(id);
    } finally {
      stop();
    }
  }
  recoveryPage(id: string, cursor?: string) {
    const before = cursor
      ? JSON.parse(Buffer.from(cursor, "base64url").toString())
      : null;
    if (
      cursor &&
      (!Array.isArray(before) ||
        before.length !== 2 ||
        !Number.isFinite(before[0]) ||
        typeof before[1] !== "string")
    )
      throw new Error("Invalid recovery cursor");
    // Position is the immutable ledger key, even when its record is deleted.
    const records = this.agent(id)
      .deliveries.filter(
        (d) =>
          d.status !== "sent" &&
          (!before ||
            d.at < before[0] ||
            (d.at === before[0] && d.id < before[1])),
      )
      .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const page = records.slice(0, 100),
      last = page.at(-1);
    return {
      deliveries: page.map(deliveryMetadata),
      nextCursor:
        records.length > 100 && last
          ? Buffer.from(JSON.stringify([last.at, last.id])).toString(
              "base64url",
            )
          : null,
    };
  }
  recovery(id: string, operationId: string) {
    const d = this.agent(id).deliveries.find((d) => d.id === operationId);
    if (!d) throw new Error("Delivery not found");
    return structuredClone(d);
  }
  questionHistory(
    id: string,
    selection: { item?: string; operation?: string; pending?: boolean } = {},
  ) {
    const agent = this.readableAgent(
      this.state.agents.find((a) => a.id === id) ?? this.store.byId(id),
    );
    if (!agent) throw new Error("Session not found");
    const delivery = selection.operation
      ? agent.deliveries.find(
          (d) => d.id === selection.operation && d.source === "question",
        )
      : undefined;
    if (selection.operation && !delivery)
      throw new Error(
        "Answer record unavailable. Retry from the conversation.",
      );
    const questions = agent.questions.filter(
      (q) =>
        (!selection.pending || q.state !== "answered") &&
        (!selection.item || q.itemId === selection.item) &&
        (!delivery || delivery.questionIds.includes(q.id)),
    );
    if ((selection.item || selection.operation) && !questions.length)
      throw new Error(
        "Question record unavailable. Retry from the conversation.",
      );
    return questions.map((q) => {
      const operations =
        q.state === "answered"
          ? []
          : agent.deliveries.filter(
              (d) =>
                d.source === "question" &&
                d.status !== "sent" &&
                d.questionIds.includes(q.id),
            );
      const unresolved =
        operations.find((d) => d.status !== "failed") ?? operations.at(-1);
      return structuredClone({
        ...q,
        ...(unresolved
          ? {
              answerOperation: { id: unresolved.id, status: unresolved.status },
            }
          : {}),
      });
    });
  }
  async historyQuestions(
    alias: string,
    threadId: string,
    selection: { item?: string; operation?: string },
  ) {
    await this.historySession(alias, threadId);
    const agent =
      this.state.agents.find((a) => a.threadId === threadId) ??
      this.store.byThread(threadId);
    if (!agent)
      throw new Error(
        "Question record unavailable. Retry from the conversation.",
      );
    return this.questionHistory(agent.id, selection);
  }
  async messageBody(id: string, itemId: string) {
    const a = this.agent(id);
    if (!a.threadId) throw new Error("Native session unavailable");
    return nativeBody(this.options.runtime, a.threadId, itemId);
  }
  async historyBody(alias: string, threadId: string, itemId: string) {
    await this.historySession(alias, threadId);
    return nativeBody(this.options.runtime, threadId, itemId);
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
      if (a.backend === "pi") return; // Passive reads never construct a Pi executor.
      // Passive selection/reconnect must not initialize a prefeature Orc.
      if (
        a.role === "orc" &&
        a.orcPromptSnapshot === undefined &&
        this.options.orcPrompt
      )
        return;
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
  async updateSettings(
    id: string,
    value: { model: string; effort: string; provider?: string },
  ) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      if (a.role === "reviewer" || a.role === "researcher")
        throw new Error(
          "Reviewer/Researcher model and effort belong to its captured profile",
        );
      if (a.closeRequest) throw new Error("Session is closing");
      const handle = await this.handle(a, false);
      const current = await handle.readSettings();
      const model = (await this.models()).find(
        (m) =>
          m.id === value.model &&
          (m.backend ?? "codex") === (a.backend ?? "codex") &&
          m.provider === (value.provider ?? a.provider),
      );
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
        current.provider === (value.provider ?? a.provider) &&
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
    if (this.closingTrees.has(root.id)) throw new Error("Tree is closing");
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
          const model = models.find(
            (m) =>
              m.id === current.model &&
              (m.backend ?? "codex") === (a.backend ?? "codex") &&
              m.provider === current.provider,
          );
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
  projects(environment = "local") {
    return this.options.projects(environment);
  }
  private sameProjectDirectory(
    project: Project,
    path: string,
    selected = "local",
    target?: string,
  ) {
    if (environmentId(project) !== selected) return false;
    if (selected !== "local" && target !== project.environment?.target)
      return false;
    return selected === "local"
      ? sameDirectory(project.path, path)
      : project.path === path;
  }
  private async historyProject(alias: string) {
    if (alias.startsWith("@saved:")) {
      const agent = this.readableAgent(this.store.byId(alias.slice(7)));
      if (!agent) throw new Error("Saved project history not found");
      return agent.project;
    }
    const reference = parseProjectReference(alias);
    const project = (await this.projects(reference.environment)).find(
      (p) => p.alias === reference.alias,
    );
    if (!project) throw new Error("Registered project not found");
    return project;
  }
  private historyIdentity(session: HistorySession): HistorySession {
    const agent = this.readableAgent(
      this.state.agents.find((a) => a.threadId === session.threadId) ??
        this.store.byThread(session.threadId),
    );
    if (!agent) return session;
    const owner =
      this.state.agents.find((a) => a.id === agent.ownerId) ??
      (agent.ownerId ? this.store.byId(agent.ownerId) : undefined);
    return {
      ...session,
      title: agent.role !== "orc" ? agent.title : session.title,
      role: agent.role,
      agentId: agent.id,
      closed: agent.closed,
      ownerThreadId: owner?.threadId,
      ownerProject: owner
        ? environmentId(owner.project) === "local"
          ? owner.project.alias
          : `@saved:${owner.id}`
        : undefined,
      environmentId: environmentId(agent.project),
      environmentTarget: agent.project.environment?.target,
    };
  }
  async history(alias: string, query: string, cursor?: string) {
    const project = await this.historyProject(alias);
    const schema = z.object({
      environment: z.string(),
      cwd: z.string(),
      query: z.string(),
      cursor: z.string(),
    });
    const position = cursor ? schema.parse(JSON.parse(cursor)) : undefined;
    if (
      position &&
      (position.environment !== projectDirectoryKey(project) ||
        position.cwd !== project.path ||
        position.query !== query)
    )
      throw new Error("Search changed. Start a new history search.");
    let nextCursor = position?.cursor;
    const sessions: HistorySession[] = [];
    for (let scan = 0; scan < 8 && sessions.length < 30; scan++) {
      const page = await this.options.runtime.history(
        project.path,
        nextCursor,
        project.environment,
      );
      for (const entry of page.sessions) {
        const session = this.historyIdentity(entry);
        if (
          this.sameProjectDirectory(
            project,
            session.cwd,
            session.environmentId,
            session.environmentTarget,
          ) &&
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
        ? JSON.stringify({
            environment: projectDirectoryKey(project),
            cwd: project.path,
            query,
            cursor: nextCursor,
          })
        : null,
    };
  }
  async historySession(alias: string, threadId: string) {
    const project = await this.historyProject(alias);
    const session = this.historyIdentity(
      await this.options.runtime.historyThread(threadId),
    );
    if (
      !this.sameProjectDirectory(
        project,
        session.cwd,
        session.environmentId,
        session.environmentTarget,
      )
    )
      throw new Error("Session does not belong to this project directory");
    return this.historyIdentity(session);
  }
  async historyMessages(
    alias: string,
    threadId: string,
    cursor?: string,
    project?: (m: Message) => Message,
  ) {
    await this.historySession(alias, threadId);
    const agent = this.readableAgent(
      this.state.agents.find((a) => a.threadId === threadId) ??
        this.store.byThread(threadId),
    );
    const page = await readingPage(
      this.options.runtime,
      threadId,
      cursor,
      agent?.deliveries ?? [],
      undefined,
      (m) => {
        m = questionEntry(m, agent?.questions ?? []);
        return project ? project(m) : m;
      },
    );
    return page;
  }
  private async restoreNativeImages(agent: RuntimeAgent, message: Message) {
    if (message.images?.length && this.options.runtime.historyImage) {
      const restored: MessageImage[] = [];
      for (const [index, image] of message.images.entries()) {
        const saved = agent.messages.find((m) => m.id === message.id)?.images?.[
          index
        ];
        if (
          image.availability === "missing" &&
          saved &&
          saved.availability !== "missing" &&
          this.images.read(agent.id, saved.id, false)
        ) {
          restored.push(saved);
          continue;
        }
        if (image.availability !== "missing") {
          restored.push(image);
          continue;
        }
        try {
          const file = await this.options.runtime.historyImage(
            agent.threadId!,
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
      message = { ...message, images: restored };
    }
    return message;
  }
  async agentHistory(
    id: string,
    cursor?: string,
    project?: (m: Message) => Message,
  ) {
    const agent = this.agent(id);
    if (!agent.threadId) return { messages: [], nextCursor: null };
    let confirmed = false;
    const page = await readingPage(
      this.options.runtime,
      agent.threadId,
      cursor,
      agent.deliveries,
      undefined,
      async (message) => {
        const d = message.clientId
          ? agent.deliveries.find((d) => d.id === message.clientId)
          : undefined;
        if (d && d.status !== "sent") {
          this.confirmNative(agent, message.clientId, message.turnId);
          confirmed = true;
          message = associate(message, agent.deliveries);
        }
        message = await this.restoreNativeImages(
          agent,
          questionEntry(message, agent.questions),
        );
        return project ? project(message) : message;
      },
    );
    if (confirmed) this.save();
    return page;
  }

  async resumeHistory(
    alias: string,
    threadId: string,
    archived: boolean,
    settings?: Settings,
  ) {
    return this.serialize(`history:${threadId}`, async () => {
      const project = await this.historyProject(alias);
      const existing =
        this.state.agents.find((a) => a.threadId === threadId) ??
        this.store.byThread(threadId);
      if (
        existing?.project.path !== undefined &&
        !(
          environmentId(existing.project) === environmentId(project) &&
          (environmentId(project) === "local" ||
            existing.project.environment?.target ===
              project.environment?.target) &&
          this.sameProjectDirectory(
            project,
            existing.project.path,
            environmentId(existing.project),
            existing.project.environment?.target,
          )
        )
      )
        throw new Error("Session does not belong to this project directory");
      if (existing && existing.role !== "orc")
        throw new Error("Continue this owned agent through its original Orc");
      if (!existing && environmentId(project) !== "local")
        throw new Error(
          "Original execution target binding is unavailable for this remote history",
        );
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
        await this.assertProject(project, existing?.backend ?? session.backend);
        const workerDefaults = existing
          ? existing.workerDefaults
          : (await this.executionSettings(settings)).worker;
        const agent: RuntimeAgent = existing ?? {
          id: crypto.randomUUID(),
          token: crypto.randomUUID(),
          role: "orc",
          project,
          title: session.title,
          backend: session.backend ?? "codex",
          provider: session.provider,
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
        if (existing) this.store.track(agent);
        agent.restoreArchived = archived;
        try {
          const handle = await this.handle(agent);
          if (!existing) this.store.track(agent, true);
          agent.title = handle.threadName ?? session.title;
          if (!existing) {
            agent.model = handle.model ?? agent.model;
            agent.effort = handle.effort ?? agent.effort;
            agent.serviceTier = handle.serviceTier ?? agent.serviceTier;
            this.state.agents.push(agent);
          }
          if (!this.state.agents.includes(agent)) this.state.agents.push(agent);
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
      orc: {
        backend: first.backend ?? "codex",
        provider: first.provider,
        model: first.id,
        effort: first.defaultEffort,
      },
      worker: {
        backend: first.backend ?? "codex",
        provider: first.provider,
        model: first.id,
        effort: first.defaultEffort,
      },
    };
    const capture = (defaults: Settings["orc"]) => {
      const backend = defaults.backend ?? "codex";
      const model = models.find(
        (m) =>
          m.id === defaults.model &&
          (m.backend ?? "codex") === backend &&
          m.provider === defaults.provider,
      );
      if (!model?.efforts.includes(defaults.effort))
        throw new Error("Choose a supported model and reasoning effort");
      return {
        ...defaults,
        backend,
        serviceTier: value.fast ? (model.fastTier ?? "default") : "default",
      };
    };
    return { orc: capture(value.orc), worker: capture(value.worker) };
  }
  async createOrc(alias: string, settings?: Settings) {
    const reference = parseProjectReference(alias);
    const project = (await this.projects(reference.environment)).find(
      (p) => p.alias === reference.alias,
    );
    if (!project) throw new Error("Registered project not found");
    if (settings) {
      await this.assertProject(project, settings.orc.backend);
      await this.assertProject(project, settings.worker.backend);
    }
    const captured = await this.executionSettings(settings);
    await this.assertProject(project, captured.orc.backend);
    await this.assertProject(project, captured.worker.backend);
    const a: RuntimeAgent = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      role: "orc",
      project,
      title: "New session",
      ...captured.orc,
      treeFast: settings?.fast ?? false,
      workerDefaults: captured.worker,
      orcPromptSnapshot: await this.options.orcPrompt?.(),
      state: "idle",
      closed: false,
      questions: [],
      messages: [],
      deliveries: [],
    };
    this.store.track(a, true);
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
    await this.assertProject(a.project, a.backend);
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
    const a = this.state.agents.find((a) => a.id === id) ?? this.store.byId(id);
    if (a && this.closingTrees.has(a.ownerId ?? a.id))
      return Promise.reject(new Error("Tree is closing"));
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
    if (this.writeFailure) throw this.writeFailure;
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
      let handle: RuntimeHandle;
      try {
        handle = await this.handle(a);
      } catch (error) {
        // No input has crossed the send seam. Opening/resuming a thread cannot
        // admit this operation; only failures after handle.send may be unknown.
        throw new DeliveryRejected(
          error instanceof Error ? error.message : "Session unavailable",
        );
      }
      const activeTurn = !a.turnEnded ? a.turnId : undefined;
      a.turnEnded = false;
      if (!activeTurn && !a.error) {
        a.state = "working";
        a.workingSince ??= Date.now();
      }
      this.save();
      const envelopeContext = JSON.stringify({
        source: d.source,
        questionIds: d.questionIds,
        answers: d.answers,
        images: d.images,
        reportingWorkerId: d.reportingWorkerId,
        reportingReviewerId: d.reportingReviewerId,
        reportingResearcherId: d.reportingResearcherId,
        reviewTarget: d.reviewTarget,
        researchQuestion: d.researchQuestion,
      });
      const send = (observed?: string) =>
        a.backend === "pi"
          ? handle.send(text, observed, paths, requestId, envelopeContext)
          : handle.send(text, observed, paths, requestId);
      let turnId: string;
      try {
        turnId = await send(activeTurn);
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
        turnId = await send(currentTurn);
      }
      if (!this.completedTurns.has(`${a.id}/${turnId}`)) {
        if (turnId !== activeTurn)
          this.event(a, { type: "working", turnId, threadId: handle.threadId });
        a.turnId = turnId;
      }
      if (a.stop && a.stop.turnId !== turnId) a.stop = undefined;
      // Admission is not a native item identity. Until its notification arrives,
      // render the persisted operation once; merge by clientId, never by turn/text.
      if (!a.messages.some((m) => m.clientId === requestId))
        a.messages.splice(messagePosition, 0, {
          id: requestId,
          clientId: requestId,
          provisional: true,
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
          q.answer = answer?.answer ?? d.text;
        }
      this.save();
      if (
        a.role === "orc" &&
        d.source === "user" &&
        text.trim() &&
        a.title === "New session" &&
        a.deliveries.filter((d) => d.source === "user" && d.status === "sent")
          .length === 1
      ) {
        void handle
          .title(text)
          .then((title) => {
            if (
              title &&
              !this.disposed &&
              !a.closed &&
              this.state.agents.includes(a) &&
              this.handles.get(a.id) === handle &&
              a.title === "New session"
            ) {
              a.title = title;
              this.save();
            }
          })
          .catch(() => {});
      }
    } catch (error) {
      if (this.writeFailure) throw this.writeFailure;
      if (d.status !== "sent") {
        d.status = error instanceof DeliveryRejected ? "failed" : "uncertain";
        d.error = error instanceof Error ? error.message : "Delivery failed";
      }
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
    if (["reviewer", "researcher"].includes(this.agent(id).role))
      throw new Error("Continue Reviewer/Researcher instructions through Orc");
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
    if (this.writeFailure) throw this.writeFailure;
    const a = this.state.agents.find((a) => a.id === id) ?? this.store.byId(id);
    if (!a) throw new Error("Agent not found");
    const d = a.deliveries.find((d) => d.id === operationId);
    if (!d || (d.status !== "sent" && d.status !== "failed")) return null;
    return {
      operationId,
      attemptId: d.attemptId,
      state:
        d.status === "sent" ? ("accepted" as const) : ("rejected" as const),
      turnId: d.turnId ?? null,
      error: d.error ?? null,
    };
  }

  private async requireNativeRejection(a: RuntimeAgent, operationId: string) {
    if (!a.threadId) return;
    let cursor: string | undefined;
    do {
      const page = await this.options.runtime.historyMessages(
        a.threadId,
        cursor,
      );
      const accepted = page.messages.find(
        (m) =>
          m.role === "user" &&
          (m.clientId === operationId || m.id === operationId),
      );
      if (accepted) {
        this.confirmNative(a, operationId, accepted.turnId);
        this.save();
        throw new Error(
          "Native history confirms this submission; it cannot be deleted or retried",
        );
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  deleteFailedSubmission(id: string, operationId: string) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      const index = a.deliveries.findIndex((d) => d.id === operationId);
      const d = a.deliveries[index];
      if (
        a.role !== "orc" ||
        a.messages.some(
          (m) =>
            m.role === "user" &&
            (m.id === operationId || m.clientId === operationId),
        ) ||
        (d && (d.source !== "user" || d.status !== "failed"))
      )
        throw new Error("Only a rejected user submission can be deleted");
      if (!d) {
        if (this.store.hasOperationElsewhere(id, operationId))
          throw new Error("Submission belongs to another conversation");
        return this.detail(id); // Pre-admission rejection or already deleted, after queue drain.
      }
      await this.requireNativeRejection(a, operationId);
      a.deliveries.splice(index, 1);
      try {
        this.save();
      } catch (error) {
        a.deliveries.splice(index, 0, d);
        throw error;
      }
      return this.detail(id);
    });
  }
  send(
    id: string,
    text: string,
    requestId: string,
    images?: MessageImage[],
    retry?: import("../src/chord-contract").RetrySend,
  ): Promise<import("../src/chord-contract").SendResult> {
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
        // The logical operation/native clientId stays fixed. A fresh attempt
        // may replace only the exact rejected predecessor, inside this queue.
        // Repeated or delayed tokens return the current outcome without admission.
        if (!retry || previous.attemptId === retry.attempt)
          return this.detail(id);
        if ((previous.attemptId ?? requestId) !== retry.after)
          return { ...this.detail(id), retryNotAdmitted: retry.attempt };
        if (
          previous.status !== "failed" ||
          a.messages.some(
            (m) =>
              m.role === "user" &&
              (m.id === requestId || m.clientId === requestId),
          )
        )
          throw new Error("Only a rejected user submission can be retried");
        await this.requireNativeRejection(a, requestId);
        previous.attemptId = retry.attempt;
        this.save();
        if (a.state === "stopping") return this.detail(id);
        return this.deliver(
          a,
          previous.text,
          requestId,
          "user",
          [],
          undefined,
          previous.images,
        );
      }
      if (images?.length) this.images.validate(a.id, requestId, text, images);
      if (a.state === "stopping") {
        a.deliveries.push({
          id: requestId,
          attemptId: retry?.attempt,
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
      if (retry) {
        a.deliveries.push({
          id: requestId,
          attemptId: retry.attempt,
          text,
          source: "user",
          status: "failed",
          questionIds: [],
          images,
          at: Date.now(),
        });
      }
      return this.deliver(a, text, requestId, "user", [], undefined, images);
    });
  }
  abandonCloseCandidate(id: string) {
    return this.serialize(id, async () => {
      const a = this.readableAgent(
        this.state.agents.find((a) => a.id === id) ?? this.store.byId(id),
      );
      if (!a || a.role !== "orc") throw new Error("Orc session not found");
      return a.closed
        ? { closed: true as const, unknownOperationIds: [] }
        : {
            closed: false as const,
            unknownOperationIds: this.abandonUnknownIds(a),
          };
    });
  }
  private abandonUnknownIds(a: RuntimeAgent): string[] {
    if (
      a.closed ||
      a.role !== "orc" ||
      !["idle", "error"].includes(a.state) ||
      a.turnId ||
      this.opening.has(a.id) ||
      this.treeActions.has(a.id) ||
      this.state.agents.some((w) => w.ownerId === a.id && !w.closed) ||
      a.questions.some((q) => q.state !== "answered") ||
      a.deliveries.some(
        (d) =>
          d.status === "queued" ||
          d.status === "sending" ||
          (d.status === "uncertain" && d.source !== "user"),
      )
    )
      throw new Error(
        "This session cannot abandon unconfirmed submissions while work, questions or owned agents remain",
      );
    const ids = a.deliveries
      .filter((d) => d.status === "uncertain" && d.source === "user")
      .map((d) => d.id);
    if (!ids.length)
      throw new Error("No unconfirmed user submissions to abandon");
    return ids;
  }
  async closeTree(id: string, abandonUnknownOperationIds?: string[]) {
    if (abandonUnknownOperationIds !== undefined)
      return this.closeAbandoningUnknown(id, abandonUnknownOperationIds);
    const a = this.agent(id);
    if (a.role !== "orc") throw new Error("Only an Orc tree can be closed");
    if (this.closingTrees.has(id)) throw new Error("Tree is closing");
    const members = this.state.agents.filter(
      (w) => w.ownerId === id && !w.closed,
    );
    const validate = () => {
      if (this.writeFailure) throw this.writeFailure;
      if (this.disposed) throw new Error("Workspace is stopped");
      if (this.treeActions.has(id))
        throw new Error("Tree settings are being saved");
      this.assertIdle(a);
      for (const member of [a, ...members.filter((w) => !w.closed)]) {
        if (
          this.queues.has(member.id) ||
          this.opening.has(member.id) ||
          this.closingChildren.has(member.id)
        )
          throw new Error(`${member.title} has an in-flight operation`);
      }
      for (const w of members.filter((w) => !w.closed)) {
        const reason = this.childCloseReason(w);
        if (reason)
          throw new Error(
            `${w.role[0]!.toUpperCase() + w.role.slice(1)} “${w.title}”: ${reason}`,
          );
        if (!w.threadId)
          throw new Error(`${w.title}: Native thread startup is unconfirmed`);
      }
    };
    validate(); // No releases or durable close requests on preflight failure.
    this.closingTrees.add(id);
    try {
      for (const member of [...members, a]) {
        validate();
        try {
          const handle = await this.handle(member, false);
          validate(); // Native resume may have revealed new work or a disconnect.
          await handle.close();
        } catch (error) {
          throw new Error(
            `${member.title}: Native thread release failed: ${String(error)}. Retry Close tree after inspecting the outcome.`,
          );
        }
        if (this.disposed)
          throw new Error("Workspace stopped during native release");
        this.handles.delete(member.id);
        if (member === a) validate();
        else {
          const reason = this.childCloseReason(member);
          if (reason) throw new Error(`${member.title}: ${reason}`);
        }
        this.failedChildCloses.delete(member.id);
        member.closed = true;
        this.save();
      }
      return { closed: true as const, id };
    } finally {
      this.closingTrees.delete(id);
    }
  }
  private closeAbandoningUnknown(id: string, operationIds: string[]) {
    return this.serialize(id, async () => {
      const a = this.agent(id);
      const validate = () => {
        const actual = this.abandonUnknownIds(a);
        if (
          actual.length !== operationIds.length ||
          new Set(operationIds).size !== actual.length ||
          actual.some((id) => !operationIds.includes(id))
        )
          throw new Error(
            "Unconfirmed submissions changed. Read the session and confirm again.",
          );
      };
      validate();
      // Keep explicit abandonment scoped to the root and its cached handle.
      await this.handles.get(id)?.close();
      this.handles.delete(id);
      validate();
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
    return this.options.runtime.skills(
      this.agent(id).project.path,
      this.agent(id).backend ?? "codex",
      this.agent(id).project.environment,
    );
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
    role: "worker" | "reviewer" | "researcher",
  ) {
    const w = this.agent(id);
    if (w.role !== role || w.ownerId !== owner.id)
      throw new Error(
        `${role === "reviewer" ? "Reviewer" : role === "researcher" ? "Researcher" : "Worker"} does not belong to this Orc`,
      );
    return w;
  }
  async tool(token: string, name: string, args: unknown): Promise<unknown> {
    const a = this.authenticated(token);
    if (!(roleTools[a.role] as readonly string[]).includes(name))
      throw new Error("Tool is not available to this role");
    if (
      this.closingTrees.has(a.ownerId ?? a.id) &&
      !name.endsWith("_read") &&
      !name.endsWith("_list")
    )
      throw new Error("Tree is closing");
    switch (name) {
      case "researcher_start":
      case "reviewer_start":
      case "worker_start": {
        const isReviewer = name === "reviewer_start";
        const isResearcher = name === "researcher_start";
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const review = isReviewer
          ? z.object(toolDefinitions.reviewer_start.shape).parse(args)
          : undefined;
        return this.serialize(a.id, async () => {
          this.agent(a.id);
          await this.assertProject(a.project, a.backend);
          const requested = parseProjectReference(input.project);
          if (
            input.project.includes(":") &&
            requested.environment !== environmentId(a.project)
          )
            throw new Error(
              "Delegation cannot change the tree execution environment",
            );
          const project = (await this.projects(environmentId(a.project))).find(
            (p) => p.alias === requested.alias,
          );
          if (!project) throw new Error("Registered project not found");
          const w: RuntimeAgent = {
            id: crypto.randomUUID(),
            token: crypto.randomUUID(),
            role: isReviewer
              ? "reviewer"
              : isResearcher
                ? "researcher"
                : "worker",
            ownerId: a.id,
            project,
            title: input.title,
            ...(a.workerDefaults ?? {
              backend: a.backend ?? "codex",
              provider: a.provider,
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
          if ("question" in input) {
            if (!this.options.researcherSnapshot)
              throw new Error("Researcher configuration is unavailable");
            const snapshot = await this.options.researcherSnapshot();
            w.researcherSnapshot = snapshot;
            w.backend = snapshot.backend ?? "codex";
            w.provider = snapshot.provider;
            w.model = snapshot.model;
            w.effort = snapshot.effort;
            w.researchQuestion = input.question;
          }
          if (review) {
            if (!this.options.reviewerSnapshot)
              throw new Error("Reviewer configuration is unavailable");
            const snapshot = await this.options.reviewerSnapshot(
              review.profile,
            );
            w.reviewerSnapshot = snapshot;
            w.backend = snapshot.backend ?? "codex";
            w.provider = snapshot.provider;
            w.model = snapshot.model;
            w.effort = snapshot.effort;
            w.reviewTarget = {
              profile: review.profile,
              spec: review.spec,
              fixedPoint: review.fixedPoint,
              reviewedHead: review.reviewedHead,
            };
          }
          await this.assertProject(project, w.backend);
          {
            const model = (await this.models()).find(
              (m) =>
                m.id === w.model &&
                (m.backend ?? "codex") === (w.backend ?? "codex") &&
                m.provider === w.provider,
            );
            if (!model || !model.efforts.includes(w.effort))
              throw new Error(
                "Assigned model or reasoning effort is unavailable",
              );
            w.serviceTier =
              (a.treeFast ?? a.serviceTier !== "default")
                ? (model.fastTier ?? "default")
                : "default";
          }
          const assignment =
            "question" in input
              ? `Assigned research question: ${input.question}\n\n${input.message}`
              : `Assigned spec: ${input.spec}\n${review ? `Review target: ${reviewTargetText(w.reviewTarget!)}\n` : ""}\n${input.message}`;
          if (assignment.length > 100_000)
            throw new Error(
              "Message is too long, including the assignment target",
            );
          this.store.track(w, true);
          this.state.agents.push(w);
          this.save();
          try {
            await this.handle(w);
          } catch (error) {
            if (isReviewer || isResearcher) {
              w.state = "error";
              w.error = `${isReviewer ? "Reviewer" : "Researcher"} thread startup unconfirmed: ${String(error)}. Inspect this agent before replacing it; do not replay start.`;
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
      case "researcher_list":
      case "reviewer_list":
      case "worker_list": {
        this.readableAgent(a);
        z.object(toolDefinitions[name].shape).parse(args);
        return this.state.agents
          .filter(
            (w) =>
              w.role ===
                (name === "researcher_list"
                  ? "researcher"
                  : name === "reviewer_list"
                    ? "reviewer"
                    : "worker") &&
              w.ownerId === a.id &&
              !w.closed,
          )
          .map((w) => this.publicAgent(w));
      }
      case "researcher_read":
      case "reviewer_read":
      case "worker_read": {
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const w = this.ownedChild(
          a,
          "workerId" in input
            ? input.workerId
            : "researcherId" in input
              ? input.researcherId
              : input.reviewerId,
          name === "worker_read"
            ? "worker"
            : name === "researcher_read"
              ? "researcher"
              : "reviewer",
        );
        const page = w.threadId
          ? await readingPage(
              this.options.runtime,
              w.threadId,
              input.before
                ? Buffer.from(
                    JSON.stringify({ before: input.before }),
                  ).toString("base64url")
                : undefined,
              w.deliveries,
              undefined,
              (m) => questionEntry(m, w.questions),
            )
          : { messages: [], nextCursor: null };
        const nativeClients = new Set(
          page.messages.filter((m) => m.clientId).map((m) => m.clientId),
        );
        const rows = input.before
          ? page.messages
          : [
              ...new Map(
                [
                  ...page.messages,
                  ...w.messages.filter(
                    (m) => !m.provisional || !nativeClients.has(m.clientId),
                  ),
                ].map((m) => [m.id, m]),
              ).values(),
            ];
        const messages = structuredClone(rows.slice(-(input.limit ?? 20)));
        const hasMore = rows.length > messages.length || !!page.nextCursor;
        return {
          [w.role]: this.publicAgent(w),
          messages,
          hasMore,
          nextBefore: hasMore ? messages[0]?.id : null,
        };
      }
      case "researcher_send":
      case "reviewer_send":
      case "worker_send": {
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const w = this.ownedChild(
          a,
          "workerId" in input
            ? input.workerId
            : "researcherId" in input
              ? input.researcherId
              : input.reviewerId,
          name === "worker_send"
            ? "worker"
            : name === "researcher_send"
              ? "researcher"
              : "reviewer",
        );
        for (const id of input.questionIds ?? [])
          if (!w.questions.some((q) => q.id === id && q.state === "delegated"))
            throw new Error("Delegated question not found");
        return this.serialize(w.id, async () => {
          this.agent(w.id);
          if ((w.role === "reviewer" || w.role === "researcher") && !w.threadId)
            throw new Error(
              `${w.role === "researcher" ? "Researcher" : "Reviewer"} thread startup is unconfirmed; inspect native history before replacing this agent`,
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
      case "researcher_close":
      case "reviewer_close":
      case "worker_close": {
        const input = z.object(toolDefinitions[name].shape).parse(args);
        const w = this.ownedChild(
          a,
          "workerId" in input
            ? input.workerId
            : "researcherId" in input
              ? input.researcherId
              : input.reviewerId,
          name === "worker_close"
            ? "worker"
            : name === "researcher_close"
              ? "researcher"
              : "reviewer",
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
          [`${w.role}Id`]: w.id,
          reason: w.closed ? undefined : w.closeRequest.reason,
        };
      }
      case "researcher_report": {
        const input = z
          .object(toolDefinitions.researcher_report.shape)
          .parse(args);
        if (input.question !== a.researchQuestion)
          throw new Error(
            "Report question does not match assigned research question",
          );
        return this.report(
          a,
          `Researcher “${a.title}” reports (Question: ${a.researchQuestion}):\n\n${input.message}`,
          crypto.randomUUID(),
        );
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
      source:
        worker.role === "researcher"
          ? "researcher"
          : worker.role === "reviewer"
            ? "reviewer"
            : "worker",
      ...(worker.role === "researcher"
        ? {
            reportingResearcherId: worker.id,
            researchQuestion: worker.researchQuestion,
          }
        : worker.role === "reviewer"
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
        worker.role === "researcher"
          ? "researcher"
          : worker.role === "reviewer"
            ? "reviewer"
            : "worker",
      ),
    );
  }
  private childCloseReason(w: RuntimeAgent) {
    let reason: string | undefined;
    if (this.queues.has(w.id) || this.opening.has(w.id))
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
            (d.reportingWorkerId ??
              d.reportingReviewerId ??
              d.reportingResearcherId) === w.id && d.status !== "sent",
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
    return reason;
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
      const reason =
        this.treeActions.has(w.ownerId!) || this.closingTrees.has(w.ownerId!)
          ? "Waiting for in-flight tree operations"
          : this.childCloseReason(w);
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
          (d.reportingWorkerId ??
            d.reportingReviewerId ??
            d.reportingResearcherId) === a.id && d.status !== "sent",
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
    this.completedItems.clear();
    void this.options.runtime.close().catch(() => {
      console.error("Runtime shutdown could not release all resources");
    });
    this.store.close();
  }
}
