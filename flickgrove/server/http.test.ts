import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { createHandler } from "./http";
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
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  };
  const fetch = createHandler(app, { origin: () => "http://127.0.0.1:4321" });
  const request = (
    path: string,
    body?: unknown,
    origin = "http://127.0.0.1:4321",
  ) =>
    fetch(
      new Request(`http://127.0.0.1:4321${path}`, {
        method: body ? "POST" : "GET",
        headers: { origin, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  expect(
    (await request("/api/agents", { project: "alpha" }, "https://evil.example"))
      .status,
  ).toBe(403);
  const response = await request("/api/agents", { project: "alpha" });
  expect(response.status).toBe(200);
  const agent = (await response.json()) as { id: string };
  await request(`/api/agents/${agent.id}/messages`, {
    text: "Build a reader",
    requestId: "first",
  });
  const secondVisit = (await (await request("/api/snapshot")).json()) as {
    agents: { state: string; token?: string }[];
  };
  expect(secondVisit.agents[0].state).toBe("working");
  expect(secondVisit.agents[0].token).toBeUndefined();
  expect(
    (await request("/api/snapshot", undefined, "https://evil.example")).status,
  ).toBe(403);
});
