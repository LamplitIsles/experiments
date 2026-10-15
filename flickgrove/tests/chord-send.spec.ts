import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
for (const [name, viewport] of [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
] as const) {
  test(`${name}: continuous messages echo before receipt, preserve editing, and reconcile without replay`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", { name: "Message Orc" });
    for (const text of [
      "First instruction",
      "Second instruction",
      "Third instruction",
    ]) {
      await input.fill(text);
      await input.press("Enter");
      await expect(input).toHaveValue("");
      await expect(input).toBeEnabled();
      await expect(
        page.locator(".user-message").filter({ hasText: text }),
      ).toHaveCount(1);
    }
    await expect(page.locator(".user-message [role=status]")).toHaveCount(0);
    await expect(page.locator(".detail-status")).toContainText("Working");
    await input.fill("A newer editable draft");
    await expect
      .poll(
        async () =>
          (
            (await (await request.get(origin + "/fixture/info")).json())
              .inputs as unknown[]
          ).length,
      )
      .toBe(1);
    await page.screenshot({
      path: `../.scratch/conversation-region-spinner/${viewport.width}-optimistic.png`,
      animations: "disabled",
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect
      .poll(
        async () =>
          (
            (await (await request.get(origin + "/fixture/info")).json())
              .inputs as unknown[]
          ).length,
      )
      .toBe(3);
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(info.inputs.map((i: { text: string }) => i.text)).toEqual([
      "First instruction",
      "Second instruction",
      "Third instruction",
    ]);
    expect(info.inputs[0].turnId).toBeUndefined();
    expect(info.inputs[1].turnId).toBeTruthy();
    expect(info.inputs[2].turnId).toBe(info.inputs[1].turnId);
    await expect(input).toHaveValue("A newer editable draft");
    await expect(page.locator(".user-message [role=status]")).toHaveCount(0);
    await page.screenshot({
      path: `../.scratch/flickgrove-results/delivery-success-${name}.png`,
    });
    await page.reload();
    await expect(input).toHaveValue("A newer editable draft");
    for (const text of [
      "First instruction",
      "Second instruction",
      "Third instruction",
    ])
      await expect(
        page.locator(".user-message").filter({ hasText: text }),
      ).toHaveCount(1);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toHaveLength(3);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(viewport.width);
  });
  test(`${name}: rejected content retries beside new draft; pending survives null lookup across refresh`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(viewport);
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", { name: "Message Orc" });
    await input.fill("Rejected content");
    await input.press("Enter");
    await input.fill("New draft");
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "rejected" },
    });
    await expect(
      page
        .locator(".user-message")
        .filter({ hasText: "Rejected content" })
        .getByRole("status"),
    ).toContainText("Needs attention");
    const failed = page
      .locator(".user-message")
      .filter({ hasText: "Rejected content" });
    await expect(failed.getByRole("status")).toContainText(
      "Synthetic rejection",
    );
    const retry = failed.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    const bubble = await failed.boundingBox(),
      button = await retry.boundingBox();
    expect(button!.x + button!.width).toBeLessThanOrEqual(bubble!.x);
    await page.screenshot({
      path: `../.scratch/conversation-region-spinner/${viewport.width}-failed-send.png`,
    });
    await page.reload();
    await expect(retry).toBeVisible();
    await expect(input).toHaveValue("New draft");
    await retry.click();
    await expect(failed.getByRole("status")).toContainText(
      "Synthetic rejection",
    );
    await expect(failed).toHaveCount(1);
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await input.evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.setSelectionRange(1, 3);
    });
    // Duplicate pointer dispatches must admit only the one explicit attempt.
    await retry.evaluate((el) => {
      (el as HTMLButtonElement).click();
      (el as HTMLButtonElement).click();
    });
    await expect(retry).toHaveCount(0);
    await expect(failed.getByRole("status")).toHaveCount(0);
    await expect(page.locator(".detail-status")).toContainText("Working");
    await expect(input).toHaveValue("New draft");
    await page.screenshot({
      path: `../.scratch/conversation-region-spinner/${viewport.width}-retrying.png`,
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect
      .poll(
        async () =>
          (await (await request.get(origin + "/fixture/info")).json()).inputs
            .length,
      )
      .toBe(3);
    await expect(failed).toHaveCount(1);
    await expect(failed.getByRole("status")).toHaveCount(0);
    await expect(input).toHaveValue("New draft");
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([1, 3]);
    await page.screenshot({
      path: `../.scratch/conversation-region-spinner/${viewport.width}-retried.png`,
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "uncertain" },
    });
    await input.fill("Unknown content");
    await input.press("Enter");
    const pending = page
      .locator(".user-message")
      .filter({ hasText: "Unknown content" });
    await expect(pending.getByRole("status")).toHaveCount(0);
    await expect(page.locator(".delivery-error")).toHaveCount(0);
    await page.reload();
    await expect(pending.getByRole("status")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check receipt" }),
    ).toHaveCount(0);
    await expect(
      page.locator(".user-message").filter({ hasText: "Unknown content" }),
    ).toHaveCount(1);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toHaveLength(4);
    await page.screenshot({
      path: `../.scratch/flickgrove-results/send-null-pending-${name}.png`,
      animations: "disabled",
    });
  });
}
test("lost receipt and state update recover from authority after refresh", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  let blocked = false;
  let sendId = "";
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    let first = true;
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.call?.member === "send") {
        sendId = frame.id;
        blocked = true;
      }
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "update" && blocked) return;
      if (frame.type === "result" && frame.id === sendId && first) {
        first = false;
        return;
      }
      ws.send(raw);
    });
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Accepted with lost receipt");
  await input.press("Enter");
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "Accepted with lost receipt" }),
  ).toHaveCount(1);
  await expect
    .poll(
      async () =>
        (
          (await (await request.get(origin + "/fixture/info")).json())
            .inputs as unknown[]
        ).length,
    )
    .toBe(1);
  blocked = false;
  await page.reload();
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "Accepted with lost receipt" }),
  ).toHaveCount(1);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(1);
});

test("an observed accepted input survives a late RPC error", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  let late: (() => void) | undefined;
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    let sendId = "";
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.call?.member === "send") sendId = frame.id;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "result" && frame.id === sendId) {
        late = () =>
          ws.send(
            JSON.stringify({
              type: "error",
              id: sendId,
              error: "Synthetic late failure",
            }),
          );
        return;
      }
      ws.send(raw);
    });
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Accepted before late error");
  await input.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith(`flickgrove/${location.origin}/outgoing/`),
          ).length,
      ),
    )
    .toBe(0);
  await expect.poll(() => !!late).toBe(true);
  late!();
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "Accepted before late error" }),
  ).toHaveCount(1);
  await expect(page.locator(".delivery-error")).toHaveCount(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(1);
});

test("two tabs cannot erase an unadmitted operation before its owner has a receipt", async ({
  page,
  context,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  const second = await context.newPage();
  let operationId = "";
  const lookups: string[] = [];
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.call?.member === "send") {
        operationId = frame.call.args[0].operationId;
        return; // Never admitted: there is no owner-side record to reconstruct.
      }
      if (frame.call?.member === "lookup")
        lookups.push(frame.call.args[0].operationId);
      server.send(raw);
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await page.goto(origin);
  await second.goto(origin); // Both modules hydrate before the first tab writes.
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Durable identity across tabs");
  await input.press("Enter");
  await expect.poll(() => operationId).not.toBe("");
  await second
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await expect(
    second.getByRole("textbox", { name: "Message Orc" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .locator(".user-message")
      .filter({ hasText: "Durable identity across tabs" }),
  ).toHaveCount(1);
  await expect.poll(() => lookups.includes(operationId)).toBe(true);
  const records = await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((key) =>
        key.startsWith(`flickgrove/${location.origin}/outgoing/`),
      )
      .map((key) => JSON.parse(localStorage.getItem(key)!)),
  );
  expect(records).toContainEqual(
    expect.objectContaining({
      id: operationId,
      text: "Durable identity across tabs",
    }),
  );
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toHaveLength(0);
  await second.close();
});

test("late original rejection cannot replace an active retry or its eventual native acceptance", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "rejected" },
  });
  let late: (() => void) | undefined,
    first = "";
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (f.call?.member === "send" && !first) first = f.id;
      server.send(raw);
    });
    server.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "result" && f.id === first) {
        late = () => ws.send(raw);
        return;
      }
      ws.send(raw);
    });
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Stable logical message");
  await input.press("Enter");
  const bubble = page
    .locator(".user-message")
    .filter({ hasText: "Stable logical message" });
  await expect(bubble.locator("small.failed")).toContainText(
    "Synthetic rejection",
  );
  await expect.poll(() => !!late).toBe(true);
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "held" },
  });
  await bubble.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(bubble.locator("small.failed")).toHaveCount(0);
  late!();
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator("small.failed")).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json()).inputs
          .length,
    )
    .toBe(2);
  await expect(bubble).toHaveCount(1);
  await expect(bubble.locator("small.failed")).toHaveCount(0);
});
