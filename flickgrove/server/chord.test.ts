import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { createUpgrade, createHandler } from "./http";
import { groveWebsocket } from "./chord-socket";
import { socketWithHeaders } from "./socket-testing";
import { openGrove } from "../src/chord-client";
import type { Detail } from "../src/contracts";
import type { Receipt, View } from "../src/chord-contract";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
export async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function fixture(hub = true) {
  const directory = mkdtempSync(join(tmpdir(), "grove-chord-"));
  const runtime = new FakeRuntime();
  let app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  let service = new HostService(app, { directory, hub, origin: () => origin });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch: (req, server) => {
      const options = { service, origin: () => origin };
      const result = createUpgrade(app, options)(req, server);
      return result === true
        ? undefined
        : (result ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => {
    service.dispose();
    server.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get app() {
      return app;
    },
    runtime,
    get service() {
      return service;
    },
    origin,
    async client(
      changed: (view: View) => void = () => {},
      offline: () => void = () => {},
      timeoutMs = 30_000,
    ) {
      const client = await openGrove(
        socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", {
          Origin: origin,
        }),
        changed,
        offline,
        timeoutMs,
      );
      cleanups.push(() => client.close());
      return client;
    },
    restart() {
      service.dispose();
      app.dispose();
      app = new Workspace({
        directory,
        runtime: new FakeRuntime(),
        projects: async () => fixtureProjects,
      });
      service = new HostService(app, { directory, hub, origin: () => origin });
    },
  };
}
test("real socket admits A/B/C in order, start then steer, with operation-bound results and independent requests", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  const hold = Promise.withResolvers<string>();
  f.runtime.sendOverride = async (_id, text, turn) =>
    text === "A" ? hold.promise : turn!;
  const a = client.call<Detail>("send", { id, text: "A", operationId: "A" });
  await until(() => f.runtime.inputs.length === 1);
  const b = client.call("send", { id, text: "B", operationId: "B" });
  const c = client.call("send", { id, text: "C", operationId: "C" });
  // A slow submission neither blocks lookup nor another Orc on this socket.
  expect(
    (await client.call<Receipt>("lookup", { id, operationId: "B" })).state,
  ).toBe("missing");
  const other = await client.call<{ id: string }>("createOrc", {
    project: "alpha",
  });
  expect(other.id).not.toBe(id);
  expect(f.runtime.inputs.map((i) => i.text)).toEqual(["A"]);
  hold.resolve("turn-A");
  await Promise.all([a, b, c]);
  expect(f.runtime.inputs.map((i) => [i.text, i.turnId])).toEqual([
    ["A", undefined],
    ["B", "turn-A"],
    ["C", "turn-A"],
  ]);
  await client.call("send", { id, text: "A", operationId: "A" });
  await expect(
    client.call("send", { id, text: "altered", operationId: "A" }),
  ).rejects.toThrow("bound");
  expect(f.runtime.inputs).toHaveLength(3);
  expect(
    await client.call<Receipt>("lookup", { id, operationId: "B" }),
  ).toMatchObject({ state: "accepted", turnId: "turn-A" });
  client.close();
  expect(f.app.detail(agent.id).state).toBe("working");
  expect(f.runtime.interruptions).toHaveLength(0);
});
test("durable lookup after restart preserves accepted and uncertain receipts without native replay", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  const client = await f.client();
  await client.call("send", { id, text: "accepted", operationId: "accepted" });
  f.runtime.sendOverride = async () => {
    throw new Error("No native confirmation");
  };
  await client.call("send", { id, text: "unknown", operationId: "unknown" });
  client.close();
  f.restart();
  const reconnected = await f.client();
  expect(
    (await reconnected.call<Receipt>("lookup", { id, operationId: "accepted" }))
      .state,
  ).toBe("accepted");
  expect(
    (await reconnected.call<Receipt>("lookup", { id, operationId: "unknown" }))
      .state,
  ).toBe("uncertain");
  expect(f.runtime.inputs).toHaveLength(2);
  await reconnected.call("send", {
    id,
    text: "unknown",
    operationId: "unknown",
  });
  expect(f.runtime.inputs).toHaveLength(2);
});
test("two browser selections and rapid switching are independent; detail pushes follow completed output", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha"),
    b = await f.app.createOrc("beta");
  const aid = qualify(f.service.identity.id, a.id),
    bid = qualify(f.service.identity.id, b.id);
  let left: View | undefined, right: View | undefined;
  const l = await f.client((v) => (left = v)),
    r = await f.client((v) => (right = v));
  await l.call("select", { ids: [aid] });
  await r.call("select", { ids: [bid] });
  await until(() => !!left?.details[aid] && !!right?.details[bid]);
  const gate = Promise.withResolvers<void>();
  const originalDetail = f.service.detail.bind(f.service);
  let held = false;
  f.service.detail = async (id) => {
    if (id === aid && !held) {
      held = true;
      await gate.promise;
    }
    return originalDetail(id);
  };
  const late = l.call("select", { ids: [aid] });
  await until(() => held);
  await l.call("select", { ids: [bid] });
  gate.resolve();
  await late;
  await until(() => !!left?.details[bid]);
  expect(left?.details[aid]).toBeUndefined();
  await r.call("send", { id: bid, text: "work", operationId: "work" });
  const turnId = f.app.detail(b.id).turnId!;
  f.runtime.emit(b.id, {
    type: "item",
    turnId,
    item: {
      id: "complete",
      type: "agentMessage",
      phase: "final_answer",
      text: "Complete answer",
    },
  });
  f.runtime.emit(b.id, { type: "completed", turnId, status: "completed" });
  await until(
    () =>
      left?.details[bid]?.messages.some((m) => m.text === "Complete answer") ===
      true,
  );
  expect(Object.keys(right!.details)).toEqual([bid]);
  await l.call("select", { ids: [] });
  await until(() => Object.keys(left!.details).length === 0);
});
test("browser/peer upgrade authorization, unknown identity and method boundaries reject access", async () => {
  const hub = fixture(),
    exec = fixture(false);
  const url = hub.origin.replace("http:", "ws:") + "/api/socket";
  for (const headers of [{ Origin: "https://foreign.invalid" }, {}] as Record<
    string,
    string
  >[])
    await expect(
      openGrove(
        socketWithHeaders(url, headers),
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
  await expect(
    openGrove(
      socketWithHeaders(exec.origin.replace("http:", "ws:") + "/api/socket", {
        Origin: exec.origin,
      }),
      () => {},
      () => {},
    ),
  ).rejects.toThrow();
  const peerURL = exec.origin.replace("http:", "ws:") + "/execution/socket";
  for (const headers of [
    { Authorization: "Bearer invalid", "Grove-Host": exec.service.identity.id },
    {
      Authorization: `Bearer ${exec.service.credential}`,
      "Grove-Host": "wrong",
    },
  ])
    await expect(
      openGrove(
        socketWithHeaders(peerURL, headers),
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
  const peer = await openGrove(
    socketWithHeaders(peerURL, {
      Authorization: `Bearer ${exec.service.credential}`,
      "Grove-Host": exec.service.identity.id,
    }),
    () => {},
    () => {},
  );
  cleanups.push(() => peer.close());
  await expect(
    peer.call("register", {
      name: "bad",
      url: hub.origin,
      credential: "fixture",
    }),
  ).rejects.toThrow("Hub");
  const client = await hub.client();
  await expect(
    client.call("send", {
      id: "unknown:agent",
      text: "bad",
      operationId: "bad",
    }),
  ).rejects.toThrow("Host not found");
  await expect(client.call("identity", {})).rejects.toThrow("execution access");
  expect(exec.runtime.inputs).toHaveLength(0);
  expect(hub.runtime.inputs).toHaveLength(0);
});
test("peer detail subscriptions union browser interests, release old interests, and publish promptly", async () => {
  const hub = fixture(),
    peer = fixture(false);
  await hub.service.register({
    name: "peer",
    url: peer.origin,
    credential: peer.service.credential,
  });
  const a = await peer.app.createOrc("alpha"),
    b = await peer.app.createOrc("beta");
  const aid = qualify(peer.service.identity.id, a.id),
    bid = qualify(peer.service.identity.id, b.id);
  let left: View | undefined, right: View | undefined;
  const l = await hub.client((v) => (left = v)),
    r = await hub.client((v) => (right = v));
  await l.call("select", { ids: [aid] });
  await r.call("select", { ids: [bid] });
  await until(() => !!left?.details[aid] && !!right?.details[bid]);
  await l.call("send", { id: aid, text: "remote", operationId: "remote" });
  const turnId = peer.app.detail(a.id).turnId!;
  peer.runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "peer-result",
      type: "agentMessage",
      phase: "final_answer",
      text: "Pushed remote result",
    },
  });
  peer.runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await until(
    () =>
      left?.details[aid]?.messages.some(
        (m) => m.text === "Pushed remote result",
      ) === true,
  );
  expect(right?.details[aid]).toBeUndefined();
  expect(hub.runtime.inputs).toHaveLength(0);
  l.close();
  await r.call("select", { ids: [] });
  expect(peer.app.detail(a.id).state).toBe("idle");
  expect(peer.runtime.interruptions).toHaveLength(0);
});
test("public Chord provider reset over a real socket precedes the next delta and a fresh decoder rehydrates", async () => {
  const {
    RemoteServiceProvider,
    replicatedState,
    createServiceStateEncoder,
    decodeServiceControlCall,
    parseServiceCall,
  } = await import("@earendil-works/chord");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { Grove, inputs, jsonValue } = await import("../src/chord-contract");
  const initial: View = {
    snapshot: { agents: [], settings: null, revision: 0 },
    details: {},
  };
  const view = replicatedState(jsonValue(initial));
  const provider = new RemoteServiceProvider([Grove]);
  provider.provide(Grove, {
    ...Object.fromEntries(
      Object.keys(inputs).map((method) => [method, async () => null]),
    ),
    view,
  } as unknown as import("../src/chord-contract").GroveContract);
  const subs = new Set<{ close(): void }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      return server.upgrade(req)
        ? undefined
        : new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        void (async () => {
          const frame = JSON.parse(String(raw));
          const call = parseServiceCall(frame.call),
            control = decodeServiceControlCall(call);
          if (control?.type === "subscribe") {
            const encoder = createServiceStateEncoder();
            const sub = provider.subscribe(
              control.serviceId,
              control.mode,
              (update) => {
                ws.send(
                  JSON.stringify({
                    type: "update",
                    subscriptionId: control.subscriptionId,
                    update: encoder.encodeUpdate(update),
                  }),
                );
              },
            );
            subs.add(sub);
            ws.send(
              JSON.stringify({
                type: "result",
                id: frame.id,
                result: encoder.encodeSnapshot(sub.snapshot),
              }),
            );
            // Public provider buffers 101 exact state updates before activation and emits an explicit reset.
            for (let revision = 1; revision <= 101; revision++)
              view.change(BACKGROUND_CONTEXT, (draft) => {
                draft.snapshot.revision = revision;
              });
            sub.activate();
            view.change(BACKGROUND_CONTEXT, (draft) => {
              draft.snapshot.revision = 102;
            });
          } else
            ws.send(
              JSON.stringify({
                type: "result",
                id: frame.id,
                result:
                  control?.type === "catalogue" ? provider.catalogue : null,
              }),
            );
        })();
      },
    },
  });
  cleanups.push(() => {
    server.stop(true);
    for (const sub of subs) sub.close();
    provider.dispose();
  });
  let latest: View | undefined;
  const seen: number[] = [];
  const client = await openGrove(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (value) => {
      latest = value;
      seen.push(value.snapshot.revision);
    },
    () => {},
  );
  cleanups.push(() => client.close());
  await until(() => latest?.snapshot.revision === 102);
  expect(seen.at(-1)).toBe(102);
  client.close();
  let hydrated: View | undefined;
  const fresh = await openGrove(
    new WebSocket(`ws://127.0.0.1:${server.port}`),
    (value) => (hydrated = value),
    () => {},
  );
  cleanups.push(() => fresh.close());
  await until(() => hydrated?.snapshot.revision === 102);
});

test("isolated WebSocket proxy preserves peer authorization and forwarded Chord state", async () => {
  const execution = fixture(false);
  const agent = await execution.app.createOrc("alpha");
  const target = execution.origin.replace("http:", "ws:") + "/execution/socket";
  const proxy = Bun.serve<{
    headers: Record<string, string>;
    upstream?: WebSocket;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      if (
        server.upgrade(req, {
          data: {
            headers: {
              Authorization: req.headers.get("Authorization") ?? "",
              "Grove-Host": req.headers.get("Grove-Host") ?? "",
            },
          },
        })
      )
        return undefined;
      return new Response("Upgrade required", { status: 400 });
    },
    websocket: {
      open(socket) {
        const upstream = socketWithHeaders(target, socket.data.headers);
        socket.data.upstream = upstream;
        upstream.addEventListener("message", (event) =>
          socket.send(String(event.data)),
        );
        upstream.addEventListener("close", () => socket.close());
        upstream.addEventListener("error", () => socket.close());
      },
      async message(socket, raw) {
        const upstream = socket.data.upstream!;
        if (upstream.readyState === 0)
          await new Promise<void>((resolve, reject) => {
            upstream.addEventListener("open", () => resolve(), { once: true });
            upstream.addEventListener(
              "close",
              () => reject(new Error("Proxy target rejected")),
              { once: true },
            );
          }).catch(() => {});
        if (upstream.readyState === 1) upstream.send(raw);
      },
      close(socket) {
        socket.data.upstream?.close();
      },
    },
  });
  cleanups.push(() => proxy.stop(true));
  const address = `ws://127.0.0.1:${proxy.port}/execution/socket`;
  const client = await openGrove(
    socketWithHeaders(address, {
      Authorization: `Bearer ${execution.service.credential}`,
      "Grove-Host": execution.service.identity.id,
    }),
    () => {},
    () => {},
  );
  cleanups.push(() => client.close());
  expect(await client.call("identity", {})).toMatchObject({
    id: execution.service.identity.id,
    role: "execution",
  });
  expect(await client.call("detail", { id: agent.id })).toMatchObject({
    id: agent.id,
  });
  await expect(
    openGrove(
      socketWithHeaders(address, {
        Authorization: "Bearer invalid",
        "Grove-Host": execution.service.identity.id,
      }),
      () => {},
      () => {},
    ),
  ).rejects.toThrow();
});

test("slow read and late result leave the socket and other calls alive", async () => {
  const f = fixture();
  let disconnected = 0;
  const client = await f.client(
    () => {},
    () => disconnected++,
    80,
  );
  const hold =
    Promise.withResolvers<Awaited<ReturnType<FakeRuntime["weekly"]>>>();
  f.runtime.weekly = () => hold.promise;
  await expect(client.call("weekly", {})).rejects.toThrow("Response timed out");
  expect(disconnected).toBe(0);
  expect(await client.call<unknown>("projects", {})).toEqual(fixtureProjects);
  hold.resolve({ remaining: 42, fetchedAt: Date.now() });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await client.call<unknown>("projects", {})).toEqual(fixtureProjects);
  expect(disconnected).toBe(0);
});

test("timed out mutation is reconciled by receipt without replay or disconnect", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha");
  const id = qualify(f.service.identity.id, agent.id);
  let disconnected = 0;
  const client = await f.client(
    () => {},
    () => disconnected++,
    80,
  );
  const hold = Promise.withResolvers<string>();
  f.runtime.sendOverride = () => hold.promise;
  await expect(
    client.call("send", { id, text: "once", operationId: "slow-once" }),
  ).rejects.toThrow("Outcome unknown");
  expect(f.runtime.inputs).toHaveLength(1);
  expect(disconnected).toBe(0);
  hold.resolve("fixture-turn");
  await until(() => f.app.detail(agent.id).deliveries[0]?.status === "sent");
  const receipt = await client.call<Receipt>("lookup", {
    id,
    operationId: "slow-once",
  });
  expect(receipt.state).toBe("accepted");
  expect(f.runtime.inputs).toHaveLength(1);
  expect(disconnected).toBe(0);
});
