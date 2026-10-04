import { expect, test } from "@playwright/test";
import { newSession, createSession } from "./browser-actions";

for (const mobile of [false, true]) {
  test(`N panel finds history, preserves Back, handles locks and resumes the original conversation (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await newSession(page);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await page
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    const search = page.getByRole("textbox", {
      name: "Search title or first message…",
    });
    await expect(search).toBeFocused();
    await search.fill("scrolling");
    await expect(page.locator(".history-result")).toHaveCount(1);
    await page.locator(".history-result").click();
    await expect(page.locator(".history-transcript")).toContainText(
      "Investigate slow scrolling",
    );
    await page.goBack();
    await expect(search).toHaveValue("scrolling");
    await search.fill("Session open in CLI");
    await page.getByRole("button", { name: /Session open in CLI/ }).click();
    await page
      .getByRole("button", { name: "Resume session", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "another Codex instance",
    );
    await expect(
      page.getByRole("button", { name: "Resume session", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "another Codex instance",
    );
    await page.screenshot({
      path: `../.scratch/flickgrove-session-history/locked-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    await page.goBack();
    await search.fill("scrolling");
    await page.getByRole("button", { name: /Previous reader task/ }).click();
    await page
      .getByRole("button", { name: /^(Resume session|Open session)$/ })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message Orc", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".historical-messages")).toContainText(
      "Previous result preserved in Codex.",
    );
    await expect(
      page.locator(".historical-messages .user-message"),
    ).toHaveCount(1);
    await page.screenshot({
      path: `../.scratch/flickgrove-session-history/resumed-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
    const snapshot = await (await page.request.get("/fixture/snapshot")).json();
    const agent = snapshot.agents.find(
      (a: { threadId: string }) => a.threadId === "history-reader",
    );
    expect(agent).toBeTruthy();
    const detail = await (
      await page.request.get(`/fixture/agents/${encodeURIComponent(agent.id)}`)
    ).json();
    expect(detail.messages).toEqual([]);
    await page.keyboard.press("Alt+x");
    await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  });
}
test("dense session list fits at least ten Orcs, with compact state and input indicators", async ({
  page,
}) => {
  await page.request.post("http://127.0.0.1:14319/fixture/reset", {
    data: { mode: "dense" },
  });
  await page.goto("http://127.0.0.1:14319/");
  const list = page.locator(".session-list");
  await expect(list.locator(".session-item")).toHaveCount(20);
  const counts = await list.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return [...node.querySelectorAll(".session-item")].filter((item) => {
      const r = item.getBoundingClientRect();
      return r.top >= bounds.top && r.bottom <= bounds.bottom;
    }).length;
  });
  expect(counts).toBeGreaterThanOrEqual(10);
  await expect(
    list.locator(".session-state-dot.working").first(),
  ).toBeVisible();
  await page.request.post("http://127.0.0.1:14319/fixture/change", {
    data: { question: true },
  });
  await expect(list.getByRole("img", { name: "Needs input" })).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove-session-history/dense-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../.scratch/flickgrove-session-history/dense-mobile.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("restored Grove history includes external turns once and retains folded Worker reports", async ({
  page,
}) => {
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  for (const [command, result] of [
    ["Build a reader", "The reader is ready."],
    ["Request Worker report", "Report received."],
    ["Close the workers", "Workers are closed."],
  ]) {
    await input.fill(command);
    await input.press("Enter");
    await expect(page.getByText(result, { exact: true })).toBeVisible();
  }
  const snapshot = await (await page.request.get("/fixture/snapshot")).json();
  const agent = snapshot.agents.find((a: { role: string }) => a.role === "orc");
  await page.request.post("/fixture/history-continuation", {
    data: { id: agent.id },
  });
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search title or first message…" })
    .fill("Restored report task");
  await page.getByRole("button", { name: /Restored report task/ }).click();
  await page
    .getByRole("button", { name: "Resume session", exact: true })
    .click();
  await expect(
    page.getByText("CLI continuation 30", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Load earlier messages", exact: true })
    .click();
  const report = page.locator(".historical-messages .worker-report");
  await expect(report).toHaveCount(1);
  await expect(report).not.toHaveAttribute("open");
  await expect(
    page
      .locator(".conversation .user-message")
      .filter({ hasText: "Build a reader" }),
  ).toHaveCount(1);
  await report.locator("summary").click();
  await expect(
    report.getByText("Full diagnostic details.", { exact: true }),
  ).toBeVisible();
  const receipts = page
    .locator(".conversation")
    .getByText("Received.", { exact: true });
  const previousReceipts = await receipts.count();
  await input.fill("Continue after restoration");
  await input.press("Enter");
  await expect(
    page
      .locator(".conversation .user-message")
      .filter({ hasText: "Continue after restoration" }),
  ).toHaveCount(1);
  await expect(receipts).toHaveCount(previousReceipts + 1);
  await expect(receipts.last()).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("CLI continuation 30", { exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator(".conversation .user-message")
      .filter({ hasText: "Continue after restoration" }),
  ).toHaveCount(1);
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
});

for (const mobile of [false, true]) {
  test(`new session width stays fixed across history and host changes (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await page.request.post("http://127.0.0.1:14319/fixture/reset", {
      data: {},
    });
    await page.goto("http://127.0.0.1:14319/");
    await newSession(page);
    const dialog = page.locator(".new-modal");
    await expect(dialog).toBeVisible();
    const width = Math.min(700, page.viewportSize()!.width - 32);
    await expect
      .poll(() => dialog.evaluate((node) => node.getBoundingClientRect().width))
      .toBe(width);
    await page
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    await expect(page.locator(".session-history")).toBeVisible();
    expect(
      await dialog.evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(width);
    await page
      .getByRole("textbox", { name: "Search title or first message…" })
      .fill("no match");
    expect(
      await dialog.evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(width);
    await page.goBack();
    await expect(page.locator(".host-choices")).toBeVisible();
    await page.locator(".host-choices button").last().click();
    expect(
      await dialog.evaluate((node) => node.getBoundingClientRect().width),
    ).toBe(width);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.screenshot({
      path: `../.scratch/flickgrove-history-directory/dialog-${mobile ? "mobile" : "desktop"}.png`,
      animations: "disabled",
    });
  });
}
