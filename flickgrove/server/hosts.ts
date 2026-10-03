import {
  chmodSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  Detail,
  Host,
  Settings,
  Snapshot,
  WeeklyUsage,
} from "../src/contracts";
import type { Workspace } from "./workspace";

type Peer = { id: string; name: string; url: string; credential: string };
type PrivateState = {
  id: string;
  credential: string;
  peers: Peer[];
  defaults: Settings | null;
};
type Cache = { host: Host; snapshot?: Snapshot; details: Map<string, Detail> };
class PeerRejected extends Error {}
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
export class HostService {
  readonly identity: { id: string; role: "hub" | "execution" };
  readonly credential: string;
  private readonly file: string;
  private readonly state: PrivateState;
  private readonly caches = new Map<string, Cache>();
  private readonly subscribers = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private revision = 0;
  private configuring: Promise<unknown> = Promise.resolve();
  private initializing?: Promise<void>;
  private readonly syncing = new Map<string, Promise<void>>();
  private refreshing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    readonly workspace: Workspace,
    readonly options: {
      directory: string;
      hub: boolean;
      name?: string;
      origin: () => string;
      timeoutMs?: number;
      pollMs?: number;
    },
  ) {
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    this.file = join(options.directory, "hosts.json");
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, "utf8"))
      : {
          id: crypto.randomUUID(),
          credential: crypto.randomUUID(),
          peers: [],
          defaults: null,
        };
    this.identity = {
      id: this.state.id,
      role: options.hub ? "hub" : "execution",
    };
    this.credential = this.state.credential;
    this.persist();
    this.unsubscribe = workspace.subscribe(() => this.publish());
    if (options.hub) {
      for (const peer of this.state.peers)
        this.caches.set(peer.id, this.empty(peer));
      this.timer = setInterval(
        () => void this.refresh(),
        options.pollMs ?? 3000,
      );
      void this.refresh();
    }
  }
  private persist() {
    const temporary = this.file + ".tmp";
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.file);
  }
  private publish() {
    this.revision++;
    for (const f of this.subscribers) f();
  }
  subscribe(f: () => void) {
    this.subscribers.add(f);
    return () => this.subscribers.delete(f);
  }
  private empty(peer: Peer): Cache {
    return {
      host: {
        id: peer.id,
        name: peer.name,
        url: peer.url,
        role: "execution",
        connected: false,
        defaults: "pending",
      },
      details: new Map(),
    };
  }
  private local(): Host {
    return {
      ...this.identity,
      name: this.options.name ?? (this.options.hub ? "Hub" : "Execution host"),
      url: this.options.origin(),
      connected: true,
      lastSeen: Date.now(),
      defaults: "synced",
    };
  }
  snapshot(): Snapshot {
    const local = this.local();
    return {
      ...this.workspace.snapshot(),
      hubId: this.identity.id,
      settings: this.state.defaults ?? this.workspace.snapshot().settings,
      revision: this.revision,
      hosts: [local, ...[...this.caches.values()].map((c) => ({ ...c.host }))],
      agents: [
        ...this.workspace.snapshot().agents.map((a) => qualified(local, a)),
        ...[...this.caches.values()].flatMap(
          (c) => c.snapshot?.agents.map((a) => qualified(c.host, a)) ?? [],
        ),
      ],
    };
  }
  private url(value: string) {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    )
      throw new Error(
        "Use an HTTP(S) service origin without a path or embedded credentials",
      );
    return url.origin;
  }
  private async request<T>(
    peer: Peer,
    path: string,
    body?: unknown,
    method = "POST",
  ): Promise<T> {
    const response = await fetch(`${peer.url}/execution${path}`, {
      method: body === undefined ? "GET" : method,
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 4000),
      headers: {
        Authorization: `Bearer ${peer.credential}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (response.status >= 500) throw new Error("Execution host unavailable");
      throw new PeerRejected(
        response.status === 401
          ? "Host authorization failed"
          : (body.error ?? "Execution host rejected the request"),
      );
    }
    return (await response.json()) as T;
  }
  private async verify(peer: Peer) {
    const identity = await this.request<{ id: string; role: string }>(
      peer,
      "/identity",
    );
    if (!identity.id || identity.id.includes(":"))
      throw new Error("Invalid service identity");
    if (identity.role !== "execution")
      throw new Error(
        "Only execution services can be added; this service is a Hub",
      );
    if (identity.id === this.identity.id)
      throw new Error("The Hub is already included");
    if (peer.id && identity.id !== peer.id)
      throw new Error(
        "Host identity changed; address edit cannot move ownership",
      );
    return identity.id;
  }
  async register(input: {
    id?: string;
    name: string;
    url: string;
    credential: string;
  }) {
    const existing = input.id
      ? this.state.peers.find((p) => p.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("Host not found");
    const peer = {
      id: existing?.id ?? "",
      name: input.name.trim(),
      url: this.url(input.url),
      credential: input.credential || existing?.credential || "",
    };
    if (!peer.name || peer.name.length > 120 || !peer.credential)
      throw new Error("Name and access token are required");
    peer.id = await this.verify(peer);
    if (!existing && this.state.peers.some((p) => p.id === peer.id))
      throw new Error("This host is already registered");
    const snapshot = await this.request<Snapshot>(peer, "/snapshot");
    if (!existing && this.state.peers.some((p) => p.id === peer.id))
      throw new Error("This host is already registered");
    if (existing) Object.assign(existing, peer);
    else this.state.peers.push(peer);
    const cache = this.caches.get(peer.id) ?? this.empty(peer);
    cache.host = {
      ...cache.host,
      name: peer.name,
      url: peer.url,
      connected: true,
      lastSeen: Date.now(),
    };
    cache.snapshot = snapshot;
    this.caches.set(peer.id, cache);
    this.persist();
    await this.sync(peer, cache);
    this.publish();
    return this.snapshot();
  }
  private sync(peer: Peer, cache: Cache): Promise<void> {
    const previous = this.syncing.get(peer.id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => this.publishDefaults(peer, cache));
    this.syncing.set(peer.id, next);
    void next
      .finally(() => {
        if (this.syncing.get(peer.id) === next) this.syncing.delete(peer.id);
      })
      .catch(() => {});
    return next;
  }
  private async publishDefaults(peer: Peer, cache: Cache) {
    try {
      await this.initializeDefaults();
      const desired = structuredClone(this.state.defaults!);
      await this.request(peer, "/settings", desired, "PUT");
      cache.host.defaults =
        JSON.stringify(desired) === JSON.stringify(this.state.defaults)
          ? "synced"
          : "pending";
    } catch {
      cache.host.defaults = "failed";
    }
  }
  private initializeDefaults(): Promise<void> {
    if (this.state.defaults) return Promise.resolve();
    return (this.initializing ??= (async () => {
      let defaults = this.workspace.snapshot().settings;
      if (!defaults) {
        const models = await this.workspace.models();
        const model = models.find((m) => m.isDefault) ?? models[0];
        if (!model) throw new Error("No models available");
        defaults = {
          fast: false,
          orc: { model: model.id, effort: model.defaultEffort },
          worker: { model: model.id, effort: model.defaultEffort },
        };
      }
      // A concurrent explicit settings update remains authoritative.
      if (!this.state.defaults) {
        this.state.defaults = structuredClone(defaults);
        this.persist();
      }
    })().finally(() => {
      this.initializing = undefined;
    }));
  }
  refresh(): Promise<void> {
    return (this.refreshing ??= this.refreshPeers().finally(() => {
      this.refreshing = undefined;
    }));
  }
  private async refreshPeers() {
    await Promise.all(
      this.state.peers.map(async (peer) => {
        const cache = this.caches.get(peer.id)!;
        try {
          await this.verify(peer);
          if (cache.host.defaults !== "synced" || !cache.host.connected)
            await this.sync(peer, cache);
          const snapshot = await this.request<Snapshot>(peer, "/snapshot");
          // Only refresh viewed conversations. These are display data, never authority or replay state.
          const details = await Promise.all(
            [...cache.details.keys()]
              .filter((id) => snapshot.agents.some((a) => a.id === id))
              .map(
                async (id) =>
                  [
                    id,
                    await this.request<Detail>(
                      peer,
                      `/agents/${encodeURIComponent(id)}`,
                    ),
                  ] as const,
              ),
          );
          cache.snapshot = snapshot;
          cache.details = new Map(details);
          cache.host.connected = true;
          cache.host.lastSeen = Date.now();
          cache.host.error = undefined;
        } catch {
          cache.host.connected = false;
          cache.host.error = "Host disconnected. Reconnecting automatically.";
        }
      }),
    );
    this.publish();
  }
  private host(id?: string) {
    if (!id || id === this.identity.id) return null;
    const peer = this.state.peers.find((p) => p.id === id);
    if (!peer) throw new Error("Host not found");
    return peer;
  }
  private route(id: string) {
    const i = id.indexOf(":");
    if (i < 1) throw new Error("Use a host-qualified session ID");
    return { peer: this.host(id.slice(0, i)), id: id.slice(i + 1) };
  }
  private available(peer: Peer) {
    if (!this.caches.get(peer.id)?.host.connected)
      throw new Error("Host disconnected. Reconnect before making changes.");
  }
  async projects(hostId?: string) {
    const p = this.host(hostId);
    if (!p) return this.workspace.projects();
    this.available(p);
    return this.request<Awaited<ReturnType<Workspace["projects"]>>>(
      p,
      "/projects",
    );
  }
  async models(hostId?: string) {
    const p = this.host(hostId);
    if (!p) return this.workspace.models();
    this.available(p);
    return this.request<Awaited<ReturnType<Workspace["models"]>>>(p, "/models");
  }
  private configure<T>(work: () => Promise<T>): Promise<T> {
    const next = this.configuring.catch(() => {}).then(work);
    this.configuring = next;
    return next;
  }
  saveSettings(settings: Settings) {
    return this.configure(() => this.updateSettings(settings));
  }
  private async updateSettings(settings: Settings) {
    await this.workspace.saveSettings(settings);
    this.state.defaults = structuredClone(settings);
    this.persist();
    for (const cache of this.caches.values()) cache.host.defaults = "pending";
    this.publish();
    await Promise.all(
      this.state.peers.map(async (p) => {
        const c = this.caches.get(p.id)!;
        if (c.host.connected) await this.sync(p, c);
      }),
    );
    this.publish();
  }
  createOrc(alias: string, hostId?: string) {
    return this.configure(() => this.create(alias, hostId));
  }
  private async create(alias: string, hostId?: string) {
    await this.initializeDefaults();
    const p = this.host(hostId);
    if (!p) {
      await this.workspace.saveSettings(this.state.defaults!);
      return qualified(this.local(), await this.workspace.createOrc(alias));
    }
    this.available(p);
    const c = this.caches.get(p.id)!;
    await this.sync(p, c);
    if (c.host.defaults !== "synced") {
      this.publish();
      throw new Error(
        "Host defaults could not synchronize. Check model/Fast support before creating.",
      );
    }
    try {
      const a = await this.request<Agent>(p, "/agents", { project: alias });
      await this.refresh();
      return qualified(c.host, a);
    } catch (error) {
      if (error instanceof PeerRejected) throw error;
      throw this.unknown(c);
    }
  }
  async detail(id: string) {
    const r = this.route(id);
    if (!r.peer) return qualified(this.local(), this.workspace.detail(r.id));
    const c = this.caches.get(r.peer.id)!;
    if (!c.host.connected) {
      const detail = c.details.get(r.id);
      if (!detail)
        throw new Error("Conversation unavailable until this host reconnects");
      return qualified(c.host, detail);
    }
    try {
      const detail = await this.request<Detail>(
        r.peer,
        `/agents/${encodeURIComponent(r.id)}`,
      );
      c.details.set(r.id, detail);
      return qualified(c.host, detail);
    } catch {
      c.host.connected = false;
      this.publish();
      const detail = c.details.get(r.id);
      if (detail) return qualified(c.host, detail);
      throw new Error("Host disconnected");
    }
  }
  async skills(id: string) {
    const r = this.route(id);
    if (!r.peer) return this.workspace.skills(r.id);
    this.available(r.peer);
    return this.request<Awaited<ReturnType<Workspace["skills"]>>>(
      r.peer,
      `/agents/${encodeURIComponent(r.id)}/skills`,
    );
  }
  private async mutate(
    id: string,
    action: string,
    body: unknown,
    local: (id: string) => Promise<unknown>,
  ) {
    const r = this.route(id);
    if (!r.peer) {
      const result = await local(r.id);
      return this.result(this.local(), result);
    }
    this.available(r.peer);
    const c = this.caches.get(r.peer.id)!;
    try {
      const result = await this.request(
        r.peer,
        `/agents/${encodeURIComponent(r.id)}/${action}`,
        body,
      );
      await this.refresh();
      return this.result(c.host, result);
    } catch (error) {
      if (error instanceof PeerRejected) throw error;
      throw this.unknown(c);
    }
  }
  private unknown(cache: Cache) {
    cache.host.connected = false;
    this.publish();
    return new Error(
      "Outcome unknown. Reconnect and inspect the workspace before another action; this request will not be replayed.",
    );
  }
  private result(host: Host, result: unknown) {
    return result && typeof result === "object" && "role" in result
      ? qualified(host, result as Detail)
      : result;
  }
  send(id: string, text: string, requestId: string) {
    return this.mutate(id, "messages", { text, requestId }, (id) =>
      this.workspace.send(id, text, requestId),
    );
  }
  answer(id: string, questionId: string, answer: string) {
    return this.mutate(id, "answer", { questionId, answer }, (id) =>
      this.workspace.answer(id, questionId, answer),
    );
  }
  reconcile(id: string, deliveryId: string, accepted: boolean) {
    return this.mutate(id, "reconcile", { deliveryId, accepted }, (id) =>
      this.workspace.reconcile(id, deliveryId, accepted),
    );
  }
  stop(id: string, turnId: string) {
    return this.mutate(id, "stop", { turnId }, (id) =>
      this.workspace.stop(id, turnId),
    );
  }
  async weekly(hostId?: string): Promise<WeeklyUsage> {
    const p = this.host(hostId);
    if (!p)
      return {
        ...(await this.workspace.weekly()),
        hostId: this.identity.id,
        source: this.local().name,
      };
    const c = this.caches.get(p.id)!;
    try {
      this.available(p);
      return {
        ...(await this.request<WeeklyUsage>(p, "/weekly")),
        hostId: p.id,
        source: c.host.name,
      };
    } catch {
      return {
        remaining: null,
        hostId: p.id,
        source: c.host.name,
        fetchedAt: Date.now(),
      };
    }
  }
  dispose() {
    clearInterval(this.timer);
    this.unsubscribe();
    this.subscribers.clear();
  }
}
