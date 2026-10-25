import { expect, test } from "@playwright/test";
import { longPress } from "./context-menu-touch";
import { openSidebar } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
for (const width of [1440, 390])
  test(`cursor menus retain guarded Orc close and leave members menu-free at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "working" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    const inputCount = (
      await (await request.get(origin + "/fixture/info")).json()
    ).inputs;
    const row = page.locator('.session-open[data-location="tree"]').first();
    const box = (await row.boundingBox())!;
    const point = { x: box.x + 30, y: box.y + 16 };
    const initial = await page.locator(".agent-detail h1").allTextContents();
    await page.mouse.click(point.x, point.y, { button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "Pin",
      "Close this tree",
    ]);
    const popup = (await page.getByRole("menu").boundingBox())!;
    expect(Math.abs(popup.x - point.x)).toBeLessThan(12);
    expect(Math.abs(popup.y - point.y)).toBeLessThan(12);
    await expect(page.locator(".agent-detail h1")).toHaveText(initial);
    await page.screenshot({
      path: `../.scratch/context-menu-only/screenshots/${width}-cursor-menu.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await row.click({ button: "right" });
    await page.goBack();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.locator(".session-list")).toBeVisible();
    await row.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "Pin",
      "Close this tree",
    ]);
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(
      page.locator(
        ".pinned-sessions .session-item:not(.worker-item) .session-open",
      ),
    ).toHaveCount(1);
    await page
      .getByRole("button", { name: "Expand Workers", exact: true })
      .first()
      .click();
    const member = page
      .locator('.session-open[data-location="tree"]')
      .filter({ hasText: "Voice input" })
      .nth(1);
    await member.click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
    await row.click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "still working or has an unconfirmed delivery" })
        .first(),
    ).toBeVisible();
    await expect(
      page.locator(
        ".pinned-sessions .session-item:not(.worker-item) .session-open",
      ),
    ).toHaveCount(1);
    await openSidebar(page);
    // Existing closeTree accepts an idle tree; no new lifecycle or close endpoint.
    for (const agentId of ["reader-orc", "reader"])
      await request.post(origin + "/fixture/change", {
        data: {
          execution: {
            agentId,
            event: { type: "completed", status: "completed" },
          },
        },
      });
    await page
      .locator('.session-open[data-location="tree"]')
      .filter({ hasText: "Reader performance" })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page
      .locator(".pinned-sessions .session-open")
      .filter({ hasText: "Reader performance" })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .click();
    await expect(
      page.locator(
        ".pinned-sessions .session-item:not(.worker-item) .session-open",
      ),
    ).toHaveCount(1);
    await expect(
      page.locator(".session-open").filter({ hasText: "Reader performance" }),
    ).toHaveCount(0);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(inputCount);
  });

test("selected working Orc refusal stays visible in the foreground mobile Sidebar", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "working" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await openSidebar(page);
  await page.locator('.session-open[data-location="tree"]').first().click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("keep selected close draft");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 7));
  const before = (await (await request.get(origin + "/fixture/info")).json())
    .inputs;
  await openSidebar(page);
  await page
    .locator('.session-open[data-location="tree"]')
    .first()
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Close this tree", exact: true })
    .click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.locator('.agent-detail [role="alert"]')).toContainText(
    "still working or has an unconfirmed delivery",
  );
  await page.screenshot({
    path: "../.scratch/context-menu-only/screenshots/390-selected-close-refusal.png",
    animations: "disabled",
  });
  await expect(page.locator('.session-list [role="alert"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".session-list")).toBeHidden();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect(input).toHaveValue("keep selected close draft");
  expect(
    await input.evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([3, 7]);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs,
  ).toEqual(before);
});

test.describe("touch context menu", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("long press, release, tap actions and scrolling keep their own intent", async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", { data: { mode: "dense" } });
    await page.goto(origin);
    await openSidebar(page);
    expect(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
    ).toBe(true);
    const tree = page.locator('.session-open[data-location="tree"]');
    await tree.first().tap();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await openSidebar(page);
    const initial = (await (await request.get(origin + "/fixture/info")).json())
      .inputs;
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    const before = await page.locator(".agent-detail h1").allTextContents();
    await longPress(page, tree.first());
    await expect(page.getByRole("menuitem")).toHaveText([
      "Pin",
      "Close this tree",
    ]);
    await expect(page.locator(".agent-detail h1")).toHaveText(before);
    await page.screenshot({
      path: "../.scratch/context-menu-only/screenshots/390-touch-menu.png",
      animations: "disabled",
    });
    await page.getByRole("menuitem", { name: "Pin", exact: true }).tap();
    const pinned = page.locator('.session-open[data-location="pinned"]');
    await expect(pinned).toHaveCount(1);
    await page.locator(".pinned-sessions .worker-disclosure").tap();
    const member = pinned.filter({
      has: page.getByText("Voice input", { exact: true }),
    });
    await longPress(page, member, false);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await openSidebar(page);
    await longPress(page, pinned.first());
    await page.getByRole("menuitem", { name: "Unpin", exact: true }).tap();
    await expect(pinned).toHaveCount(0);
    await longPress(page, tree.first());
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .tap();
    await expect(page.locator('.session-list [role="alert"]')).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    // A real vertical touch drag scrolls the list and cancels the long-press timer.
    const list = page.locator(".session-list");
    const box = (await tree.nth(2).boundingBox())!;
    const scroll = await list.evaluate((el) => el.scrollTop);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + 80, y: box.y + 20 }],
    });
    for (const dy of [20, 50, 90, 130])
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: box.x + 80, y: box.y + 20 - dy }],
      });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await cdp.detach();
    await expect
      .poll(() => list.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(scroll);
    await page.waitForTimeout(800);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.screenshot({
      path: "../.scratch/context-menu-only/screenshots/390-touch-scrolled.png",
      animations: "disabled",
    });
    for (const agentId of ["reader-orc", "reader"])
      await request.post(origin + "/fixture/change", {
        data: {
          execution: {
            agentId,
            event: { type: "completed", status: "completed" },
          },
        },
      });
    const reader = tree.filter({ hasText: "Reader performance" });
    await longPress(page, reader);
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .tap();
    await expect(reader).toHaveCount(0);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(initial);
  });
});
