import { openSidebar } from "./browser-actions";
import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/collapsible-session-sidebar/screenshots";
test.use({ serviceWorkers: "block" });
const toggle = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Toggle Sidebar", exact: true });

test.beforeEach(async ({ request }) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
});

test("desktop offcanvas persists, keeps draft/caret/tree and releases width", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await expect(
    page.getByRole("heading", { name: "FlickGrove", exact: true }),
  ).toBeVisible();
  const composer = page.getByRole("textbox", {
    name: "Message Orc",
    exact: true,
  });
  await expect(composer).toBeEnabled();
  await page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first()
    .click();
  await composer.fill("Unsent sidebar draft");
  await composer.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(4, 9),
  );
  const transcript = page.locator(".conversation");
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(1000);
  await transcript.evaluate((el) => (el.scrollTop = 150));
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(150);
  const original = (await page.locator(".agent-detail").boundingBox())!;
  expect(original.y).toBe(0);
  expect(original.height).toBe(900);
  await page.screenshot({
    animations: "disabled",
    path: shots + "/desktop-expanded.png",
  });
  await composer.press("Meta+b");
  await expect(
    page.locator('[data-slot="sidebar"][data-state]'),
  ).toHaveAttribute("data-state", "collapsed");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Unsent sidebar draft");
  expect(
    await composer.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([4, 9]);
  await expect
    .poll(
      async () => (await page.locator(".agent-detail").boundingBox())!.width,
    )
    .toBeGreaterThan(original.width + 300);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(150);
  await expect
    .poll(async () => (await page.locator(".agent-detail").boundingBox())!.x)
    .toBe(0);
  const composerBounds = (await page.locator(".composer").boundingBox())!;
  expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(900);
  await page.screenshot({
    animations: "disabled",
    path: shots + "/desktop-collapsed.png",
  });
  await page.reload();
  await expect(
    page.locator('[data-slot="sidebar"][data-state]'),
  ).toHaveAttribute("data-state", "collapsed");
  await expect(composer).toHaveValue("Unsent sidebar draft");
  await toggle(page).click();
  await expect(
    page.getByRole("button", { name: "Collapse Workers", exact: true }).first(),
  ).toBeVisible();
  await composer.focus();
  await composer.press("Control+b");
  await expect(
    page.locator('[data-slot="sidebar"][data-state]'),
  ).toHaveAttribute("data-state", "collapsed");
  await composer.press("Control+b");
  await expect(
    page.locator('[data-slot="sidebar"][data-state]'),
  ).toHaveAttribute("data-state", "expanded");
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .focus();
  await page.keyboard.press("Meta+b");
  await expect(toggle(page)).toBeFocused();
});

test("shortcut guards and layout storage read/write failure retain usable controls", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const get = Storage.prototype.getItem,
      set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key.endsWith("/sidebar-open"))
        throw new DOMException("Blocked", "SecurityError");
      return get.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith("/sidebar-open"))
        throw new DOMException("Blocked", "QuotaExceededError");
      set.call(this, key, value);
    };
  });
  await page.goto(origin);
  const panel = page.locator('[data-slot="sidebar"][data-state]');
  const composer = page.getByRole("textbox", {
    name: "Message Orc",
    exact: true,
  });
  await expect(composer).toBeEnabled();
  await composer.focus();
  for (const extra of [
    { isComposing: true },
    { altKey: true },
    { shiftKey: true },
    { repeat: true },
  ]) {
    await composer.dispatchEvent("keydown", {
      key: "b",
      code: "KeyB",
      metaKey: true,
      ...extra,
    });
    await expect(panel).toHaveAttribute("data-state", "expanded");
  }
  await composer.dispatchEvent("compositionstart");
  await composer.press("Meta+b");
  await expect(panel).toHaveAttribute("data-state", "expanded");
  await composer.dispatchEvent("compositionend");
  await composer.evaluate((el) => {
    const event = new KeyboardEvent("keydown", {
      key: "b",
      code: "KeyB",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    el.dispatchEvent(event);
  });
  await expect(panel).toHaveAttribute("data-state", "expanded");
  await page.getByRole("button", { name: "Edit title", exact: true }).click();
  await page.getByRole("textbox", { name: "Session title" }).press("Meta+b");
  await expect(panel).toHaveAttribute("data-state", "expanded");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Meta+b");
  await expect(panel).toHaveAttribute("data-state", "expanded");
  await page.keyboard.press("Escape");
  await toggle(page).click();
  await expect(panel).toHaveAttribute("data-state", "collapsed");
  await toggle(page).click();
  await expect(panel).toHaveAttribute("data-state", "expanded");
});

test("mobile drawer is transient, selection dismisses, Esc/Back respect foreground and desktop preference", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await expect(page.locator(".session-list")).toBeHidden();
  await openSidebar(page);
  await page.screenshot({
    animations: "disabled",
    path: shots + "/mobile-drawer.png",
  });
  await page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Open Voice input Worker", exact: true })
    .click();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await expect(page.locator(".session-list")).toBeHidden();
  await page.screenshot({
    animations: "disabled",
    path: shots + "/mobile-detail.png",
  });
  await toggle(page).click();
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog", { name: "New session", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "New session", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".session-list")).toBeVisible();
  await page.goBack();
  await expect(page.locator(".session-list")).toBeHidden();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.locator(".owner-link").click();
  const composer = page.getByRole("textbox", {
    name: "Message Orc",
    exact: true,
  });
  await composer.fill("Mobile draft");
  await composer.evaluate((el: HTMLTextAreaElement) =>
    el.setSelectionRange(2, 6),
  );
  await openSidebar(page);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!document.activeElement?.closest(
            '[data-mobile="true"][data-slot="sidebar"]',
          ),
      ),
    )
    .toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.locator(".session-list")).toBeHidden();
  await expect(composer).toHaveValue("Mobile draft");
  expect(
    await composer.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await expect(page.locator('[data-slot="sheet-overlay"]')).toBeHidden();
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.press("End");
  await composer.press("!");
  await expect(composer).toHaveValue("Mobile draft!");
  await page.setViewportSize({ width: 700, height: 844 });
  await expect(page.locator(".session-list")).toHaveCount(1);
  await expect(page.locator(".session-list")).toBeHidden();
  await page.setViewportSize({ width: 701, height: 900 });
  await expect(page.locator(".session-list")).toBeVisible();
  await page
    .getByRole("button", { name: "Collapse Ungrouped", exact: true })
    .click();
  await toggle(page).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".session-list")).toBeHidden();
  await openSidebar(page);
  await expect(
    page.getByRole("button", { name: "Expand Ungrouped", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.locator('[data-slot="sidebar"][data-state]'),
  ).toHaveAttribute("data-state", "collapsed");
  await expect(page.locator(".session-list")).toHaveCount(1);
  await expect(page.locator('[data-slot="sheet-overlay"]')).toBeHidden();
  await composer.click();
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("Mobile draft!");
  await page.setViewportSize({ width: 390, height: 844 });
  await openSidebar(page);
  await page
    .locator(".session-list-heading")
    .getByRole("button", { name: "New session", exact: true })
    .click();
  const search = page
    .getByRole("dialog", { name: "New session", exact: true })
    .getByRole("combobox", { name: "Search projects" });
  await search.fill("exper");
  await page.setViewportSize({ width: 701, height: 900 });
  await expect(search).toHaveValue("exper");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "New session", exact: true }),
  ).toBeHidden();
  await expect(page.locator(".session-list")).toHaveCount(1);
  await expect(page.locator('[data-slot="sheet-overlay"]')).toBeHidden();
  await composer.click();
  await expect(composer).toBeFocused();
  expect(
    await page.evaluate(() =>
      localStorage.getItem(`flickgrove/${location.origin}/sidebar-open`),
    ),
  ).toBe("false");
});

test("empty/no-detail tools, compact quota popover, long text and disconnection", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "empty" } });
  await page.addInitScript(() =>
    localStorage.setItem(
      `flickgrove/${location.origin}/sidebar-open`,
      '"invalid"',
    ),
  );
  await page.goto(origin);
  await expect(page.locator(".detail-empty")).toBeVisible();
  await page.screenshot({
    animations: "disabled",
    path: shots + "/desktop-empty.png",
  });
  await toggle(page).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-slot=dialog-content]")).toBeHidden();
  await expect(page.locator("[data-slot=dialog-overlay]")).toBeHidden();
  await page.screenshot({
    animations: "disabled",
    path: shots + "/desktop-no-detail-collapsed.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
  await expect
    .poll(
      async () => (await page.locator(".detail-empty").boundingBox())?.height,
    )
    .toBe(844);
  await expect(page.locator(".global-actions")).toHaveCount(1);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    animations: "disabled",
    path: shots + "/mobile-empty.png",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await request.post(origin + "/fixture/reset", {
    data: { mode: "org-groups" },
  });
  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  const usage = page.getByRole("button", { name: "Weekly usage", exact: true });
  await expect(usage).toHaveCount(1);
  await expect(usage).not.toContainText("Weekly usage");
  await usage.click();
  await expect(page.locator(".weekly-popover")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    animations: "disabled",
    path: shots + "/mobile-popover.png",
  });
  await page.keyboard.press("Escape");
  await toggle(page).click();
  await page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first()
    .click();
  await page.screenshot({
    animations: "disabled",
    path: shots + "/mobile-long-groups.png",
  });
  await page.keyboard.press("Escape");
  await page.routeWebSocket("**/api/socket", (ws) => ws.close());
  await page.reload();
  await toggle(page).click();
  await expect(page.locator(".connection-banner")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toBeVisible();
});
