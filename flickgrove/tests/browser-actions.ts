import { expect, type Page } from "@playwright/test";

export async function newSession(page: Page) {
  await expect(page.locator("[data-slot=dialog-content]")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur();
  });
  await page.keyboard.press("n");
}
export async function openSidebar(page: Page) {
  const mobile = (page.viewportSize()?.width ?? 1440) <= 700;
  const shell = page.locator(
    mobile
      ? '[data-mobile="true"][data-slot="sidebar"]'
      : '[data-slot="sidebar"][data-state]',
  );
  await expect(shell).toHaveCount(1);
  if (
    mobile
      ? !(await page.locator(".session-list").isVisible())
      : (await shell.getAttribute("data-state")) === "collapsed"
  )
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click();
  await expect(page.locator(".session-list")).toBeVisible();
  if (mobile)
    await expect.poll(async () => (await shell.boundingBox())?.x).toBe(0);
}
export async function openSettings(page: Page) {
  if (
    (page.viewportSize()?.width ?? 1440) <= 700 &&
    (await page.locator(".session-list").isVisible())
  )
    await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

export async function createSession(page: Page) {
  const previous = await page.evaluate(() =>
    history.state?.grove?.details.at(-1),
  );
  await page
    .getByRole("dialog", { name: "New session", exact: true })
    .getByRole("button", { name: "New session", exact: true })
    .click();
  await expect(page.locator("[data-slot=dialog-content]")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => history.state?.grove?.details.at(-1)))
    .not.toBe(previous);
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeFocused();
}
