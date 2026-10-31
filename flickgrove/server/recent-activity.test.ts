import { afterEach, expect, spyOn, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { HostService } from "./hosts";
import { FakeRuntime, fixtureProjects } from "./testing";
import { Workspace } from "./workspace";
import { WorkspaceStore } from "./workspace-store";
import { detailSchema, snapshotSchema } from "../src/chord-contract";
import { DeliveryRejected } from "./runtime";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-activity-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    reviewerSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "review",
    }),
    researcherSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "research",
    }),
  });
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  return { directory, runtime, app };
}

test("a pre-activity database upgrades with null activity until new work", () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-activity-upgrade-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const prior = join(directory, "prior"),
    path = join(directory, "workspace.sqlite");
  mkdirSync(join(prior, "meta"), { recursive: true });
  const shipped = fileURLToPath(new URL("../drizzle/", import.meta.url));
  const journal = JSON.parse(
    readFileSync(join(shipped, "meta/_journal.json"), "utf8"),
  );
  const entries = journal.entries.slice(0, 2);
  writeFileSync(
    join(prior, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries)
    copyFileSync(
      join(shipped, entry.tag + ".sql"),
      join(prior, entry.tag + ".sql"),
    );
  const db = new Database(path);
  db.exec(
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
  );
  db.query("INSERT INTO workspace VALUES(1,?)").run(
    JSON.stringify({
      agents: [
        {
          id: "old",
          token: "old-token",
          role: "orc",
          title: "Old",
          project: fixtureProjects[0],
          model: "sol",
          effort: "medium",
          serviceTier: "default",
          state: "idle",
          closed: false,
          messages: [],
          deliveries: [],
          questions: [],
        },
      ],
      revision: 0,
    }),
  );
  migrate(drizzle(db), { migrationsFolder: prior });
  db.close();
  const store = new WorkspaceStore(path);
  try {
    expect(store.byId("old")?.lastActivityAt).toBeUndefined();
    expect(
      store.sqlite
        .query("SELECT last_activity_at FROM sessions WHERE id = 'old'")
        .get(),
    ).toEqual({ last_activity_at: null });
    const old = store.track(store.byId("old")!);
    old.lastActivityAt = 1234;
    store.flush();
    expect(store.byId("old")?.lastActivityAt).toBe(1234);
  } finally {
    store.close();
  }
});

test("activity follows real turns and messages, excludes replays and stale events, and survives restart and host projection", async () => {
  const { directory, runtime, app } = fixture();
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const orc = await app.createOrc("alpha");
  const other = await app.createOrc("beta");
  expect(app.detail(orc.id).lastActivityAt).toBeUndefined();
  await app.send(orc.id, "start", "first");
  expect(app.detail(orc.id).lastActivityAt).toBe(1000);
  const turn = app.detail(orc.id).turnId!;
  now = 2000;
  const message = {
    type: "item" as const,
    turnId: turn,
    item: { id: "answer", type: "agentMessage", text: "hello" },
  };
  runtime.emit(orc.id, message);
  expect(app.detail(orc.id).lastActivityAt).toBe(2000);
  now = 3000;
  runtime.emit(orc.id, message);
  runtime.emit(orc.id, {
    ...message,
    item: { ...message.item, id: "replayed" },
    replayed: true,
  });
  runtime.emit(orc.id, {
    type: "item",
    turnId: "stale",
    item: { id: "stale-answer", type: "agentMessage", text: "old" },
  });
  runtime.emit(orc.id, {
    type: "completed",
    turnId: "stale",
    status: "completed",
  });
  await app.send(orc.id, "start", "first");
  expect(app.detail(orc.id).lastActivityAt).toBe(2000);
  runtime.emit(orc.id, {
    type: "item",
    turnId: turn,
    item: { id: "external", type: "userMessage", text: "another input" },
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(3000);
  now = 4000;
  runtime.emit(orc.id, {
    type: "completed",
    turnId: turn,
    status: "completed",
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(4000);
  now = 5000;
  runtime.emit(orc.id, {
    type: "completed",
    turnId: turn,
    status: "completed",
  });
  runtime.emit(orc.id, {
    type: "item",
    turnId: turn,
    item: { id: "late", type: "userMessage", text: "late" },
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(4000);
  expect(app.detail(other.id).lastActivityAt).toBeUndefined();
  app.dispose();
  const restarted = new Workspace({
    directory,
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => restarted.dispose());
  expect(restarted.detail(orc.id).lastActivityAt).toBe(4000);
  expect(restarted.detail(other.id).lastActivityAt).toBeUndefined();
  const host = new HostService(restarted, {
    directory,
    origin: () => "http://localhost",
  });
  expect(
    host.snapshot().agents.find((a) => a.id.endsWith(orc.id))?.lastActivityAt,
  ).toBe(4000);
  expect(
    (await host.detail(`${host.identity.id}:${orc.id}`)).lastActivityAt,
  ).toBe(4000);
  expect(
    snapshotSchema
      .parse(host.snapshot())
      .agents.find((a) => a.id.endsWith(orc.id))?.lastActivityAt,
  ).toBe(4000);
  expect(
    detailSchema.parse(await host.detail(`${host.identity.id}:${orc.id}`))
      .lastActivityAt,
  ).toBe(4000);
});

test("an idle Orc retains owned Worker activity after the Worker closes", async () => {
  const { app, runtime } = fixture();
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const orc = await app.createOrc("alpha");
  const token = runtime.agents.get(orc.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Worker",
    spec: "test",
    message: "work",
  })) as { id: string };
  expect(app.detail(orc.id).state).toBe("idle");
  expect(app.detail(orc.id).lastActivityAt).toBe(1000);
  expect(app.detail(worker.id).state).toBe("working");
  now = 2000;
  const turn = app.detail(worker.id).turnId!;
  runtime.emit(worker.id, {
    type: "item",
    turnId: turn,
    item: { id: "child-answer", type: "agentMessage", text: "done" },
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(2000);
  now = 3000;
  runtime.emit(worker.id, {
    type: "completed",
    turnId: turn,
    status: "completed",
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(3000);
  now = 4000;
  await app.tool(token, "worker_close", { workerId: worker.id });
  expect(app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
  expect(app.detail(orc.id).lastActivityAt).toBe(3000);
});

test("rejected submissions and replayed starts do not create activity", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  runtime.emit(orc.id, { type: "working", turnId: "replayed", replayed: true });
  runtime.emit(orc.id, {
    type: "completed",
    turnId: "replayed",
    status: "completed",
    replayed: true,
  });
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("rejected");
  };
  await app.send(orc.id, "rejected", "rejected");
  expect(app.detail(orc.id).lastActivityAt).toBeUndefined();
  runtime.sendOverride = undefined;
  await app.send(orc.id, "accepted", "accepted");
  expect(app.detail(orc.id).lastActivityAt).toEqual(expect.any(Number));
});

test("Reviewer and Researcher work updates their idle Orc", async () => {
  const { app, runtime } = fixture();
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const orc = await app.createOrc("alpha");
  const token = runtime.agents.get(orc.id)!.token;
  const reviewer = (await app.tool(token, "reviewer_start", {
    project: "alpha",
    title: "Reviewer",
    profile: "spec",
    spec: "#5082",
    fixedPoint: "base",
    reviewedHead: "head",
    message: "review",
  })) as { id: string };
  expect(app.detail(orc.id).lastActivityAt).toBe(1000);
  now = 2000;
  runtime.emit(reviewer.id, {
    type: "completed",
    turnId: app.detail(reviewer.id).turnId!,
    status: "completed",
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(2000);
  now = 3000;
  const researcher = (await app.tool(token, "researcher_start", {
    project: "alpha",
    title: "Researcher",
    question: "Why?",
    message: "research",
  })) as { id: string };
  expect(app.detail(orc.id).lastActivityAt).toBe(3000);
  now = 4000;
  runtime.emit(researcher.id, {
    type: "completed",
    turnId: app.detail(researcher.id).turnId!,
    status: "completed",
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(4000);
  expect(app.detail(orc.id).state).toBe("idle");
});

test("recovered child completion uses its native time, never the restart time or an older time", async () => {
  const { app, runtime } = fixture();
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const orc = await app.createOrc("alpha");
  const token = runtime.agents.get(orc.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Worker",
    spec: "test",
    message: "work",
  })) as { id: string };
  const turn = app.detail(worker.id).turnId!;
  now = 9000;
  runtime.emit(worker.id, {
    type: "completed",
    turnId: "stale",
    status: "completed",
    replayed: true,
    recoveredActivityAt: 8000,
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(1000);
  runtime.emit(worker.id, {
    type: "completed",
    turnId: turn,
    status: "completed",
    replayed: true,
    recoveredActivityAt: 2000,
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(2000);
  now = 3000;
  await app.tool(token, "worker_send", {
    workerId: worker.id,
    message: "next",
  });
  const next = app.detail(worker.id).turnId!;
  now = 10000;
  runtime.emit(worker.id, {
    type: "completed",
    turnId: next,
    status: "completed",
    replayed: true,
    recoveredActivityAt: 1500,
  });
  expect(app.detail(orc.id).lastActivityAt).toBe(3000);
});
