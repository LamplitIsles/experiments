import { expect, test } from "@playwright/test";
import { openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";
const markdown =
  "检查 **风险** 和 `路径`，参考[说明](https://example.test/guide)：\n补充说明\n\n- 第一项\n- 第二项";

async function supplyMarkdown(page: import("@playwright/test").Page) {
  await page.route("**/api/read/questions?*", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin },
    });
    const questions = await response.json();
    for (const question of questions) question.text = markdown;
    await route.fulfill({ response, json: questions });
  });
}

for (const width of [1440, 390]) {
  test(`renders question Markdown while answering and reviewing at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await supplyMarkdown(page);
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .first()
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message Orc", exact: true }),
    ).toBeVisible();
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "markdown", questionOptions: true },
    });
    const panel = page.locator(".question-panel");
    const question = panel.locator(".question-card");
    await expect(question.getByRole("heading", { level: 3 })).toContainText(
      "检查 风险 和 路径",
    );
    await expect(question.locator("strong")).toHaveText("风险");
    await expect(question.locator("code")).toHaveText("路径");
    expect(
      await question
        .locator(".markdown p")
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThan(35);
    await expect(question.locator("li")).toHaveText(["第一项", "第二项"]);
    await expect(question.getByRole("link", { name: "说明" })).toHaveAttribute(
      "href",
      "https://example.test/guide",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${width}-question.png`),
    });
    await panel.locator(".question-option").first().click();
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "held" },
    });
    await panel.getByRole("button", { name: "Send all answers" }).click();
    await expect(panel.locator(".answer-batch strong")).toHaveText("风险");
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "accepted" },
    });
    await expect(panel).not.toBeVisible();
    const info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs.at(-1).text).toContain("Answer: Recommended choice");
    await page
      .locator(".user-message")
      .filter({ hasText: "Recommended choice" })
      .getByRole("button", { name: "View questions and answers" })
      .click();
    await expect(question.locator("strong")).toHaveText("风险");
    await expect(panel.locator(".recorded-answer")).toContainText(
      "Recommended choice",
    );
  });
}

test("renders delegated member questions as Markdown", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "working" } });
  await supplyMarkdown(page);
  await page.goto(origin);
  await openSidebar(page);
  await page
    .locator(".session-row")
    .filter({
      has: page.getByRole("button", { name: "Open Streaming voice input Orc" }),
    })
    .first()
    .getByRole("button", { name: "Expand Workers" })
    .click();
  await page
    .getByRole("button", { name: "Open Voice input Worker" })
    .first()
    .click();
  await request.post(`${origin}/fixture/change`, {
    data: {
      question: true,
      questionAgent: "voice",
      questionId: "member-markdown",
    },
  });
  await page.getByRole("button", { name: "1 pending question" }).click();
  await expect(page.locator(".delegated-questions strong")).toHaveText("风险");
  await expect(page.locator(".delegated-questions li")).toHaveText([
    "第一项",
    "第二项",
  ]);
});
