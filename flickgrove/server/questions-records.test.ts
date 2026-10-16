import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService, qualify } from "./hosts";
import { servePeer } from "./http";
import { encodedBytes, PAGE_BYTES } from "./conversation-reading";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "grove-question-records-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const server = servePeer(app, {
    service,
    origin: () => origin,
    hostname: "127.0.0.1",
    port: 0,
  });
  origin = `http://127.0.0.1:${server.port}`;
  cleanups.push(() => {
    server.stop(true);
    service.dispose();
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  });
  const read = (path: string, headers: Record<string, string> = {}) =>
    fetch(origin + "/api/read" + path, {
      headers: {
        Origin: origin,
        Authorization: "Bearer stale",
        "X-Grove-Peer": service.identity.id,
        ...headers,
      },
    });
  return { app, runtime, service, read };
}
test("native question/answer identity survives bounded HTTP history, reconnect and closed history reads", async () => {
  const f = fixture();
  const a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "start", "start");
  f.runtime.emit(a.id, {
    type: "item",
    turnId: f.app.detail(a.id).turnId!,
    item: {
      type: "agentMessage",
      id: "original-question",
      phase: "commentary",
      delivery: "async",
      questions: [
        {
          question: "original body",
          options: [
            { label: "original option", description: "original description" },
          ],
        },
      ],
    },
  });
  expect(
    f.app.detail(a.id).messages.find((m) => m.id === "original-question")
      ?.questionItemId,
  ).toBe("original-question");
  await f.app.answerBatch(
    a.id,
    [{ questionId: "original-question:0", answer: "original option" }],
    "original-answer",
  );
  const thread = f.app.detail(a.id).threadId!;
  const qid = qualify(f.service.identity.id, a.id);
  const page = await (
    await f.read("/messages?" + new URLSearchParams({ agent: qid }))
  ).json();
  expect(encodedBytes(page)).toBeLessThanOrEqual(PAGE_BYTES);
  expect(
    page.messages.find((m: any) => m.id === "original-question")
      ?.questionItemId,
  ).toBe("original-question");
  const answer = page.messages.find(
    (m: any) => m.clientId === "original-answer",
  );
  expect(answer.delivery.source).toBe("question");
  expect(answer.id).not.toBe(answer.clientId);
  const selectors: Record<string, string>[] = [
    { item: "original-question" },
    { operation: answer.clientId },
  ];
  for (const selector of selectors) {
    const response = await f.read(
      "/questions?" + new URLSearchParams({ agent: qid, ...selector }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject([
      {
        id: "original-question:0",
        itemId: "original-question",
        state: "answered",
        text: "original body",
        options: [
          { label: "original option", description: "original description" },
        ],
        answer: "original option",
      },
    ]);
  }
  expect(
    await (
      await f.read(
        "/questions?" + new URLSearchParams({ agent: qid, pending: "true" }),
      )
    ).json(),
  ).toEqual([]);
  await f.app.synchronizeDetail(a.id);
  expect(
    f.app.detail(a.id).messages.find((m) => m.id === "original-question")
      ?.questionItemId,
  ).toBe("original-question");
  f.runtime.emit(a.id, {
    type: "completed",
    turnId: f.app.detail(a.id).turnId!,
    status: "completed",
  });
  await f.app.closeTree(a.id);
  const history = await f.read(
    "/questions?" +
      new URLSearchParams({
        project: "alpha",
        thread,
        item: "original-question",
      }),
  );
  expect(history.status).toBe(200);
  expect((await history.json())[0].answer).toBe("original option");
  expect(
    f.runtime.inputs.filter((i) => i.clientId === "original-answer"),
  ).toHaveLength(1);
  expect(
    (
      await f.read(
        "/questions?" +
          new URLSearchParams({
            project: "beta",
            thread,
            item: "original-question",
          }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.read(
        "/questions?" +
          new URLSearchParams({
            project: "alpha",
            thread,
            operation: "unknown",
          }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.read(
        "/questions?" +
          new URLSearchParams({
            project: "alpha",
            thread,
            item: "original-question",
          }),
        { "X-Grove-Peer": "wrong" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.read(
        "/questions?" +
          new URLSearchParams({
            project: "alpha",
            thread,
            item: "original-question",
          }),
        { Origin: "https://foreign.invalid", Authorization: "Bearer invalid" },
      )
    ).status,
  ).toBe(403);
});

test("pending HTTP question retains its unknown operation outside the bounded delivery window", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "start", "start");
  f.runtime.emit(a.id, {
    type: "item",
    turnId: f.app.detail(a.id).turnId!,
    item: {
      type: "agentMessage",
      id: "old-question",
      delivery: "async",
      questions: [{ question: "Old pending question" }],
    },
  });
  f.runtime.sendOverride = async () => {
    throw new Error("Owned unknown admission");
  };
  await f.app.answerBatch(
    a.id,
    [{ questionId: "old-question:0", answer: "original frozen answer" }],
    "old-answer",
  );
  f.runtime.sendOverride = undefined;
  for (let i = 0; i < 105; i++)
    await f.app.send(a.id, `later ${i}`, `later-${i}`);
  expect(f.app.detail(a.id).deliveries.some((d) => d.id === "old-answer")).toBe(
    false,
  );
  const agent = qualify(f.service.identity.id, a.id);
  const records = await (
    await f.read(
      "/questions?" + new URLSearchParams({ agent, pending: "true" }),
    )
  ).json();
  expect(records[0].answerOperation).toEqual({
    id: "old-answer",
    status: "uncertain",
  });
  const recovery = await (
    await f.read(
      "/recovery?" +
        new URLSearchParams({
          agent,
          operation: records[0].answerOperation.id,
        }),
    )
  ).json();
  expect(recovery.answers).toEqual([
    { questionId: "old-question:0", answer: "original frozen answer" },
  ]);
  expect(
    f.runtime.inputs.filter((i) => i.clientId === "old-answer"),
  ).toHaveLength(1);
});

test("question HTTP prefers an unresolved original identity over an earlier rejected attempt", async () => {
  const f = fixture(),
    a = await f.app.createOrc("alpha");
  await f.app.send(a.id, "start", "start");
  f.runtime.emit(a.id, {
    type: "item",
    turnId: f.app.detail(a.id).turnId!,
    item: {
      type: "agentMessage",
      id: "attempts",
      delivery: "async",
      questions: [{ question: "A question" }],
    },
  });
  const { DeliveryRejected } = await import("./runtime");
  f.runtime.sendOverride = async () => {
    throw new DeliveryRejected("Owned rejection");
  };
  await f.app.answerBatch(
    a.id,
    [{ questionId: "attempts:0", answer: "rejected" }],
    "rejected-attempt",
  );
  f.runtime.sendOverride = async () => {
    throw new Error("Owned unknown");
  };
  await f.app.answerBatch(
    a.id,
    [{ questionId: "attempts:0", answer: "unknown" }],
    "unknown-attempt",
  );
  const agent = qualify(f.service.identity.id, a.id);
  const q = await (
    await f.read(
      "/questions?" + new URLSearchParams({ agent, pending: "true" }),
    )
  ).json();
  expect(q[0].answerOperation).toEqual({
    id: "unknown-attempt",
    status: "uncertain",
  });
});

test("closed Worker history reads the original delegated question and contextual answer", async () => {
  const f = fixture(),
    owner = await f.app.createOrc("alpha");
  const token = f.runtime.agents.get(owner.id)!.token;
  const worker = (await f.app.tool(token, "worker_start", {
    project: "alpha",
    title: "Owned reporter",
    spec: "fixture",
    message: "Owned task",
  })) as import("../src/contracts").Detail;
  f.runtime.emit(worker.id, {
    type: "item",
    turnId: worker.turnId!,
    item: {
      type: "agentMessage",
      id: "closed-worker-question",
      delivery: "async",
      questions: [
        {
          question: "Original Worker question",
          options: [{ label: "Original option" }],
        },
      ],
    },
  });
  await f.app.tool(token, "worker_send", {
    workerId: worker.id,
    message: "Contextual original answer",
    questionIds: ["closed-worker-question:0"],
  });
  f.runtime.emit(worker.id, {
    type: "completed",
    turnId: f.app.detail(worker.id).turnId!,
    status: "completed",
  });
  await f.app.tool(token, "worker_close", { workerId: worker.id });
  expect(f.app.snapshot().agents.some((a) => a.id === worker.id)).toBe(false);
  const response = await f.read(
    "/questions?" +
      new URLSearchParams({
        project: "alpha",
        thread: worker.threadId!,
        item: "closed-worker-question",
      }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([
    {
      id: "closed-worker-question:0",
      state: "answered",
      text: "Original Worker question",
      options: [{ label: "Original option" }],
      answer: "Contextual original answer",
    },
  ]);
});
