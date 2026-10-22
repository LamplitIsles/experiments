import { readingCache } from "./api";
import { historyCache } from "./history-cache";
import type { Agent, Detail, Host, Snapshot, Settings } from "./contracts";
import { openGrove, type GroveClient } from "./chord-client";
import { settingsSchema, type Method, type View } from "./chord-contract";
import { z } from "zod";
import { voiceCapability } from "./voice-contract";
const identitySchema = z.object({
  id: z
    .string()
    .min(1)
    .refine((id) => !id.includes(":")),
  name: z.string().min(1).max(120),
});
const prefix = `flickgrove/${location.origin}`;
function read<T>(key: string, fallback: T): T {
  try {
    return (
      JSON.parse(localStorage.getItem(`${prefix}/${key}`) ?? "null") ?? fallback
    );
  } catch {
    return fallback;
  }
}
const modelsSchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    backend: z.enum(["codex", "pi"]).optional(),
    provider: z.string().optional(),
    efforts: z.array(z.string()),
    defaultEffort: z.string(),
    isDefault: z.boolean(),
    fastTier: z.string().nullable(),
  }),
);
const selectionSchema = z.object({
  host: z.string(),
  sessions: z.record(z.string(), z.string()),
});
export const preferences = {
  get sidebarOpen(): boolean {
    const value = read<unknown>("sidebar-open", true);
    return typeof value === "boolean" ? value : true;
  },
  set sidebarOpen(value: boolean) {
    try {
      localStorage.setItem(`${prefix}/sidebar-open`, JSON.stringify(value));
    } catch {
      /* Layout remains usable in memory. */
    }
  },
  get treeOrder(): Record<string, string[]> {
    const result = z
      .record(z.string(), z.array(z.string()))
      .safeParse(read<unknown>("tree-order", {}));
    if (!result.success) return {};
    return Object.fromEntries(
      Object.entries(result.data).map(([host, ids]) => [
        host,
        [...new Set(ids.filter((id) => id.startsWith(host + ":")))],
      ]),
    );
  },
  set treeOrder(value: Record<string, string[]>) {
    readingCache.writeDevice(`${prefix}/tree-order`, JSON.stringify(value));
  },
  get selection() {
    const result = selectionSchema.safeParse(read<unknown>("selection", null));
    if (!result.success)
      return { host: "", sessions: {} as Record<string, string> };
    return {
      host:
        identitySchema.safeParse(read<unknown>("entry", null)).data?.id ?? "",
      sessions: Object.fromEntries(
        Object.entries(result.data.sessions).filter(
          ([host, id]) =>
            id.startsWith(host + ":") &&
            host ===
              identitySchema.safeParse(read<unknown>("entry", null)).data?.id,
        ),
      ),
    };
  },
  set selection(value: { host: string; sessions: Record<string, string> }) {
    readingCache.writeDevice(`${prefix}/selection`, JSON.stringify(value));
  },
  get models() {
    const result = modelsSchema.safeParse(read<unknown>("models", []));
    return result.success ? result.data : [];
  },
  set models(value: import("./contracts").Model[]) {
    readingCache.writeDevice(`${prefix}/models`, JSON.stringify(value));
  },
  get settings() {
    const value = settingsSchema.safeParse(read<unknown>("preferences", null));
    return value.success ? value.data : null;
  },
  set settings(value: Settings | null) {
    readingCache.writeDevice(`${prefix}/preferences`, JSON.stringify(value));
  },
};
type Link = {
  config: { id: string; name: string };
  host: Host;
  agents: Agent[];
  client?: GroveClient;
  socket?: WebSocket;
  generation: number;
  retry?: ReturnType<typeof setTimeout>;
  probe?: ReturnType<typeof setInterval>;
  probing?: boolean;
};
export class LocalConnection {
  entryId = "";
  private link?: Link;
  private disposed = false;
  private revision = 0;
  private selected: string | null = null;
  private details: Record<string, Detail> = {};
  constructor(
    private changed: (view: View) => void,
    private offline: (id: string) => void,
  ) {}
  snapshot(): Snapshot {
    return {
      entryId: this.entryId,
      revision: this.revision,
      settings: preferences.settings,
      hosts: this.link ? [{ ...this.link.host }] : [],
      agents: this.link?.agents ?? [],
    };
  }
  private publish() {
    this.revision++;
    this.changed({ snapshot: this.snapshot(), details: { ...this.details } });
  }
  async start() {
    const storedIdentity = identitySchema.safeParse(
      read<unknown>("entry", null),
    );
    const local = storedIdentity.success ? storedIdentity.data : null;
    if (local) {
      this.entryId = local.id;
      this.add(local);
    }
    try {
      const response = await fetch("/api/identity", {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Instance identity unavailable");
      const actual = identitySchema.parse(await response.json());
      if (this.disposed) return;
      if (local && local.id !== actual.id) {
        if (this.link) this.stop(this.link);
        this.link = undefined;
        this.details = {};
      }
      if (!local || local.id !== actual.id) {
        this.entryId = actual.id;
        this.add(actual);
      }
      readingCache.writeDevice(`${prefix}/entry`, JSON.stringify(actual));
    } catch (error) {
      if (!local) throw error;
    }
    this.publish();
  }
  private add(config: { id: string; name: string }) {
    const raw = readingCache.readPeerSnapshot(config.id);
    const stored = {
      agents: raw.agents.filter((a) => a.hostId === config.id),
      lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : undefined,
    };
    const link: Link = {
      config,
      host: {
        id: config.id,
        name: config.name,
        url: location.origin,
        connected: false,
        lastSeen: stored.lastSeen,
      },
      agents: stored.agents,
      generation: 0,
    };
    this.link = link;
    void this.connect(link);
  }
  private async connect(link: Link) {
    if (this.disposed) return;
    link.probing = false;
    const generation = ++link.generation;
    let closed = false;
    const socket = this.socket();
    link.socket = socket;
    const offline = () => {
      if (closed || this.disposed || generation !== link.generation) return;
      closed = true;
      clearInterval(link.probe);
      link.client = undefined;
      link.host.connected = false;
      historyCache.reconnect(link.config.id);
      link.host.error = "Instance disconnected. Reconnecting automatically.";
      this.offline(link.config.id);
      this.publish();
      link.retry = setTimeout(() => void this.connect(link), 1000);
    };
    try {
      const client = await openGrove(
        socket,
        (view) => {
          if (closed || this.disposed || generation !== link.generation) return;
          if (
            view.snapshot.entryId !== link.config.id ||
            view.snapshot.agents.some((a) => a.hostId !== link.config.id)
          ) {
            link.host.error = "Instance identity changed";
            socket.close(1008, "Instance identity changed");
            return;
          }
          link.agents = view.snapshot.agents;
          const active = new Set(link.agents.map((a) => a.id));
          for (const id of Object.keys(this.details))
            if (id.startsWith(link.config.id + ":") && !active.has(id))
              delete this.details[id];
          for (const [id, detail] of Object.entries(view.details))
            if (active.has(id)) this.details[id] = detail;
          link.host.lastSeen = Date.now();
          readingCache.savePeerSnapshot(
            link.config.id,
            link.agents,
            link.host.lastSeen,
          );
          this.publish();
        },
        offline,
        30_000,
      );
      if (closed || this.disposed || generation !== link.generation) {
        client.close();
        return;
      }
      const identity = await client.call<{ id: string }>("identity", {});
      if (identity.id !== link.config.id)
        throw new Error("Instance identity changed");
      if (closed || this.disposed || generation !== link.generation) {
        client.close();
        return;
      }
      link.client = client;
      link.host.connected = true;
      link.host.error = undefined;
      this.publish();
      if (this.selected?.startsWith(link.config.id + ":"))
        void client.call("select", { ids: [this.selected] }).catch(() => {});
      // Browser WebSocket has no Ping API. A dedicated lightweight identity
      // probe detects a stalled path independently of business RPC deadlines.
      link.probe = setInterval(() => {
        if (link.probing) return;
        link.probing = true;
        let deadline: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("Instance heartbeat timed out")),
            10_000,
          );
        });
        void Promise.race([client.call("identity", {}), timeout])
          .then(() => {
            if (generation === link.generation && !closed)
              link.host.lastSeen = Date.now();
          })
          .catch(() => {
            client.close();
            offline();
          })
          .finally(() => {
            clearTimeout(deadline);
            link.probing = false;
          });
      }, 15_000);
    } catch {
      socket.close();
      offline();
    }
  }
  private socket() {
    const url = new URL("/api/socket", location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, ["grove.v1"]);
  }
  async call<T>(member: Method, input: unknown): Promise<T> {
    if (member === "select") {
      this.selected = (input as { ids: string[] }).ids[0] ?? null;
      if (this.link?.client)
        await this.link.client.call("select", {
          ids: this.selected ? [this.selected] : [],
        });
      return null as T;
    }
    const link = this.link;
    if (!link?.client || !link.host.connected)
      throw new Error(
        "Instance disconnected. Outcome unknown; this operation will not be replayed.",
      );
    return link.client.call<T>(member, input);
  }
  async media(agent: string, path: string, init: RequestInit = {}) {
    const peer = agent.split(":")[0];
    const link = this.link?.config.id === peer ? this.link : undefined;
    if (!link || !link.host.connected) throw new Error("Instance is offline");
    const headers = new Headers(init.headers);
    headers.set("X-Grove-Peer", peer);
    const response = await fetch(new URL(path, location.origin), {
      ...init,
      headers,
      credentials: "omit",
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const error =
        typeof body?.error === "string" && body.error.trim()
          ? body.error
          : response.status === 413
            ? "Image upload exceeds 20 MiB"
            : `Image request failed (HTTP ${response.status})`;
      throw new Error(error);
    }
    if (response.headers.get("X-Grove-Peer") !== peer)
      throw new Error("Instance identity changed");
    return response;
  }
  async voiceCapability(agent: string, signal?: AbortSignal) {
    const id = agent.split(":")[0];
    const link = this.link?.config.id === id ? this.link : undefined;
    if (!link?.host.connected) throw new Error("Instance is offline");
    const response = await fetch(
      new URL("/api/voice/capability", location.origin),
      {
        headers: {
          "X-Grove-Peer": id,
        },
        credentials: "omit",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(8000)])
          : AbortSignal.timeout(8000),
      },
    );
    if (!response.ok || response.headers.get("X-Grove-Peer") !== id)
      throw new Error("Voice instance unavailable");
    return voiceCapability.parse(await response.json());
  }
  async voiceSocket(agent: string) {
    const capability = await this.voiceCapability(agent);
    if (!capability.available)
      throw new Error("Voice unavailable on this instance");
    const id = agent.split(":")[0];
    const link = this.link?.config.id === id ? this.link : undefined;
    if (!link?.host.connected) throw new Error("Instance is offline");
    const url = new URL("/api/voice/stream", location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(url, ["grove-voice.v1", `grove-peer.${id}`]);
  }
  private stop(link: Link) {
    link.generation++;
    clearTimeout(link.retry);
    clearInterval(link.probe);
    link.client?.close();
    link.socket?.close();
  }
  close() {
    this.disposed = true;
    if (this.link) this.stop(this.link);
  }
}
