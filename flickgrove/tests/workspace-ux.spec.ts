import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-workspace-ux/screenshots";
const active = (page: Page) =>
  page.locator(".session-item.active .session-open");
const title = (page: Page) => page.locator(".agent-detail h1");
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });

test("persistent selection, local arrows and guarded drafts", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await composer(page).fill("First unsent draft");
  await page.locator(".session-open").last().click();
  await composer(page).fill("Last draft");
  await page.locator(".session-open").first().click();
  await expect(composer(page)).toHaveValue("First unsent draft");
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Voice input");
  await expect(composer(page)).toHaveCount(0);
  await expect(page.locator(".read-only")).toContainText("Read-only");
  await page.screenshot({ path: `${shots}/desktop-worker.png` });
  await page.keyboard.press("ArrowUp");
  await expect(composer(page)).toHaveValue("First unsent draft");
  await composer(page).focus();
  await composer(page).press("ArrowDown");
  await composer(page).dispatchEvent("keydown", {
    key: "ArrowDown",
    code: "ArrowDown",
    isComposing: true,
  });
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Escape");
  await composer(page).fill("draft ");
  await composer(page).press("Alt+KeyS");
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("Escape");
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(title(page)).toHaveText("Voice input");
  await page.keyboard.press("ArrowUp");
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(page.locator(".navigation-focus")).toHaveCount(0);
});

test("closing a middle visible session selects its next neighbor and collapsing selected Worker selects Orc", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await expect(title(page)).toHaveText("Streaming voice input");
  await page.locator(".session-open").nth(2).click();
  await expect(title(page)).toHaveText("Additional task 1");
  await expect(
    page.getByRole("button", { name: "Session settings", exact: true }),
  ).toBeEnabled();
  await page.keyboard.press("Alt+x");
  await expect(title(page)).toHaveText("Additional task 2");
  await page.locator(".session-open").first().click();
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page
    .getByRole("button", { name: "Open Voice input Worker", exact: true })
    .click();
  await expect(title(page)).toHaveText("Voice input");
  await page.getByRole("button", { name: "Collapse Workers" }).first().click();
  await expect(title(page)).toHaveText("Streaming voice input");
  await expect(active(page)).toHaveAccessibleName(
    "Open Streaming voice input Orc",
  );
});
