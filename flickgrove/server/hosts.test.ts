import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService, qualify } from "./hosts";
import { createHandler } from "./http";
import type { Detail, Snapshot } from "../src/contracts";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture(hub: boolean, collision = false) {
  const directory = mkdtempSync(join(tmpdir(), "grove-host-test-"));
  if (collision) {
    // Own synthetic durable state, with equal local IDs on two hosts.
    const agent = {
      id: "same",
      token: "fixture-agent-token",
      role: "orc",
      project: fixtureProjects[0],
      title: "Collision",
      model: "sol",
      effort: "medium",
      serviceTier: "default",
      state: "idle",
      closed: false,
      questions: [],
      messages: [],
      deliveries: [],
    };
    const { Database } = require("bun:sqlite");
    const db = new Database(join(directory, "workspace.sqlite"));
    db.exec(
      "CREATE TABLE workspace (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
    );
    db.query("INSERT INTO workspace VALUES(1,?)").run(
      JSON.stringify({ agents: [agent], settings: null, revision: 0 }),
    );
    db.close();
  }
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, {
    directory,
    hub,
    name: hub ? "NUC" : "Mac",
    origin: () => origin,
    pollMs: 60000,
    timeoutMs: 150,
  });
  const handler = createHandler(app, { service, origin: () => origin });
  let drop = false;
  let loseResponse: string | null = null;
  let requestCount = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      if (drop) throw new Error("fixture transport outage");
      if (req.method !== "GET" && req.url.includes("/messages")) requestCount++;
      const result = await handler(req);
      if (
        loseResponse &&
        req.method === "POST" &&
        new URL(req.url).pathname.endsWith(loseResponse)
      )
        await new Promise((resolve) => setTimeout(resolve, 300));
      return result;
    },
    error: () => new Response("unavailable", { status: 503 }),
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanup.push(() => {
    service.dispose();
    server.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  async function request(
    path: string,
    body?: unknown,
    token?: string,
    method = "POST",
  ) {
    return fetch(origin + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  return {
    app,
    service,
    directory,
    origin,
    runtime,
    request,
    handler,
    setDrop: (value: boolean) => {
      drop = value;
    },
    loseResponse: (path = "/messages") => {
      loseResponse = path;
    },
    count: () => requestCount,
  };
}
test("execution role is private, identity durable, browser origin and independent MCP authorization stay enforced", async () => {
  const exec = fixture(false);
  expect((await exec.request("/")).status).toBe(404);
  expect((await exec.request("/api/snapshot")).status).toBe(404);
  expect((await exec.request("/execution/snapshot")).status).toBe(401);
  expect(
    (await exec.request("/execution/snapshot", undefined, "invalid")).status,
  ).toBe(401);
  expect(
    (
      await exec.request(
        "/execution/identity",
        undefined,
        exec.service.credential,
      )
    ).status,
  ).toBe(200);
  const state = JSON.parse(
    readFileSync(join(exec.directory, "hosts.json"), "utf8"),
  );
  expect(state.id).toBe(exec.service.identity.id);
  expect(statSync(join(exec.directory, "hosts.json")).mode & 0o777).toBe(0o600);
  const another = new HostService(exec.app, {
    directory: exec.directory,
    hub: false,
    origin: () => exec.origin,
  });
  expect(another.identity).toEqual(exec.service.identity);
  expect(another.credential).toBe(exec.service.credential);
  another.dispose();
  expect(
    (
      await exec.handler(
        new Request(exec.origin + "/execution/snapshot", {
          headers: {
            Authorization: `Bearer ${exec.service.credential}`,
            Origin: "https://foreign.invalid",
          },
        }),
      )
    ).status,
  ).toBe(403);
  expect(
    (await exec.request("/api/mcp/info", undefined, exec.service.credential))
      .status,
  ).toBe(400);
});
test("verified shared registry rejects identity/auth/role/URL swaps and never reads back credentials", async () => {
  const hub = fixture(true);
  const peer = fixture(false);
  const second = fixture(false);
  const input = {
    name: "Mac",
    url: peer.origin,
    credential: peer.service.credential,
  };
  for (const bad of [
    { ...input, credential: "invalid" },
    { ...input, url: "file:///tmp/test" },
    { ...input, url: hub.origin, credential: hub.service.credential },
  ])
    await expect(hub.service.register(bad)).rejects.toThrow();
  expect(hub.service.snapshot().hosts).toHaveLength(1);
  await hub.service.register(input);
  await expect(hub.service.register(input)).rejects.toThrow(
    "already registered",
  );
  await expect(
    hub.service.register({
      ...input,
      id: peer.service.identity.id,
      url: second.origin,
      credential: second.service.credential,
    }),
  ).rejects.toThrow("identity changed");
  await hub.service.register({
    ...input,
    id: peer.service.identity.id,
    name: "Mac renamed",
    credential: "",
  });
  const snapshot = JSON.stringify(hub.service.snapshot());
  expect(snapshot).not.toContain(peer.service.credential);
  expect(snapshot).not.toContain("fixture-agent-token");
  expect(snapshot).toContain("Mac renamed");
  const redirect = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(peer.origin + "/execution/identity"),
  });
  try {
    await expect(
      hub.service.register({
        ...input,
        url: `http://127.0.0.1:${redirect.port}`,
      }),
    ).rejects.toThrow();
  } finally {
    redirect.stop(true);
  }
  const state = JSON.parse(
    readFileSync(join(hub.directory, "hosts.json"), "utf8"),
  );
  expect(state.peers[0].credential).toBe(peer.service.credential);
});
test("two-host collision routing, shared defaults, simultaneous answers, outage caches and reconnect without replay", async () => {
  const hub = fixture(true, true);
  const peer = fixture(false, true);
  await hub.service.register({
    name: "Mac",
    url: peer.origin,
    credential: peer.service.credential,
  });
  const localId = qualify(hub.service.identity.id, "same");
  const remoteId = qualify(peer.service.identity.id, "same");
  expect(hub.service.snapshot().agents.map((a) => a.id)).toEqual([
    localId,
    remoteId,
  ]);
  await hub.service.send(remoteId, "Remote message", "remote-message");
  expect(peer.runtime.inputs).toHaveLength(1);
  expect(hub.runtime.inputs).toHaveLength(0);
  const turnId = peer.app.detail("same").turnId!;
  peer.runtime.emit("same", {
    type: "item",
    turnId,
    item: {
      id: "q",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Which?" }],
    },
  });
  const answers = await Promise.all([
    hub.service.answer(remoteId, "q:0", "One"),
    hub.service.answer(remoteId, "q:0", "Two"),
  ]);
  expect(peer.runtime.inputs).toHaveLength(2);
  expect((answers[0] as Detail).questions[0].state).toBe("answered");
  await hub.service.detail(remoteId);
  await hub.service.saveSettings({
    fast: true,
    orc: { model: "sol", effort: "high" },
    worker: { model: "sol", effort: "medium" },
  });
  const created = await hub.service.createOrc("beta", peer.service.identity.id);
  expect(created.hostId).toBe(peer.service.identity.id);
  expect(created.serviceTier).toBe("priority");
  expect(created.effort).toBe("high");
  expect(peer.app.detail("same").effort).toBe("medium");
  const token = peer.runtime.agents.get(created.id.split(":")[1])!.token;
  const worker = (await peer.app.tool(token, "worker_start", {
    project: "alpha",
    title: "Worker",
    spec: "fixture",
    message: "Work",
  })) as Detail;
  expect(worker.ownerId).toBe(created.id.split(":")[1]);
  expect((await hub.request("/api/mcp/info", undefined, token)).status).toBe(
    400,
  );
  peer.setDrop(true);
  await hub.service.refresh();
  expect(
    hub.service.snapshot().hosts?.find((h) => h.id === peer.service.identity.id)
      ?.connected,
  ).toBe(false);
  expect((await hub.service.detail(remoteId)).messages[0].text).toBe(
    "Remote message",
  );
  await expect(
    hub.service.send(remoteId, "No replay", "blocked"),
  ).rejects.toThrow("disconnected");
  await hub.service.send(localId, "Local still works", "local");
  expect(hub.runtime.inputs).toHaveLength(1);
  await hub.service.saveSettings({
    fast: false,
    orc: { model: "sol", effort: "medium" },
    worker: { model: "sol", effort: "high" },
  });
  expect(
    hub.service.snapshot().hosts?.find((h) => h.id === peer.service.identity.id)
      ?.defaults,
  ).toBe("pending");
  const before = peer.count();
  peer.setDrop(false);
  await hub.service.refresh();
  expect(peer.count()).toBe(before);
  expect(peer.app.snapshot().settings?.worker.effort).toBe("high");
  expect(
    hub.service.snapshot().hosts?.find((h) => h.id === peer.service.identity.id)
      ?.connected,
  ).toBe(true);
  const fetched = await hub.request("/api/snapshot");
  expect(
    ((await fetched.json()) as Snapshot).agents.some((a) => a.id === remoteId),
  ).toBe(true);
  const quota = await hub.service.weekly(peer.service.identity.id);
  expect(quota.remaining).toBe(72);
  expect(quota.source).toBe("Mac");
});
test("unknown mutation response is not replayed; rejected close preserves connection and defaults capability is enforced", async () => {
  const hub = fixture(true);
  const peer = fixture(false);
  await hub.service.register({
    name: "Mac",
    url: peer.origin,
    credential: peer.service.credential,
  });
  const agent = await hub.service.createOrc("alpha", peer.service.identity.id);
  peer.runtime.sendOverride = async () => {
    throw new Error("fixture acceptance unknown");
  };
  const result = (await hub.service.send(
    agent.id,
    "Ambiguous",
    "one",
  )) as Detail;
  expect(result.deliveries[0].status).toBe("uncertain");
  await hub.service.refresh();
  expect(peer.runtime.inputs).toHaveLength(1);
  await expect(hub.service.send(agent.id, "/close", "close")).rejects.toThrow(
    "unconfirmed delivery",
  );
  expect(
    hub.service.snapshot().hosts?.find((h) => h.id === peer.service.identity.id)
      ?.connected,
  ).toBe(true);
  peer.runtime.models = async () => [];
  await hub.service.saveSettings({
    fast: false,
    orc: { model: "sol", effort: "high" },
    worker: { model: "sol", effort: "medium" },
  });
  expect(
    hub.service.snapshot().hosts?.find((h) => h.id === peer.service.identity.id)
      ?.defaults,
  ).toBe("failed");
  await expect(
    hub.service.createOrc("alpha", peer.service.identity.id),
  ).rejects.toThrow("synchronize");
});

test("accepted peer mutation with a lost HTTP response refreshes authority without transport replay", async () => {
  const hub = fixture(true);
  const peer = fixture(false);
  await hub.service.register({
    name: "Mac",
    url: peer.origin,
    credential: peer.service.credential,
  });
  const agent = await hub.service.createOrc("alpha", peer.service.identity.id);
  peer.loseResponse();
  await expect(
    hub.service.send(agent.id, "Accepted once", "accepted-once"),
  ).rejects.toThrow("Outcome unknown");
  expect(peer.runtime.inputs).toHaveLength(1);
  await hub.service.refresh();
  const detail = await hub.service.detail(agent.id);
  expect(detail.messages.filter((m) => m.id === "accepted-once")).toHaveLength(
    1,
  );
  expect(peer.count()).toBe(1);
});

test("accepted remote creation with a lost response is unknown and never recreated on refresh", async () => {
  const hub = fixture(true);
  const peer = fixture(false);
  await hub.service.register({
    name: "Mac",
    url: peer.origin,
    credential: peer.service.credential,
  });
  peer.loseResponse("/execution/agents");
  await expect(
    hub.service.createOrc("alpha", peer.service.identity.id),
  ).rejects.toThrow("Outcome unknown");
  expect(peer.app.snapshot().agents).toHaveLength(1);
  expect(
    hub.service.snapshot().hosts?.find((h) => h.id === peer.service.identity.id)
      ?.connected,
  ).toBe(false);
  await hub.service.refresh();
  expect(peer.app.snapshot().agents).toHaveLength(1);
  expect(hub.service.snapshot().agents).toHaveLength(1);
});

test.each([true, false])(
  "registration initializes persisted Hub defaults before peer-local Worker creation (existing=%s)",
  async (existing) => {
    const hub = fixture(true);
    const peer = fixture(false);
    if (existing)
      await hub.app.saveSettings({
        fast: false,
        orc: { model: "sol", effort: "high" },
        worker: { model: "sol", effort: "high" },
      });
    const expected = existing
      ? hub.app.snapshot().settings!
      : {
          fast: false,
          orc: { model: "sol", effort: "medium" },
          worker: { model: "sol", effort: "medium" },
        };
    // The peer Orc predates registration and retains its captured settings.
    const orc = await peer.app.createOrc("alpha");
    await hub.service.register({
      name: "Mac",
      url: peer.origin,
      credential: peer.service.credential,
    });
    expect(
      hub.service
        .snapshot()
        .hosts?.find((h) => h.id === peer.service.identity.id)?.defaults,
    ).toBe("synced");
    expect(
      JSON.parse(readFileSync(join(hub.directory, "hosts.json"), "utf8"))
        .defaults,
    ).toEqual(expected);
    expect(peer.app.snapshot().settings).toEqual(expected);
    const worker = (await peer.app.tool(
      peer.runtime.agents.get(orc.id)!.token,
      "worker_start",
      {
        project: "alpha",
        title: "Local worker",
        spec: "fixture",
        message: "Work",
      },
    )) as Detail;
    expect(peer.app.detail(worker.id).effort).toBe(expected.worker.effort);
    expect(peer.app.detail(orc.id).effort).toBe("medium");
  },
);
