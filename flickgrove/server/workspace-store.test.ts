import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "./workspace-store";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { readingHttp } from "./reading-http";
import { invoke } from "./chord-methods";
import { FakeRuntime, fixtureProjects } from "./testing";
import { DeliveryRejected, type RuntimeAgent } from "./runtime";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-rows-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "workspace.sqlite") };
}
function agent(
  id: string,
  overrides: Partial<RuntimeAgent> = {},
): RuntimeAgent {
  return {
    id,
    token: `private-${id}`,
    role: "orc",
    title: id,
    project: fixtureProjects[0],
    model: "sol",
    effort: "high",
    serviceTier: "default",
    state: "idle",
    closed: false,
    messages: [],
    deliveries: [],
    questions: [],
    ...overrides,
  };
}
function legacy(path: string, agents: RuntimeAgent[]) {
  const db = new Database(path);
  db.exec(
    "CREATE TABLE workspace(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL)",
  );
  db.query("INSERT INTO workspace VALUES(1,?)").run(
    JSON.stringify({ agents, revision: 999 }),
  );
  db.close();
}
function store(path: string) {
  const value = new WorkspaceStore(path);
  cleanup.push(() => value.close());
  return value;
}
test("real Bun migrator converts all durable roles, envelopes and order atomically and reopens idempotently", () => {
  const { path } = fixture();
  const target = {
    profile: "high_risk_spec" as const,
    spec: "4250",
    fixedPoint: "fixed",
    reviewedHead: "report-head",
  };
  const parent = agent("parent", {
    treeFast: false,
    turnEnded: false,
    turnId: "unknown",
    stop: { turnId: "unknown", status: "unknown" },
    closeRequest: { reason: "wait" },
    orcPromptSnapshot: "captured",
    workerDefaults: { model: "sol", effort: "high", serviceTier: "default" },
    readingRevision: 88,
    historyCursor: "old",
    workingSince: 100,
    messages: [
      { id: "omitted", role: "assistant", text: "Do not import body", at: 1 },
    ],
    questions: [
      {
        id: "q0",
        itemId: "item",
        index: 0,
        title: "Q",
        text: "Original?",
        options: [{ label: "Yes" }],
        state: "delegated",
        at: 3,
      },
      {
        id: "q1",
        itemId: "item",
        index: 1,
        title: "Q1",
        text: "Second?",
        options: [],
        state: "answered",
        answer: "",
        at: 3,
      },
    ],
    deliveries: [
      {
        id: "same-op",
        text: "fallback",
        source: "question",
        status: "uncertain",
        attemptId: "attempt",
        turnId: "turn",
        questionIds: ["q1", "q0"],
        answers: [{ questionId: "q1", answer: "" }],
        at: 7,
      },
      {
        id: "report",
        text: "original report",
        source: "reviewer",
        status: "failed",
        error: "rejected",
        questionIds: [],
        reportingReviewerId: "reviewer",
        reviewTarget: target,
        at: 1,
      },
    ],
  });
  const reviewer = agent("reviewer", {
    role: "reviewer",
    ownerId: "parent",
    threadId: "review-thread",
    closed: true,
    reviewTarget: { ...target, reviewedHead: "current-head" },
    reviewerSnapshot: {
      model: "sol",
      effort: "high",
      prompt: "review",
      serviceTier: "default",
    } as RuntimeAgent["reviewerSnapshot"],
    deliveries: [
      {
        id: "same-op",
        text: "different scope",
        source: "worker",
        status: "sent",
        questionIds: [],
        at: 0,
      },
    ],
  });
  const researcher = agent("researcher", {
    role: "researcher",
    ownerId: "parent",
    researchQuestion: "Why?",
    researcherSnapshot: {
      model: "sol",
      effort: "high",
      prompt: "research",
      serviceTier: "default",
    } as RuntimeAgent["researcherSnapshot"],
  });
  legacy(path, [
    parent,
    reviewer,
    researcher,
    agent("worker", { role: "worker", ownerId: "parent", closed: true }),
  ]);
  const db = store(path);
  expect(db.openAgents().map((a) => a.id)).toEqual(["parent", "researcher"]);
  const loaded = db.byId("parent")!;
  expect(loaded).toMatchObject({
    treeFast: false,
    turnEnded: false,
    turnId: "unknown",
    stop: parent.stop,
    closeRequest: parent.closeRequest,
    project: parent.project,
    workerDefaults: parent.workerDefaults,
    orcPromptSnapshot: "captured",
  });
  expect(loaded.deliveries).toEqual(parent.deliveries);
  expect(loaded.questions).toEqual(parent.questions);
  expect(db.byId("reviewer")).toMatchObject({
    role: "reviewer",
    closed: true,
    ownerId: "parent",
    reviewTarget: reviewer.reviewTarget,
    reviewerSnapshot: reviewer.reviewerSnapshot,
  });
  expect(db.byId("researcher")).toMatchObject({
    researchQuestion: "Why?",
    researcherSnapshot: researcher.researcherSnapshot,
  });
  expect(loaded.messages).toEqual([]);
  expect(loaded.readingRevision).toBeUndefined();
  expect(loaded.workingSince).toBeUndefined();
  expect(loaded.historyCursor).toBeUndefined();
  expect(
    db.sqlite
      .query("SELECT name FROM sqlite_master WHERE name='workspace'")
      .get(),
  ).toBeNull();
  expect(
    db.sqlite.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
  ).toEqual({ n: 1 });
  const reopened = store(path);
  expect(reopened.byId("parent")?.deliveries).toEqual(parent.deliveries);
  expect(
    reopened.sqlite
      .query("SELECT count(*) AS n FROM __drizzle_migrations")
      .get(),
  ).toEqual({ n: 1 });
});
test("conversion failure rolls back schema, data and success log and refuses Workspace startup", () => {
  const { path, directory } = fixture();
  legacy(path, [agent("one"), agent("two", { token: "private-one" })]);
  const before = new Database(path);
  const original = before.query("SELECT value FROM workspace").get();
  before.close();
  expect(
    () =>
      new Workspace({
        directory,
        runtime: new FakeRuntime(),
        projects: async () => fixtureProjects,
      }),
  ).toThrow();
  const db = new Database(path);
  expect(db.query("SELECT value FROM workspace").get()).toEqual(original);
  expect(
    db.query("SELECT name FROM sqlite_master WHERE name='sessions'").get(),
  ).toBeNull();
  expect(
    db.query("SELECT count(*) AS n FROM __drizzle_migrations").get(),
  ).toEqual({ n: 0 });
  // Repair only the test-owned source; a subsequent real startup can retry.
  db.query(
    "UPDATE workspace SET value=json_set(value,'$.agents[1].token','private-two')",
  ).run();
  db.close();
  expect(store(path).openAgents()).toHaveLength(2);
});
test("fresh empty startup and unknown applied migrations are distinct", () => {
  const { path } = fixture();
  const db = store(path);
  expect(db.openAgents()).toEqual([]);
  db.sqlite
    .query(
      "INSERT INTO __drizzle_migrations(hash,created_at) VALUES('future',9999999999999)",
    )
    .run();
  expect(() => new WorkspaceStore(path)).toThrow("unknown migrations");
});
test("one changed row never rewrites cold sessions or a long active ledger; failed commit publishes nothing", async () => {
  const { path, directory } = fixture();
  const cold = Array.from({ length: 661 }, (_, i) =>
    agent(`cold-${i}`, {
      closed: true,
      deliveries: [
        {
          id: "cold",
          text: "body",
          source: "user",
          status: "sent",
          questionIds: [],
          at: 0,
        },
      ],
    }),
  );
  const active = agent("hot", {
    threadId: "hot-thread",
    deliveries: Array.from({ length: 1500 }, (_, i) => ({
      id: `d${i}`,
      text: "envelope",
      source: "user" as const,
      status: "sent" as const,
      questionIds: [],
      at: i,
    })),
  });
  legacy(path, [...cold, active]);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    branches: { read: async () => null },
  });
  cleanup.push(() => app.dispose());
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.exec(
    "CREATE TABLE writes(kind TEXT,id TEXT); CREATE TRIGGER session_writes AFTER UPDATE ON sessions BEGIN INSERT INTO writes VALUES('session',new.id); END; CREATE TRIGGER delivery_writes AFTER UPDATE ON deliveries BEGIN INSERT INTO writes VALUES('delivery',new.operation_id); END;",
  );
  await app.send("hot", "new", "new-op");
  expect(
    db
      .query("SELECT * FROM writes WHERE kind='session' AND id LIKE 'cold-%'")
      .all(),
  ).toEqual([]);
  expect(
    db
      .query("SELECT * FROM writes WHERE kind='delivery' AND id!='new-op'")
      .all(),
  ).toEqual([]);
  expect(
    (app as unknown as { state: { agents: unknown[] } }).state.agents,
  ).toHaveLength(1);
  db.exec("DELETE FROM writes");
  runtime.emit("hot", {
    type: "item",
    turnId: "confirmed",
    item: {
      id: "native-existing",
      type: "userMessage",
      clientId: "d1499",
      text: "envelope",
    },
  });
  expect(db.query("SELECT id FROM writes WHERE kind='delivery'").all()).toEqual(
    [{ id: "d1499" }],
  );
  expect(
    db
      .query("SELECT * FROM writes WHERE kind='session' AND id LIKE 'cold-%'")
      .all(),
  ).toEqual([]);
  let publications = 0;
  const off = app.subscribe(() => publications++);
  db.exec(
    "CREATE TRIGGER fail_write BEFORE INSERT ON deliveries WHEN new.operation_id='failure' BEGIN SELECT RAISE(ABORT,'test failure'); END",
  );
  await expect(app.send("hot", "no admission", "failure")).rejects.toThrow();
  expect(runtime.inputs.some((i) => i.text === "no admission")).toBe(false);
  expect(publications).toBe(0);
  off();
});

test("native acceptance outside an empty memory window prevents failed deletion and retry", async () => {
  const { directory } = fixture();
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  const a = await app.createOrc("alpha");
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("rejected");
  };
  await app.send(a.id, "original", "operation");
  runtime.historyItems.set(a.threadId!, [
    {
      id: "native",
      role: "user",
      clientId: "operation",
      text: "original",
      at: 1,
    },
  ]);
  await expect(app.deleteFailedSubmission(a.id, "operation")).rejects.toThrow(
    "Native history confirms",
  );
  expect(app.lookup(a.id, "operation")?.state).toBe("accepted");
  const b = await app.createOrc("alpha");
  await app.send(b.id, "retry", "operation");
  runtime.historyItems.set(b.threadId!, [
    {
      id: "native-retry",
      role: "user",
      clientId: "operation",
      text: "retry",
      at: 2,
    },
  ]);
  const count = runtime.inputs.length;
  await expect(
    app.send(b.id, "retry", "operation", undefined, {
      after: "operation",
      attempt: "retry-attempt",
    }),
  ).rejects.toThrow("Native history confirms");
  expect(runtime.inputs).toHaveLength(count);
});
test("NULL delegated answers use immutable delivery text while explicit empty answers survive confirmation and restart", async () => {
  const { directory, path } = fixture();
  const questions = [0, 1].map((index) => ({
    id: `ask:${index}`,
    itemId: "ask",
    index,
    title: "Q",
    text: "Answer?",
    options: [],
    state: "delegated" as const,
    at: 1,
  }));
  legacy(path, [
    agent("owner", {
      threadId: "native-thread",
      questions,
      deliveries: [
        {
          id: "answer",
          text: "delegated body",
          source: "question",
          status: "uncertain",
          questionIds: ["ask:0", "ask:1"],
          answers: [{ questionId: "ask:1", answer: "" }],
          at: 2,
        },
      ],
    }),
  ]);
  const runtime = new FakeRuntime();
  runtime.historyItems.set("native-thread", [
    {
      id: "native-answer",
      clientId: "answer",
      role: "user",
      text: "delegated body",
      at: 2,
    },
  ]);
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  await app.synchronizeDetail("owner");
  expect(app.questionHistory("owner").map((q) => q.answer)).toEqual([
    "delegated body",
    "",
  ]);
  expect(
    store(path)
      .byId("owner")
      ?.questions.map((q) => q.answer),
  ).toEqual(["delegated body", ""]);
});

test("cold history preview preserves the journal without opening a native writer", async () => {
  const { directory, path } = fixture();
  const closed = agent("closed", {
    closed: true,
    threadId: "closed-thread",
    deliveries: [
      {
        id: "unknown",
        text: "original",
        source: "user",
        status: "uncertain",
        questionIds: [],
        at: 1,
      },
    ],
  });
  legacy(path, [closed]);
  const runtime = new FakeRuntime();
  runtime.historySessions.set("closed-thread", {
    threadId: "closed-thread",
    title: "History",
    preview: "original",
    cwd: fixtureProjects[0].path,
    updatedAt: 1,
    source: "cli",
    archived: false,
    role: "session",
  });
  runtime.historyItems.set("closed-thread", [
    {
      id: "native",
      clientId: "unknown",
      role: "user",
      text: "original",
      at: 1,
    },
  ]);
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  const db = store(path);
  const before = db.byId("closed");
  expect(
    (await app.historyMessages("alpha", "closed-thread")).messages[0].delivery
      ?.source,
  ).toBe("user");
  expect(db.byId("closed")).toEqual(before);
  expect(runtime.agents.size).toBe(0);
  expect(app.snapshot().agents).toEqual([]);
});

test("native confirmation and question answers roll back together when the delivery update fails", async () => {
  const { directory, path } = fixture();
  legacy(path, [
    agent("owner", {
      threadId: "native-thread",
      questions: [
        {
          id: "q",
          itemId: "ask",
          index: 0,
          title: "Q",
          text: "Answer?",
          options: [],
          state: "delegated",
          at: 1,
        },
      ],
      deliveries: [
        {
          id: "answer",
          text: "body fallback",
          source: "question",
          status: "uncertain",
          questionIds: ["q"],
          at: 2,
        },
      ],
    }),
    agent("cold", {
      closed: true,
      questions: [
        {
          id: "cold-q",
          itemId: "cold-item",
          index: 0,
          title: "Cold",
          text: "Committed?",
          options: [],
          state: "answered",
          answer: "committed cold answer",
          at: 1,
        },
      ],
    }),
  ]);
  const runtime = new FakeRuntime();
  runtime.historyItems.set("native-thread", [
    {
      id: "native-answer",
      clientId: "answer",
      role: "user",
      text: "body fallback",
      at: 2,
    },
  ]);
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  await app.reconcileSettings("owner");
  const db = store(path);
  db.sqlite.exec(
    "CREATE TRIGGER fail_confirmation BEFORE UPDATE ON deliveries WHEN new.status='sent' BEGIN SELECT RAISE(ABORT,'fixture confirmation failure'); END",
  );
  let publications = 0;
  const off = app.subscribe(() => publications++);
  await expect(app.synchronizeDetail("owner")).rejects.toThrow(
    "fixture confirmation failure",
  );
  expect(db.byId("owner")?.deliveries[0].status).toBe("uncertain");
  expect(db.byId("owner")?.questions[0]).toMatchObject({ state: "delegated" });
  expect(db.byId("owner")?.questions[0].answer).toBeUndefined();
  const origin = "http://fixture.invalid";
  const service = new HostService(app, {
    directory: join(directory, "peer"),
    origin: () => origin,
  });
  cleanup.push(() => service.dispose());
  const reads = [
    () => app.detail("owner"),
    () => app.recovery("owner", "answer"),
    () => app.recoveryPage("owner"),
    () => app.questionHistory("owner", { operation: "answer" }),
  ];
  const outcomes = reads.map((read) => {
    try {
      return read();
    } catch {
      return "read failed";
    }
  });
  const responses = await Promise.all(
    [
      "/recovery?operation=answer",
      "/questions?operation=answer",
      "/deliveries?",
    ].map((path) =>
      readingHttp(
        new Request(
          origin +
            "/api/read" +
            path +
            "&agent=" +
            encodeURIComponent(service.identity.id + ":owner"),
          { headers: { Origin: origin, "X-Grove-Peer": service.identity.id } },
        ),
        service,
        [origin],
      ),
    ),
  );
  console.info(
    "failed-commit reads",
    JSON.stringify(outcomes),
    "HTTP",
    responses.map((r) => r!.status),
  );
  expect(outcomes).toEqual([
    "read failed",
    "read failed",
    "read failed",
    "read failed",
  ]);
  expect(responses.map((r) => r!.status)).toEqual([400, 400, 400]);
  expect(app.questionHistory("cold")[0].answer).toBe("committed cold answer");
  const cold = await readingHttp(
    new Request(
      origin +
        "/api/read/questions?agent=" +
        encodeURIComponent(service.identity.id + ":cold"),
      { headers: { Origin: origin, "X-Grove-Peer": service.identity.id } },
    ),
    service,
    [origin],
  );
  expect(cold!.status).toBe(200);
  expect((await cold!.json())[0].answer).toBe("committed cold answer");
  expect(publications).toBe(0);
  off();
});

test("startup preserves repeated question IDs in an envelope captured from the legal fixed-point worker_send API", async () => {
  // Captured by running a8cd620's real Workspace with a test-owned FakeRuntime:
  // create Orc/Worker, emit async question, worker_send(questionIds:[q,q]).
  const captured = (await Bun.file(
    new URL(
      "../tests/fixtures/legacy-duplicate-questions.json",
      import.meta.url,
    ),
  ).json()) as { agents: RuntimeAgent[] };
  const worker = captured.agents.find((a) => a.role === "worker")!;
  const original = worker.deliveries.at(-1)!;
  expect(original.questionIds).toEqual([
    "duplicate-question:0",
    "duplicate-question:0",
  ]);
  const { path } = fixture();
  legacy(path, captured.agents);
  const db = store(path);
  expect(db.byId(worker.id)?.deliveries.at(-1)).toEqual(original);
  expect(db.byId(worker.id)?.questions[0]).toMatchObject({
    state: "answered",
    answer: "answer",
  });
  const reopened = store(path);
  expect(reopened.byId(worker.id)?.deliveries.at(-1)?.questionIds).toEqual(
    original.questionIds,
  );
});

for (const abandon of [false, true]) {
  test(`failed ${abandon ? "abandon" : "ordinary"} close cannot publish closure through recovery or history`, async () => {
    const { directory, path } = fixture();
    legacy(path, [
      agent("owner", {
        threadId: "owner-thread",
        deliveries: abandon
          ? [
              {
                id: "unknown",
                text: "original",
                source: "user",
                status: "uncertain",
                questionIds: [],
                at: 1,
              },
            ]
          : [],
      }),
      agent("cold", { threadId: "cold-thread", closed: true }),
    ]);
    const runtime = new FakeRuntime();
    runtime.historySessions.set("cold-thread", {
      threadId: "cold-thread",
      title: "Cold",
      preview: "",
      cwd: fixtureProjects[0].path,
      updatedAt: 1,
      source: "cli",
      archived: false,
      role: "session",
    });
    const app = new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
    });
    cleanup.push(() => app.dispose());
    await app.reconcileSettings("owner");
    const db = store(path);
    for (const event of ["UPDATE", "INSERT"])
      db.sqlite.exec(
        `CREATE TRIGGER fail_close_${event} BEFORE ${event} ON sessions WHEN new.closed=1 BEGIN SELECT RAISE(ABORT,'fixture close failure'); END`,
      );
    await expect(
      app.closeTree("owner", abandon ? ["unknown"] : undefined),
    ).rejects.toThrow("fixture close failure");
    expect(db.byId("owner")?.closed).toBe(false);
    expect(runtime.listeners.has("owner")).toBe(false);
    const service = new HostService(app, {
      directory: join(directory, "peer"),
      origin: () => "http://fixture.invalid",
    });
    cleanup.push(() => service.dispose());
    const outcomes = await Promise.all(
      [
        () => app.abandonCloseCandidate("owner"),
        () => app.historySession("alpha", "owner-thread"),
        () => app.history("alpha", ""),
        () =>
          invoke(service, "abandonCloseCandidate", {
            id: service.identity.id + ":owner",
          }),
        () =>
          invoke(service, "historySession", {
            project: "alpha",
            threadId: "owner-thread",
          }),
      ].map(async (read) => {
        try {
          return await read();
        } catch {
          return "read failed";
        }
      }),
    );
    console.info("failed-close reads", abandon, JSON.stringify(outcomes));
    expect(outcomes).toEqual(Array(5).fill("read failed"));
    expect(await app.abandonCloseCandidate("cold")).toEqual({
      closed: true,
      unknownOperationIds: [],
    });
    expect(
      await invoke(service, "historySession", {
        project: "alpha",
        threadId: "cold-thread",
      }),
    ).toMatchObject({ closed: true, agentId: "cold" });
  });
}

test("a failed owned child close cannot disappear from the authenticated shared role lists", async () => {
  const { directory, path } = fixture();
  legacy(path, [
    agent("owner"),
    agent("child", {
      role: "worker",
      ownerId: "owner",
      threadId: "child-thread",
    }),
  ]);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanup.push(() => app.dispose());
  await app.reconcileSettings("child");
  const db = store(path);
  for (const event of ["UPDATE", "INSERT"])
    db.sqlite.exec(
      `CREATE TRIGGER fail_close_${event} BEFORE ${event} ON sessions WHEN new.closed=1 BEGIN SELECT RAISE(ABORT,'fixture close failure'); END`,
    );
  await expect(
    app.tool("private-owner", "worker_close", { workerId: "child" }),
  ).rejects.toThrow("fixture close failure");
  expect(db.byId("child")?.closed).toBe(false);
  expect(runtime.listeners.has("child")).toBe(false);
  expect(app.identity("private-owner").id).toBe("owner");
  const outcomes = await Promise.all(
    ["worker_list", "reviewer_list", "researcher_list"].map(async (name) => {
      try {
        return await app.tool("private-owner", name, {});
      } catch {
        return "read failed";
      }
    }),
  );
  console.info("failed-child-close lists", JSON.stringify(outcomes));
  expect(outcomes).toEqual(["read failed", "read failed", "read failed"]);
});
