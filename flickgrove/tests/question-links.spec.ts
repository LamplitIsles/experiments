import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { newSession, openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";

for (const width of [1440, 390])
  test(`question file previews use the original session at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "working" },
    });
    const snapshot = await (
      await request.get(`${origin}/fixture/snapshot`)
    ).json();
    const orc = snapshot.agents.find(
      (agent: { title: string }) => agent.title === "Streaming voice input",
    );
    expect(orc.project.path).toMatch(/^\/tmp\/grove-design-preview-/);
    await mkdir(orc.project.path, { recursive: true });
    await writeFile(
      join(orc.project.path, "question.md"),
      "# Question fixture\n",
    );
    await page.route("**/api/read/questions?*", async (route) => {
      const response = await route.fetch({
        headers: { ...route.request().headers(), origin },
      });
      const questions = await response.json();
      for (const question of questions)
        question.text =
          "See [local file](question.md) and [unsafe](javascript:alert(1)).\nSecond line";
      await route.fulfill({ response, json: questions });
    });
    const previewAgents: string[] = [];
    page.on("request", (req) => {
      if (req.url().endsWith("/api/file-preview"))
        previewAgents.push(req.postDataJSON().agent);
    });
    await page.goto(origin);
    await openSidebar(page);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .first()
      .click();
    await request.post(`${origin}/fixture/change`, {
      data: { question: true, questionId: "links", questionOptions: false },
    });
    const panel = page.locator(".question-panel");
    const drawer = page.getByRole("region", { name: "File preview" });
    const file = panel.getByRole("link", { name: "local file" });
    await expect(file).toBeVisible();
    await expect(panel.locator('a[href^="javascript:"]')).toHaveCount(0);
    await panel.locator("textarea").fill("First line\nSecond line");
    await file.focus();
    await file.press("Enter");
    await expect(drawer).toBeVisible();
    await expect(
      drawer
        .frameLocator("iframe")
        .getByRole("heading", { name: "Question fixture" }),
    ).toBeVisible();
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect(panel.locator("textarea")).toHaveValue(
      "First line\nSecond line",
    );
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "held" },
    });
    await panel.locator("textarea").press("Enter");
    await expect(panel.locator(".answer-batch")).toContainText("First line");
    await expect(panel.locator(".answer-batch")).toContainText("Second line");
    await panel
      .locator(".answer-batch")
      .getByRole("link", { name: "local file" })
      .click();
    await expect(
      drawer
        .frameLocator("iframe")
        .getByRole("heading", { name: "Question fixture" }),
    ).toBeVisible();
    await page.goBack();
    await request.post(`${origin}/fixture/change`, {
      data: { sendMode: "accepted" },
    });
    await expect(panel).not.toBeVisible();
    await page
      .locator(".user-message")
      .filter({ hasText: "First line" })
      .getByRole("button", { name: "View questions and answers" })
      .click();
    await panel.getByRole("link", { name: "local file" }).click();
    await expect(
      drawer
        .frameLocator("iframe")
        .getByRole("heading", { name: "Question fixture" }),
    ).toBeVisible();
    await page.goBack();
    await panel.getByRole("button", { name: "Close", exact: true }).click();

    await newSession(page);
    await page
      .getByRole("option", { name: "Codex for Love", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    await page
      .locator(".history-result")
      .filter({ hasText: "Streaming voice input" })
      .click();
    const transcript = page.locator(".history-transcript");
    await transcript
      .getByRole("button", { name: "View questions and answers" })
      .first()
      .click();
    const historyPanel = page.getByRole("region", {
      name: "Questions and answers",
    });
    await historyPanel.getByRole("link", { name: "local file" }).click();
    await expect(
      drawer
        .frameLocator("iframe")
        .getByRole("heading", { name: "Question fixture" }),
    ).toBeVisible();
    await expect(drawer.getByRole("status")).toHaveCount(0);
    await drawer
      .frameLocator("iframe")
      .locator("body")
      .evaluate(async () => {
        await document.fonts.ready;
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
    await page.screenshot({
      path: testInfo.outputPath(`${width}-history-preview.png`),
    });
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await expect(
      historyPanel.getByRole("link", { name: "local file" }),
    ).toBeVisible();
    await page.goBack();
    await page.getByRole("switch", { name: "Only Orc" }).click();
    await page
      .locator(".history-result")
      .filter({ has: page.getByText("Voice input", { exact: true }) })
      .click();
    await page.getByRole("button", { name: "View owning Orc" }).click();
    await page
      .locator(".history-transcript")
      .getByRole("button", { name: "View questions and answers" })
      .first()
      .click();
    await historyPanel.getByRole("link", { name: "local file" }).click();
    await expect(
      drawer
        .frameLocator("iframe")
        .getByRole("heading", { name: "Question fixture" }),
    ).toBeVisible();
    await page.goBack();
    expect(previewAgents).toEqual([orc.id, orc.id, orc.id, orc.id, orc.id]);
    const info = await (await request.get(`${origin}/fixture/info`)).json();
    expect(info.inputs.at(-1).text).toContain(
      "Answer: First line\nSecond line",
    );
  });

test("member question preview uses the member identity", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "working" } });
  const snapshot = await (
    await request.get(`${origin}/fixture/snapshot`)
  ).json();
  const worker = snapshot.agents.find(
    (agent: { title: string }) => agent.title === "Voice input",
  );
  expect(worker.project.path).toMatch(/^\/tmp\/grove-design-preview-/);
  await mkdir(worker.project.path, { recursive: true });
  await writeFile(join(worker.project.path, "member.md"), "# Member fixture\n");
  await page.route("**/api/read/questions?*", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin },
    });
    const questions = await response.json();
    for (const question of questions)
      question.text = "[Member file](member.md)\nSecond line";
    await route.fulfill({ response, json: questions });
  });
  const previewAgents: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/file-preview"))
      previewAgents.push(req.postDataJSON().agent);
  });
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
    data: { question: true, questionAgent: "voice", questionId: "member-link" },
  });
  await page.getByRole("button", { name: "1 pending question" }).click();
  const member = page.locator(".delegated-questions");
  await expect(member).toContainText("Second line");
  await member.getByRole("link", { name: "Member file" }).click();
  const drawer = page.getByRole("region", { name: "File preview" });
  await expect(
    drawer
      .frameLocator("iframe")
      .getByRole("heading", { name: "Member fixture" }),
  ).toBeVisible();
  await page.goBack();
  await expect(member.getByRole("link", { name: "Member file" })).toBeVisible();
  expect(previewAgents).toEqual([worker.id]);
});

test("history without a known session explains unavailable local file preview", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "working" } });
  await request.post(`${origin}/fixture/change`, {
    data: { externalQuestionHistory: true },
  });
  await page.route("**/api/read/questions?*", async (route) => {
    const response = await route.fetch({
      headers: { ...route.request().headers(), origin },
    });
    await route.fulfill({
      response,
      status: 200,
      json: [
        {
          id: "external-q",
          itemId: "external-question",
          index: 0,
          title: "Question",
          text: "See [local file](question.md) and [file URL](file:///tmp/question.md).",
          options: [],
          state: "answered",
          answer: "Done",
          at: 1,
        },
      ],
    });
  });
  const previewAgents: string[] = [];
  page.on("request", (req) => {
    if (req.url().endsWith("/api/file-preview"))
      previewAgents.push(req.postDataJSON().agent);
  });
  await page.goto(origin);
  await openSidebar(page);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .first()
    .click();
  await newSession(page);
  await page
    .getByRole("option", { name: "Codex for Love", exact: true })
    .click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  await page.getByRole("switch", { name: "Only Orc" }).click();
  await page
    .locator(".history-result")
    .filter({ hasText: "External question history" })
    .click();
  await page
    .locator(".history-transcript")
    .getByRole("button", { name: "View questions and answers" })
    .click();
  const panel = page.getByRole("region", { name: "Questions and answers" });
  await expect(panel).toContainText("Open this session to preview the file.");
  await expect(panel.getByRole("link", { name: "local file" })).toHaveCount(0);
  await expect(panel.getByRole("link", { name: "file URL" })).toHaveCount(0);
  await expect(
    panel.getByText("file URL (Open this session to preview the file.)"),
  ).toBeVisible();
  await page.goBack();
  await page.goBack();
  expect(previewAgents).toEqual([]);
  await expect(page.getByRole("region", { name: "File preview" })).toHaveCount(
    0,
  );
});
