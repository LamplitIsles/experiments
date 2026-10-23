import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime } from "./testing";
import { HostService } from "./hosts";
import { createHandler } from "./http";
import type { RuntimeEvent, RuntimeAgent } from "./runtime";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-handoff-"));
  const runtime = new FakeRuntime();
  const agents = new Map<string, RuntimeAgent>();
  const open = runtime.open.bind(runtime);
  runtime.open = async (agent, notify) => {
    agents.set(agent.id, agent);
    return open(agent, notify);
  };
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => [{ alias: "alpha", name: "Alpha", path: directory }],
    reviewerSnapshot: async () => ({
      model: "sol",
      effort: "medium",
      prompt: "Fixture",
    }),
    researcherSnapshot: async () => ({
      model: "sol",
      effort: "medium",
      prompt: "Fixture",
    }),
  });
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => app.dispose(),
  );
  const owner = await app.createOrc("alpha");
  await app.send(owner.id, "Work", "initial");
  const token = runtime.agents.get(owner.id)!.token;
  const origin = () => "http://127.0.0.1";
  const service = new HostService(app, { directory, origin });
  const handler = createHandler(app, { origin, service });
  const call = async (
    name: string,
    args: unknown = { summary: "Delivered the result" },
    auth = token,
  ) => {
    const response = await handler(
      new Request("http://127.0.0.1/api/mcp/call", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, arguments: args }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  const emit = (event: RuntimeEvent) => runtime.emit(owner.id, event);
  const complete = (
    status: "completed" | "failed" | "interrupted" = "completed",
  ) =>
    emit({ type: "completed", turnId: app.detail(owner.id).turnId!, status });
  const handoff = () =>
    app.snapshot().agents.find((a) => a.id === owner.id)!.userHandoff;
  const child = async (role = "worker") => {
    const r = await call(`${role}_start`, {
      project: "alpha",
      title: role,
      spec: "#4485",
      message: "Work",
      ...(role === "reviewer"
        ? { profile: "standards", fixedPoint: "base", reviewedHead: "head" }
        : {}),
      ...(role === "researcher" ? { question: "Why?" } : {}),
    });
    return r.body as { id: string };
  };
  return {
    app,
    runtime,
    owner,
    token,
    call,
    emit,
    complete,
    handoff,
    child,
    directory,
    agents,
  };
}

test("authenticated handoff is self-only, bounded, pending until successful completion and ephemeral", async () => {
  const f = await fixture();
  expect((await f.call("orc_handoff", undefined, "invalid")).status).toBe(400);
  for (const summary of [" ", "x".repeat(301)])
    expect((await f.call("orc_handoff", { summary })).status).toBe(400);
  expect(
    (await f.call("orc_handoff", { summary: "Fine", agentId: "other" })).status,
  ).toBe(400);
  for (const role of ["worker", "reviewer", "researcher"]) {
    const c = await f.child(role);
    expect(
      (
        await f.call(
          "orc_handoff",
          undefined,
          f.runtime.agents.get(c.id)!.token,
        )
      ).status,
    ).toBe(400);
    f.runtime.emit(c.id, {
      type: "completed",
      turnId: f.app.detail(c.id).turnId!,
      status: "completed",
    });
  }
  const inputs = f.runtime.inputs.length;
  expect((await f.call("orc_handoff")).body).toMatchObject({ pending: true });
  expect((await f.call("orc_handoff", { summary: "Repeated" })).status).toBe(
    200,
  );
  expect(f.handoff()).toBeUndefined();
  const turnId = f.app.detail(f.owner.id).turnId!;
  f.complete();
  expect(f.handoff()).toEqual({ id: turnId, summary: "Delivered the result" });
  f.emit({ type: "completed", turnId, status: "completed" });
  expect(f.handoff()?.id).toBe(turnId);
  expect(f.runtime.inputs.length).toBe(inputs);
  expect(f.runtime.interruptions).toEqual([]);
  expect((await f.call("orc_handoff")).status).toBe(400);
  f.app.dispose();
  const restored = new Workspace({
    directory: f.directory,
    runtime: new FakeRuntime(),
    projects: async () => [],
  });
  cleanup.push(() => restored.dispose());
  expect(
    restored.snapshot().agents.every((a) => !a.userHandoff && !a.finalFailure),
  ).toBe(true);
});

for (const reason of [
  "failed",
  "stop",
  "input",
  "dispatch",
  "question",
  "member-starts",
  "disconnect",
] as const) {
  test(`handoff candidate cancelled by ${reason}, cannot be rearmed in the same turn`, async () => {
    const f = await fixture();
    let idleChild: { id: string } | undefined;
    if (reason === "member-starts") {
      idleChild = await f.child();
      f.runtime.emit(idleChild.id, {
        type: "completed",
        turnId: f.app.detail(idleChild.id).turnId!,
        status: "completed",
      });
    }
    expect((await f.call("orc_handoff")).status).toBe(200);
    const turnId = f.app.detail(f.owner.id).turnId!;
    if (reason === "failed") f.complete("failed");
    if (reason === "stop") {
      await f.app.stop(f.owner.id, turnId);
      f.complete("interrupted");
      expect(f.app.snapshot().agents[0]!.finalFailure).toBeUndefined();
    }
    if (reason === "input") await f.app.send(f.owner.id, "More work", "more");
    if (reason === "dispatch") {
      const c = await f.child();
      f.runtime.emit(c.id, {
        type: "completed",
        turnId: f.app.detail(c.id).turnId!,
        status: "completed",
      });
    }
    if (reason === "question")
      f.emit({
        type: "item",
        turnId,
        item: {
          type: "agentMessage",
          id: "q",
          delivery: "async",
          questions: [{ question: "Which?" }],
        },
      });
    if (reason === "member-starts") {
      f.runtime.emit(idleChild!.id, {
        type: "working",
        turnId: "member-continues",
      });
      f.runtime.emit(idleChild!.id, {
        type: "completed",
        turnId: "member-continues",
        status: "completed",
      });
    }
    if (reason === "disconnect")
      f.emit({ type: "disconnected", error: "Lost connection" });
    expect((await f.call("orc_handoff")).status).toBe(400);
    f.emit({ type: "completed", turnId, status: "completed" });
    expect(f.handoff()).toBeUndefined();
  });
}

test("pending questions, active members and queued/uncertain delivery block handoff; confirmed report allows it", async () => {
  const f = await fixture();
  const c = await f.child();
  expect((await f.call("orc_handoff")).status).toBe(400);
  f.runtime.emit(c.id, {
    type: "completed",
    turnId: f.app.detail(c.id).turnId!,
    status: "completed",
  });
  const member = f.agents.get(c.id)!;
  member.closeRequest = { reason: "Native release unresolved" };
  expect((await f.call("orc_handoff")).status).toBe(400);
  member.closeRequest = undefined;
  const owner = f.agents.get(f.owner.id)!;
  for (const status of ["queued", "sending", "uncertain"] as const) {
    owner.deliveries.push({
      id: status,
      text: "Report",
      source: "worker",
      status,
      questionIds: [],
      at: 1,
    });
    expect((await f.call("orc_handoff")).status).toBe(400);
    owner.deliveries.pop();
  }
  owner.deliveries.push({
    id: "confirmed",
    text: "Report",
    source: "worker",
    status: "sent",
    questionIds: [],
    at: 1,
  });
  expect((await f.call("orc_handoff")).status).toBe(200);
  owner.deliveries.push({
    id: "late",
    text: "Report",
    source: "worker",
    status: "uncertain",
    questionIds: [],
    at: 1,
  });
  f.complete();
  expect(f.handoff()).toBeUndefined();
});

test("final failures have turn identity, retry and Stop are silent, stale native events ignored", async () => {
  const f = await fixture();
  const turnId = f.app.detail(f.owner.id).turnId!;
  f.emit({
    type: "error",
    turnId,
    error: "Capacity",
    willRetry: true,
    errorKind: "capacity",
  });
  expect(f.app.snapshot().agents[0]!.finalFailure).toBeUndefined();
  f.complete("failed");
  expect(f.app.snapshot().agents[0]!.finalFailure).toEqual({ id: turnId });
  f.emit({ type: "working", turnId: "next" });
  f.emit({ type: "completed", turnId, status: "failed" });
  expect(f.app.detail(f.owner.id).turnId).toBe("next");
  f.complete("failed");
  expect(f.app.snapshot().agents[0]!.finalFailure).toEqual({ id: "next" });
});

test("pending user questions and stopped workspace reject handoff", async () => {
  const f = await fixture();
  const turnId = f.app.detail(f.owner.id).turnId!;
  f.emit({
    type: "item",
    turnId,
    item: {
      type: "agentMessage",
      id: "batch",
      delivery: "async",
      questions: [{ question: "Choose a path" }],
    },
  });
  expect((await f.call("orc_handoff")).status).toBe(400);
  expect(f.app.snapshot().agents[0]!.questions[0]!.notificationText).toBe(
    "Choose a path",
  );
  f.app.dispose();
  expect((await f.call("orc_handoff")).status).toBe(400);
});

test("queued report after candidate cancels even after native acceptance; no automatic replay", async () => {
  const f = await fixture();
  const c = await f.child();
  f.runtime.emit(c.id, {
    type: "completed",
    turnId: f.app.detail(c.id).turnId!,
    status: "completed",
  });
  expect((await f.call("orc_handoff")).status).toBe(200);
  const token = f.runtime.agents.get(c.id)!.token;
  const inputs = f.runtime.inputs.length;
  expect(
    (await f.call("worker_report", { message: "More work to inspect" }, token))
      .status,
  ).toBe(200);
  expect(f.runtime.inputs.length).toBe(inputs + 1); // One authorized report, no handoff send.
  expect((await f.call("orc_handoff")).status).toBe(400);
  f.complete();
  expect(f.handoff()).toBeUndefined();
  expect(f.runtime.inputs.length).toBe(inputs + 1);
});

test("unknown member outcome refuses handoff without replay or accepting stale callbacks", async () => {
  const f = await fixture();
  const c = await f.child();
  const inputs = f.runtime.inputs.length;
  f.runtime.emit(c.id, { type: "disconnected", error: "Unknown turn outcome" });
  expect((await f.call("orc_handoff")).status).toBe(400);
  f.runtime.emit(c.id, {
    type: "completed",
    turnId: "stale",
    status: "completed",
  });
  expect((await f.call("orc_handoff")).status).toBe(400);
  expect(f.app.detail(c.id).state).toBe("error");
  expect(f.runtime.inputs.length).toBe(inputs);
});
