import { expect, test } from "bun:test";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import type { Delivery } from "../src/contracts";
import { recoveredPiActivity } from "./pi-completion";

function fixture() {
  const original = {
    id: 11,
    conversationId: 1,
    kind: "pi.generation",
    background: false,
    owner: undefined as number | undefined,
    startedAt: 1000,
    endedAt: 1200,
    state: {
      status: "terminal",
      outcome: { status: "completed", result: { entryId: 57 } },
    },
  };
  const successor = {
    id: 22,
    conversationId: 1,
    kind: "pi.generation",
    background: false,
    owner: undefined as number | undefined,
    startedAt: 1300,
    endedAt: 2400,
    state: { status: "terminal" },
  };
  const later = {
    id: 33,
    conversationId: 1,
    kind: "pi.generation",
    background: false,
    owner: undefined as number | undefined,
    startedAt: 1500,
    endedAt: 2100,
    state: { status: "terminal" },
  };
  const old = {
    id: 10,
    conversationId: 1,
    kind: "pi.generation",
    background: false,
    owner: undefined as number | undefined,
    startedAt: 1,
    endedAt: 99999,
    state: { status: "terminal" },
  };
  const calls: unknown[] = [];
  const input = {
    id: 56,
    conversationId: 1,
    kind: "grove.input",
    data: { operation: "operation" },
    byTaskId: 11 as number | undefined,
  };
  const answer = {
    id: 57,
    conversationId: 1,
    kind: "pi.assistant",
    byTaskId: 11 as number | undefined,
  };
  const submission = {
    id: 55,
    conversationId: 1,
    type: "input",
    requestId: "operation",
    status: "done",
    entry: 56 as number | undefined,
    answer: 57,
  };
  const delivery: Delivery = {
    id: "operation",
    turnId: "55",
    text: "work",
    source: "user",
    status: "sent",
    at: 1,
    questionIds: [],
  };
  const storage = {
    task: async (id: number) => (id === 11 ? original : undefined),
    submission: async (id: number) => (id === 55 ? submission : undefined),
    entry: async (_conversation: number, id: number) => ({
      entry: id === 56 ? input : id === 57 ? answer : undefined,
    }),
    scanTasks: async (query: unknown, limit: number, cursor: unknown) => {
      calls.push({ query, limit, cursor });
      return cursor
        ? { items: [successor, original, old] }
        : { items: [later], next: { id: 33 } };
    },
  } as unknown as Pick<Storage, "task" | "scanTasks" | "submission" | "entry">;
  return {
    storage,
    original,
    successor,
    later,
    old,
    calls,
    input,
    answer,
    submission,
    delivery,
  };
}
const recover = (f: ReturnType<typeof fixture>, turn = "11") =>
  recoveredPiActivity(f.storage, ROOT_CONVERSATION_ID, turn, [f.delivery]);

test("recovery takes the maximum actual time across paged successors, excluding older history", async () => {
  const f = fixture();
  expect(await recover(f)).toBe(2400);
  expect(f.calls).toHaveLength(2);
  expect(f.calls[0]).toMatchObject({
    query: {
      conversationId: 1,
      kind: "pi.generation",
      status: "terminal",
      order: "descending",
    },
  });
});

test("recovery requires a real saved current generation and excludes unstarted or foreign tasks", async () => {
  const f = fixture();
  expect(await recover(f, "99")).toBeUndefined();
  expect(await recover(f, "011")).toBeUndefined();
  f.original.conversationId = 2;
  expect(await recover(f)).toBeUndefined();
  f.original.conversationId = 1;
  f.original.kind = "pi.tool";
  expect(await recover(f)).toBeUndefined();
  f.original.kind = "pi.generation";
  f.original.owner = 5;
  expect(await recover(f)).toBeUndefined();
  f.original.owner = undefined;
  f.original.background = true;
  expect(await recover(f)).toBeUndefined();
  f.original.background = false;
  f.original.startedAt = NaN;
  expect(await recover(f)).toBeUndefined();
  f.original.startedAt = 1000;
  f.successor.conversationId = 2;
  f.later.startedAt = NaN;
  expect(await recover(f)).toBe(1200);
  f.original.endedAt = NaN;
  expect(await recover(f)).toBeUndefined();
});

test("a matched submitted input can recover work from before its ID and reject unrelated records", async () => {
  const f = fixture();
  expect(await recover(f, "55")).toBe(1200);
  f.input.byTaskId = undefined;
  expect(await recover(f, "55")).toBe(1200);
  f.original.state.outcome.result.entryId = 99;
  expect(await recover(f, "55")).toBeUndefined();
  f.original.state.outcome.result.entryId = 57;
  f.input.byTaskId = 11;
  f.later.id = 70;
  expect(await recover(f, "55")).toBe(2100);
  f.later.id = 33;
  f.submission.status = "unanswered";
  expect(await recover(f, "55")).toBe(1200);
  f.submission.entry = undefined;
  expect(await recover(f, "55")).toBeUndefined();
  f.submission.entry = 56;
  f.submission.conversationId = 2;
  expect(await recover(f, "55")).toBeUndefined();
  f.submission.conversationId = 1;
  f.submission.type = "write";
  expect(await recover(f, "55")).toBeUndefined();
  f.submission.type = "input";
  f.submission.status = "queued";
  expect(await recover(f, "55")).toBeUndefined();
  f.submission.status = "done";
  f.delivery.id = "unrelated";
  expect(await recover(f, "55")).toBeUndefined();
  f.delivery.id = "operation";
  f.delivery.turnId = "11";
  expect(await recover(f, "55")).toBeUndefined();
  f.delivery.turnId = "55";
  f.input.data.operation = "unrelated";
  expect(await recover(f, "55")).toBeUndefined();
});
