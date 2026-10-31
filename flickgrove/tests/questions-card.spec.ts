import { openSidebar } from "./browser-actions";
import {
  expect,
  test,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import sharp from "sharp";
const origin = "http://127.0.0.1:14319";
const shots = new URL(
  "../../.scratch/questions-panel-readiness/screenshots",
  import.meta.url,
).pathname;
const panel = (page: Page) => page.locator(".question-panel");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
async function change(request: APIRequestContext, data: object) {
  return request.post(origin + "/fixture/change", { data });
}
async function start(page: Page, request: APIRequestContext, width = 1440) {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(origin);
  await openSidebar(page);
  if (width === 390) await page.locator(".session-open").first().click();
  await expect(composer(page)).toBeVisible();
}
async function inputs(request: APIRequestContext) {
  return (await (await request.get(origin + "/fixture/info")).json()).inputs;
}
async function question(
  request: APIRequestContext,
  id: string,
  count = 1,
  extra = {},
) {
  await change(request, {
    question: true,
    questionId: id,
    questionCount: count,
    questionOptions: false,
    ...extra,
  });
}
for (const width of [1440, 390]) {
  test(`card batch keyboard, queue, drafts and readonly restoration ${width}`, async ({
    page,
    request,
  }) => {
    await start(page, request, width);
    await composer(page).fill("ordinary $grove-research draft");
    const image = await sharp({
      create: { width: 30, height: 30, channels: 4, background: "#4080a0" },
    })
      .png()
      .toBuffer();
    await page.getByLabel("Choose message images").setInputFiles({
      name: "owned.png",
      mimeType: "image/png",
      buffer: image,
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await composer(page).evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(3, 8),
    );
    await question(request, "batch", 2);
    await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText(
      "batch question 1",
    );
    await expect(composer(page)).not.toBeVisible();
    await panel(page).locator("textarea").fill("First answer");
    await panel(page).locator("textarea").dispatchEvent("compositionstart");
    await panel(page).locator("textarea").press("Enter");
    await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText(
      "batch question 1",
    );
    await panel(page).locator("textarea").dispatchEvent("compositionend");
    await panel(page).locator("textarea").press("Enter");
    await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText(
      "batch question 2",
    );
    await panel(page).locator("textarea").fill("Second answer");
    await panel(page).locator("textarea").press("Shift+Enter");
    await expect(panel(page).locator("textarea")).toHaveValue(
      "Second answer\n",
    );
    await question(request, "queued");
    await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText(
      "batch question 2",
    );
    await panel(page)
      .getByRole("button", { name: "Collapse questions" })
      .click();
    await expect(composer(page)).toHaveValue("ordinary $grove-research draft");
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect
      .poll(() =>
        composer(page).evaluate((el: HTMLTextAreaElement) => [
          el.selectionStart,
          el.selectionEnd,
        ]),
      )
      .toEqual([3, 8]);
    await change(request, {
      append: { agentId: "orc", text: "ordinary update" },
    });
    await expect(panel(page)).not.toBeVisible();
    // Re-enter the same conversation, including a previously collapsed batch.
    if (width === 390) {
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
      await page.locator(".session-open").first().click();
    } else {
      await page.reload();
    }
    await expect(panel(page).locator("textarea")).toHaveValue(
      "Second answer\n",
    );
    const before = (await inputs(request)).length;
    await panel(page)
      .getByRole("button", { name: "Send all answers", exact: true })
      .click();
    await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText(
      "queued question 1",
    );
    expect((await inputs(request)).length).toBe(before + 1);
    const sent = (await inputs(request)).at(-1).text;
    expect(sent).toContain("batch question 1");
    expect(sent).toContain("batch question 2");
    expect(sent).not.toContain("queued question");
    await panel(page).locator("textarea").fill("Keep this pending draft");
    // Answer message identity supplies a readonly entry without text parsing.
    const answerEntry = page
      .locator(".user-message")
      .filter({ hasText: "First answer" })
      .getByRole("button", { name: "View questions and answers" });
    await answerEntry.focus();
    await answerEntry.press("Enter");
    await expect(
      panel(page).getByText("Questions and answers · Read only"),
    ).toBeVisible();
    await expect(panel(page).locator(".recorded-answer")).toContainText(
      "First answer",
    );
    await expect(panel(page).locator("textarea:visible")).toHaveCount(0);
    await expect(
      panel(page).getByRole("button", { name: "Send all answers" }),
    ).not.toBeVisible();
    await page.screenshot({ path: `${shots}/${width}-readonly.png` });
    await question(request, "during-review");
    await expect(panel(page).locator(".recorded-answer")).toContainText(
      "First answer",
    );
    await panel(page)
      .getByRole("button", { name: "Next question" })
      .filter({ visible: true })
      .click();
    await expect(panel(page).locator(".recorded-answer")).toContainText(
      "Second answer",
    );
    await panel(page)
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(panel(page).locator("textarea")).toHaveValue(
      "Keep this pending draft",
    );
    await panel(page)
      .getByRole("button", { name: "Collapse questions" })
      .click();
    await answerEntry.click();
    await expect(panel(page).locator(".recorded-answer")).toContainText(
      "First answer",
    );
    await page.keyboard.press("Escape");
    await expect(panel(page)).not.toBeVisible();
    await expect(composer(page)).toHaveValue("ordinary $grove-research draft");
    await page.screenshot({ path: `${shots}/${width}-collapsed.png` });
  });
  test(`loading retry long options, single choice and Enter validation ${width}`, async ({
    page,
    request,
  }) => {
    await start(page, request, width);
    let fail = true;
    const gate = Promise.withResolvers<void>();
    await page.route("**/api/read/questions?*", async (route) => {
      if (!fail) {
        await route.continue();
        return;
      }
      await gate.promise;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Owned question read failure" }),
      });
    });
    await question(request, "choices", 2, {
      questionOptions: true,
      questionLong: true,
    });
    await expect(panel(page).getByRole("status")).toContainText(
      "Loading questions",
    );
    await page.screenshot({ path: `${shots}/${width}-loading.png` });
    gate.resolve();
    await expect(panel(page).getByRole("alert")).toContainText(
      "Owned question read failure",
    );
    await page.screenshot({ path: `${shots}/${width}-failed.png` });
    fail = false;
    await panel(page)
      .getByRole("button", { name: "Retry", exact: true })
      .click();
    await expect(panel(page).locator(".question-option")).toHaveCount(2);
    const before = (await inputs(request)).length;
    await panel(page).getByRole("button", { name: "Next question" }).focus();
    await panel(page)
      .getByRole("button", { name: "Next question" })
      .press("Enter");
    await expect(
      panel(page).getByText("Question 2 of 2", { exact: true }),
    ).toBeVisible();
    await panel(page)
      .getByRole("button", { name: "Previous question" })
      .focus();
    await panel(page)
      .getByRole("button", { name: "Previous question" })
      .press("Enter");
    await expect(
      panel(page).getByText("Question 1 of 2", { exact: true }),
    ).toBeVisible();
    // Unmarked first option must not be selected implicitly.
    await panel(page).locator(".question-option").first().focus();
    await panel(page).locator(".question-option").first().press("Tab");
    await expect(panel(page).locator(".question-option").last()).toBeFocused();
    await panel(page).locator(".question-option").last().press("Shift+Tab");
    await expect(panel(page).locator(".question-option").first()).toBeFocused();
    await panel(page).locator(".question-option").first().press("Enter");
    expect((await inputs(request)).length).toBe(before);
    await expect(panel(page).getByRole("status")).toContainText(
      "Answer this question",
    );
    await panel(page).locator(".question-option").first().press("Space");
    await expect(
      panel(page).getByText("Question 2 of 2", { exact: true }),
    ).toBeVisible();
    await panel(page).locator(".question-option").last().click();
    expect((await inputs(request)).length).toBe(before);
    await page.screenshot({ path: `${shots}/${width}-long-options.png` });
    const footer = await panel(page).locator(".question-footer").boundingBox();
    expect(footer!.y + footer!.height).toBeLessThan(width === 390 ? 844 : 900);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel(page).locator(".question-option").first().focus();
    await panel(page).locator(".question-option").first().press("Enter");
    await expect(panel(page)).not.toBeVisible();
    expect((await inputs(request)).length).toBe(before + 1);
  });
}
test("unknown frozen batch never replays, rejected batch retries once", async ({
  page,
  request,
}) => {
  await start(page, request);
  await question(request, "unknown", 1, { sendMode: "uncertain" });
  await panel(page).locator("textarea").fill("frozen");
  const before = (await inputs(request)).length;
  await panel(page).getByRole("button", { name: "Send all answers" }).click();
  await expect(panel(page).locator(".answer-batch")).toContainText("Sending");
  await question(request, "arrival");
  await expect(panel(page).locator(".answer-batch")).toContainText("frozen");
  await page.reload();
  await expect(panel(page).locator(".answer-batch")).toContainText("frozen");
  expect((await inputs(request)).length).toBe(before + 1);
  await expect(panel(page).getByRole("button", { name: "Retry" })).toHaveCount(
    0,
  );
  // Separate test-owned scenario for definitive rejection and explicit retry.
  await start(page, request);
  await question(request, "failed", 1, { sendMode: "rejected" });
  await panel(page).locator("textarea").fill("retained");
  await panel(page).getByRole("button", { name: "Send all answers" }).click();
  await expect(panel(page).locator(".answer-batch")).toContainText(
    "Synthetic rejection",
  );
  await change(request, { sendMode: "accepted" });
  await panel(page).getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel(page)).not.toBeVisible();
  expect((await inputs(request)).at(-1).text).toContain("retained");
});

test("marked first recommendation is only a draft; Stop remains independent while answers are pending", async ({
  page,
  request,
}) => {
  await start(page, request);
  const before = (await inputs(request)).length;
  await question(request, "recommended", 1, {
    questionOptions: true,
    questionRecommended: true,
  });
  await expect(panel(page).locator(".question-option").first()).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await inputs(request)).length).toBe(before);
  await panel(page)
    .getByRole("button", { name: "Stop Orc", exact: true })
    .click();
  await expect(panel(page).getByRole("heading", { level: 3 })).toHaveText(
    "recommended question 1",
  );
  expect((await inputs(request)).length).toBe(before);
  // Stop is an execution action, not a question answer or cancellation.
  await change(request, { complete: "interrupted" });
  await expect(
    panel(page).getByRole("button", { name: "Send all answers" }),
  ).toBeEnabled();
  await panel(page).getByRole("button", { name: "Send all answers" }).click();
  await expect(panel(page)).not.toBeVisible();
  expect((await inputs(request)).at(-1).text).toContain(
    "Recommended choice (Recommended)",
  );
});

test("answered original question reopens from an earlier native HTTP page without duplicates", async ({
  page,
  request,
}) => {
  await start(page, request);
  await question(request, "paged-original");
  await panel(page).locator("textarea").fill("paged recorded answer");
  await panel(page).locator("textarea").press("Enter");
  await expect(panel(page)).not.toBeVisible();
  for (let i = 0; i < 110; i++)
    await change(request, {
      append: { agentId: "orc", text: `Native later item ${i}` },
    });
  await page.reload();
  await expect(composer(page)).toBeVisible();
  const conversation = page.locator(".conversation");
  await conversation.evaluate((el) => (el.scrollTop = 0));
  // Await each actual HTTP page before scrolling the virtualized prefix.
  for (let i = 0; i < 5; i++) {
    const earlier = page.getByRole("button", {
      name: "Load earlier messages",
      exact: true,
    });
    if (!(await earlier.count())) break;
    await expect(earlier).toBeEnabled();
    const response = page.waitForResponse(
      (r) =>
        r.url().includes("/api/read/messages?") &&
        r.request().method() === "GET",
    );
    await earlier.click();
    expect((await response).status()).toBe(200);
    await expect(
      page.getByText("Loading conversation…", { exact: true }),
    ).toHaveCount(0);
    await conversation.evaluate(async (el) => {
      el.scrollTop = 0;
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    if (await page.locator('[data-message-id="paged-original"]').count()) break;
  }
  const entry = page.locator('[data-message-id="paged-original"]');
  await expect(entry).toHaveCount(1);
  await entry
    .getByRole("button", { name: "View questions and answers" })
    .click();
  await expect(panel(page).locator(".recorded-answer")).toContainText(
    "paged recorded answer",
  );
  await expect(
    panel(page).getByRole("button", { name: "Send all answers" }),
  ).toHaveCount(0);
  expect(
    (await inputs(request)).filter((i: any) =>
      i.text.includes("paged recorded answer"),
    ),
  ).toHaveLength(1);
});

test("a new browser freezes an unresolved answer outside the delivery window from its original HTTP identity", async ({
  page,
  request,
  browser,
}) => {
  await start(page, request);
  await question(request, "old-window", 1, { sendMode: "uncertain" });
  await panel(page).locator("textarea").fill("Original frozen outside window");
  await panel(page).locator("textarea").press("Enter");
  await expect(panel(page).locator(".answer-batch")).toContainText(
    "Original frozen outside window",
  );
  const operation = await panel(page)
    .locator(".answer-batch")
    .getAttribute("data-operation-id");
  await change(request, { sendMode: "accepted", laterSubmissions: 105 });
  const before = (await inputs(request)).length;
  const context = await browser.newContext();
  try {
    const observer = await context.newPage();
    await observer.goto(origin);
    await expect(panel(observer).locator(".answer-batch")).toHaveAttribute(
      "data-operation-id",
      operation!,
    );
    await expect(panel(observer).locator(".answer-batch")).toContainText(
      "Original frozen outside window",
    );
    await expect(panel(observer).locator("textarea")).toHaveCount(0);
    await expect(
      panel(observer).getByRole("button", { name: "Retry" }),
    ).toHaveCount(0);
    expect((await inputs(request)).length).toBe(before);
  } finally {
    await context.close();
  }
});
