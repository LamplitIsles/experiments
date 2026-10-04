import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14319";

test("mouse and keyboard selection keep the list highlight on the open detail", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, { data: { mode: "dense" } });
  await page.goto(origin);
  await page.keyboard.press("ArrowDown");
  const rows = page.locator(".session-open");
  const second = rows.nth(1);
  const secondId = await second.getAttribute("data-agent-id");
  await second.click();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await expect(
    page.locator(".session-item.active .session-open"),
  ).toHaveAttribute("data-agent-id", secondId!);
  await expect(page.locator(".navigation-focus")).toHaveCount(0);
  const next = rows.nth(2);
  const nextId = await next.getAttribute("data-agent-id");
  const nextTitle = await next.locator("strong").textContent();
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator(".session-item.active .session-open"),
  ).toHaveAttribute("data-agent-id", nextId!);
  await expect(page.locator(".agent-detail h1")).toHaveText(nextTitle!);
  await expect(page.locator(".navigation-focus")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".agent-detail h1")).toHaveText(nextTitle!);
  await second.click();
  await page.locator(".role-project").click();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".session-item.active .session-open"),
  ).toHaveAttribute("data-agent-id", secondId!);
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".agent-detail h1")).toHaveText(nextTitle!);
});
