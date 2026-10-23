import { expect, test, type Page } from "@playwright/test";
import { newSession, createSession, openSidebar } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
test.use({ serviceWorkers: "block" });
const group = (p: Page, key: string) =>
  p.locator(`.org-group[data-org="${key}"]`);
const roots = (p: Page) =>
  p.locator(".session-item:not(.worker-item) .session-open");
const ids = (p: Page) =>
  roots(p).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-agent-id")),
  );
const heading = (p: Page) => p.locator(".agent-detail h1");
const composer = (p: Page) =>
  p.getByRole("textbox", { name: "Message Orc", exact: true });

test.beforeEach(async ({ request }) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "org-groups" },
  });
});

test("derived groups, member summaries, folding, visible keyboard order and selected restoration", async ({
  page,
  request,
}) => {
  await page.goto(origin);
  await expect(page.locator(".org-name")).toHaveText([
    "guionai",
    "lamplitisles",
    "personal",
    "Ungrouped",
  ]);
  await expect(group(page, "guionai").locator(".session-open")).toHaveCount(2);
  await expect(group(page, "").locator(".session-open")).toHaveCount(2);
  await request.post(origin + "/fixture/change", {
    data: { question: true, questionAgent: "voice" },
  });
  await expect(
    group(page, "guionai").getByLabel("Needs input: 1"),
  ).toBeVisible();
  await expect(
    group(page, "guionai").getByLabel("2 working", { exact: true }),
  ).toBeVisible();
  await group(page, "guionai").locator(".org-disclosure").click();
  await expect(heading(page)).toHaveText("Streaming voice input");
  // A background publication cannot undo explicit folding of the selected group.
  await request.post(origin + "/fixture/change", { data: { usage: 55 } });
  await expect(group(page, "guionai").locator(".session-open")).toHaveCount(0);
  await composer(page).press("Alt+k");
  await expect(heading(page)).toHaveText("Project removed from catalogue");
  await composer(page).press("Meta+1");
  await expect(heading(page)).toHaveText("Reader performance");
  await composer(page).press("Alt+j");
  await expect(heading(page)).toHaveText("Personal repository");
  await expect(composer(page)).toBeFocused();
  await composer(page).evaluate((el) => el.blur());
  await page.keyboard.press("ArrowDown");
  await expect(heading(page)).toHaveText("Local repository without remote");
  await page.reload();
  await expect(
    group(page, "guionai").locator(".org-disclosure"),
  ).toHaveAttribute("aria-expanded", "false");
  // Reach the folded group using only navigation keys; no direct focus helper.
  const disclosure = group(page, "guionai").locator(".org-disclosure");
  await page.keyboard.press("ArrowLeft");
  await expect(group(page, "").locator(".org-disclosure")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(disclosure).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await newSession(page);
  await createSession(page);
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await page
    .getByRole("button", { name: "Expand Workers", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: /Open Documentation.*Worker/ })
    .click();
  await disclosure.click();
  await page.reload();
  await expect(disclosure).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: /Open Documentation.*Worker/ }),
  ).toHaveAttribute("aria-current", "true");
  await page.screenshot({ path: "../.scratch/org-session-groups/desktop.png" });
});

test("keyboard-only group route preserves member navigation and Composer completion", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(heading(page)).toHaveText("Streaming voice input");
  // Start from page focus and enter the existing session navigation with keys.
  await page.keyboard.press("ArrowDown");
  await expect(roots(page).nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight"); // Expand members.
  await page.keyboard.press("ArrowRight"); // First member.
  await expect(
    page.getByRole("button", { name: "Open Voice input Worker", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowLeft"); // Existing child → parent.
  await expect(roots(page).first()).toBeFocused();
  await page.keyboard.press("ArrowLeft"); // Existing member collapse.
  await expect(roots(page).first()).toBeFocused();
  await page.keyboard.press("ArrowLeft"); // Collapsed root → group header.
  const header = group(page, "guionai").locator(".org-disclosure");
  await expect(header).toBeFocused();
  await page.screenshot({
    path: "../.scratch/org-session-groups/keyboard-header-focus.png",
  });
  await page.keyboard.press("Alt+ArrowDown");
  await expect(header).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await expect(heading(page)).toHaveText("Streaming voice input");
  await page.keyboard.press("ArrowDown");
  await expect(
    group(page, "lamplitisles").locator(".org-disclosure"),
  ).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(header).toBeFocused();
  await page.keyboard.press("Space");
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowLeft");
  await expect(header).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowRight"); // Expand and return to first Orc.
  await expect(header).toHaveAttribute("aria-expanded", "true");
  await expect(roots(page).first()).toBeFocused();
  await page.keyboard.press("i");
  await expect(composer(page)).toBeFocused();
  await page.keyboard.type("Preserved draft");
  await page.keyboard.press("Tab");
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveValue("Preserved draft");
  await page.keyboard.press("Shift+Tab");
  await expect(composer(page)).toBeFocused();
});

test("same-group drag persists; cross-group/header/member drop rejects without navigation", async ({
  page,
}) => {
  await page.goto(origin);
  await expect(heading(page)).toHaveText("Streaming voice input");
  const before = await ids(page);
  const source = group(page, "guionai").locator(".session-open").first();
  const target = group(page, "guionai").locator(".session-open").last();
  await composer(page).fill("Retained draft");
  await source.dragTo(target, { targetPosition: { x: 25, y: 55 } });
  const expected = [before[1], before[0], ...before.slice(2)];
  await expect.poll(() => ids(page)).toEqual(expected);
  await expect(composer(page)).toHaveValue("Retained draft");
  await page.reload();
  await expect.poll(() => ids(page)).toEqual(expected);
  const moving = group(page, "guionai").locator(".session-open").first();
  for (const rejected of [
    group(page, "personal").locator(".session-open"),
    group(page, "lamplitisles").locator(".org-disclosure"),
  ]) {
    await moving.dragTo(rejected);
    await expect.poll(() => ids(page)).toEqual(expected);
    await expect(page.locator(".drop-before, .drop-after")).toHaveCount(0);
    await expect(heading(page)).toHaveText("Streaming voice input");
  }
  await page.waitForTimeout(510); // Let the post-drag click guard expire.
  await group(page, "guionai")
    .getByRole("button", { name: "Expand Workers", exact: true })
    .click();
  const member = page.getByRole("button", {
    name: "Open Voice input Worker",
    exact: true,
  });
  await expect(member).toHaveAttribute("draggable", "false");
  await moving.dragTo(member);
  await expect.poll(() => ids(page)).toEqual(expected);
  await expect(page.locator(".drop-before, .drop-after")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await openSidebar(page);
  await expect.poll(() => ids(page)).toEqual(expected);
  await expect(roots(page).first()).toHaveAttribute("draggable", "false");
  await group(page, "personal").locator(".org-disclosure").click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: "../.scratch/org-session-groups/mobile.png" });
  const row = group(page, "").locator(".session-row").first();
  const rowId = await row.getAttribute("data-swipe-id");
  const box = (await row.boundingBox())!;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + 230, y: box.y + 25 }],
  });
  for (let i = 1; i <= 6; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + 230 - i * 20, y: box.y + 25 }],
    });
    await page.waitForTimeout(20);
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await cdp.detach();
  const close = row.getByRole("button", {
    name: "Close this tree",
    exact: true,
  });
  await expect(close).toBeVisible();
  await page.screenshot({
    path: "../.scratch/org-session-groups/mobile-swipe.png",
  });
  await close.click();
  await expect
    .poll(() => ids(page))
    .toEqual(
      expected.filter((id) => id !== rowId && !id?.endsWith(":personal-orc")),
    );
});

test("catalogue delay stays accessible without false Ungrouped; failure recovers on refresh", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/change", {
    data: { projectsDelay: 1200 },
  });
  await page.goto(origin);
  await expect(
    page.locator('.org-group[data-org="@loading"] .session-open'),
  ).toHaveCount(6);
  await expect(group(page, "")).toHaveCount(0);
  await expect(roots(page).first()).toHaveAttribute("draggable", "false");
  await expect(group(page, "guionai")).toBeVisible();
  await request.post(origin + "/fixture/change", {
    data: { projectsDelay: 0, projectsFailure: true },
  });
  await page.reload();
  await expect(group(page, "").locator(".session-open")).toHaveCount(6);
  await group(page, "")
    .getByRole("button", { name: "Open Personal repository Orc", exact: true })
    .click();
  await expect(heading(page)).toHaveText("Personal repository");
  await request.post(origin + "/fixture/change", {
    data: { projectsFailure: false },
  });
  await page.reload();
  await expect(
    group(page, "personal").locator(".session-open"),
  ).toHaveAttribute("aria-current", "true");
  // Refreshing creation choices retains sidebar grouping, but cannot offer stale choices.
  await request.post(origin + "/fixture/change", {
    data: { projectsDelay: 1200, projectsFailure: true },
  });
  await newSession(page);
  const dialog = page.getByRole("dialog", { name: "New session", exact: true });
  await expect(
    dialog.getByRole("listbox", { name: "Project", exact: true }),
  ).toHaveAttribute("aria-busy", "true");
  await expect(
    dialog.getByRole("option").filter({ hasNotText: "Saved history" }),
  ).toHaveCount(0);
  await expect(group(page, "personal").locator(".session-open")).toHaveCount(1);
  await expect(dialog.getByText("Synthetic catalogue failure")).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "New session", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("option").filter({ hasNotText: "Saved history" }),
  ).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: { projectsDelay: 0, projectsFailure: false },
  });
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    dialog.getByRole("option").filter({ hasNotText: "Saved history" }),
  ).toHaveCount(5);
  const search = dialog.getByRole("combobox", {
    name: "Search projects…",
    exact: true,
  });
  await search.fill("forge");
  await search.press("Enter");
  await expect(
    dialog.getByRole("option", { name: "Forge", exact: true }),
  ).toHaveAttribute("data-checked", "true");
  await expect(dialog).toBeVisible();
  await expect(heading(page)).toHaveText("Personal repository");
});
