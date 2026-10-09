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
  const second = await app.createOrc("beta", {
    fast: false,
    orc: { model: "luna", effort: "low" },
    worker: { model: "sol", effort: "high" },
  });
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
  await app.answerBatch(
    a.id,
    [{ questionId: "ask:0", answer: "Blue" }],
    "answer-blue",
  );
  await app.answerBatch(
    a.id,
    [{ questionId: "ask:0", answer: "Blue" }],
    "answer-blue",
  );
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
  await app.answerBatch(
    a.id,
    [{ questionId: "ask:0", answer: "Yes" }],
    "answer-yes",
  );
  expect(app.detail(a.id).questions[0].state).toBe("unanswered");
  runtime.sendOverride = undefined;
  await app.answerBatch(
    a.id,
    [{ questionId: "ask:0", answer: "Yes" }],
    "answer-yes",
  );
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
    "researcher_start",
    "researcher_list",
    "researcher_read",
    "researcher_send",
    "researcher_close",
    "worker_start",
    "worker_list",
    "worker_read",
    "worker_send",
    "worker_close",
    "reviewer_start",
    "reviewer_list",
    "reviewer_read",
    "reviewer_send",
    "reviewer_close",
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
  await expect(app.closeTree(a.id)).rejects.toThrow("Worker");
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
  await expect(app.closeTree(a.id)).rejects.toThrow("Worker");
  await app.tool(token, "worker_close", { workerId: worker.id });
  await app.closeTree(a.id);
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

test("lookup retains an uncertain answer without replaying or inventing native acceptance", async () => {
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
  await app.answerBatch(
    a.id,
    [{ questionId: "ask:0", answer: "Blue" }],
    "answer-blue",
  );
  await expect(app.closeTree(a.id)).rejects.toThrow("unconfirmed");
  const count = runtime.inputs.length;
  expect(app.lookup(a.id, "answer-blue")).toBeNull();
  expect(app.detail(a.id).questions[0].state).toBe("unanswered");
  expect(runtime.inputs).toHaveLength(count);
  runtime.emit(a.id, { type: "completed", turnId, status: "completed" });
  await expect(app.closeTree(a.id)).rejects.toThrow("unconfirmed");
});

test("each tree captures independent Orc and Worker settings while other trees cannot change its tier", async () => {
  const { app, runtime } = fixture();
  const settings = {
    orc: { model: "sol", effort: "high" },
    worker: { model: "sol", effort: "medium" },
  };
  const first = await app.createOrc("alpha");
  const second = await app.createOrc("alpha", { ...settings, fast: true });
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
  await app.createOrc("alpha", { ...settings, fast: false });
  expect(app.detail(second.id).serviceTier).toBe("priority");
  expect(app.detail(worker.id).serviceTier).toBe("priority");
  const third = await app.createOrc("alpha");
  expect(app.detail(third.id).serviceTier).toBe("default");
  await expect(
    app.createOrc("alpha", {
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
  await expect(app.closeTree(a.id)).rejects.toThrow("still working");
  runtime.emit(a.id, {
    type: "completed",
    turnId: turnId!,
    status: "completed",
  });
  await app.closeTree(a.id);
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

test("queued Worker reports survive restart and unknown delivery keeps closure blocked", async () => {
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
  ).resolves.toMatchObject({
    closed: false,
    closing: true,
    reason: expect.stringContaining("report delivery"),
  });
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
  ).resolves.toMatchObject({
    closed: false,
    closing: true,
    reason: expect.stringContaining("report delivery"),
  });
  expect(restarted.lookup(a.id, d.id)).toBeNull();
  expect(restarted.snapshot().agents.some((a) => a.id === w.id)).toBe(true);
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
  ).resolves.toMatchObject({
    closed: false,
    closing: true,
    reason: expect.stringContaining("report delivery"),
  });
  runtime.sendOverride = undefined;
  await expect(app.send(a.id, "Attempted replacement", d.id)).rejects.toThrow(
    "bound",
  );
  await app.retryDelivery(a.id, d.id);
  expect(runtime.inputs.at(-1)?.text).toBe(d.text);
  await untilClosed(app, w.id);
  expect(app.snapshot().agents.some((a) => a.id === w.id)).toBe(false);
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
  ).rejects.toThrow("including the report header");
  expect(app.detail(a.id).deliveries).toHaveLength(0);
  await app.tool(token, "worker_close", { workerId: w.id });
});

test("stop targets only the observed Orc turn, waits for authoritative interruption and leaves Workers open", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  const token = runtime.agents.get(orc.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Worker",
    spec: "fixture",
    message: "Work",
  })) as { id: string };
  await app.send(orc.id, "Work", "work");
  const turnId = app.detail(orc.id).turnId!;
  const stopped = await app.stop(orc.id, turnId);
  expect(stopped.state).toBe("stopping");
  expect(stopped.stop?.status).toBe("pending");
  expect(
    (await app.send(orc.id, "Do more", "more")).deliveries.find(
      (d) => d.id === "more",
    )?.status,
  ).toBe("failed");
  await expect(app.closeTree(orc.id)).rejects.toThrow(
    "Workers, Reviewers and Researchers first",
  );
  runtime.emit(orc.id, { type: "completed", turnId, status: "interrupted" });
  expect(app.detail(orc.id).state).toBe("idle");
  expect(app.detail(orc.id).stop?.status).toBe("confirmed");
  expect(app.detail(worker.id).state).toBe("working");
  expect(runtime.interruptions).toEqual([{ agentId: orc.id, turnId }]);
  await app.send(orc.id, "Next", "next");
  await expect(app.stop(orc.id, turnId)).rejects.toThrow("no longer");
  expect(runtime.interruptions).toHaveLength(1);
});
test("normal completion wins the stop race and disconnected interruption remains unknown", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  await app.send(orc.id, "Work", "work");
  const turnId = app.detail(orc.id).turnId!;
  runtime.interruptOverride = async () => {
    runtime.emit(orc.id, { type: "completed", turnId, status: "completed" });
  };
  expect((await app.stop(orc.id, turnId)).stop?.status).toBe("completed");
  await app.send(orc.id, "Next", "next");
  const next = app.detail(orc.id).turnId!;
  runtime.interruptOverride = async () => {
    runtime.emit(orc.id, { type: "disconnected", error: "fixture disconnect" });
    throw new Error("fixture timeout");
  };
  const unknown = await app.stop(orc.id, next);
  expect(unknown.stop?.status).toBe("unknown");
  expect(unknown.state).toBe("error");
  await expect(app.stop(orc.id, next)).rejects.toThrow();
  expect(runtime.interruptions).toHaveLength(2);
  await expect(app.closeTree(orc.id)).rejects.toThrow("still working");
});
test("a report during Stopping is retained for explicit retry and cannot make closing pass", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  const token = runtime.agents.get(orc.id)!.token;
  const worker = (await app.tool(token, "worker_start", {
    project: "alpha",
    title: "Worker",
    spec: "fixture",
    message: "Work",
  })) as { id: string };
  await app.send(orc.id, "Work", "work");
  const turnId = app.detail(orc.id).turnId!;
  await app.stop(orc.id, turnId);
  await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
    message: "Report retained",
  });
  const report = app
    .detail(orc.id)
    .deliveries.find((d) => d.source === "worker")!;
  expect(report.status).toBe("failed");
  expect(report.text).toContain("Report retained");
  runtime.emit(orc.id, { type: "completed", turnId, status: "interrupted" });
  runtime.emit(worker.id, {
    type: "completed",
    turnId: app.detail(worker.id).turnId!,
    status: "completed",
  });
  await expect(
    app.tool(token, "worker_close", { workerId: worker.id }),
  ).resolves.toMatchObject({
    closed: false,
    closing: true,
    reason: expect.stringContaining("report delivery"),
  });
  await app.retryDelivery(orc.id, report.id);
  expect(
    app.detail(orc.id).deliveries.find((d) => d.id === report.id)?.status,
  ).toBe("sent");
});

test("backend restart keeps a requested stop unknown and cannot replay it against a resumed turn", async () => {
  const { app, runtime, directory } = fixture();
  const orc = await app.createOrc("alpha");
  await app.send(orc.id, "Work", "work");
  const turnId = app.detail(orc.id).turnId!;
  await app.stop(orc.id, turnId);
  app.dispose();
  const nextRuntime = new FakeRuntime();
  nextRuntime.sendOverride = async () => "resumed-turn";
  const restarted = new Workspace({
    directory,
    runtime: nextRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restarted.dispose());
  expect(restarted.detail(orc.id).stop?.status).toBe("unknown");
  await expect(restarted.stop(orc.id, turnId)).rejects.toThrow();
  await restarted.send(orc.id, "Explicit next turn", "next");
  expect(restarted.detail(orc.id).stop).toBeUndefined();
  expect(nextRuntime.interruptions).toHaveLength(0);
  expect(runtime.interruptions).toHaveLength(1);
});

test("a late failed stop response cannot affect a new explicitly resumed turn", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  await app.send(orc.id, "Work", "work");
  const observed = app.detail(orc.id).turnId!;
  const release = Promise.withResolvers<void>();
  runtime.interruptOverride = async () => {
    await release.promise;
    throw new Error("old request timed out");
  };
  const stop = app.stop(orc.id, observed);
  runtime.emit(orc.id, { type: "disconnected", error: "lost old connection" });
  runtime.sendOverride = async () => "explicit-new-turn";
  await app.send(orc.id, "Explicit resume", "new");
  release.resolve();
  expect((await stop).turnId).toBe("explicit-new-turn");
  expect(app.detail(orc.id).state).toBe("working");
  expect(app.detail(orc.id).stop).toBeUndefined();
  expect(runtime.interruptions).toEqual([
    { agentId: orc.id, turnId: observed },
  ]);
});

test.each(["pending", "unknown"] as const)(
  "an in-flight stale steer retains %s Stop until authoritative completion",
  async (status) => {
    const { app, runtime } = fixture();
    const orc = await app.createOrc("alpha");
    await app.send(orc.id, "Work", "work");
    const observed = app.detail(orc.id).turnId!;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let sends = 0;
    runtime.sendOverride = async () => {
      sends++;
      started.resolve();
      await release.promise;
      throw new StaleTurn("observed steer rejected");
    };
    const delivery = app.send(orc.id, "Steer retained", "steer");
    await started.promise;
    if (status === "unknown")
      runtime.interruptOverride = async () => {
        throw new Error("fixture timeout");
      };
    await app.stop(orc.id, observed);
    release.resolve();
    await delivery;
    const stopped = app.detail(orc.id);
    expect(sends).toBe(1);
    expect(stopped.state).toBe("stopping");
    expect(stopped.turnId).toBe(observed);
    expect(stopped.stop).toEqual({ turnId: observed, status });
    expect(stopped.deliveries.find((d) => d.id === "steer")?.status).toBe(
      "failed",
    );
    runtime.emit(orc.id, {
      type: "completed",
      turnId: observed,
      status: "interrupted",
    });
    runtime.sendOverride = async () => "explicit-retry";
    await app.send(orc.id, "Steer retained", "steer");
    expect(app.lookup(orc.id, "steer")?.state).toBe("rejected");
    await app.send(orc.id, "Steer retained", "steer-retry");
    expect(
      app.detail(orc.id).deliveries.find((d) => d.id === "steer-retry")?.status,
    ).toBe("sent");
    expect(app.detail(orc.id).turnId).toBe("explicit-retry");
  },
);

async function workerFixture() {
  const f = fixture();
  const owner = await f.app.createOrc("alpha");
  const token = f.runtime.agents.get(owner.id)!.token;
  const worker = (await f.app.tool(token, "worker_start", {
    project: "alpha",
    title: "Reader",
    spec: "fixture",
    message: "Implement",
  })) as { id: string };
  return { ...f, owner, token, worker };
}

test("Worker close waits for the observed turn, rejects new work, and keeps reports before automatic closure", async () => {
  const { app, runtime, owner, token, worker } = await workerFixture();
  const turnId = app.detail(worker.id).turnId!;
  const request = { workerId: worker.id };
  expect(await app.tool(token, "worker_close", request)).toMatchObject({
    closed: false,
    closing: true,
  });
  expect(await app.tool(token, "worker_close", request)).toMatchObject({
    closed: false,
    closing: true,
  });
  await expect(
    app.tool(token, "worker_send", { ...request, message: "New task" }),
  ).rejects.toThrow("awaiting closure");
  await expect(app.closeTree(owner.id)).rejects.toThrow("Worker");
  runtime.emit(worker.id, {
    type: "completed",
    turnId: "stale-turn",
    status: "completed",
  });
  expect(app.detail(worker.id).state).toBe("working");
  await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
    message: "Implementation failed with diagnostic details",
  });
  runtime.emit(worker.id, {
    type: "item",
    turnId,
    item: {
      id: "final",
      type: "agentMessage",
      phase: "final_answer",
      text: "Failure details",
    },
  });
  runtime.emit(worker.id, {
    type: "completed",
    turnId,
    status: "failed",
    error: "Compilation failed",
  });
  await untilClosed(app, worker.id);
  expect(app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
  expect(runtime.listeners.has(worker.id)).toBe(false);
  expect(runtime.interruptions).toHaveLength(0);
  expect(
    app
      .detail(owner.id)
      .messages.some((m) => m.text.includes("Implementation failed")),
  ).toBe(true);
  expect(
    app
      .detail(owner.id)
      .deliveries.find((d) => d.reportingWorkerId === worker.id)?.status,
  ).toBe("sent");
});

test("Worker closure waits for a send acknowledgement even when completion arrives first", async () => {
  const { app, runtime, token, worker } = await workerFixture();
  const turnId = app.detail(worker.id).turnId!;
  const started = Promise.withResolvers<void>();
  const held = Promise.withResolvers<string>();
  runtime.sendOverride = async () => {
    started.resolve();
    return held.promise;
  };
  const send = app.tool(token, "worker_send", {
    workerId: worker.id,
    message: "Finish current implementation",
  });
  await started.promise;
  await app.tool(token, "worker_close", { workerId: worker.id });
  runtime.emit(worker.id, { type: "completed", turnId, status: "completed" });
  expect(app.detail(worker.id).closeRequest?.reason).toContain("in-flight");
  held.resolve(turnId);
  await send;
  await Promise.resolve();
  await untilClosed(app, worker.id);
  expect(app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
});

test("pending closure allows only contextual answers and waits for the answer turn", async () => {
  const { app, runtime, token, worker } = await workerFixture();
  const turnId = app.detail(worker.id).turnId!;
  runtime.emit(worker.id, {
    type: "item",
    turnId,
    item: {
      id: "decision",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Which format?" }],
    },
  });
  await app.tool(token, "worker_close", { workerId: worker.id });
  runtime.emit(worker.id, { type: "completed", turnId, status: "completed" });
  await app.send(
    app.detail(worker.id).ownerId!,
    "Review pending decision",
    "review-decision",
  );
  expect(app.detail(worker.id).closeRequest?.reason).toContain("answers");
  await expect(
    app.tool(token, "worker_send", {
      workerId: worker.id,
      message: "Unrelated task",
      questionIds: ["unknown"],
    }),
  ).rejects.toThrow("Delegated question");
  const questionId = app.detail(worker.id).questions[0].id;
  await app.tool(token, "worker_send", {
    workerId: worker.id,
    message: "Use Markdown",
    questionIds: [questionId],
  });
  expect(app.detail(worker.id).questions[0].state).toBe("answered");
  expect(app.detail(worker.id).state).toBe("working");
  runtime.emit(worker.id, {
    type: "completed",
    turnId: app.detail(worker.id).turnId!,
    status: "completed",
  });
  await untilClosed(app, worker.id);
  expect(app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
});

test("restart retains pending closure without pretending an interrupted turn completed", async () => {
  const { app, runtime, directory, owner, token, worker } =
    await workerFixture();
  await app.tool(token, "worker_close", { workerId: worker.id });
  await expect(
    app.tool(token, "worker_close", {
      workerId: worker.id,
      confirmInterrupted: true,
    }),
  ).rejects.toThrow("interrupted owned agent");
  runtime.emit(worker.id, {
    type: "error",
    turnId: app.detail(worker.id).turnId!,
    willRetry: false,
    error: "Turn outcome not received",
  });
  app.dispose();
  const resumedRuntime = new FakeRuntime();
  const restarted = new Workspace({
    directory,
    runtime: resumedRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restarted.dispose());
  expect(restarted.detail(worker.id)).toMatchObject({
    state: "error",
    closeRequest: {
      reason: expect.stringContaining("unconfirmed"),
    },
  });
  expect(resumedRuntime.inputs).toHaveLength(0);
  await restarted.send(owner.id, "Inspect interrupted Worker", "inspect");
  const resumedToken = resumedRuntime.agents.get(owner.id)!.token;
  expect(
    await restarted.tool(resumedToken, "worker_close", { workerId: worker.id }),
  ).toMatchObject({ closing: true });
  expect(
    await restarted.tool(resumedToken, "worker_close", {
      workerId: worker.id,
      confirmInterrupted: true,
    }),
  ).toMatchObject({ closed: true, closing: false });
  expect(restarted.snapshot().agents.some((a) => a.id === worker.id)).toBe(
    false,
  );
});

test.each([false, true])(
  "authoritative failed completion closes a Worker even when requested afterward or preceded by error (%s)",
  async (requestAfterCompletion) => {
    const { app, runtime, owner, token, worker } = await workerFixture();
    const turnId = app.detail(worker.id).turnId!;
    await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
      message: "Final failure diagnosis",
    });
    if (!requestAfterCompletion)
      await app.tool(token, "worker_close", { workerId: worker.id });
    runtime.emit(worker.id, {
      type: "error",
      turnId,
      willRetry: false,
      error: "Compilation failed",
    });
    expect(app.detail(worker.id).turnId).toBe(turnId);
    runtime.emit(worker.id, {
      type: "completed",
      turnId,
      status: "failed",
      error: "Compilation failed",
    });
    if (requestAfterCompletion) {
      expect(
        await app.tool(token, "worker_close", { workerId: worker.id }),
      ).toMatchObject({ closed: true });
    }
    await untilClosed(app, worker.id);
    expect(app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
    expect(
      app
        .detail(owner.id)
        .messages.some((m) => m.text.includes("Final failure diagnosis")),
    ).toBe(true);
  },
);

test("Orc title edits update the runtime name, survive restart and never send a model message", async () => {
  const { app, runtime, directory, owner, worker } = await workerFixture();
  const inputs = runtime.inputs.length;
  expect((await app.rename(owner.id, "  Reader implementation  ")).title).toBe(
    "Reader implementation",
  );
  expect(runtime.inputs).toHaveLength(inputs);
  expect(runtime.names.get(app.detail(owner.id).threadId!)).toBe(
    "Reader implementation",
  );
  runtime.renameOverride = async () => {
    throw new Error("Codex rename rejected");
  };
  await expect(app.rename(owner.id, "Rejected title")).rejects.toThrow(
    "Codex rename rejected",
  );
  expect(app.detail(owner.id).title).toBe("Reader implementation");
  runtime.renameOverride = undefined;
  await expect(app.rename(owner.id, " ")).rejects.toThrow();
  await expect(app.rename(owner.id, "x".repeat(121))).rejects.toThrow();
  await expect(app.rename(worker.id, "Rename Worker")).rejects.toThrow(
    "Only Orc",
  );
  app.dispose();
  const restarted = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restarted.dispose());
  await Bun.sleep(0);
  expect(restarted.detail(owner.id).title).toBe("Reader implementation");
  expect(restarted.detail(owner.id).messages).toHaveLength(0);
});

test("restart reads canonical Orc names without resuming turns and preserves cache on read failure", async () => {
  const { app, runtime, directory, owner, worker } = await workerFixture();
  const threadId = app.detail(owner.id).threadId!;
  await app.rename(owner.id, "Cached name");
  runtime.names.set(threadId, "Renamed in Codex");
  app.dispose();
  const restored = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  const inputCount = runtime.inputs.length;
  const open = runtime.open.bind(runtime);
  let resumes = 0;
  runtime.open = async (...args) => {
    resumes++;
    return open(...args);
  };
  await Bun.sleep(0);
  expect(restored.detail(owner.id).title).toBe("Renamed in Codex");
  expect(restored.detail(worker.id).title).toBe("Reader");
  expect(runtime.inputs).toHaveLength(inputCount);
  expect(resumes).toBe(2); // Original Orc and Worker settings reconcile without sending a turn.
  restored.dispose();
  runtime.readTitle = async () => {
    throw new Error("offline");
  };
  const offline = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => offline.dispose());
  await Bun.sleep(0);
  expect(offline.detail(owner.id).title).toBe("Renamed in Codex");
  expect(offline.detail(owner.id).state).toBe("idle");
});

test("resuming an Orc refreshes its cached name but Worker task titles stay local", async () => {
  const { app, runtime, directory, owner, worker } = await workerFixture();
  await app.rename(owner.id, "Initial name");
  app.dispose();
  const restored = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  await Bun.sleep(0);
  runtime.names.set(restored.detail(owner.id).threadId!, "External name");
  runtime.names.set(restored.detail(worker.id).threadId!, "Codex Worker name");
  runtime.emit(owner.id, {
    type: "disconnected",
    error: "fixture disconnect before resume",
  });
  runtime.emit(worker.id, {
    type: "disconnected",
    error: "fixture disconnect before resume",
  });
  await restored.send(owner.id, "Resume explicitly", "resume-name");
  expect(restored.detail(owner.id).title).toBe("External name");
  await restored.tool(runtime.agents.get(owner.id)!.token, "worker_send", {
    workerId: worker.id,
    message: "Resume Worker",
  });
  expect(restored.detail(worker.id).title).toBe("Reader");
});

test("a rejected rename after disconnect preserves the visible and persisted title", async () => {
  const { app, runtime, directory } = fixture();
  const owner = await app.createOrc("alpha");
  await app.rename(owner.id, "Old visible name");
  runtime.emit(owner.id, { type: "disconnected", error: "Connection lost" });
  runtime.names.set(app.detail(owner.id).threadId!, "External canonical name");
  runtime.renameOverride = async () => {
    throw new Error("Rename rejected");
  };
  await expect(app.rename(owner.id, "Requested name")).rejects.toThrow(
    "Rename rejected",
  );
  expect(app.detail(owner.id).title).toBe("Old visible name");
  expect(runtime.inputs).toHaveLength(0);
  app.dispose();
  runtime.readTitle = async () => {
    throw new Error("Offline");
  };
  const restored = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  await Bun.sleep(0);
  expect(restored.detail(owner.id).title).toBe("Old visible name");
});

test("slash text is ordinary message content, with no Close or Stop command dispatch", async () => {
  const { app, runtime } = fixture();
  const orc = await app.createOrc("alpha");
  await app.send(orc.id, "/stop", "literal-stop");
  await app.send(orc.id, "/close", "literal-close");
  expect(runtime.inputs.map((i) => i.text)).toEqual(["/stop", "/close"]);
  expect(runtime.interruptions).toHaveLength(0);
  expect(app.snapshot().agents.some((a) => a.id === orc.id)).toBe(true);
});

test("failed native release keeps Orc and automatic Worker closure visible and retryable", async () => {
  const { app, runtime, token, worker } = await workerFixture();
  const other = await app.createOrc("beta");
  const attempts: string[] = [];
  const failed = new Set([other.id, worker.id]);
  runtime.closeOverride = async (id) => {
    attempts.push(id);
    if (failed.has(id)) throw new Error("fixture unsubscribe timeout");
  };
  await expect(app.closeTree(other.id)).rejects.toThrow("unsubscribe timeout");
  expect(app.snapshot().agents.some((a) => a.id === other.id)).toBe(true);
  expect(runtime.listeners.has(other.id)).toBe(true);
  await app.tool(token, "worker_close", { workerId: worker.id });
  runtime.emit(worker.id, {
    type: "completed",
    turnId: app.detail(worker.id).turnId!,
    status: "completed",
  });
  await Bun.sleep(0);
  expect(app.snapshot().agents.some((a) => a.id === worker.id)).toBe(true);
  expect(app.detail(worker.id).closeRequest?.reason).toContain(
    "unsubscribe timeout",
  );
  expect(runtime.listeners.has(worker.id)).toBe(true);
  await app.send(other.id, "Other thread remains usable", "other-once");
  expect(attempts.filter((id) => id === worker.id)).toHaveLength(1);
  runtime.emit(other.id, {
    type: "completed",
    turnId: app.detail(other.id).turnId!,
    status: "completed",
  });
  failed.clear();
  expect(
    await app.tool(token, "worker_close", { workerId: worker.id }),
  ).toMatchObject({ closed: true });
  await app.closeTree(other.id);
  expect(runtime.listeners.has(worker.id)).toBe(false);
  expect(runtime.listeners.has(other.id)).toBe(false);
  expect(runtime.inputs.filter((i) => i.agentId === other.id)).toHaveLength(1);
});

async function untilClosed(app: Workspace, id: string) {
  const deadline = Date.now() + 1000;
  while (app.snapshot().agents.some((a) => a.id === id)) {
    if (Date.now() > deadline) throw new Error("Native close did not settle");
    await Bun.sleep(5);
  }
}

test("one immutable answer batch sends once, confirms original IDs, excludes new questions and validates before delivery", async () => {
  const { app, runtime, directory } = fixture();
  const a = await app.createOrc("alpha");
  const other = await app.createOrc("alpha");
  await app.send(a.id, "Start", "first");
  const turnId = app.detail(a.id).turnId!;
  const ask = (id: string, count: number) =>
    runtime.emit(a.id, {
      type: "item",
      turnId,
      item: {
        id,
        type: "agentMessage",
        delivery: "async",
        questions: Array.from({ length: count }, (_, i) => ({
          question: `${id} ${i}`,
        })),
      },
    });
  ask("original", 2);
  const answers = [
    { questionId: "original:0", answer: "One" },
    { questionId: "original:1", answer: "Two" },
  ];
  for (const invalid of [
    [],
    [answers[0], answers[0]],
    [answers[0], { questionId: "wrong", answer: "No" }],
    [answers[0], { ...answers[1], answer: " " }],
  ])
    await expect(app.answerBatch(a.id, invalid, "invalid")).rejects.toThrow();
  await expect(app.answerBatch(other.id, answers, "foreign")).rejects.toThrow();
  expect(runtime.inputs).toHaveLength(1);
  const gate = Promise.withResolvers<void>();
  runtime.sendOverride = async () => {
    await gate.promise;
    return turnId;
  };
  const submit = app.answerBatch(a.id, answers, "batch-one");
  await Bun.sleep(10);
  const pending = app
    .detail(a.id)
    .deliveries.find((d) => d.id === "batch-one")!;
  expect(pending.status).toBe("sending");
  expect(pending.answers).toEqual(answers);
  expect(pending.questionIds).toEqual(["original:0", "original:1"]);
  expect(
    app.detail(a.id).questions.every((q) => q.state === "unanswered"),
  ).toBe(true);
  ask("later", 1);
  gate.resolve();
  await submit;
  expect(runtime.inputs).toHaveLength(2);
  expect(runtime.inputs[1].text).toBe(
    "Question: original 0\nAnswer: One\n\nQuestion: original 1\nAnswer: Two",
  );
  expect(
    app.detail(a.id).questions.map((q) => [q.id, q.state, q.answer]),
  ).toEqual([
    ["original:0", "answered", "One"],
    ["original:1", "answered", "Two"],
    ["later:0", "unanswered", undefined],
  ]);
  await app.answerBatch(a.id, answers, "batch-one");
  await expect(
    app.answerBatch(
      a.id,
      [{ ...answers[0], answer: "Changed" }, answers[1]],
      "batch-one",
    ),
  ).rejects.toThrow("different content");
  expect(app.lookup(a.id, "batch-one")?.state).toBe("accepted");
  expect(runtime.inputs).toHaveLength(2);
  app.dispose();
  const resumedRuntime = new FakeRuntime();
  const restored = new Workspace({
    directory,
    runtime: resumedRuntime,
    projects: async () => fixtureProjects,
  });
  cleanups.push(() => restored.dispose());
  expect(restored.lookup(a.id, "batch-one")?.state).toBe("accepted");
  await restored.answerBatch(a.id, answers, "batch-one");
  expect(resumedRuntime.inputs).toHaveLength(0);
});

test("rejected batch retries its persisted answers; unknown batch lookup and duplicate never resend", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Start", "first");
  const turnId = app.detail(a.id).turnId!;
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "batch",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "First?" }, { question: "Second?" }],
    },
  });
  const answers = [
    { questionId: "batch:0", answer: "Yes" },
    { questionId: "batch:1", answer: "No" },
  ];
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("Synthetic rejection");
  };
  await app.answerBatch(a.id, answers, "rejected-batch");
  expect(app.lookup(a.id, "rejected-batch")?.state).toBe("rejected");
  expect(
    app
      .detail(a.id)
      .questions.every((q) => q.state === "unanswered" && !q.answer),
  ).toBe(true);
  runtime.sendOverride = undefined;
  await app.retryDelivery(a.id, "rejected-batch");
  expect(app.detail(a.id).questions.map((q) => q.answer)).toEqual([
    "Yes",
    "No",
  ]);
  expect(runtime.inputs).toHaveLength(3);
  await expect(
    app.answerBatch(a.id, answers, "already-answered"),
  ).rejects.toThrow("remain unanswered");
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "next",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Third?" }],
    },
  });
  const next = [{ questionId: "next:0", answer: "Unknown" }];
  runtime.sendOverride = async () => {
    throw new Error("Synthetic unknown acceptance");
  };
  await app.answerBatch(a.id, next, "unknown-batch");
  const count = runtime.inputs.length;
  await app.answerBatch(a.id, next, "unknown-batch");
  await expect(app.answerBatch(a.id, next, "different-batch")).rejects.toThrow(
    "original answer batch",
  );
  await expect(app.retryDelivery(a.id, "unknown-batch")).rejects.toThrow(
    "rejected",
  );
  expect(app.lookup(a.id, "unknown-batch")).toBeNull();
  expect(app.lookup(a.id, "never-submitted")).toBeNull();
  expect(runtime.inputs).toHaveLength(count);
  expect(app.detail(a.id).questions.at(-1)?.state).toBe("unanswered");
});

test("a rejected answer retry validates originals already accepted by another operation", async () => {
  const { app, runtime } = fixture();
  const a = await app.createOrc("alpha");
  await app.send(a.id, "Start", "start");
  const turnId = app.detail(a.id).turnId!;
  runtime.emit(a.id, {
    type: "item",
    turnId,
    item: {
      id: "original",
      type: "agentMessage",
      delivery: "async",
      questions: [{ question: "Choice?" }],
    },
  });
  const answers = [{ questionId: "original:0", answer: "Yes" }];
  runtime.sendOverride = async () => {
    throw new DeliveryRejected("Rejected");
  };
  await app.answerBatch(a.id, answers, "failed");
  runtime.sendOverride = undefined;
  await app.answerBatch(a.id, answers, "accepted-elsewhere");
  const count = runtime.inputs.length;
  await expect(app.retryDelivery(a.id, "failed")).rejects.toThrow(
    "remain unanswered",
  );
  expect(runtime.inputs).toHaveLength(count);
});
