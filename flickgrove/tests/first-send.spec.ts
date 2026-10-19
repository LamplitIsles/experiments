import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { newSession, createSession } from "./browser-actions";
let server: ChildProcess, origin: string;
test.beforeEach(async () => {
  server = spawn("bun", ["tests/empty-session-serve.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: ["ignore", "pipe", "inherit"],
  });
  origin = String((await once(server.stdout!, "data"))[0]).trim();
});
test.afterEach(async () => {
  const exited = once(server, "exit");
  server.kill("SIGTERM");
  await exited;
});
for (const width of [1440, 390]) {
  test(`fresh empty restart rejects before native send with original identity at ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const results = new Map<string, unknown>();
    const calls = new Map<string, { member: string; operation?: string }>();
    page.on("websocket", (ws) => {
      ws.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.call)
          calls.set(frame.id, {
            member: frame.call.member,
            operation: frame.call.args[0]?.operationId,
          });
      });
      ws.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "result") results.set(frame.id, frame.result);
      });
    });
    await page.goto(origin);
    await newSession(page);
    await page.getByRole("option", { name: "Fixture", exact: true }).click();
    await createSession(page);
    const id = await page.evaluate(
      () => history.state.grove.details.at(-1) as string,
    );
    const requests = async () => {
      const r = await page.request.get(origin + "/fixture/requests");
      expect(r.status()).toBe(200);
      return r.json();
    };
    expect(
      (await requests()).filter(
        (r: { method: string }) => r.method === "thread/items/list",
      ),
    ).toHaveLength(0);
    expect(
      (
        await page.request.post(origin + "/fixture/control", {
          data: { missingRollout: true, itemsUnsupported: true },
        })
      ).status(),
    ).toBe(200);
    expect(
      (await page.request.post(origin + "/fixture/restart")).status(),
    ).toBe(200);
    await page.reload();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("First owned input after restart");
    const submittedAt = Date.now();
    await input.press("Enter");
    const message = page
      .locator(".user-message")
      .filter({ hasText: "First owned input after restart" });
    await expect(message).toHaveCount(1);
    // Exact first-input regression: no indefinite Sending for a failed open.
    await expect(message.getByRole("status")).toContainText("Needs attention");
    const settledMs = Date.now() - submittedAt;
    await expect(message.getByRole("status")).toContainText(
      "JSON-RPC error -32600: no rollout found for thread id thread-fake",
    );
    const operation = [...calls.values()].find(
      (c) => c.member === "send",
    )!.operation!;
    await expect
      .poll(() =>
        [...calls]
          .filter(([, c]) => c.member === "lookup" && c.operation === operation)
          .map(([id]) => results.get(id)),
      )
      .toContainEqual(
        expect.objectContaining({ operationId: operation, state: "rejected" }),
      );
    const native = await requests();
    expect(
      native.filter((r: { method: string }) => r.method === "turn/start"),
    ).toHaveLength(0);
    expect(
      native.filter((r: { method: string }) => r.method === "thread/start"),
    ).toHaveLength(1);
    expect(
      await (await page.request.get(origin + "/fixture/inputs")).json(),
    ).toEqual([]);
    const read = await page.request.get(
      origin + "/api/read/messages?" + new URLSearchParams({ agent: id }),
      { headers: { Origin: origin, "X-Grove-Peer": id.split(":")[0] } },
    );
    expect(read.status()).toBe(400);
    expect((await read.json()).error).toBe(
      "JSON-RPC error -32601: thread/items/list is not supported yet",
    );
    await expect(page.locator(".history-controls [role=alert]")).toHaveText(
      "JSON-RPC error -32601: thread/items/list is not supported yet",
    );
    await input.fill("Newer draft");
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: `../.scratch/send-freeze-after-questions-card/rejected-${width}.png`,
      animations: "disabled",
    });
    await message.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(message.getByRole("status")).toContainText("Needs attention");
    await expect(input).toHaveValue("Newer draft");
    await page.reload();
    await expect(message).toHaveCount(1);
    expect(
      (await requests()).filter(
        (r: { method: string }) => r.method === "turn/start",
      ),
    ).toHaveLength(0);
    console.log(
      "PRE-ADMISSION",
      JSON.stringify({
        width,
        operation,
        nativeSendCalls: 0,
        ordinaryTurns: 0,
        threadStarts: 1,
        readStatus: 400,
        settledMs,
      }),
    );
  });
}

test("attempted input stays unknown across restart and read failure without replay", async ({
  page,
}) => {
  const lookupIds = new Set<string>();
  const lookupResults: unknown[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.call?.member === "lookup") lookupIds.add(frame.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "result" && lookupIds.has(frame.id))
        lookupResults.push(frame.result);
    });
  });
  expect(
    (
      await page.request.post(origin + "/fixture/control", {
        data: { itemsUnsupported: true, holdTurnAdmission: true },
      })
    ).status(),
  ).toBe(200);
  await page.goto(origin);
  await newSession(page);
  await page.getByRole("option", { name: "Fixture", exact: true }).click();
  await createSession(page);
  const id = await page.evaluate(
    () => history.state.grove.details.at(-1) as string,
  );
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Unknown owned input");
  await input.press("Enter");
  const message = page
    .locator(".user-message")
    .filter({ hasText: "Unknown owned input" });
  await expect(message.getByRole("status")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(origin + "/fixture/inputs")).json())
          .length,
    )
    .toBe(1);
  const read = await page.request.get(
    origin + "/api/read/messages?" + new URLSearchParams({ agent: id }),
    { headers: { Origin: origin, "X-Grove-Peer": id.split(":")[0] } },
  );
  expect(read.status()).toBe(400);
  expect((await read.json()).error).toBe(
    "JSON-RPC error -32601: thread/items/list is not supported yet",
  );
  expect(
    (
      await page.request.post(origin + "/fixture/control", {
        data: {
          itemsUnsupported: true,
          missingRollout: true,
          holdTurnAdmission: true,
        },
      })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(origin + "/fixture/restart")).status()).toBe(
    200,
  );
  await page.reload();
  await expect(message.getByRole("status")).toHaveCount(0);
  await expect.poll(() => lookupResults).toContainEqual(null);
  await expect(page.locator(".delivery-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Restore to draft", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        Object.keys(localStorage).filter((k) => k.includes("/accepted/"))
          .length,
    ),
  ).toBe(0);
  expect(
    (await (await page.request.get(origin + "/fixture/inputs")).json()).length,
  ).toBe(1);
  const native = await (
    await page.request.get(origin + "/fixture/requests")
  ).json();
  expect(
    native.filter((r: { method: string }) => r.method === "turn/start"),
  ).toHaveLength(1);
  expect(
    native.filter((r: { method: string }) => r.method === "thread/start"),
  ).toHaveLength(1);
  console.log(
    "UNKNOWN",
    JSON.stringify({
      nativeSendCalls: 1,
      ordinaryTurns: 1,
      threadStarts: 1,
      accepted: 0,
    }),
  );
});

test("resumed empty thread admits first input while unsupported history stays actionable", async ({
  page,
}) => {
  let operation: string | undefined;
  const lookupIds = new Set<string>();
  const receipts: unknown[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const f = JSON.parse(String(payload));
      if (f.call?.member === "send") operation = f.call.args[0].operationId;
      if (f.call?.member === "lookup") lookupIds.add(f.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const f = JSON.parse(String(payload));
      if (f.type === "result" && lookupIds.has(f.id)) receipts.push(f.result);
    });
  });
  await page.goto(origin);
  await newSession(page);
  await page.getByRole("option", { name: "Fixture", exact: true }).click();
  await createSession(page);
  const id = await page.evaluate(
    () => history.state.grove.details.at(-1) as string,
  );
  // Native resume is available with its default null cursor; only reading fails.
  expect(
    (
      await page.request.post(origin + "/fixture/control", {
        data: { missingRollout: false, itemsUnsupported: true },
      })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(origin + "/fixture/restart")).status()).toBe(
    200,
  );
  await page.reload();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Resumed first owned input");
  await input.press("Enter");
  const message = page
    .locator(".user-message")
    .filter({ hasText: "Resumed first owned input" });
  await expect(message).toHaveCount(1);
  await expect(message.getByRole("status")).toHaveCount(0);
  await expect
    .poll(() => receipts)
    .toContainEqual(
      expect.objectContaining({ operationId: operation, state: "accepted" }),
    );
  expect(
    await (await page.request.get(origin + "/fixture/inputs")).json(),
  ).toEqual([{ operation }]);
  const native = await (
    await page.request.get(origin + "/fixture/native-inputs")
  ).json();
  expect(native).toHaveLength(1);
  expect(native[0].clientId).toBe(operation);
  const requests = await (
    await page.request.get(origin + "/fixture/requests")
  ).json();
  expect(
    requests.filter(
      (r: { method: string; operation?: string }) =>
        r.method === "turn/start" && r.operation === operation,
    ),
  ).toHaveLength(1);
  expect(
    requests.filter(
      (r: { method: string; ephemeral?: boolean }) =>
        r.method === "thread/start" && !r.ephemeral,
    ),
  ).toHaveLength(1);
  expect(
    requests.filter(
      (r: { method: string; threadId?: string }) =>
        r.method === "thread/resume" && r.threadId === "thread-fake",
    ).length,
  ).toBeGreaterThan(0);
  const read = await page.request.get(
    origin + "/api/read/messages?" + new URLSearchParams({ agent: id }),
    { headers: { Origin: origin, "X-Grove-Peer": id.split(":")[0] } },
  );
  expect(read.status()).toBe(400);
  expect((await read.json()).error).toBe(
    "JSON-RPC error -32601: thread/items/list is not supported yet",
  );
  await expect(page.locator(".history-controls [role=alert]")).toHaveText(
    "JSON-RPC error -32601: thread/items/list is not supported yet",
  );
  await expect(
    page
      .locator(".history-controls")
      .getByRole("button", { name: "Retry", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".delivery-error")).toHaveCount(0);
  await page.reload();
  await expect(message).toHaveCount(1);
  await expect(message.getByRole("status")).toHaveCount(0);
  expect(
    await (await page.request.get(origin + "/fixture/native-inputs")).json(),
  ).toEqual(native);
  console.log(
    "RESUMED-READ",
    JSON.stringify({
      operation,
      nativeClientId: native[0].clientId,
      nativeInputs: native.length,
      nativeSendCalls: 1,
      ordinaryTurns: 1,
      readStatus: 400,
    }),
  );
});
