import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { DeliveryRejected, StaleTurn } from "./runtime";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "flickgrove-test-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  return { app, runtime, directory };
}

test("new Orcs capture defaults and retain their own project and conversation", async () => {
  const { app } = fixture();
  const first = await app.createOrc("alpha");
  await app.saveSettings({
    fast: false,
    orc: { model: "luna", effort: "low" },
    worker: { model: "sol", effort: "high" },
  });
  const second = await app.createOrc("beta");
  await app.send(first.id, "Build a reader", "message-1");
  expect(
    app
      .snapshot()
      .agents.map((a) => ({ project: a.project.alias, model: a.model })),
  ).toEqual([
    { project: "alpha", model: "sol" },
    { project: "beta", model: "luna" },
  ]);
  expect(app.detail(first.id).messages.map((m) => m.text)).toEqual([
    "Build a reader",
  ]);
  expect(app.detail(second.id).messages).toEqual([]);
});

test("ordinary answers appear complete at turn end but async questions appear while working", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Build it", "first");
  const turnId = app.detail(a.id).turnId!;
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "final",
      type: "agentMessage",
      phase: "final_answer",
      text: "Complete answer.",
    },
  });
  expect(app.detail(a.id).messages.map((m) => m.text)).toEqual(["Build it"]);
  const question = {
    type: "item" as const,
    turnId,
    item: {
      id: "ask",
      type: "agentMessage",
      phase: "final_answer",
      delivery: "async",
      text: "Choose a color",
      questions: [
        {
          header: "Color",
          question: "Which color?",
          options: [{ label: "Blue" }, { label: "Green" }],
        },
      ],
    },
  };
  runtime.emit(a.id, question);
  runtime.emit(a.id, question);
  expect(app.detail(a.id).questions).toHaveLength(1);
  expect(app.detail(a.id).questions[0]).toMatchObject({
    text: "Which color?",
    state: "unanswered",
  });
  expect(app.detail(a.id).state).toBe("working");
  runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  expect(app.detail(a.id).messages.map((m) => m.text)).toEqual([
    "Build it",
    "Choose a color",
    "Complete answer.",
  ]);
  expect(app.detail(a.id).state).toBe("idle");
});

test("explicit answers include their question and duplicate submission never sends twice", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Build it", "first");
  const turnId = app.detail(a.id).turnId!;
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "ask",
      type: "agentMessage",
      delivery: "async",
      questions: [
        { question: "Which color?", options: [{ label: "Blue" }] },
        { question: "Which size?" },
      ],
    },
  });
  await app.answer(a.id, "ask:0", "Blue");
  await app.answer(a.id, "ask:0", "Blue");
  expect(runtime.inputs.map((i) => i.text)).toEqual([
    "Build it",
    "Question: Which color?\nAnswer: Blue",
  ]);
  expect(runtime.inputs[1].turnId).toBe(turnId);
  expect(app.detail(a.id).questions.map((q) => q.state)).toEqual([
    "answered",
    "unanswered",
  ]);
});

test("backend restart restores questions and captured models and resumes an existing thread", async () => {
  const { app, runtime: original, directory } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Continue tomorrow", "first");
  const threadId = app.detail(a.id).threadId;
  original.emit(a.id, {
    type: "item",
    turnId: app.detail(a.id).turnId!,
    item: {
      id: "persisted-question",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Continue?" }],
    },
  });
  app.dispose();
  const runtime = new FakeRuntime();
  const restarted = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restarted.dispose());
  expect(restarted.detail(a.id)).toMatchObject({
    model: "sol",
    state: "error",
    threadId,
  });
  expect(restarted.detail(a.id).questions[0]).toMatchObject({
    id: "persisted-question:0",
    state: "unanswered",
  });
  await restarted.send(a.id, "Continue now", "second");
  expect(restarted.detail(a.id).messages.map((m) => m.text)).toEqual([
    "Continue tomorrow",
    "Continue now",
  ]);
  expect(runtime.agents.get(a.id)?.threadId).toBe(threadId);
});

test("a completed turn arriving before send resolves does not leave a session working", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  runtime.sendOverride = async () => {
    runtime.emit(a.id, { type: "working", turnId: "fast" });
    runtime.emit(a.id, {
      type: "item",
      turnId: "fast",
      item: {
        id: "reply",
        type: "agentMessage",
        phase: "final_answer",
        text: "Done",
      },
    });
    runtime.emit(a.id, {
      type: "completed",
      turnId: "fast",
      status: "completed",
    });
    return "fast";
  };
  await app.send(a.id, "Start", "first");
  expect(app.detail(a.id).state).toBe("idle");
  expect(app.detail(a.id).messages.map((m) => m.text)).toEqual([
    "Start",
    "Done",
  ]);
});

test("a proven stale turn starts anew, while uncertain acceptance is never automatically retried", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Start", "first");
  runtime.sendOverride = async (_id, _text, turnId) => {
    if (turnId) throw new StaleTurn("No active turn");
    return "new-turn";
  };
  await app.send(a.id, "Follow up", "second");
  expect(app.detail(a.id).turnId).toBe("new-turn");
  runtime.sendOverride = async () => {
    throw new Error("Transport timed out");
  };
  await app.send(a.id, "Uncertain", "third");
  const count = runtime.inputs.length;
  await app.send(a.id, "Uncertain", "third");
  expect(runtime.inputs).toHaveLength(count);
  expect(app.detail(a.id).deliveries.at(-1)?.status).toBe("uncertain");
});

test("a rejected question answer can retry and does not clear other unanswered questions", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Start", "first");
  const turnId = app.detail(a.id).turnId!;
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "ask",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "One?" }, { question: "Two?" }],
    },
  });
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("Unavailable model");
  };
  await app.answer(a.id, "ask:0", "Yes");
  expect(app.detail(a.id).questions[0].state).toBe("unanswered");
  runtime.sendOverride = undefined;
  await app.answer(a.id, "ask:0", "Yes");
  expect(app.detail(a.id).questions.map((q) => q.state)).toEqual([
    "answered",
    "unanswered",
  ]);
});

test("Orc tools own their Workers while Workers can only report to their parent", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  const b = await app.createOrc("beta");
  const tokenA = runtime.agents.get(a.id)!.token;
  const tokenB = runtime.agents.get(b.id)!.token;
  expect(app.identity(tokenA).tools).toEqual([
    "worker_start",
    "worker_list",
    "worker_read",
    "worker_send",
    "worker_close",
  ]);
  const worker = (await app.tool(tokenA, "worker_start", {
    project: "beta",
    title: "Reader",
    spec: "#3109",
    message: "Implement the reader",
  })) as { id: string };
  const tokenW = runtime.agents.get(worker.id)!.token;
  expect(app.identity(tokenW).tools).toEqual(["worker_report"]);
  expect(app.detail(worker.id)).toMatchObject({
    ownerId: a.id,
    project: { alias: "beta" },
  });
  await expect(
    app.tool(tokenB, "worker_read", { workerId: worker.id }),
  ).rejects.toThrow("Worker does not belong to this Orc");
  await expect(
    app.tool(tokenW, "worker_close", { workerId: worker.id }),
  ).rejects.toThrow("not available");
  await app.tool(tokenW, "worker_report", { message: "Reader is implemented" });
  expect(app.detail(a.id).messages.at(-1)?.text).toContain(
    "Reader is implemented",
  );
  expect(app.detail(b.id).messages).toEqual([]);
  await expect(
    app.send(worker.id, "Direct instruction", "forbidden"),
  ).rejects.toThrow("through Orc");
});

test("history pages move backward and a tree closes only after Orc closes its idle Workers", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  const token = runtime.agents.get(a.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "#3109",
    message: "Implement",
  })) as { id: string };
  const turnId = app.detail(worker.id).turnId!;
  runtime.emit(worker.id, {
    type: "item",
    turnId,
    item: {
      id: "final",
      type: "agentMessage",
      phase: "final_answer",
      text: "Reader done",
    },
  });
  const page = (await app.tool(token, "worker_read", {
    workerId: worker.id,
    limit: 1,
  })) as any;
  expect(page.worker.state).toBe("working");
  await expect(app.send(a.id, "/close", "close-1")).rejects.toThrow("Worker");
  runtime.emit(worker.id, { type: "completed", turnId, status: "completed" });
  const latest = (await app.tool(token, "worker_read", {
    workerId: worker.id,
    limit: 1,
  })) as any;
  expect(latest.messages.map((m: any) => m.text)).toEqual(["Reader done"]);
  const earlier = (await app.tool(token, "worker_read", {
    workerId: worker.id,
    before: latest.nextBefore,
    limit: 1,
  })) as any;
  expect(earlier.messages[0].text).toContain("Assigned spec: #3109");
  expect(earlier.hasMore).toBe(false);
  await expect(app.send(a.id, "/close", "close-2")).rejects.toThrow("Worker");
  await app.tool(token, "worker_close", { workerId: worker.id });
  await app.send(a.id, "/close", "close-3");
  expect(app.snapshot().agents).toEqual([]);
  expect(runtime.inputs.some((i) => i.text === "/close")).toBe(false);
});

test("Worker async questions are delegated once and only explicit contextual replies resolve them", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  const token = runtime.agents.get(a.id)!.token;
  const w = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "#3109",
    message: "Implement",
  })) as { id: string };
  const turnId = app.detail(w.id).turnId!;
  const event = {
    type: "item" as const,
    turnId,
    item: {
      type: "agentMessage",
      id: "ask",
      delivery: "async",
      text: "Important context: preserve stored data.",
      questions: [{ question: "Keep old data?" }],
    },
  };
  runtime.emit(w.id, event);
  runtime.emit(w.id, event);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(app.detail(w.id).questions[0].state).toBe("delegated");
  expect(app.detail(a.id).messages).toHaveLength(1);
  expect(app.detail(a.id).messages[0].text).toContain("Keep old data?");
  expect(app.detail(a.id).messages[0].text).toContain(
    "Important context: preserve stored data.",
  );
  await app.tool(token, "worker_send", {
    workerId: w.id,
    message: "Check the spec",
  });
  expect(app.detail(w.id).questions[0].state).toBe("delegated");
  await app.tool(token, "worker_send", {
    workerId: w.id,
    message: "No migration is needed",
    questionIds: ["ask:0"],
  });
  expect(app.detail(w.id).questions[0].state).toBe("answered");
});

test("explicit reconciliation resolves an uncertain answer without replaying the message", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Start", "first");
  const turnId = app.detail(a.id).turnId!;
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "ask",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Which color?" }],
    },
  });
  runtime.sendOverride = async () => {
    throw new Error("Disconnected before confirmation");
  };
  await app.answer(a.id, "ask:0", "Blue");
  await expect(app.send(a.id, "/close", "close")).rejects.toThrow(
    "unconfirmed",
  );
  const count = runtime.inputs.length;
  const detail = await app.reconcile(a.id, "answer:ask:0", true);
  expect(detail.questions[0]).toMatchObject({
    state: "answered",
    answer: "Blue",
  });
  expect(runtime.inputs).toHaveLength(count);
  await expect(app.send(a.id, "/close", "close-2")).rejects.toThrow(
    "still working",
  );
  runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await app.send(a.id, "/close", "close-3");
  expect(app.snapshot().agents).toEqual([]);
});

test("one global Fast setting applies to new Orcs and Workers while existing sessions retain their tier", async () => {
  const { app, runtime } = fixture();
  const settings = {
    orc: { model: "sol", effort: "high" },
    worker: { model: "sol", effort: "medium" },
  };
  const first = await app.createOrc("alpha");
  await app.saveSettings({ ...settings, fast: true });
  const second = await app.createOrc("alpha");
  expect(app.detail(first.id).serviceTier).toBe("default");
  expect(app.detail(second.id).serviceTier).toBe("priority");
  const token = runtime.agents.get(second.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "beta",
    title: "Reader",
    spec: "fixture",
    message: "Implement",
  })) as { id: string };
  expect(app.detail(worker.id).serviceTier).toBe("priority");
  await app.saveSettings({ ...settings, fast: false });
  expect(app.detail(second.id).serviceTier).toBe("priority");
  expect(app.detail(worker.id).serviceTier).toBe("priority");
  const third = await app.createOrc("alpha");
  expect(app.detail(third.id).serviceTier).toBe("default");
  await expect(
    app.saveSettings({
      ...settings,
      fast: true,
      orc: { model: "luna", effort: "low" },
    }),
  ).rejects.toThrow("Fast is not available");
});

test("a rejected steer preserves the active turn and prevents premature closing", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Begin", "first");
  const { turnId, workingSince } = app.detail(a.id);
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("Rejected steer");
  };
  await app.send(a.id, "Follow up", "second");
  expect(app.detail(a.id)).toMatchObject({
    state: "working",
    turnId,
    workingSince,
  });
  expect(app.detail(a.id).deliveries.at(-1)?.status).toBe("failed");
  await expect(app.send(a.id, "/close", "close")).rejects.toThrow(
    "still working",
  );
  runtime.emit(a.id, {
    type: "completed",
    turnId: turnId!,
    status: "completed",
  });
  await app.send(a.id, "/close", "close-after-completion");
  expect(app.snapshot().agents).toHaveLength(0);
});

test("a stale steer retries against the current active turn instead of starting another", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Begin", "first");
  runtime.sendOverride = async (_id, _text, turnId) => {
    if (turnId !== "current-turn")
      throw new StaleTurn("Expected old but found current", "current-turn");
    return turnId;
  };
  await app.send(a.id, "Follow up", "second");
  expect(runtime.inputs.at(-1)?.turnId).toBe("current-turn");
  expect(app.detail(a.id).deliveries.at(-1)?.status).toBe("sent");
  expect(app.detail(a.id).turnId).toBe("current-turn");
});

test("queued Worker reports survive restart and block closure until explicitly reconciled", async () => {
  const { app, runtime, directory } = fixture();
  const a = await app.createOrc("alpha");
  const token = runtime.agents.get(a.id)!.token;
  const w = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "fixture",
    message: "Implement",
  })) as { id: string };
  const workerToken = runtime.agents.get(w.id)!.token;
  runtime.emit(w.id, {
    type: "completed",
    turnId: app.detail(w.id).turnId!,
    status: "completed",
  });
  const held = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  runtime.sendOverride = async () => {
    started.resolve();
    return held.promise;
  };
  const blocker = app.send(a.id, "Hold owner queue", "hold");
  await started.promise;
  const report = app.tool(workerToken, "worker_report", {
    message: "Durable completion report",
  });
  expect(app.detail(a.id).deliveries.at(-1)).toMatchObject({
    status: "queued",
    reportingWorkerId: w.id,
  });
  await expect(
    app.tool(token, "worker_close", { workerId: w.id }),
  ).rejects.toThrow("undelivered report");
  app.dispose();
  const resumedRuntime = new FakeRuntime();
  const restarted = new Workspace({
    directory,
    runtime: resumedRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restarted.dispose());
  await restarted.send(a.id, "Resume explicitly", "resume");
  const resumedToken = resumedRuntime.agents.get(a.id)!.token;
  const d = restarted
    .detail(a.id)
    .deliveries.find((d) => d.reportingWorkerId === w.id)!;
  expect(d.status).toBe("uncertain");
  expect(d.text).toContain("Durable completion report");
  expect(resumedRuntime.inputs.map((i) => i.text)).toEqual([
    "Resume explicitly",
  ]);
  await expect(
    restarted.tool(resumedToken, "worker_close", { workerId: w.id }),
  ).rejects.toThrow("undelivered report");
  await restarted.reconcile(a.id, d.id, true);
  await restarted.tool(resumedToken, "worker_close", { workerId: w.id });
  held.resolve("held-turn");
  await blocker;
  await expect(report).rejects.toThrow("Workspace is stopped");
});

test("a rejected Worker report blocks closing its sender and can retry the persisted envelope", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  const token = runtime.agents.get(a.id)!.token;
  const w = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "fixture",
    message: "Implement",
  })) as { id: string };
  runtime.emit(w.id, {
    type: "completed",
    turnId: app.detail(w.id).turnId!,
    status: "completed",
  });
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("Rejected report");
  };
  await app.tool(runtime.agents.get(w.id)!.token, "worker_report", {
    message: "Report contents",
  });
  const d = app.detail(a.id).deliveries.at(-1)!;
  expect(d.status).toBe("failed");
  await expect(
    app.tool(token, "worker_close", { workerId: w.id }),
  ).rejects.toThrow("undelivered report");
  runtime.sendOverride = undefined;
  await app.send(a.id, "Attempted replacement", d.id);
  expect(runtime.inputs.at(-1)?.text).toBe(d.text);
  await app.tool(token, "worker_close", { workerId: w.id });
});

test("queued async-question forwarding is durable before the owner queue runs", async () => {
  const { app, runtime, directory } = fixture();
  const a = await app.createOrc("alpha");
  const w = (await app.tool(runtime.agents.get(a.id)!.token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "fixture",
    message: "Implement",
  })) as { id: string };
  const held = Promise.withResolvers<string>();
  const started = Promise.withResolvers<void>();
  runtime.sendOverride = async () => {
    started.resolve();
    return held.promise;
  };
  const blocker = app.send(a.id, "Hold queue", "hold");
  await started.promise;
  runtime.emit(w.id, {
    type: "item",
    turnId: app.detail(w.id).turnId!,
    item: {
      id: "ask-queued",
      type: "agentMessage",
      delivery: "async",
      text: "Required context",
      questions: [{ question: "Proceed?" }],
    },
  });
  expect(app.detail(a.id).deliveries.at(-1)?.status).toBe("queued");
  app.dispose();
  const restarted = new Workspace({
    directory,
    runtime: new FakeRuntime(),
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restarted.dispose());
  expect(restarted.detail(w.id).questions[0].state).toBe("delegated");
  expect(restarted.detail(a.id).deliveries.at(-1)).toMatchObject({
    status: "uncertain",
    reportingWorkerId: w.id,
  });
  expect(restarted.detail(a.id).deliveries.at(-1)?.text).toContain(
    "Required context",
  );
  held.resolve("held-turn");
  await blocker;
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("an oversized Worker report envelope is rejected before queue persistence", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  const token = runtime.agents.get(a.id)!.token;
  const w = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "fixture",
    message: "Implement",
  })) as { id: string };
  runtime.emit(w.id, {
    type: "completed",
    turnId: app.detail(w.id).turnId!,
    status: "completed",
  });
  await expect(
    app.tool(runtime.agents.get(w.id)!.token, "worker_report", {
      message: "x".repeat(100_000),
    }),
  ).rejects.toThrow("including the Worker report header");
  expect(app.detail(a.id).deliveries).toHaveLength(0);
  await app.tool(token, "worker_close", { workerId: w.id });
});
