import {
  chmodSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  Detail,
  Host,
  Settings,
  Snapshot,
  Answer,
  MessageImage,
} from "../src/contracts";
import type { Workspace } from "./workspace";

export const qualify = (host: string, id: string) => `${host}:${id}`;
function qualified<T extends Agent>(host: Host, a: T): T {
  // Whitelist public fields at the execution boundary, including when a peer
  // accidentally returns an internal agent record. Credentials never cross it.
  const publicAgent: Agent = {
    id: qualify(host.id, a.id),
    role: a.role,
    ownerId: a.ownerId ? qualify(host.id, a.ownerId) : undefined,
    project: a.project,
    title: a.title,
    model: a.model,
    effort: a.effort,
    state: a.state,
    workingSince: a.workingSince,
    threadId: a.threadId,
    turnId: a.turnId,
    error: a.error,
    closed: a.closed,
    questions: a.questions,
    serviceTier: a.serviceTier,
    stop: a.stop,
    closeRequest: a.closeRequest,
    historyCursor: a.historyCursor,
    historyMessageCount: a.historyMessageCount,
    hostId: host.id,
    hostName: host.name,
  };
  if ("deliveries" in a && "messages" in a) {
    const detail = a as unknown as Detail;
    return {
      ...publicAgent,
      messages: detail.messages,
      deliveries: detail.deliveries.map((d) => ({
        ...d,
        reportingWorkerId: d.reportingWorkerId
          ? qualify(host.id, d.reportingWorkerId)
          : undefined,
      })),
    } as unknown as T;
  }
  return publicAgent as T;
}
// A Peer owns only its local workspace. Browser clients perform aggregation.
export class HostService {
  readonly identity: { id: string; name: string };
  readonly credential: string;
  constructor(
    readonly workspace: Workspace,
    readonly options: {
      directory: string;
      name?: string;
      origin: () => string;
    },
  ) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const file = join(options.directory, "hosts.json");
    const state = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { id: crypto.randomUUID(), credential: crypto.randomUUID() };
    if (
      !state.id ||
      state.id.includes(":") ||
      typeof state.credential !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(state.credential)
    )
      throw new Error("Invalid Peer identity");
    writeFileSync(
      file,
      JSON.stringify({ id: state.id, credential: state.credential }),
      { mode: 0o600 },
    );
    chmodSync(file, 0o600);
    this.identity = { id: state.id, name: options.name ?? "This Peer" };
    this.credential = state.credential;
  }
  private local(): Host {
    return { ...this.identity, url: this.options.origin(), connected: true };
  }
  private raw(id: string) {
    const prefix = this.identity.id + ":";
    if (!id.startsWith(prefix))
      throw new Error("Conversation belongs to another Peer");
    return id.slice(prefix.length);
  }
  subscribe(f: () => void) {
    return this.workspace.subscribe(f);
  }
  snapshot(): Snapshot {
    return {
      ...this.workspace.snapshot(),
      entryId: this.identity.id,
      hosts: [this.local()],
      agents: this.workspace
        .snapshot()
        .agents.map((a) => qualified(this.local(), a)),
    };
  }
  projects() {
    return this.workspace.projects();
  }
  models() {
    return this.workspace.models();
  }
  async weekly() {
    return {
      ...(await this.workspace.weekly()),
      hostId: this.identity.id,
      source: this.identity.name,
    };
  }
  async history(alias: string, query: string, cursor?: string) {
    const page = await this.workspace.history(alias, query, cursor);
    return {
      ...page,
      sessions: page.sessions.map((s) => ({
        ...s,
        agentId: s.agentId ? qualify(this.identity.id, s.agentId) : undefined,
      })),
    };
  }
  historySession(alias: string, threadId: string) {
    return this.workspace.historySession(alias, threadId);
  }
  historyMessages(alias: string, threadId: string, cursor?: string) {
    return this.workspace.historyMessages(alias, threadId, cursor);
  }
  async resumeHistory(
    alias: string,
    threadId: string,
    archived: boolean,
    settings: Settings,
  ) {
    return qualified(
      this.local(),
      await this.workspace.resumeHistory(alias, threadId, archived, settings),
    );
  }
  async createOrc(alias: string, settings: Settings) {
    return qualified(
      this.local(),
      await this.workspace.createOrc(alias, settings),
    );
  }
  async detail(id: string) {
    return qualified(this.local(), this.workspace.detail(this.raw(id)));
  }
  agentHistory(id: string, cursor?: string) {
    return this.workspace.agentHistory(this.raw(id), cursor);
  }
  skills(id: string) {
    return this.workspace.skills(this.raw(id));
  }
  async uploadImages(
    id: string,
    operationId: string,
    text: string,
    files: File[],
  ) {
    const raw = this.raw(id);
    const agent = this.workspace.detail(raw);
    if (agent.role !== "orc" || agent.closed)
      throw new Error("Choose an open Orc conversation");
    return this.workspace.images.upload(raw, operationId, text, files);
  }
  media(id: string, imageId: string, preview: boolean) {
    const raw = this.raw(id);
    this.workspace.detail(raw);
    return this.workspace.images.read(raw, imageId, preview);
  }
  async send(
    id: string,
    text: string,
    operationId: string,
    images?: MessageImage[],
  ) {
    return qualified(
      this.local(),
      await this.workspace.send(this.raw(id), text, operationId, images),
    );
  }
  async rename(id: string, title: string) {
    return qualified(
      this.local(),
      await this.workspace.rename(this.raw(id), title),
    );
  }
  closeTree(id: string) {
    return this.workspace.closeTree(this.raw(id));
  }
  async answerBatch(id: string, answers: Answer[], operationId: string) {
    return qualified(
      this.local(),
      await this.workspace.answerBatch(this.raw(id), answers, operationId),
    );
  }
  retryDelivery(id: string, deliveryId: string) {
    return this.workspace.retryDelivery(this.raw(id), deliveryId);
  }
  lookup(id: string, operationId: string) {
    return this.workspace.lookup(this.raw(id), operationId);
  }
  async stop(id: string, turnId: string) {
    return qualified(
      this.local(),
      await this.workspace.stop(this.raw(id), turnId),
    );
  }
  dispose() {}
}
