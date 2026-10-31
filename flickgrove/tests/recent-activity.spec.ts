import { expect, test, type Page } from "@playwright/test";
import { openSidebar } from "./browser-actions";

const origin = "http://127.0.0.1:14319";
const recent = (page: Page) =>
  page.locator('.session-open[data-location="recent"]');
const tree = (page: Page) =>
  page.locator('.session-open[data-location="tree"]');
async function choose(page: Page, window: string) {
  await page.getByRole("combobox", { name: "Activity window" }).click();
  await page.getByRole("option", { name: window, exact: true }).click();
}

for (const width of [1440, 390])
  test(`recent activity filters and remembers the selected window at ${width}`, async ({
    page,
    request,
  }, testInfo) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "activity" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    await expect(recent(page).locator("strong")).toHaveText([
      "Earlier today",
      "Reader performance",
      "Streaming voice input",
    ]);
    await expect(
      page.getByRole("button", { name: /^Close this tree:/ }),
    ).toHaveCount(0);
    await choose(page, "1h");
    await expect(recent(page).locator("strong")).toHaveText([
      "Streaming voice input",
    ]);
    await choose(page, "4h");
    await expect(recent(page).locator("strong")).toHaveText([
      "Reader performance",
      "Streaming voice input",
    ]);
    await choose(page, "1w");
    await expect(recent(page)).toHaveCount(4);
    await expect(tree(page)).toHaveCount(5);
    await expect(
      page.getByRole("option", { name: "1w", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath(`${width}-recent.png`) });
    await recent(page).filter({ hasText: "Streaming voice input" }).click();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
    await openSidebar(page);
    await expect(
      page.locator('.session-open[aria-current="true"]'),
    ).toHaveCount(1);
    await expect(
      recent(page).filter({ hasText: "Streaming voice input" }),
    ).toHaveAttribute("aria-current", "true");
    await page.reload();
    await openSidebar(page);
    await expect(
      page.getByRole("combobox", { name: "Activity window" }),
    ).toContainText("1w");
    await expect(recent(page)).toHaveCount(4);
    await tree(page).first().click({ button: "right" });
    await expect(page.getByRole("menu")).toHaveCount(0);
  });

test("time expiry preserves detail and keyboard navigation, with shortcut close", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "activity" } });
  await page.clock.install();
  await page.goto(origin);
  await choose(page, "1h");
  await recent(page).first().click();
  await page.clock.fastForward("31:00");
  await expect(recent(page)).toHaveCount(0);
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect(tree(page).first()).toHaveAttribute("aria-current", "true");
  await choose(page, "1w");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.locator(".agent-detail h1")).toBeVisible();
  await tree(page).filter({ hasText: "Earlier this week" }).click();
  await page.keyboard.press("Alt+KeyX");
  await expect(tree(page).filter({ hasText: "Earlier this week" })).toHaveCount(
    0,
  );
});

test("failed optional storage retains the current selection", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "activity" } });
  await page.addInitScript(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith("/activity-window"))
        throw new Error("Storage unavailable");
      return set.call(this, key, value);
    };
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin);
  await openSidebar(page);
  await choose(page, "1h");
  await expect(recent(page)).toHaveCount(1);
  await choose(page, "1w");
  await expect(recent(page)).toHaveCount(4);
  await recent(page).first().click();
  await openSidebar(page);
  await expect(
    page.getByRole("combobox", { name: "Activity window" }),
  ).toContainText("1w");
  await expect(recent(page)).toHaveCount(4);
});

test("new work appears immediately and remains visible while working", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "idle" } });
  await page.clock.install();
  await page.goto(origin);
  await expect(recent(page)).toHaveCount(0);
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Start a new task");
  await input.press("Enter");
  await expect(recent(page).locator("strong")).toHaveText([
    "Streaming voice input",
  ]);
  await page.clock.fastForward("25:00:00");
  await expect(recent(page).locator("strong")).toHaveText([
    "Streaming voice input",
  ]);
});

test("recent activity keeps name order when an Orc starts work", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "activity" } });
  await page.goto(origin);
  const titles = [
    "Earlier today",
    "Reader performance",
    "Streaming voice input",
  ];
  await expect(recent(page).locator("strong")).toHaveText(titles);
  await recent(page).filter({ hasText: "Reader performance" }).click();
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Start work on this Orc");
  await input.press("Enter");
  await expect(page.locator(".detail-status")).toContainText("Working");
  await expect(recent(page).locator("strong")).toHaveText(titles);
});

test("shortcuts traverse recent sessions once and respect the composer", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: { mode: "activity" } });
  await page.goto(origin);
  await recent(page).first().click();
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await page.keyboard.press("Control+Digit1");
  await expect(page.locator(".agent-detail h1")).toHaveText("Earlier today");
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.focus();
  await page.keyboard.press("Alt+KeyJ");
  await expect(page.locator(".agent-detail h1")).toHaveText("Earlier today");
});
