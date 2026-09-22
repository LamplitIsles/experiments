import { expect, test } from "bun:test";
import { ReaderConversation, type AppServer } from "./conversation";

function fixture() {
  const listeners = new Map<string, (p: any) => void>();
  const requests: Array<{ method: string; params: any }> = [];
  let next = 0;
  const server: AppServer = {
    async call(method, params) {
      requests.push({ method, params });
      if (method === "thread/turns/list") return { data: [], nextCursor: null };
      if (method === "turn/start") return { turn: { id: `t${++next}` } };
      return {};
    },
    async listSkills() {
      return [];
    },
    onNotification(method, listener) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    async close() {},
  };
  let now = 0;
  const timers = new Map<any, { at: number; callback: () => void }>();
  const clock = {
    now: () => now,
    setTimeout(callback: () => void, ms: number) {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout(handle: ReturnType<typeof setTimeout>) {
      timers.delete(handle);
    },
  };
  const states: string[] = [];
  const c = new ReaderConversation(
    server,
    "thread",
    {
      working: () => states.push("working"),
      idle: () => states.push("idle"),
      blocked: () => states.push("blocked"),
      release: () => states.push("release"),
    },
    clock,
  );
  const emit = (method: string, params: any) =>
    listeners.get(method)?.({ threadId: "thread", ...params });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const [handle, timer] of timers)
      if (timer.at <= now) {
        timers.delete(handle);
        timer.callback();
      }
    await settle();
  };
  const complete = (id: string, status = "completed", error?: any) =>
    emit("turn/completed", { turn: { id, status, error } });
  return {
    c,
    server,
    requests,
    timers,
    emit,
    settle,
    advance,
    complete,
    states,
  };
}

test("Tab follow-ups are FIFO turns, Enter steers, and interruption restores remaining jobs", async () => {
  const f = fixture();
  await f.c.queue("A");
  await f.c.queue("B");
  await f.c.queue("C");
  expect(f.c.queuedInputs()).toEqual(["B", "C"]);
  expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  await f.c.submit("steer A");
  expect(f.requests.at(-1)?.method).toBe("turn/steer");
  f.complete("t1");
  await f.settle();
  expect(
    f.requests
      .filter((r) => r.method === "turn/start")
      .map((r) => r.params.input[0].text),
  ).toEqual(["A", "B"]);
  expect(f.c.queuedInputs()).toEqual(["C"]);
  await f.c.interrupt();
  expect(f.requests.at(-1)).toMatchObject({
    method: "turn/interrupt",
    params: { turnId: "t2" },
  });
  f.complete("t2", "interrupted");
  await f.settle();
  expect(f.c.takeRestoredDraft()).toBe("C");
  expect(f.c.takeRestoredDraft()).toBe("");
  expect(f.c.queuedInputs()).toEqual([]);
  expect(f.states).toEqual(["idle", "working", "idle"]);
  await f.c.close();
});

test("recent history pages prepend in order without losing messages added after resume", async () => {
  const f = fixture();
  let page = 0;
  const original = f.server.call;
  f.server.call = async (method, params) => {
    if (method !== "thread/turns/list") return original(method, params);
    expect(params?.sortDirection).toBe("desc");
    page++;
    return {
      data: [
        {
          id: `old-${page}`,
          status: "completed",
          items: [
            {
              type: "agentMessage",
              phase: "final_answer",
              text: page === 1 ? "recent" : "earlier",
            },
          ],
        },
      ],
      nextCursor: page === 1 ? "older" : null,
    };
  };
  await f.c.loadRecentHistory();
  expect(page).toBe(1);
  await f.c.submit("live");
  await f.c.loadEarlierHistory();
  expect(f.c.visible.map((m) => m.body)).toEqual(["earlier", "recent", "live"]);
  expect(f.c.hasEarlierHistory()).toBe(false);
  await f.c.close();
});

test("Tab during capacity wait preserves the timer and cancel restores queued jobs", async () => {
  const f = fixture();
  await f.c.submit("A");
  f.complete("t1", "failed", { codexErrorInfo: "serverOverloaded" });
  await f.settle();
  await f.c.queue("B");
  expect(f.timers.size).toBe(1);
  expect(f.requests.filter((r) => r.method === "turn/start")).toHaveLength(1);
  await f.c.submit("/cancel-retry");
  expect(f.timers.size).toBe(0);
  expect(f.c.takeRestoredDraft()).toBe("B");
  await f.c.close();
});

test("one lifecycle projection avoids transient idle during held-input handoff and capacity wait", async () => {
  const f = fixture();
  await f.c.compact();
  f.emit("turn/started", { turn: { id: "compact" } });
  await f.c.submit("held");
  f.complete("compact");
  await f.settle();
  expect(f.states).toEqual(["idle", "working"]);
  f.complete("t1", "failed", { codexErrorInfo: "serverOverloaded" });
  expect(f.states).toEqual(["idle", "working", "blocked"]);
  await f.c.close();
  expect(f.states).toEqual(["idle", "working", "blocked", "release"]);
});

test("completion before the start response still settles to idle after admission drains", async () => {
  const f = fixture();
  const call = f.server.call;
  f.server.call = async (method, params) => {
    const response = await call(method, params);
    if (method === "turn/start") {
      f.emit("turn/started", { turn: { id: response.turn.id } });
      f.complete(response.turn.id);
    }
    return response;
  };
  await f.c.submit("quick reply");
  await f.settle();
  expect(f.c.status).toBe("idle");
  expect(f.states).toEqual(["idle", "working", "idle"]);
});

test("native compact completion serializes held and immediately arriving input", async () => {
  const f = fixture();
  await f.c.submit("/compact");
  f.emit("turn/started", { turn: { id: "compact" } });
  f.emit("item/started", {
    turnId: "compact",
    item: { type: "contextCompaction", id: "item" },
  });
  await f.c.submit("one");
  await f.c.submit("two");
  f.emit("item/completed", {
    turnId: "compact",
    item: { type: "contextCompaction", id: "item" },
  });
  expect(f.requests).toHaveLength(1);
  f.complete("compact");
  await f.c.submit("three");
  await f.settle();
  expect(f.c.compacting).toBe(false);
  expect(f.requests.map((r) => r.method)).toEqual([
    "thread/compact/start",
    "turn/start",
    "turn/steer",
    "turn/steer",
  ]);
  expect(f.requests.slice(1).map((r) => r.params.input[0].text)).toEqual([
    "one",
    "two",
    "three",
  ]);
});

test("failed compact releases the gate; foreign and stale events cannot release it", async () => {
  const f = fixture();
  await f.c.compact();
  f.emit("turn/started", { turn: { id: "compact" } });
  await f.c.submit("held");
  f.emit("turn/completed", {
    threadId: "other",
    turn: { id: "compact", status: "completed" },
  });
  f.complete("old");
  await f.settle();
  expect(f.requests).toHaveLength(1);
  f.complete("compact", "failed", { message: "compact failed" });
  await f.settle();
  expect(f.c.compacting).toBe(false);
  expect(f.requests[1].params.input[0].text).toBe("held");
  expect(f.c.notice).toContain("compact failed");
});

test("automatic compaction releases held input into the existing turn", async () => {
  const f = fixture();
  await f.c.submit("initial");
  f.emit("item/started", {
    turnId: "t1",
    item: { type: "contextCompaction", id: "i" },
  });
  await f.c.submit("during auto compact");
  expect(f.requests).toHaveLength(1);
  f.emit("item/completed", {
    turnId: "t1",
    item: { type: "contextCompaction", id: "i" },
  });
  await f.settle();
  expect(f.requests[1].method).toBe("turn/steer");
  expect(f.requests[1].params.expectedTurnId).toBe("t1");
});

test("capacity resumes without replay at 15 then 30 minutes and ignores duplicate completion", async () => {
  const f = fixture();
  await f.c.submit("original");
  const error = { codexErrorInfo: "serverOverloaded", message: "capacity" };
  f.complete("t1", "failed", error);
  f.complete("t1", "failed", error);
  expect(f.timers.size).toBe(1);
  expect(f.c.recoveryLabel()).toContain("15:00");
  await f.advance(15 * 60_000 - 1);
  expect(f.requests).toHaveLength(1);
  await f.advance(1);
  expect(f.requests[1]).toEqual({
    method: "turn/start",
    params: { threadId: "thread", input: [] },
  });
  f.complete("t2", "failed", error);
  await f.advance(30 * 60_000 - 1);
  expect(f.requests).toHaveLength(2);
  await f.advance(1);
  expect(f.requests).toHaveLength(3);
  f.complete("t3");
  expect(f.timers.size).toBe(0);
  expect(f.c.recoveryLabel()).toBe("");
});

for (const action of [
  "message",
  "compact",
  "direct compact",
  "cancel",
  "close",
])
  test(`capacity recovery is cancelled by ${action}`, async () => {
    const f = fixture();
    await f.c.submit("original");
    f.complete("t1", "failed", { codexErrorInfo: "serverOverloaded" });
    expect(f.timers.size).toBe(1);
    if (action === "message") await f.c.submit("new input");
    if (action === "compact") await f.c.submit("/compact");
    if (action === "direct compact") await f.c.compact();
    if (action === "cancel") await f.c.submit("/cancel-retry");
    if (action === "close") await f.c.close();
    const count = f.requests.length;
    await f.advance(60 * 60_000);
    expect(f.requests).toHaveLength(count);
    expect(f.timers.size).toBe(0);
    expect(f.states).toEqual([
      "idle",
      "working",
      "blocked",
      action === "cancel" ? "idle" : action === "close" ? "release" : "working",
    ]);
  });

test("non-capacity failure is surfaced without scheduled retry", async () => {
  const f = fixture();
  await f.c.submit("original");
  f.complete("t1", "failed", {
    codexErrorInfo: "usageLimitExceeded",
    message: "quota",
  });
  expect(f.c.notice).toBe("quota");
  expect(f.timers.size).toBe(0);
});

test("capacity during manual compact retries compact before releasing held input", async () => {
  const f = fixture();
  await f.c.compact();
  f.emit("turn/started", { turn: { id: "compact1" } });
  await f.c.submit("waiting");
  f.complete("compact1", "failed", { codexErrorInfo: "serverOverloaded" });
  await f.advance(15 * 60_000);
  expect(f.requests.map((r) => r.method)).toEqual([
    "thread/compact/start",
    "thread/compact/start",
  ]);
  f.emit("turn/started", { turn: { id: "compact2" } });
  f.complete("compact2");
  await f.settle();
  expect(f.requests[2].params.input[0].text).toBe("waiting");
});

test("rejected compact request does not trap subsequent input", async () => {
  const f = fixture();
  const call = f.server.call;
  f.server.call = async (method, params) => {
    if (method === "thread/compact/start") throw new Error("compact rejected");
    return call(method, params);
  };
  await expect(f.c.compact()).rejects.toThrow("compact rejected");
  await f.c.submit("next");
  expect(f.c.compacting).toBe(false);
  expect(f.requests[0].method).toBe("turn/start");
});

test("interrupted compaction releases held input without capacity retry", async () => {
  const f = fixture();
  await f.c.compact();
  f.emit("turn/started", { turn: { id: "compact" } });
  await f.c.submit("waiting");
  f.complete("compact", "interrupted");
  await f.settle();
  expect(f.requests[1].params.input[0].text).toBe("waiting");
  expect(f.timers.size).toBe(0);
});
