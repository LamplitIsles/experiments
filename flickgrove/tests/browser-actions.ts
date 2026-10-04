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
  if (await page.locator(".mobile-back > button").isVisible())
    await page.getByRole("button", { name: "‹ Sessions" }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

export async function createSession(page: Page) {
  const previous = await page.evaluate(() =>
    history.state?.grove?.details.at(-1),
  );
  await page.getByRole("button", { name: /Create on/ }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => history.state?.grove?.details.at(-1)))
    .not.toBe(previous);
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeFocused();
}
