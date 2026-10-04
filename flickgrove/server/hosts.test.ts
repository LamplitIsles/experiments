import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService, qualify } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket, type SocketData } from "./chord-socket";
import type { ServerWebSocket } from "bun";
import { openGrove } from "../src/chord-client";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
const settings = {
  fast: false,
  orc: { model: "sol", effort: "medium" },
  worker: { model: "luna", effort: "low" },
};
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-peer-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, {
    directory,
    name: "Test Peer",
    origin: () => origin,
  });
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: {
      ...groveWebsocket,
      open(socket) {
        sockets.add(socket);
        groveWebsocket.open(socket);
      },
    },
    fetch: (req, s) => {
      const options = { service, origin: () => origin };
      const result = createUpgrade(app, options)(req, s);
      return result === true
        ? undefined
        : (result ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanup.push(() => {
    server.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, runtime, app, service, origin, sockets };
}
async function client(f: ReturnType<typeof fixture>, token?: string) {
  const Client = WebSocket as unknown as {
    new (
      url: string,
      protocols: string[],
      options: { headers: Record<string, string> },
    ): WebSocket;
  };
  const socket = new Client(
    f.origin.replace("http:", "ws:") + "/api/socket",
    token ? ["grove.v1", `grove-auth.${token}`] : ["grove.v1"],
    { headers: { Origin: "http://other-peer.invalid" } },
  );
  const c = await openGrove(
    socket,
    () => {},
    () => {},
    2000,
  );
  cleanup.push(() => c.close());
  return c;
}
test("cross-origin browser access requires the target Peer credential and can execute directly", async () => {
  const f = fixture();
  await expect(client(f)).rejects.toThrow();
  await expect(client(f, "wrong")).rejects.toThrow();
  const c = await client(f, f.service.credential);
  expect(await c.call<{ id: string; name: string }>("identity", {})).toEqual(
    f.service.identity,
  );
  const agent = await c.call<{ id: string }>("createOrc", {
    project: "alpha",
    settings,
  });
  expect(agent.id.startsWith(f.service.identity.id + ":")).toBe(true);
  await c.call("send", {
    id: agent.id,
    text: "Direct input",
    operationId: "one",
  });
  expect(f.runtime.inputs.map((i) => i.text)).toEqual(["Direct input"]);
  expect(
    (
      await c.call<{ state: string }>("lookup", {
        id: agent.id,
        operationId: "one",
      })
    ).state,
  ).toBe("accepted");
  await expect(c.call("detail", { id: "foreign:agent" })).rejects.toThrow(
    "another Peer",
  );
  expect(JSON.stringify(f.service.snapshot())).not.toContain(
    f.service.credential,
  );
});
test("Peer identity survives restart and owns only local state", async () => {
  const f = fixture(),
    other = fixture();
  const first = await f.service.createOrc("alpha", settings);
  const identity = new HostService(f.app, {
    directory: f.directory,
    origin: () => f.origin,
  });
  expect(identity.identity.id).toBe(f.service.identity.id);
  expect(identity.credential).toBe(f.service.credential);
  expect(f.service.snapshot().hosts).toHaveLength(1);
  expect(other.service.snapshot().agents).toHaveLength(0);
  expect(
    JSON.parse(readFileSync(join(f.directory, "hosts.json"), "utf8")).peers,
  ).toBeUndefined();
  await expect(other.service.detail(first.id)).rejects.toThrow("another Peer");
});
test("captured Worker settings survive workspace restart without browser or global settings", async () => {
  const f = fixture();
  const agent = await f.app.createOrc("alpha", settings);
  await f.app.createOrc("beta", {
    ...settings,
    worker: { model: "sol", effort: "high" },
  });
  f.app.dispose();
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory: f.directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  await app.send(agent.id, "Resume", "resume");
  const token = runtime.agents.get(agent.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Child",
    spec: "spec",
    message: "Go",
  })) as { id: string };
  expect(app.detail(worker.id)).toMatchObject({
    model: "luna",
    effort: "low",
    serviceTier: "default",
  });
  expect(qualify(f.service.identity.id, worker.id)).toContain(":");
});

test("native WebSocket Pong clears only its matching liveness deadline", async () => {
  const f = fixture();
  await client(f, f.service.credential);
  const socket = [...f.sockets][0];
  let expired = false;
  socket.data.ping = "test-owned-probe";
  socket.data.deadline = setTimeout(() => {
    expired = true;
  }, 100);
  groveWebsocket.pong(socket, Buffer.from("unrelated"));
  expect(socket.data.ping).toBe("test-owned-probe");
  socket.ping("test-owned-probe");
  const until = Date.now() + 500;
  while (socket.data.ping && Date.now() < until) await Bun.sleep(5);
  expect(socket.data.ping).toBeUndefined();
  await Bun.sleep(110);
  expect(expired).toBe(false);
});

test("a Peer exposes its local browser identity alongside its advertised proxy origin", async () => {
  const f = fixture();
  const handler = createHandler(f.app, {
    service: f.service,
    origin: () => "https://advertised.invalid",
    localOrigin: () => f.origin,
  });
  const local = await handler(
    new Request(f.origin + "/api/identity", { headers: { Origin: f.origin } }),
  );
  expect(local.status).toBe(200);
  expect(await local.json()).toEqual(f.service.identity);
  const foreign = await handler(
    new Request(f.origin + "/api/identity", {
      headers: { Origin: "https://foreign.invalid" },
    }),
  );
  expect(foreign.status).toBe(403);
});
