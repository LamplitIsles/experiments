import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket } from "./chord-socket";
import { callRoute } from "./socket-testing";
import { FakeRuntime, fixtureProjects } from "./testing";

let dispose: () => void;
afterEach(() => dispose?.());
test("local API creates a session, preserves work across visits and rejects foreign origins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flickgrove-http-"));
  const app = new Workspace({
    directory,
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
  });
  dispose = () => {
    service.dispose();
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  };
  const service = new HostService(app, {
    directory,

    origin: () => "http://127.0.0.1:4321",
  });
  const fetch = createHandler(app, {
    service,
    origin: () => "http://127.0.0.1:4321",
  });
  let address = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch: (req, server) => {
      const upgraded = createUpgrade(app, { service, origin: () => address })(
        req,
        server,
      );
      return upgraded === true ? undefined : (upgraded ?? fetch(req));
    },
  });
  address = `http://127.0.0.1:${server.port}`;
  const previousDispose = dispose;
  dispose = () => {
    server.stop(true);
    previousDispose();
  };
  const request = (
    path: string,
    body?: unknown,
    origin = "http://127.0.0.1:4321",
  ) =>
    body && origin === "http://127.0.0.1:4321"
      ? callRoute(address, path, body)
      : fetch(
          new Request(`http://127.0.0.1:4321${path}`, {
            method: body ? "POST" : "GET",
            headers: { origin, "Content-Type": "application/json" },
            ...(body ? { body: JSON.stringify(body) } : {}),
          }),
        );
  expect(
    (
      await request(
        "/api/agents",
        {
          project: "alpha",
          settings: {
            fast: false,
            orc: { model: "sol", effort: "medium" },
            worker: { model: "sol", effort: "medium" },
          },
        },
        "https://evil.example",
      )
    ).status,
  ).toBe(403);
  const response = await request("/api/agents", {
    project: "alpha",
    settings: {
      fast: false,
      orc: { model: "sol", effort: "medium" },
      worker: { model: "sol", effort: "medium" },
    },
  });
  expect(response.status).toBe(200);
  const agent = (await response.json()) as { id: string };
  await request(`/api/agents/${agent.id}/messages`, {
    text: "Build a reader",
    operationId: "first",
  });
  const secondVisit = service.snapshot() as {
    agents: { state: string; token?: string }[];
  };
  expect(secondVisit.agents[0].state).toBe("working");
  expect(secondVisit.agents[0].token).toBeUndefined();
  expect(
    (await request("/api/snapshot", undefined, "https://evil.example")).status,
  ).toBe(403);
});
