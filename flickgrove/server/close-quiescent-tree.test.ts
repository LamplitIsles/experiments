import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import type { RuntimeAgent } from "./runtime";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-quiescent-"));
  const runtime = new FakeRuntime();
  const agents = new Map<string, RuntimeAgent>();
  const open = runtime.open.bind(runtime);
  runtime.open = async (agent, notify) => {
    agents.set(agent.id, agent);
    return open(agent, notify);
  };
  const snapshot = async () => ({
    model: "sol",
    effort: "medium",
    prompt: "Fixture role",
  });
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    reviewerSnapshot: snapshot,
    researcherSnapshot: snapshot,
  });
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  const owner = await app.createOrc("alpha");
  const token = runtime.agents.get(owner.id)!.token;
  const children: RuntimeAgent[] = [];
  for (const role of ["worker", "reviewer", "researcher"] as const) {
    const child = (await app.tool(token, `${role}_start`, {
      project: "alpha",
      title: `${role} fixture`,
      message: "Fixture assignment",
      ...(role === "researcher"
        ? { question: "Fixture question?" }
        : { spec: "#3917" }),
      ...(role === "reviewer"
        ? {
            profile: "high_risk_spec",
            fixedPoint: "base",
            reviewedHead: "head",
          }
        : {}),
    })) as { id: string };
    runtime.emit(child.id, {
      type: "completed",
      turnId: app.detail(child.id).turnId!,
      status: "completed",
    });
    children.push(agents.get(child.id)!);
  }
  const releases: string[] = [];
  runtime.closeOverride = async (id) => {
    releases.push(id);
  };
  return { app, runtime, directory, owner, token, children, releases, agents };
}

test("ordinary Close releases all three roles before root, preserves history and ignores late events", async () => {
  const { app, runtime, directory, owner, children, releases } =
    await fixture();
  const callbacks = children.map((c) => runtime.listeners.get(c.id)!);
  const inputs = runtime.inputs.length;
  // Known failed termination is eligible, without confirmInterrupted.
  runtime.emit(children[1]!.id, {
    type: "working",
    turnId: "terminal-failure",
  });
  runtime.emit(children[1]!.id, {
    type: "completed",
    turnId: "terminal-failure",
    status: "failed",
  });
  expect(app.detail(children[1]!.id).state).toBe("error");
  await expect(app.closeTree(children[1]!.id)).rejects.toThrow("Orc tree");
  expect(releases).toEqual([]);
  await app.closeTree(owner.id);
  expect(releases).toEqual([...children.map((c) => c.id), owner.id]);
  expect(app.snapshot().agents).toEqual([]);
  expect(runtime.inputs).toHaveLength(inputs);
  expect(runtime.interruptions).toEqual([]);
  for (const callback of callbacks)
    callback({ type: "working", turnId: "late" });
  expect(app.snapshot().agents).toEqual([]);
  for (const c of children)
    expect((await app.historySession("alpha", c.threadId!)).threadId).toBe(
      c.threadId!,
    );
  app.dispose();
  const restoredRuntime = new FakeRuntime();
  const restored = new Workspace({
    directory,
    runtime: restoredRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  expect(restored.snapshot().agents).toEqual([]);
  expect(restoredRuntime.agents.size).toBe(0);
});

test("restored root with unconfirmed startup refuses Close before releasing children", async () => {
  const { WorkspaceStore } = await import("./workspace-store");
  const { app, directory, owner, children } = await fixture();
  app.dispose();
  const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
  const root = store.track(store.byId(owner.id)!);
  root.threadId = undefined;
  store.flush();
  store.close();
  const runtime = new FakeRuntime(),
    releases: string[] = [];
  runtime.closeOverride = async (id) => {
    releases.push(id);
  };
  const restored = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  await Promise.all(
    children.map((child) => restored.reconcileSettings(child.id)),
  );
  expect(runtime.agents.has(owner.id)).toBe(false);
  await expect(restored.closeTree(owner.id)).rejects.toThrow(
    "Native thread startup is unconfirmed",
  );
  expect(releases).toEqual([]);
  expect(restored.snapshot().agents.map((a) => a.id)).toEqual([
    owner.id,
    ...children.map((child) => child.id),
  ]);
  for (const child of children)
    expect(restored.detail(child.id).ownerId).toBe(owner.id);
});

const guards: [
  string,
  (child: RuntimeAgent, root: RuntimeAgent) => void,
  string,
][] = [
  [
    "working",
    (c) => {
      c.state = "working";
    },
    "current work",
  ],
  [
    "stopping",
    (c) => {
      c.state = "stopping";
    },
    "outcome",
  ],
  [
    "unknown error",
    (c) => {
      c.state = "error";
      c.turnEnded = false;
    },
    "outcome",
  ],
  [
    "unanswered question",
    (c) => {
      c.questions.push({
        id: "q",
        itemId: "q",
        index: 0,
        at: 1,
        text: "Choose?",
        title: "Choose?",
        state: "unanswered",
        options: [],
      });
    },
    "answers",
  ],
  [
    "delegated question",
    (c) => {
      c.questions.push({
        id: "q",
        itemId: "q",
        index: 0,
        at: 1,
        text: "Choose?",
        title: "Choose?",
        state: "delegated",
        options: [],
      });
    },
    "answers",
  ],
  ...(["queued", "sending", "uncertain"] as const).map(
    (status) =>
      [
        `${status} child submission`,
        (c: RuntimeAgent) => {
          c.deliveries.push({
            id: "pending",
            text: "input",
            source: "worker",
            status,
            questionIds: [],
            at: 1,
          });
        },
        "delivery confirmation",
      ] as [string, (c: RuntimeAgent) => void, string],
  ),
  ...(["queued", "sending", "uncertain", "failed"] as const).map(
    (status) =>
      [
        `${status} owner report`,
        (c: RuntimeAgent, root: RuntimeAgent) => {
          root.deliveries.push({
            id: "report",
            text: "report",
            source: c.role as "worker",
            ...(c.role === "reviewer"
              ? { reportingReviewerId: c.id }
              : c.role === "researcher"
                ? { reportingResearcherId: c.id }
                : { reportingWorkerId: c.id }),
            status,
            questionIds: [],
            at: 1,
          });
        },
        status === "failed" ? "report delivery" : "unconfirmed delivery",
      ] as [string, (c: RuntimeAgent, root: RuntimeAgent) => void, string],
  ),
  [
    "unknown startup",
    (c) => {
      c.threadId = undefined;
    },
    "startup",
  ],
];
for (const [name, block, reason] of guards)
  test(`preflight refuses ${name} without releasing any member`, async () => {
    const { app, agents, owner, children, releases } = await fixture();
    // Rotate roles so guard coverage includes Reviewer and Researcher too.
    const c =
      children[guards.findIndex((g) => g[0] === name) % children.length]!;
    block(c, agents.get(owner.id)!);
    await expect(app.closeTree(owner.id)).rejects.toThrow(reason);
    expect(releases).toEqual([]);
    expect(app.snapshot().agents).toHaveLength(4);
  });

test("partial native failure retains root; ordinary retry releases only remaining members", async () => {
  const { app, runtime, owner, children, releases } = await fixture();
  let fail = true;
  runtime.closeOverride = async (id) => {
    releases.push(id);
    if (id === children[1]!.id && fail)
      throw new Error("fixture release unknown");
  };
  await expect(app.closeTree(owner.id)).rejects.toThrow(
    "reviewer fixture: Native thread release failed",
  );
  expect(releases).toEqual([children[0]!.id, children[1]!.id]);
  expect(app.snapshot().agents.map((a) => a.id)).toEqual([
    owner.id,
    children[1]!.id,
    children[2]!.id,
  ]);
  expect(runtime.listeners.has(children[0]!.id)).toBe(false);
  expect(runtime.listeners.has(children[1]!.id)).toBe(true);
  fail = false;
  await app.closeTree(owner.id);
  expect(releases).toEqual([
    children[0]!.id,
    children[1]!.id,
    children[1]!.id,
    children[2]!.id,
    owner.id,
  ]);
});

test("native release gate refuses tree mutations before admission and leaves another tree responsive", async () => {
  const { app, runtime, owner, token, children, releases } = await fixture();
  const other = await app.createOrc("beta");
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  runtime.closeOverride = async (id) => {
    releases.push(id);
    if (id === children[0]!.id) {
      entered.resolve();
      await gate.promise;
    }
  };
  const closing = app.closeTree(owner.id);
  await entered.promise;
  try {
    expect(app.snapshot().agents).toHaveLength(5);
    await expect(app.send(owner.id, "New work", "new")).rejects.toThrow(
      "closing",
    );
    await expect(
      app.answerBatch(owner.id, [{ questionId: "q", answer: "yes" }], "answer"),
    ).rejects.toThrow("closing");
    await expect(
      app.updateSettings(children[0]!.id, { model: "sol", effort: "high" }),
    ).rejects.toThrow("closing");
    await expect(app.updateTreeFast(owner.id, false)).rejects.toThrow(
      "closing",
    );
    await expect(app.rename(owner.id, "New name")).rejects.toThrow("closing");
    await expect(app.closeTree(owner.id)).rejects.toThrow("closing");
    await expect(
      app.tool(token, "worker_start", {
        project: "alpha",
        title: "New",
        spec: "#3917",
        message: "Work",
      }),
    ).rejects.toThrow("closing");
    await expect(
      app.tool(token, "worker_send", {
        workerId: children[0]!.id,
        message: "Work",
      }),
    ).rejects.toThrow("closing");
    for (const child of children)
      await expect(
        app.tool(child.token, `${child.role}_report`, {
          message: "Late report",
          ...child.reviewTarget,
          ...(child.researchQuestion
            ? { question: child.researchQuestion }
            : {}),
        }),
      ).rejects.toThrow("closing");
    await expect(
      app.tool(token, "worker_close", { workerId: children[0]!.id }),
    ).rejects.toThrow("closing");
    expect(app.detail(owner.id).deliveries).toEqual([]);
    await app.send(other.id, "Independent work", "other");
    expect(app.detail(other.id).state).toBe("working");
  } finally {
    gate.resolve();
  }
  await closing;
  expect(releases).toEqual([...children.map((c) => c.id), owner.id]);
  expect(app.snapshot().agents.map((a) => a.id)).toEqual([other.id]);
  await expect(
    app.tool(token, "worker_send", {
      workerId: children[0]!.id,
      message: "After release",
    }),
  ).rejects.toThrow("authorization");
});

for (const operation of ["settings", "start", "send"] as const)
  test(`preflight refuses an already executing ${operation} without release`, async () => {
    const { app, runtime, owner, token, children, releases } = await fixture();
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let pending: Promise<unknown>;
    if (operation === "settings") {
      runtime.settingsOverride = async () => {
        entered.resolve();
        await gate.promise;
      };
      pending = app.updateSettings(children[0]!.id, {
        model: "sol",
        effort: "high",
      });
    } else {
      runtime.sendOverride = async () => {
        entered.resolve();
        await gate.promise;
        return "gated";
      };
      pending =
        operation === "start"
          ? app.tool(token, "worker_start", {
              project: "alpha",
              title: "New",
              spec: "fixture",
              message: "Work",
            })
          : app.send(owner.id, "Work", "gated-input");
    }
    await entered.promise;
    try {
      await expect(app.closeTree(owner.id)).rejects.toThrow(
        operation === "send" ? "unconfirmed delivery" : "in-flight",
      );
      expect(releases).toEqual([]);
    } finally {
      gate.resolve();
    }
    await pending;
  });

test("native resume reveals active work before any release; disconnect never confirms closure", async () => {
  const { app, directory, owner, children } = await fixture();
  app.dispose();
  const restoredRuntime = new FakeRuntime();
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const open = restoredRuntime.open.bind(restoredRuntime);
  restoredRuntime.open = async (agent, notify) => {
    if (agent.id === children[0]!.id) {
      entered.resolve();
      await gate.promise;
      notify({ type: "working", turnId: "external" });
    }
    return open(agent, notify);
  };
  const restored = new Workspace({
    directory,
    runtime: restoredRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  const releases: string[] = [];
  restoredRuntime.closeOverride = async (id) => {
    releases.push(id);
  };
  await entered.promise;
  await expect(restored.closeTree(owner.id)).rejects.toThrow();
  gate.resolve();
  await Bun.sleep(0);
  await expect(restored.closeTree(owner.id)).rejects.toThrow("current work");
  expect(releases).toEqual([]);
  restoredRuntime.emit(children[0]!.id, {
    type: "disconnected",
    error: "fixture disconnect",
  });
  await expect(restored.closeTree(owner.id)).rejects.toThrow("outcome");
  expect(releases).toEqual([]);
});

test("restart after partial release keeps remaining identities without replaying unknown Close", async () => {
  const { app, runtime, directory, owner, children, releases } =
    await fixture();
  runtime.closeOverride = async (id) => {
    releases.push(id);
    if (id === children[1]!.id)
      throw new Error("fixture disconnected during release");
  };
  await expect(app.closeTree(owner.id)).rejects.toThrow(
    "disconnected during release",
  );
  app.dispose();
  const next = new FakeRuntime(),
    attempts: string[] = [];
  next.closeOverride = async (id) => {
    attempts.push(id);
  };
  const restored = new Workspace({
    directory,
    runtime: next,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  await Bun.sleep(0);
  expect(attempts).toEqual([]);
  expect(restored.snapshot().agents.map((a) => a.id)).toEqual([
    owner.id,
    children[1]!.id,
    children[2]!.id,
  ]);
  await restored.closeTree(owner.id);
  expect(attempts).toEqual([children[1]!.id, children[2]!.id, owner.id]);
});

test("native work arriving on an unreleased member stops cascade before root", async () => {
  const { app, runtime, owner, children, releases } = await fixture();
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  runtime.closeOverride = async (id) => {
    releases.push(id);
    entered.resolve();
    await gate.promise;
  };
  const closing = app.closeTree(owner.id);
  await entered.promise;
  runtime.emit(children[2]!.id, {
    type: "working",
    turnId: "external-arrival",
  });
  gate.resolve();
  await expect(closing).rejects.toThrow("current work");
  expect(releases).toEqual([children[0]!.id]);
  expect(app.snapshot().agents.map((a) => a.id)).toEqual([
    owner.id,
    children[1]!.id,
    children[2]!.id,
  ]);
});

test("a late root question during native release prevents tree success", async () => {
  const { app, runtime, owner, children, releases } = await fixture();
  runtime.closeOverride = async (id) => {
    releases.push(id);
    if (id === owner.id)
      runtime.emit(id, {
        type: "item",
        turnId: "late-question",
        item: {
          id: "late-question",
          type: "agentMessage",
          delivery: "async",
          questions: [{ question: "Still need a decision?" }],
        },
      });
  };
  await expect(app.closeTree(owner.id)).rejects.toThrow("unanswered questions");
  expect(releases).toEqual([...children.map((c) => c.id), owner.id]);
  expect(app.snapshot().agents.map((a) => a.id)).toEqual([owner.id]);
  expect(app.detail(owner.id).unansweredCount).toBe(1);
});

for (const arrival of ["working", "question"] as const)
  test(`native ${arrival} arriving on the releasing child retains its source and root`, async () => {
    const { app, runtime, owner, token, children, releases } = await fixture();
    const child = children[0]!;
    const threadId = child.threadId;
    const inputs = runtime.inputs.length;
    const gate = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    runtime.closeOverride = async (id) => {
      releases.push(id);
      if (id === child.id && releases.length === 1) {
        entered.resolve();
        await gate.promise;
      }
    };
    const closing = app.closeTree(owner.id);
    await entered.promise;
    try {
      runtime.emit(
        child.id,
        arrival === "working"
          ? { type: "working", turnId: "during-release" }
          : {
              type: "item",
              turnId: "during-release",
              item: {
                id: "during-release-question",
                type: "agentMessage",
                delivery: "async",
                questions: [
                  { question: "Which option?", options: [{ label: "Blue" }] },
                ],
              },
            },
      );
    } finally {
      gate.resolve();
    }
    await expect(closing).rejects.toThrow(
      arrival === "working" ? "current work" : "report delivery",
    );
    expect(releases).toEqual([child.id]);
    expect(app.snapshot().agents.map((a) => a.id)).toEqual([
      owner.id,
      ...children.map((c) => c.id),
    ]);
    expect(app.detail(child.id).threadId).toBe(threadId);
    // Native release succeeded even though Grove refused logical closure.
    expect(runtime.listeners.has(child.id)).toBe(false);
    expect(runtime.inputs).toHaveLength(inputs);
    expect(runtime.interruptions).toEqual([]);
    const reopened: string[] = [];
    const open = runtime.open.bind(runtime);
    runtime.open = async (agent, notify) => {
      reopened.push(agent.id);
      return open(agent, notify);
    };
    if (arrival === "working") {
      await expect(app.closeTree(owner.id)).rejects.toThrow("current work");
      expect(releases).toEqual([child.id]);
      await app.reconcileSettings(child.id);
      expect(runtime.inputs).toHaveLength(inputs);
      runtime.emit(child.id, {
        type: "completed",
        turnId: "during-release",
        status: "completed",
      });
      await app.closeTree(owner.id);
      expect(releases).toEqual([
        child.id,
        child.id,
        children[1]!.id,
        children[2]!.id,
        owner.id,
      ]);
    } else {
      expect(app.detail(child.id).questions[0]?.state).toBe("delegated");
      await app.tool(token, "worker_send", {
        workerId: child.id,
        message: "Blue",
        questionIds: ["during-release-question:0"],
      });
      expect(app.detail(child.id).questions[0]?.state).toBe("answered");
      expect(app.detail(child.id).threadId).toBe(threadId);
      expect(
        app
          .detail(owner.id)
          .deliveries.some(
            (d) =>
              d.id === `report:${child.id}:during-release-question` &&
              d.status === "queued",
          ),
      ).toBe(true);
      await expect(app.closeTree(owner.id)).rejects.toThrow(
        "unconfirmed delivery",
      );
      expect(releases).toEqual([child.id]);
    }
    expect(reopened).toEqual([child.id]);
  });
