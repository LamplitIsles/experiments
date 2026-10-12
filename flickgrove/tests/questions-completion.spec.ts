import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const panel = (page: Page) => page.locator(".question-panel");
const input = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const change = (request: APIRequestContext, data: object) =>
  request.post(origin + "/fixture/change", { data });
async function start(page: Page, request: APIRequestContext, width = 1440) {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(origin);
  if (width === 390) await page.locator(".session-open").first().click();
  await expect(input(page)).toBeVisible();
}
for (const width of [1440, 390])
  test(`pending arrivals and completion respect foreground Settings ${width}`, async ({
    page,
    request,
  }) => {
    await start(page, request, width);
    await input(page).fill("ordinary draft");
    // Open settings before arrival. It keeps focus and remains the foremost layer.
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const focused = await page.evaluate(
      () => document.activeElement?.outerHTML,
    );
    await change(request, {
      question: true,
      questionId: "foreground",
      questionOptions: false,
    });
    await expect(panel(page)).not.toBeVisible();
    expect(await page.evaluate(() => document.activeElement?.outerHTML)).toBe(
      focused,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(panel(page).locator("h3")).toHaveText("foreground question 1");
    await panel(page).locator("textarea").fill("frozen answer");
    await change(request, { sendMode: "held" });
    await panel(page).locator("textarea").press("Enter");
    await page.keyboard.press("Enter");
    await expect(panel(page).locator(".answer-batch")).toContainText(
      "frozen answer",
    );
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await change(request, { sendMode: "accepted" });
    await expect(panel(page)).not.toBeVisible();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(input(page)).toHaveValue("ordinary draft");
  });
test("mobile New/Back and widening preserve questions and foreground hierarchy", async ({
  page,
  request,
}) => {
  await start(page, request, 390);
  await input(page).fill("navigation draft");
  await input(page).evaluate((el) => el.blur());
  await page.keyboard.press("n");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox").first();
  await field.fill("New draft");
  await change(request, {
    question: true,
    questionId: "deferred",
    questionOptions: false,
  });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("New draft");
  await expect(panel(page)).not.toBeVisible();
  await page.goBack();
  await expect(panel(page).locator("h3")).toHaveText("deferred question 1");
  await panel(page).locator("textarea").fill("question draft");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual([]);
  await expect(panel(page).locator("textarea")).toHaveValue("question draft");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => history.state.grove.surfaces))
    .toEqual(["questions"]);
  await page.goBack();
  await expect(panel(page)).not.toBeVisible();
  await expect(input(page)).toHaveValue("navigation draft");
  await page.goBack();
  await expect(page.locator(".session-list")).toBeVisible();
  await page.locator(".session-open").first().click();
  await expect(panel(page).locator("textarea")).toHaveValue("question draft");
});
test("unadmitted answer retains exact identity after reload and null lookup never replays", async ({
  page,
  request,
}) => {
  let intercepted: any;
  await page.routeWebSocket(
    origin.replace("http:", "ws:") + "/api/socket",
    (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.call?.member === "answerBatch")
          intercepted = message.call.args[0];
        else server.send(raw);
      });
    },
  );
  await start(page, request);
  await change(request, {
    question: true,
    questionId: "unadmitted",
    questionOptions: false,
  });
  await panel(page).locator("textarea").fill("original envelope");
  const before = (await (await request.get(origin + "/fixture/info")).json())
    .inputs.length;
  await panel(page).locator("textarea").press("Enter");
  await expect.poll(() => intercepted).toBeDefined();
  await expect(panel(page).locator(".answer-batch")).toHaveAttribute(
    "data-operation-id",
    intercepted.operationId,
  );
  await change(request, {
    question: true,
    questionId: "new",
    questionOptions: false,
  });
  await page.reload();
  await expect(panel(page).locator(".answer-batch")).toHaveAttribute(
    "data-operation-id",
    intercepted.operationId,
  );
  await expect(panel(page).locator(".answer-batch")).toContainText(
    "original envelope",
  );
  await expect(panel(page).getByRole("button", { name: "Retry" })).toHaveCount(
    0,
  );
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.length,
  ).toBe(before);
});
test("late readonly load cannot replace a different Peer; reconnect reopens answered native item", async ({
  page,
  request,
}) => {
  await start(page, request);
  await change(request, {
    question: true,
    questionId: "record",
    questionOptions: false,
  });
  await panel(page).locator("textarea").fill("recorded answer");
  await panel(page).locator("textarea").press("Enter");
  await expect(panel(page)).not.toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/read/questions?*item=record", async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  await page
    .locator('[data-message-id="record"]')
    .getByRole("button", { name: "View questions and answers" })
    .click();
  await expect(panel(page).getByRole("status")).toContainText(
    "Loading questions",
  );
  await page.getByRole("button", { name: "Neil’s Mac", exact: true }).click();
  release();
  await expect(page.locator(".detail-heading h1")).toContainText(
    "Reader performance",
  );
  await expect(panel(page)).not.toBeVisible();
  await page.getByRole("button", { name: /^NUC/ }).click();
  await page.reload();
  await expect(input(page)).toBeVisible();
  await page
    .locator('[data-message-id="record"]')
    .getByRole("button", { name: "View questions and answers" })
    .click();
  await expect(panel(page).locator(".recorded-answer")).toContainText(
    "recorded answer",
  );
  await expect(panel(page).locator("textarea:visible")).toHaveCount(0);
});
