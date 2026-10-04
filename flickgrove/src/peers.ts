import type { Agent, Detail, Host, Snapshot, Settings } from "./contracts";
import { openGrove, type GroveClient } from "./chord-client";
import {
  settingsSchema,
  snapshotSchema,
  type Method,
  type View,
} from "./chord-contract";
import { z } from "zod";
const identitySchema = z.object({
  id: z
    .string()
    .min(1)
    .refine((id) => !id.includes(":")),
  name: z.string().min(1).max(120),
});
const peerSchema = identitySchema.extend({
  url: z
    .string()
    .url()
    .refine((url) => {
      try {
        const parsed = new URL(url);
        return (
          ["http:", "https:"].includes(parsed.protocol) && parsed.origin === url
        );
      } catch {
        return false;
      }
    }),
  credential: z.string().regex(/^[A-Za-z0-9_-]*$/),
});
export type PeerConnection = {
  id: string;
  name: string;
  url: string;
  credential: string;
};
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
    efforts: z.array(z.string()),
    defaultEffort: z.string(),
    isDefault: z.boolean(),
    fastTier: z.string().nullable(),
  }),
);
export const preferences = {
  get models() {
    const result = modelsSchema.safeParse(read<unknown>("models", []));
    return result.success ? result.data : [];
  },
  set models(value: import("./contracts").Model[]) {
    localStorage.setItem(`${prefix}/models`, JSON.stringify(value));
  },
  get settings() {
    const value = settingsSchema.safeParse(read<unknown>("preferences", null));
    return value.success ? value.data : null;
  },
  set settings(value: Settings | null) {
    localStorage.setItem(`${prefix}/preferences`, JSON.stringify(value));
  },
  get host() {
    return localStorage.getItem(`${prefix}/create-host`) ?? "";
  },
  set host(value: string) {
    localStorage.setItem(`${prefix}/create-host`, value);
  },
};
type Link = {
  config: PeerConnection;
  host: Host;
  agents: Agent[];
  client?: GroveClient;
  socket?: WebSocket;
  generation: number;
  retry?: ReturnType<typeof setTimeout>;
  probe?: ReturnType<typeof setInterval>;
  probing?: boolean;
};
export class Peers {
  entryId = "";
  private links = new Map<string, Link>();
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
      hosts: [...this.links.values()].map((l) => ({ ...l.host })),
      agents: [...this.links.values()].flatMap((l) => l.agents),
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
    const parsed = z.array(peerSchema).safeParse(read<unknown>("peers", []));
    const configs = parsed.success ? parsed.data : [];
    if (local) {
      this.entryId = local.id;
      this.add({ ...local, url: location.origin, credential: "" });
      for (const config of configs)
        if (config.id !== local.id) this.add(config);
    }
    try {
      const response = await fetch("/api/identity", {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Peer identity unavailable");
      const actual = identitySchema.parse(await response.json());
      if (this.disposed) return;
      if (local && local.id !== actual.id) {
        for (const link of this.links.values()) this.stop(link);
        this.links.clear();
        this.details = {};
      }
      if (!local || local.id !== actual.id) {
        this.entryId = actual.id;
        this.add({ ...actual, url: location.origin, credential: "" });
        for (const config of configs)
          if (config.id !== actual.id) this.add(config);
      }
      localStorage.setItem(`${prefix}/entry`, JSON.stringify(actual));
    } catch (error) {
      if (!local) throw error;
    }
    this.publish();
  }
  private persist() {
    localStorage.setItem(
      `${prefix}/peers`,
      JSON.stringify(
        [...this.links.values()]
          .filter((l) => l.config.id !== this.entryId)
          .map((l) => l.config),
      ),
    );
  }
  private add(config: PeerConnection) {
    const raw = read<{ agents: Agent[]; lastSeen?: number }>(
      `peer-cache/${config.id}`,
      { agents: [] },
    );
    const cached = snapshotSchema.safeParse({
      agents: raw.agents,
      settings: null,
      revision: 0,
    });
    const stored = {
      agents: cached.success
        ? cached.data.agents.filter((a) => a.hostId === config.id)
        : [],
      lastSeen: Number.isFinite(raw.lastSeen) ? raw.lastSeen : undefined,
    };
    const link: Link = {
      config,
      host: {
        id: config.id,
        name: config.name,
        url: config.url,
        connected: false,
        lastSeen: stored.lastSeen,
      },
      agents: stored.agents,
      generation: 0,
    };
    this.links.set(config.id, link);
    void this.connect(link);
  }
  private async connect(link: Link) {
    if (this.disposed) return;
    link.probing = false;
    const generation = ++link.generation;
    let closed = false;
    const socket = this.socket(link.config);
    link.socket = socket;
    const offline = () => {
      if (closed || this.disposed || generation !== link.generation) return;
      closed = true;
      clearInterval(link.probe);
      link.client = undefined;
      link.host.connected = false;
      link.host.error = "Peer disconnected. Reconnecting automatically.";
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
            link.host.error = "Peer identity changed";
            socket.close(1008, "Peer identity changed");
            return;
          }
          link.agents = view.snapshot.agents.map((a) => ({
            ...a,
            hostName: link.config.name,
          }));
          for (const [id, detail] of Object.entries(view.details))
            this.details[id] = { ...detail, hostName: link.config.name };
          link.host.lastSeen = Date.now();
          localStorage.setItem(
            `${prefix}/peer-cache/${link.config.id}`,
            JSON.stringify({
              agents: link.agents,
              lastSeen: link.host.lastSeen,
            }),
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
        throw new Error("Peer identity changed");
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
            () => reject(new Error("Peer heartbeat timed out")),
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
  private socket(config: PeerConnection) {
    const url = new URL("/api/socket", config.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return new WebSocket(
      url,
      config.credential
        ? ["grove.v1", `grove-auth.${config.credential}`]
        : ["grove.v1"],
    );
  }
  async register(input: {
    id?: string;
    name: string;
    url: string;
    credential: string;
  }) {
    const url = new URL(input.url);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.origin !== input.url.replace(/\/$/, "")
    )
      throw new Error("Use an HTTP(S) address without a path");
    const old = input.id ? this.links.get(input.id) : undefined;
    const config = {
      id: input.id ?? "",
      name: input.name.trim(),
      url: url.origin,
      credential: input.credential || old?.config.credential || "",
    };
    if (!config.name || !config.credential)
      throw new Error("Name and access token are required");
    if (!/^[A-Za-z0-9_-]+$/.test(config.credential))
      throw new Error("Invalid Peer credential");
    const socket = this.socket(config);
    let observed: string | undefined;
    let client: GroveClient | undefined;
    try {
      client = await openGrove(
        socket,
        (v) => {
          observed = v.snapshot.entryId;
        },
        () => {},
        10_000,
      );
      const identity = await client.call<{ id: string }>("identity", {});
      if (identity.id !== observed || (input.id && input.id !== identity.id))
        throw new Error(
          "Peer identity changed; address edit cannot move ownership",
        );
      config.id = identity.id;
      if (config.id === this.entryId)
        throw new Error("This Peer is already included");
      if (!old && this.links.has(config.id))
        throw new Error("This Peer is already registered");
    } catch (error) {
      if (error instanceof Error && error.message === "Connection failed")
        throw new Error(
          "Peer connection or authorization failed. Check the address and access token.",
        );
      throw error;
    } finally {
      client?.close();
      socket.close();
    }
    if (old) this.stop(old);
    this.add(config);
    this.persist();
    this.publish();
    return this.snapshot();
  }
  remove(id: string) {
    if (id === this.entryId) throw new Error("Cannot remove the page Peer");
    const link = this.links.get(id);
    if (link) this.stop(link);
    this.links.delete(id);
    this.persist();
    this.publish();
  }
  async call<T>(member: Method, input: unknown): Promise<T> {
    const p = input as { id?: string; host?: string; ids?: string[] };
    if (member === "select") {
      this.selected = p.ids?.[0] ?? null;
      // Deselecting an unrelated Peer must not delay or fail the active selection.
      const target = this.selected?.split(":")[0];
      for (const link of this.links.values())
        if (link.client && link.config.id !== target)
          void link.client.call("select", { ids: [] }).catch(() => {});
      const link = target ? this.links.get(target) : undefined;
      if (link?.client)
        await link.client.call("select", { ids: [this.selected!] });
      return null as T;
    }
    const id = p.id?.split(":")[0] ?? p.host ?? this.entryId;
    const link = this.links.get(id);
    if (!link?.client || !link.host.connected)
      throw new Error(
        "Peer disconnected. Outcome unknown; this operation will not be replayed.",
      );
    return link.client.call<T>(member, input);
  }
  async media(agent: string, path: string, init: RequestInit = {}) {
    const peer = agent.split(":")[0];
    const link = this.links.get(peer);
    if (!link || !link.host.connected)
      throw new Error("Execution Peer is offline");
    const headers = new Headers(init.headers);
    headers.set("X-Grove-Peer", peer);
    if (link.config.credential)
      headers.set("Authorization", `Bearer ${link.config.credential}`);
    const response = await fetch(new URL(path, link.config.url), {
      ...init,
      headers,
      credentials: "omit",
      signal: AbortSignal.timeout(60_000),
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
      throw new Error("Peer identity changed");
    return response;
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
    for (const link of this.links.values()) this.stop(link);
  }
}
