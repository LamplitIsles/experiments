import { describe, expect, test } from "bun:test";
import { ReaderConversation, type AppServer } from "./conversation";
import { createHerdrReporter } from "./herdr";

type Listener = (params: any) => void;
function fake(): AppServer & {
  requests: any[];
  emit(method: string, params: any): void;
} {
  const listeners = new Map<string, Listener[]>();
  const requests: any[] = [];
  return {
    requests,
    async call(method, params) {
      requests.push({ method, params });
      if (method === "thread/read") return { thread: { turns: [] } };
      return {};
    },
    async listSkills(cwd) {
      requests.push({ method: "skills/list", params: { cwds: [cwd] } });
      return [];
    },
    async listModels() {
      requests.push({ method: "model/list", params: {} });
      return [];
    },
    onNotification(method, listener) {
      listeners.set(method, [...(listeners.get(method) ?? []), listener]);
      return () =>
        listeners.set(
          method,
          (listeners.get(method) ?? []).filter((x) => x !== listener),
        );
    },
    emit(method, params) {
      for (const listener of listeners.get(method) ?? []) listener(params);
    },
    async close() {},
  };
}

describe("reader-first native projection", () => {
  test("exposes user input before a slow native start responds", async () => {
    const server = fake();
    const originalCall = server.call;
    let resolveStart: ((value: unknown) => void) | undefined;
    server.call = async (method, params) => {
      if (method !== "turn/start") return originalCall(method, params);
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    };
    const c = new ReaderConversation(server, "thread-1");
    const submitted = c.submit("visible before native response");
    expect(c.visible).toMatchObject([
      { role: "user", body: "visible before native response" },
    ]);
    await Bun.sleep(0);
    resolveStart?.({ turn: { id: "turn-1" } });
    await submitted;
  });

  test("admits user input immediately, hides deltas, and atomically adds final pieces", async () => {
    const server = fake();
    const c = new ReaderConversation(server, "thread-1");
    await c.submit("Please answer in **Markdown**");
    expect(c.visible).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "turn/start",
      params: { threadId: "thread-1" },
    });
    server.emit("turn/started", {
      turn: { id: "turn-1", startedAt: "2026-09-20T01:00:00Z" },
    });
    server.emit("item/completed", {
      turnId: "turn-1",
      item: { type: "agentMessage", phase: "final_answer", text: "# Complete" },
    });
    expect(c.visible).toHaveLength(1);
    server.emit("item/completed", {
      turnId: "turn-1",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "\n\nNo stream.",
      },
    });
    server.emit("turn/completed", {
      turn: {
        id: "turn-1",
        status: "completed",
        startedAt: "2026-09-20T01:00:00Z",
        completedAt: "2026-09-20T01:01:08Z",
      },
    });
    await Bun.sleep(0);
    expect(c.visible[1]).toMatchObject({
      role: "assistant",
      body: "# Complete\n\nNo stream.",
      workedMs: 68_000,
    });
  });

  test("steers with the authoritative turn and reports native context only", async () => {
    const server = fake();
    const c = new ReaderConversation(server, "thread-1");
    server.emit("turn/started", { turn: { id: "turn-7" } });
    await c.submit("Steer this");
    expect(server.requests[0]).toMatchObject({
      method: "turn/steer",
      params: { expectedTurnId: "turn-7" },
    });
    server.emit("thread/tokenUsage/updated", {
      tokenUsage: { last: { totalTokens: 120 }, modelContextWindow: 200 },
    });
    expect(c.contextLabel()).toBe("context 120 / 200");
    server.emit("thread/tokenUsage/updated", { tokenUsage: {} });
    expect(c.contextLabel()).toBe("context unavailable");
  });

  test("routes compact natively, hides it, holds input during compaction, and releases after native completion", async () => {
    const server = fake();
    const c = new ReaderConversation(server, "thread-1");
    await c.submit("/compact");
    expect(c.visible).toHaveLength(0);
    expect(server.requests[0].method).toBe("thread/compact/start");
    await c.submit("after compact");
    expect(server.requests).toHaveLength(1);
    server.emit("turn/started", { turn: { id: "compact" } });
    server.emit("turn/completed", {
      turn: { id: "compact", status: "completed" },
    });
    await Bun.sleep(0);
    expect(server.requests[1].method).toBe("turn/start");
  });

  test("uses official enabled skills only, invalidates them, and keeps selection side-effect free", async () => {
    const server = fake();
    server.listSkills = async (cwd) => {
      server.requests.push({ method: "skills/list", params: { cwds: [cwd] } });
      return [{ name: "review", description: "Review code" }];
    };
    const c = new ReaderConversation(server, "thread-1");
    expect(await c.listSkills("/work")).toEqual([
      { name: "review", description: "Review code" },
    ]);
    expect(server.requests[0]).toMatchObject({
      method: "skills/list",
      params: { cwds: ["/work"] },
    });
    server.emit("skills/changed", {});
    await c.listSkills("/work");
    expect(
      server.requests.filter((request) => request.method === "skills/list"),
    ).toHaveLength(2);
    expect(
      server.requests.some((request) => request.method === "turn/start"),
    ).toBe(false);
  });

  test("lists official models and switches the native thread without chat text", async () => {
    const server = fake();
    server.listModels = async () => {
      server.requests.push({ method: "model/list", params: {} });
      return [
        {
          name: "gpt-test",
          description: "Test model",
          efforts: [
            { name: "low", description: "Low" },
            { name: "high", description: "High" },
          ],
          defaultEffort: "high",
        },
      ];
    };
    const c = new ReaderConversation(server, "thread-1");
    expect(await c.listModels()).toEqual([
      {
        name: "gpt-test",
        description: "Test model",
        efforts: [
          { name: "low", description: "Low" },
          { name: "high", description: "High" },
        ],
        defaultEffort: "high",
      },
    ]);
    await c.submit("/model gpt-test low");
    expect(c.visible).toEqual([]);
    expect(server.requests).toEqual([
      { method: "model/list", params: {} },
      {
        method: "thread/settings/update",
        params: { threadId: "thread-1", model: "gpt-test", effort: "low" },
      },
    ]);
    server.emit("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { model: "gpt-test", effort: "low" },
    });
    expect(c.runtime).toEqual({ model: "gpt-test", effort: "low" });
  });

  test("tracks authoritative title/settings and lets live token usage replace a rollout seed", () => {
    const server = fake();
    const c = new ReaderConversation(server, "thread-1");
    c.seedTokenUsage({ totalTokens: 30, modelContextWindow: 300 });
    expect(c.contextLabel()).toBe("context 30 / 300");
    server.emit("thread/tokenUsage/updated", {
      threadId: "thread-1",
      tokenUsage: { last: { totalTokens: 50 }, modelContextWindow: 500 },
    });
    server.emit("thread/name/updated", {
      threadId: "thread-1",
      threadName: "Native name",
    });
    server.emit("thread/settings/updated", {
      threadId: "thread-1",
      threadSettings: { model: "gpt-5", effort: "high" },
    });
    expect(c.tokenUsage).toEqual({
      last: { totalTokens: 50 },
      modelContextWindow: 500,
    });
    expect(c.runtime).toEqual({
      name: "Native name",
      model: "gpt-5",
      effort: "high",
    });
  });

  test("Herdr reporting failures are isolated from native conversation work", async () => {
    const reporter = createHerdrReporter(
      { HERDR_ENV: "1", HERDR_PANE_ID: "test:pane" },
      (() => {
        throw new Error("missing herdr");
      }) as any,
    );
    const server = fake();
    const c = new ReaderConversation(server, "thread-1", reporter);
    await c.submit("still sends");
    expect(server.requests[0].method).toBe("turn/start");
    await c.close();
  });

  test("Herdr asynchronous launch errors are observable and isolated", () => {
    let onError: (() => void) | undefined;
    const warnings: string[] = [];
    const reporter = createHerdrReporter(
      { HERDR_ENV: "1", HERDR_PANE_ID: "w:p" },
      (() => {
        return {
          unref() {},
          on(event: string, listener: () => void) {
            if (event === "error") onError = listener;
          },
        };
      }) as any,
      (message) => warnings.push(message),
    );
    reporter.working();
    onError?.();
    expect(warnings).toEqual([
      "Herdr reporting failed: unable to launch herdr",
    ]);
  });
});
