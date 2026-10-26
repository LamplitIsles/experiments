import { expect, test, type Page } from "@playwright/test";
import { longPress } from "./context-menu-touch";
import { openSidebar } from "./browser-actions";
import { writeFileSync } from "node:fs";
const origin = "http://127.0.0.1:14319";
const evidence = "../.scratch/visible-session-shortcuts";
const rows = (page: Page, source = "tree") =>
  page.locator(`.session-open[data-location="${source}"]`);
const current = (page: Page) =>
  page.locator('.session-open[aria-current="true"]');
async function pin(page: Page, index = 0) {
  await rows(page).nth(index).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
}
async function state(page: Page) {
  return page.evaluate(() => ({
    route: history.state?.grove,
    current: [
      ...document.querySelectorAll('.session-open[aria-current="true"]'),
    ].map((el) => ({
      id: el.getAttribute("data-agent-id"),
      source: el.getAttribute("data-location"),
    })),
    folded: localStorage.getItem(
      `flickgrove/${location.origin}/collapsed-orgs`,
    ),
  }));
}
for (const neighbor of [false, true])
  test(`AltX from folded Pin preserves org folding after actual close (neighbor ${neighbor})`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", { data: { mode: "idle" } });
    await page.goto(origin);
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await pin(page);
    if (neighbor) await pin(page, 1);
    await rows(page, "pinned").first().click();
    await page.locator(".org-disclosure").click();
    await expect(page.locator(".org-disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await page
      .locator(".composer textarea")
      .fill("Closing draft remains local");
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/close-${neighbor}-before.png`,
    });
    const before = await state(page);
    await page.keyboard.press("Alt+KeyX");
    await expect(rows(page, "pinned")).toHaveCount(neighbor ? 1 : 0);
    await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/close-${neighbor}-after.png`,
    });
    writeFileSync(
      `${evidence}/close-${neighbor}-state.json`,
      JSON.stringify({ before, after: await state(page) }, null, 2),
    );
    await expect(page.locator(".org-disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(rows(page)).toHaveCount(0);
    if (neighbor)
      await expect(current(page)).toHaveAttribute("data-location", "pinned");
    else await expect(page.locator(".agent-detail")).toHaveCount(0);
  });
async function number(page: Page, digit: number, modifier = "metaKey") {
  return page.locator("body").evaluate(
    (el, { digit, modifier }) => {
      const event = new KeyboardEvent("keydown", {
        key: String(digit),
        code: `Digit${digit}`,
        [modifier]: true,
        bubbles: true,
        cancelable: true,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { digit, modifier },
  );
}
async function selected(page: Page, id: string, source: string) {
  await expect(current(page)).toHaveCount(1);
  await expect(current(page)).toHaveAttribute("data-agent-id", id);
  await expect(current(page)).toHaveAttribute("data-location", source);
}
for (const width of [1440, 390])
  test(`unified visible switching and guards at ${width}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(60000);
    await request.post(origin + "/fixture/reset", { data: { mode: "dense" } });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    await pin(page, 1); // Reader first in Pin, reversing the original root order.
    await pin(page, 0);
    await page.locator(".pinned-sessions .worker-disclosure").nth(1).click();
    const entries = await page.locator(".session-open").evaluateAll((els) => {
      const seen = new Set<string>();
      return els.flatMap((el) => {
        const id = el.getAttribute("data-agent-id")!;
        if (seen.has(id)) return [];
        seen.add(id);
        return [{ id, source: el.getAttribute("data-location")! }];
      });
    });
    expect(entries.slice(0, 4).map((e) => e.source)).toEqual(
      Array(4).fill("pinned"),
    );
    const inputs = (await (await request.get(origin + "/fixture/info")).json())
      .inputs;
    expect(await number(page, 9, "ctrlKey")).toBe(true);
    await openSidebar(page);
    await selected(page, entries[8].id, entries[8].source);
    expect(await number(page, 1)).toBe(true);
    await openSidebar(page);
    await selected(page, entries[0].id, "pinned");
    // Same current identity from its original copy must advance to the next ID.
    await rows(page)
      .filter({ has: page.getByText("Reader performance", { exact: true }) })
      .click();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("Alt+KeyJ");
    await openSidebar(page);
    await selected(page, entries[1].id, "pinned");
    // Full cycle checks every expanded member, original-tree exclusion and wrap.
    for (const entry of [...entries.slice(2), entries[0]]) {
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement)
          document.activeElement.blur();
      });
      await page.keyboard.press("Alt+KeyJ");
      await openSidebar(page);
      await selected(page, entry.id, entry.source);
    }
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("Alt+KeyK");
    await openSidebar(page);
    await selected(page, entries.at(-1)!.id, "tree");
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/${width}-ordered.png`,
    });
    // Fold hides every original entry, leaving only the four Pin entries.
    await page.locator(".org-disclosure").click();
    expect(await number(page, 9)).toBe(false);
    expect(await number(page, 3)).toBe(true);
    await openSidebar(page);
    await selected(page, entries[2].id, "pinned");
    await expect(page.locator(".org-disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // AltX on a member detail retains the existing Orc-only role boundary.
    if (width === 390) await page.keyboard.press("Escape");
    await page.keyboard.press("Alt+KeyX");
    await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
    await openSidebar(page);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/${width}-folded-member.png`,
    });
    await number(page, 2);
    if (width === 390 && (await page.locator(".session-list").isVisible()))
      await page.keyboard.press("Escape");
    const input = page.locator(".composer textarea");
    await input.fill("Unsent navigation draft");
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(2, 8),
    );
    await input.press("Alt+KeyJ");
    await input.press("Control+Digit1");
    await expect(input).toHaveValue("Unsent navigation draft");
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([2, 8]);
    await input.press("Escape");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await page.locator("body").dispatchEvent("keydown", {
        key: "j",
        code: "KeyJ",
        altKey: true,
        ...init,
      });
    }
    await input.dispatchEvent("compositionstart");
    await page.keyboard.press("Alt+KeyJ");
    await input.dispatchEvent("compositionend");
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await openSidebar(page);
    await rows(page, "pinned").first().click({ button: "right" });
    await page.keyboard.press("Alt+KeyJ");
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await page.keyboard.press("Escape");
    if (width === 390) await page.keyboard.press("Escape");
    await input.click();
    await input.press("Alt+KeyX"); // Ordinary working refusal keeps the fold and draft.
    await expect(
      page.getByRole("alert").filter({ hasText: "still working" }),
    ).toBeVisible();
    await expect(input).toHaveValue("Unsent navigation draft");
    await openSidebar(page);
    await expect(page.locator(".org-disclosure")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(inputs);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/${width}-refusal.png`,
    });
    if (width === 390) await page.keyboard.press("Escape");
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/${width}-help.png`,
    });
  });

test("without a current session J starts first and K starts last", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "idle" } });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await openSidebar(page);
  const ids = await rows(page).evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-agent-id")!),
  );
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.keyboard.press("Alt+KeyK");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await page.goBack();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.keyboard.press("Alt+KeyJ");
  await openSidebar(page);
  await selected(page, ids[0], "tree");
});

test.describe("mobile Pin close with another visible owner", () => {
  test.use({ hasTouch: true });
  test("folding inside Sidebar excludes hidden surviving neighbors", async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "org-groups-idle" },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(origin);
    await openSidebar(page);
    await pin(page);
    await rows(page, "pinned").first().click();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await openSidebar(page);
    const group = page.locator('[data-org="guionai"] > .org-disclosure');
    await group.click();
    await expect(group).toHaveAttribute("aria-expanded", "false");
    const d = rows(page).filter({
      has: page.getByText("Reader performance", { exact: true }),
    });
    const dId = (await d.getAttribute("data-agent-id"))!;
    await expect(d).toBeVisible();
    const before = await state(page);
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/mobile-owner-close-before.png`,
    });
    await longPress(page, rows(page, "pinned").first());
    await page
      .getByRole("menuitem", { name: "Close this tree", exact: true })
      .tap();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(rows(page, "pinned")).toHaveCount(0);
    await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
    await page.screenshot({
      animations: "disabled",
      path: `${evidence}/mobile-owner-close-after.png`,
    });
    writeFileSync(
      `${evidence}/mobile-owner-close-state.json`,
      JSON.stringify({ before, after: await state(page) }, null, 2),
    );
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Reader performance",
    );
    await openSidebar(page);
    await selected(page, dId, "tree");
    await expect(group).toHaveAttribute("aria-expanded", "false");
  });
});
