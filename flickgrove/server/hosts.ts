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
import { monitorHost } from "./host-liveness";

import {
  openGrove,
  RequestRejected,
  type GroveClient,
} from "../src/chord-client";
import {
  routeCall,
  detailSchema,
  receiptSchema,
  type View,
} from "../src/chord-contract";

type Link = {
  client?: GroveClient;
  socket?: WebSocket;
  connecting?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  generation: number;
};
type Peer = { id: string; name: string; url: string; credential: string };
type PrivateState = {
  id: string;
  credential: string;
  peers: Peer[];
  defaults: Settings | null;
};
type Cache = { host: Host; snapshot?: Snapshot; details: Map<string, Detail> };

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
  private readonly links = new Map<string, Link>();
  private readonly observed = new Map<string, number>();
  private disposed = false;
  constructor(
    readonly workspace: Workspace,
    readonly options: {
      directory: string;
      hub: boolean;
      name?: string;
      origin: () => string;
      timeoutMs?: number;
      probeIntervalMs?: number;
      probeTimeoutMs?: number;
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
      for (const peer of this.state.peers)
        void this.connect(peer).catch(() => {});
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
    _method = "POST",
  ): Promise<T> {
    await this.connect(peer);
    const client = this.links.get(peer.id)?.client;
    if (!client) throw new Error("Execution host unavailable");
    const call = routeCall(path, body);
    return client.call<T>(call.member, call.input);
  }
  private connect(peer: Peer): Promise<void> {
    let link = this.links.get(peer.id);
    if (!link) {
      link = { generation: 0 };
      this.links.set(peer.id, link);
    }
    if (link.client) return Promise.resolve();
    if (link.connecting) return link.connecting;
    clearTimeout(link.timer);
    const current = link;
    const generation = ++current.generation;
    const url = new URL("/execution/socket", peer.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new (WebSocket as unknown as {
      new (url: URL, options: { headers: Record<string, string> }): WebSocket;
    })(url, {
      headers: {
        Authorization: `Bearer ${peer.credential}`,
        "Grove-Host": peer.id,
      },
    });
    current.socket = socket;
    socket.addEventListener(
      "close",
      (event) => {
        if (!this.disposed && generation === current.generation)
          console.warn("[grove] host socket closed", {
            hostId: peer.id,
            code: event.code,
          });
      },
      { once: true },
    );
    let offlineReported = false;
    const offline = () => {
      if (this.disposed || generation !== current.generation || offlineReported)
        return;
      offlineReported = true;
      current.client = undefined;
      const cache = this.caches.get(peer.id);
      if (cache) {
        cache.host.connected = false;
        cache.host.error = "Host disconnected. Reconnecting automatically.";
        this.publish();
      }
      current.timer = setTimeout(() => {
        void this.connect(peer).catch(() => {});
      }, 1000);
    };
    let latest: View | undefined;
    current.connecting = (async () => {
      const client = await openGrove(
        socket,
        (value) => {
          if (generation !== current.generation || this.disposed) return;
          latest = value;
          if (current.client) this.adoptPeer(peer, value);
        },
        offline,
        this.options.timeoutMs ?? 30_000,
        (member) =>
          console.warn("[grove] host request timed out", {
            hostId: peer.id,
            member,
          }),
      );
      monitorHost(
        socket,
        () => {
          console.warn("[grove] host pong timed out", { hostId: peer.id });
          offline();
        },
        this.options.probeIntervalMs,
        this.options.probeTimeoutMs,
        () => {
          if (generation !== current.generation || this.disposed) return;
          const cache = this.caches.get(peer.id);
          if (cache) {
            cache.host.lastSeen = Date.now();
            this.publish();
          }
        },
      );
      const identity = await client.call<{ id: string; role: string }>(
        "identity",
        {},
      );
      if (identity.id !== peer.id || identity.role !== "execution") {
        client.close();
        throw new Error("Host identity changed or invalid execution role");
      }
      if (generation !== current.generation || this.disposed) {
        client.close();
        return;
      }
      current.client = client;
      if (latest) this.adoptPeer(peer, latest);
      // Selection is a business request; a lost result must not tear down a verified socket.
      await this.selectPeer(peer).catch(() => {});
      const cache = this.caches.get(peer.id);
      if (cache) void this.sync(peer, cache).then(() => this.publish());
    })()
      .catch((error) => {
        socket.close();
        offline();
        throw error;
      })
      .finally(() => {
        current.connecting = undefined;
      });
    return current.connecting;
  }
  private adoptPeer(peer: Peer, value: View) {
    const cache = this.caches.get(peer.id);
    if (!cache) return;
    cache.snapshot = value.snapshot;
    for (const [id, detail] of Object.entries(value.details))
      cache.details.set(id, detail);
    for (const id of cache.details.keys())
      if (!value.snapshot.agents.some((a) => a.id === id))
        cache.details.delete(id);
    cache.host.connected = true;
    cache.host.lastSeen = Date.now();
    cache.host.error = undefined;
    this.publish();
  }
  private selectPeer(peer: Peer) {
    const ids = [...this.observed.keys()]
      .filter((id) => id.startsWith(peer.id + ":"))
      .map((id) => id.slice(peer.id.length + 1));
    return (
      this.links.get(peer.id)?.client?.call("select", { ids }) ??
      Promise.resolve()
    );
  }
  observe(ids: string[]) {
    for (const id of ids)
      this.observed.set(id, (this.observed.get(id) ?? 0) + 1);
    const peers = this.state.peers.filter((p) =>
      ids.some((id) => id.startsWith(p.id + ":")),
    );
    for (const peer of peers) void this.selectPeer(peer).catch(() => {});
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      for (const id of ids) {
        const count = this.observed.get(id)! - 1;
        if (count) this.observed.set(id, count);
        else this.observed.delete(id);
      }
      for (const peer of peers) void this.selectPeer(peer).catch(() => {});
    };
  }

  private async verify(peer: Peer) {
    const response = await fetch(`${peer.url}/execution/identity`, {
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 4000),
      headers: { Authorization: `Bearer ${peer.credential}` },
    });
    if (!response.ok) throw new Error("Host authorization failed");
    const identity = (await response.json()) as { id: string; role: string };
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
  register(input: {
    id?: string;
    name: string;
    url: string;
    credential: string;
  }) {
    return this.configure(() => this.registerHost(input));
  }
  private async registerHost(input: {
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

    const previousCache = this.caches.get(peer.id);
    const cache = this.empty(peer);
    cache.host = {
      ...cache.host,
      name: peer.name,
      url: peer.url,
      connected: false,
      lastSeen: previousCache?.host.lastSeen,
    };

    this.caches.set(peer.id, cache);
    const oldLink = this.links.get(peer.id);
    if (oldLink) {
      ++oldLink.generation;
      clearTimeout(oldLink.timer);
      oldLink.client?.close();
      oldLink.socket?.close();
      this.links.delete(peer.id);
    }
    try {
      await this.connect(peer);
    } catch (error) {
      const failed = this.links.get(peer.id);
      if (failed) {
        ++failed.generation;
        clearTimeout(failed.timer);
        failed.client?.close();
        failed.socket?.close();
        this.links.delete(peer.id);
      }
      if (previousCache) this.caches.set(peer.id, previousCache);
      else this.caches.delete(peer.id);
      if (existing) void this.connect(existing).catch(() => {});
      throw error;
    }
    if (existing) Object.assign(existing, peer);
    else this.state.peers.push(peer);
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
  async models() {
    return this.workspace.models();
  }
  async history(
    alias: string,
    query: string,
    cursor?: string,
    hostId?: string,
  ) {
    const p = this.host(hostId);
    if (!p) {
      const page = await this.workspace.history(alias, query, cursor);
      return {
        ...page,
        sessions: page.sessions.map((session) => ({
          ...session,
          agentId: session.agentId
            ? `${this.identity.id}:${session.agentId}`
            : undefined,
        })),
      };
    }
    this.available(p);
    const params = new URLSearchParams({ project: alias, query });
    if (cursor) params.set("cursor", cursor);
    const page = await this.request<Awaited<ReturnType<Workspace["history"]>>>(
      p,
      `/history?${params}`,
    );
    return {
      ...page,
      sessions: page.sessions.map((session) => ({
        ...session,
        agentId: session.agentId ? `${p.id}:${session.agentId}` : undefined,
      })),
    };
  }
  async historySession(alias: string, threadId: string, hostId?: string) {
    const p = this.host(hostId);
    if (!p) {
      const session = await this.workspace.historySession(alias, threadId);
      return {
        ...session,
        agentId: session.agentId
          ? `${this.identity.id}:${session.agentId}`
          : undefined,
      };
    }
    this.available(p);
    const params = new URLSearchParams({ project: alias, thread: threadId });
    const session = await this.request<
      Awaited<ReturnType<Workspace["historySession"]>>
    >(p, `/history/session?${params}`);
    return {
      ...session,
      agentId: session.agentId ? `${p.id}:${session.agentId}` : undefined,
    };
  }
  async historyMessages(
    alias: string,
    threadId: string,
    cursor?: string,
    hostId?: string,
  ) {
    const p = this.host(hostId);
    if (!p) return this.workspace.historyMessages(alias, threadId, cursor);
    this.available(p);
    const params = new URLSearchParams({ project: alias, thread: threadId });
    if (cursor) params.set("cursor", cursor);
    return this.request<Awaited<ReturnType<Workspace["historyMessages"]>>>(
      p,
      `/history/messages?${params}`,
    );
  }
  async agentHistory(id: string, cursor?: string) {
    const r = this.route(id);
    if (!r.peer) return this.workspace.agentHistory(r.id, cursor);
    this.available(r.peer);
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    return this.request<Awaited<ReturnType<Workspace["agentHistory"]>>>(
      r.peer,
      `/agents/${encodeURIComponent(r.id)}/history?${params}`,
    );
  }
  async resumeHistory(
    alias: string,
    threadId: string,
    archived: boolean,
    hostId?: string,
  ) {
    const p = this.host(hostId);
    if (!p)
      return qualified(
        this.local(),
        await this.workspace.resumeHistory(alias, threadId, archived),
      );
    this.available(p);
    const c = this.caches.get(p.id)!;
    try {
      const agent = await this.request<Agent>(p, "/history/resume", {
        project: alias,
        threadId,
        archived,
      });

      return qualified(c.host, agent);
    } catch (error) {
      if (error instanceof RequestRejected) throw error;
      throw this.unknown();
    }
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

      return qualified(c.host, a);
    } catch (error) {
      if (error instanceof RequestRejected) throw error;
      throw this.unknown();
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
    const cached = c.details.get(r.id);
    if (this.observed.has(id) && cached) return qualified(c.host, cached);
    try {
      const detail = detailSchema.parse(
        await this.request<Detail>(
          r.peer,
          `/agents/${encodeURIComponent(r.id)}`,
        ),
      );
      c.details.set(r.id, detail);
      return qualified(c.host, detail);
    } catch (error) {
      if (error instanceof RequestRejected) throw error;
      const detail = c.details.get(r.id);
      if (detail) return qualified(c.host, detail);
      throw error;
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

      return this.result(c.host, result);
    } catch (error) {
      if (error instanceof RequestRejected) throw error;
      throw this.unknown();
    }
  }
  private unknown() {
    return new Error(
      "Outcome unknown. Inspect the workspace or look up the operation receipt before another action; this request will not be replayed.",
    );
  }
  private result(host: Host, result: unknown) {
    return result && typeof result === "object" && "role" in result
      ? qualified(host, result as Detail)
      : result;
  }
  send(id: string, text: string, operationId: string) {
    return this.mutate(id, "messages", { text, operationId }, (id) =>
      this.workspace.send(id, text, operationId),
    );
  }
  closeTree(id: string) {
    return this.mutate(id, "close", {}, (id) => this.workspace.closeTree(id));
  }
  rename(id: string, title: string) {
    return this.mutate(id, "title", { title }, (id) =>
      this.workspace.rename(id, title),
    );
  }
  answerBatch(
    id: string,
    answers: import("../src/contracts").Answer[],
    operationId: string,
  ) {
    return this.mutate(id, "answers", { answers, operationId }, (id) =>
      this.workspace.answerBatch(id, answers, operationId),
    );
  }
  retryDelivery(id: string, deliveryId: string) {
    const r = this.route(id);
    if (!r.peer) return this.workspace.retryDelivery(r.id, deliveryId);
    this.available(r.peer);
    return this.links
      .get(r.peer.id)!
      .client!.call("retryDelivery", { id: r.id, deliveryId });
  }
  async lookup(id: string, operationId: string) {
    const r = this.route(id);
    if (!r.peer) return this.workspace.lookup(r.id, operationId);
    this.available(r.peer);
    return receiptSchema.parse(
      await this.request(r.peer, `/agents/${encodeURIComponent(r.id)}/lookup`, {
        operationId,
      }),
    );
  }
  stop(id: string, turnId: string) {
    return this.mutate(id, "stop", { turnId }, (id) =>
      this.workspace.stop(id, turnId),
    );
  }
  async weekly(): Promise<WeeklyUsage> {
    return {
      ...(await this.workspace.weekly()),
      hostId: this.identity.id,
      source: this.local().name,
    };
  }
  dispose() {
    this.disposed = true;
    for (const link of this.links.values()) {
      ++link.generation;
      clearTimeout(link.timer);
      link.client?.close();
      link.socket?.close();
    }
    this.links.clear();
    this.unsubscribe();
    this.subscribers.clear();
  }
}
