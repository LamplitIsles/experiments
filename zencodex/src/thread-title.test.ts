import { expect, test } from "bun:test";
import { nameThreadFromPrompt, parseTitle, titlePrompt } from "./thread-title";

function fixture(
  existingName: string | null = null,
  response = '{"title":"Fix login timeout"}',
) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(params: any) => void>>();
  const emit = (method: string, params: any) => {
    for (const listener of listeners.get(method) ?? []) listener(params);
  };
  const client = {
    calls,
    onNotification(method: string, listener: (params: any) => void) {
      const set = listeners.get(method) ?? new Set();
      set.add(listener);
      listeners.set(method, set);
      return () => set.delete(listener);
    },
    async call(method: string, params?: Record<string, unknown>): Promise<any> {
      calls.push({ method, params });
      if (method === "config/read")
        return { config: { additional: { mcp_servers: { companion: {} } } } };
      if (method === "thread/start") return { thread: { id: "temporary" } };
      if (method === "turn/start") {
        // Notifications may arrive before the response to turn/start.
        emit("item/completed", {
          threadId: "temporary",
          turnId: "title-turn",
          item: { type: "agentMessage", text: response },
        });
        emit("turn/completed", {
          threadId: "temporary",
          turn: { id: "title-turn", status: "completed" },
        });
        return { turn: { id: "title-turn" } };
      }
      if (method === "thread/read") return { thread: { name: existingName } };
      return {};
    },
  };
  return client;
}

test("generates a structured title in an isolated ephemeral thread and persists the official name", async () => {
  const client = fixture();
  await nameThreadFromPrompt(
    client,
    "original",
    "/fixture",
    "Fix the login timeout",
    "gpt-6-luna",
    "low",
  );
  expect(client.calls.map((call) => call.method)).toEqual([
    "config/read",
    "thread/start",
    "turn/start",
    "thread/read",
    "thread/name/set",
    "thread/unsubscribe",
  ]);
  expect(client.calls[1].params).toMatchObject({
    model: "gpt-6-luna",
    ephemeral: true,
    threadSource: "system",
    sandbox: "read-only",
    approvalPolicy: "never",
    config: {
      "features.unified_exec": false,
      "features.shell_tool": false,
      "cloud.skills.enabled": false,
      default_permissions: ":read-only",
      mcp_servers: { companion: { enabled: false } },
    },
  });
  expect(client.calls[2].params).toMatchObject({
    threadId: "temporary",
    effort: "low",
    outputSchema: { required: ["title"], additionalProperties: false },
  });
  expect(client.calls[4]).toEqual({
    method: "thread/name/set",
    params: { threadId: "original", name: "Fix login timeout" },
  });
});

test("does not replace a manual name or persist malformed output", async () => {
  const manuallyNamed = fixture("My own name");
  await nameThreadFromPrompt(
    manuallyNamed,
    "original",
    "/fixture",
    "Fix login",
    "fallback-model",
  );
  expect(
    manuallyNamed.calls.some((call) => call.method === "thread/name/set"),
  ).toBe(false);
  expect(
    manuallyNamed.calls.find((call) => call.method === "turn/start")?.params
      ?.effort,
  ).toBeUndefined();

  const malformed = fixture(null, "not JSON");
  await nameThreadFromPrompt(
    malformed,
    "original",
    "/fixture",
    "Fix login",
    "gpt-6-luna",
    "low",
  );
  expect(
    malformed.calls.some((call) => call.method === "thread/name/set"),
  ).toBe(false);
  expect(malformed.calls.at(-1)?.method).toBe("thread/unsubscribe");
});

test("aborting an in-flight title request does not write a name or wait for completion", async () => {
  const client = fixture();
  const started = Promise.withResolvers<void>();
  const originalCall = client.call;
  client.call = async (method, params) => {
    if (method === "turn/start") {
      started.resolve();
      return { turn: { id: "never-completes" } };
    }
    return originalCall(method, params);
  };
  const controller = new AbortController();
  const naming = nameThreadFromPrompt(
    client,
    "original",
    "/fixture",
    "Fix login",
    "gpt-6-luna",
    "low",
    controller.signal,
  );
  await started.promise;
  controller.abort();
  await expect(naming).rejects.toBeDefined();
  expect(client.calls.some((call) => call.method === "thread/name/set")).toBe(
    false,
  );
});

test("title text is bounded and normalized without splitting Unicode", () => {
  expect(
    new TextEncoder().encode(titlePrompt("🚀".repeat(500))).length,
  ).toBeLessThanOrEqual(960);
  expect(parseTitle('{"title":"  “修复 登录 超时！”  "}')).toBe(
    "修复 登录 超时",
  );
  expect(parseTitle('{"title":""}')).toBeUndefined();
});
