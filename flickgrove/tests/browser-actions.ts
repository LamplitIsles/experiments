import { expect, type Page } from "@playwright/test";

export async function newSession(page: Page) {
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press("n");
}
export async function openSettings(page: Page) {
  if (await page.locator(".agent-detail").count()) {
    if (await page.getByRole("button", { name: "Close detail" }).isVisible())
      await page.getByRole("button", { name: "Close detail" }).click();
    else await page.getByRole("button", { name: "‹ Sessions" }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}
