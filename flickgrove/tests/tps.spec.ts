import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
const artifacts = resolve("../.scratch/output-speed-tooltip");
async function select(page: Page, title: string, mobile = false) {
  const button = page.getByRole("button", {
    name: `Open ${title} Orc`,
    exact: true,
  });
  if (mobile && !(await button.isVisible()))
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click();
  await button.click();
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeVisible();
}
async function usage(page: Page) {
  await page.getByRole("button", { name: "Weekly usage", exact: true }).click();
  await expect(page.locator(".output-speed")).toBeVisible();
}
for (const width of [1440, 390])
  test(`Usage ${width}: actual background values, empty, refresh failures, caret and one-layer close`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post("/fixture/control", {
      data: {
        quotaFailure: false,
        logFailure: false,
        delay: 0,
        distinctWindows: false,
      },
    });
    await page.goto("/");
    await select(page, "Fast fixture", width === 390);
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("draft preserved");
    await input.evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(4, 4));
    const before = await (await page.request.get("/fixture/info")).json();
    await usage(page);
    await expect(page.locator(".output-speed dd")).toHaveText([
      "37.2",
      "37.2",
      "37.2",
    ]);
    await expect(page.locator(".output-speed dt")).toHaveText([
      "1h",
      "4h",
      "1w",
    ]);
    const help = page.locator('[data-speed-help][data-state="open"]');
    for (const label of ["1h", "4h", "1w"]) {
      const trigger = page.getByRole("button", {
        name: `${label} output speed details`,
      });
      await trigger.hover();
      await trigger.focus();
      await expect(help).toHaveCount(0);
      await trigger.click();
      await expect(help).toContainText("sol · Fast. 2 samples.");
      await expect(help).toContainText(
        "may include partial or interrupted output",
      );
      await help.click();
      await expect(page.locator(".weekly-popover")).toBeVisible();
      const box = (await help.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(width === 390 ? 844 : 900);
      await page.screenshot({
        path: `${artifacts}/${width}-${label}-help.png`,
        animations: "disabled",
      });
      await trigger.click();
      await expect(help).toHaveCount(0);
      await expect(page.locator(".weekly-popover")).toBeVisible();
    }
    const trigger = page.getByRole("button", {
      name: "1h output speed details",
    });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(help).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(page.locator(".weekly-popover")).toBeVisible();
    await trigger.focus();
    await page.keyboard.press("Space");
    await expect(help).toBeVisible();
    await page.locator(".weekly-number").click();
    await expect(help).toHaveCount(0);
    await expect(page.locator(".weekly-popover")).toBeVisible();
    await page.request.post("/fixture/control", {
      data: { distinctWindows: true },
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".output-speed dd")).toHaveText([
      "11.0",
      "22.0",
      "33.0",
    ]);
    for (const [label, count] of [
      ["1h", 1],
      ["4h", 2],
      ["1w", 3],
    ] as const) {
      const rowTrigger = page.getByRole("button", {
        name: `${label} output speed details`,
      });
      await rowTrigger.click();
      await expect(help).toContainText(`${count} samples.`);
      await rowTrigger.click();
    }
    await page.request.post("/fixture/control", {
      data: { distinctWindows: false },
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".output-speed dd")).toHaveText([
      "37.2",
      "37.2",
      "37.2",
    ]);
    const popup = await page.locator(".weekly-popover").boundingBox();
    expect(popup!.x).toBeGreaterThanOrEqual(12);
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(width - 12);
    expect(
      await page.locator("body").evaluate((e) => e.scrollWidth <= innerWidth),
    ).toBe(true);
    await page.request.post("/fixture/control", {
      data: { quotaFailure: true },
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".weekly-number strong")).toHaveText("28%");
    await expect(page.locator(".output-speed dd")).toHaveText([
      "37.2",
      "37.2",
      "37.2",
    ]);
    await page.request.post("/fixture/control", {
      data: { quotaFailure: false, remaining: 60, logFailure: true },
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator(".weekly-number strong")).toHaveText("40%");
    await trigger.click();
    await expect(help).toContainText("Speed statistics unavailable.");
    await trigger.click();
    await expect(page.locator(".output-speed dd")).toHaveText([
      "37.2",
      "37.2",
      "37.2",
    ]);
    await page.screenshot({
      path: `${artifacts}/${width}-usage-failure.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await expect(page.locator(".weekly-popover")).toHaveCount(0);
    await expect(input).toHaveValue("draft preserved");
    expect(
      await input.evaluate((e: HTMLTextAreaElement) => e.selectionStart),
    ).toBe(4);
    expect(
      (await (await page.request.get("/fixture/info")).json()).inputs.length,
    ).toBe(before.inputs.length);
    await page.request.post("/fixture/control", {
      data: { logFailure: false, remaining: 72 },
    });
    await select(page, "Empty fixture", width === 390);
    await usage(page);
    await expect(page.locator(".output-speed dd")).toHaveText(["—", "—", "—"]);
    await page.getByRole("button", { name: "1h output speed details" }).click();
    await expect(
      page.locator('[data-speed-help][data-state="open"]'),
    ).toContainText("luna · Standard. 0 samples.");
    await page.getByRole("button", { name: "1h output speed details" }).click();
    await page.screenshot({
      path: `${artifacts}/${width}-usage-empty.png`,
      animations: "disabled",
    });
    if (width === 390) {
      await page.goBack();
      await expect(page.locator(".weekly-popover")).toHaveCount(0);
      await expect(input).toBeVisible();
    } else {
      await page.keyboard.press("Escape");
    }
    await select(page, "Long model fixture", width === 390);
    await usage(page);
    await page.getByRole("button", { name: "1w output speed details" }).click();
    await expect(help).toContainText("model".repeat(35));
    expect(await help.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    const longBox = (await help.boundingBox())!;
    expect(longBox.x).toBeGreaterThanOrEqual(0);
    expect(longBox.x + longBox.width).toBeLessThanOrEqual(width);
    expect(longBox.y + longBox.height).toBeLessThanOrEqual(
      width === 390 ? 844 : 900,
    );
    expect(
      await help.evaluate((e) => {
        const r = e.getBoundingClientRect();
        return e.contains(document.elementFromPoint(r.left + 10, r.top + 10));
      }),
    ).toBe(true);
    await page.screenshot({
      path: `${artifacts}/${width}-long-model.png`,
      animations: "disabled",
    });
    expect(errors).toEqual([]);
  });
test("late old key is ignored; blocked analysis leaves send, selection and observed Stop usable without extra sends", async ({
  page,
}) => {
  await page.request.post("/fixture/control", {
    data: { delay: 0, quotaFailure: false, logFailure: false },
  });
  await page.goto("/");
  await select(page, "Fast fixture");
  await page.request.post("/fixture/control", { data: { delay: 1300 } });
  const held = (await (await page.request.get("/fixture/info")).json())
    .heldReads;
  await usage(page);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/info")).json()).heldReads,
    )
    .toBeGreaterThan(held);
  await page.request.post("/fixture/control", { data: { delay: 0 } });
  await select(page, "Standard fixture");
  await usage(page);
  await expect(page.locator(".output-speed dd")).toHaveText([
    "74.3",
    "74.3",
    "74.3",
  ]);
  await page.waitForTimeout(1500);
  await expect(page.locator(".output-speed dd")).toHaveText([
    "74.3",
    "74.3",
    "74.3",
  ]);
  await page.request.post("/fixture/control", { data: { delay: 0 } });
  await page.keyboard.press("Escape");
  await select(page, "Fast fixture");
  const before = await (await page.request.get("/fixture/info")).json();
  await page.request.post("/fixture/control", { data: { block: true } });
  await usage(page);
  await page.keyboard.press("Escape");
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("One authorized fixture input");
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: "Stop Orc", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
  await select(page, "Standard fixture");
  await expect(
    page.getByRole("heading", { name: "Standard fixture", exact: true }),
  ).toBeVisible();
  const after = await (await page.request.get("/fixture/info")).json();
  expect(after.inputs.length - before.inputs.length).toBe(1);
  expect(after.interruptions.length - before.interruptions.length).toBe(1);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/info")).json()).diagnostics
          .pid,
    )
    .toBe(0);
});

test("touch opens and dismisses a help popover without closing Usage", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:14328",
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  try {
    await page.request.post("/fixture/control", {
      data: {
        quotaFailure: false,
        logFailure: false,
        delay: 0,
        distinctWindows: false,
      },
    });
    await page.goto("/");
    await select(page, "Fast fixture", true);
    await usage(page);
    for (const label of ["1h", "4h", "1w"]) {
      const trigger = page.getByRole("button", {
        name: `${label} output speed details`,
      });
      await trigger.tap();
      await expect(
        page.locator('[data-speed-help][data-state="open"]'),
      ).toContainText("2 samples.");
      await trigger.tap();
      await expect(
        page.locator('[data-speed-help][data-state="open"]'),
      ).toHaveCount(0);
      await expect(page.locator(".weekly-popover")).toBeVisible();
    }
    await page.getByRole("button", { name: "1h output speed details" }).tap();
    await page.getByRole("button", { name: "4h output speed details" }).tap();
    await expect(
      page.locator('[data-speed-help][data-state="open"]'),
    ).toContainText("2 samples.");
    await page.goBack();
    await expect(
      page.locator('[data-speed-help][data-state="open"]'),
    ).toHaveCount(0);
    await expect(page.locator(".weekly-popover")).toBeVisible();
  } finally {
    await context.close();
  }
});

for (const width of [1440, 390])
  test(`Usage help Back hierarchy and dismissal ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post("/fixture/control", {
      data: {
        distinctWindows: true,
        quotaFailure: false,
        logFailure: false,
        delay: 0,
      },
    });
    await page.goto("/");
    await select(page, "Fast fixture", width === 390);
    await usage(page);
    const help = page.locator('[data-speed-help][data-state="open"]');
    const parent = page.locator(".weekly-popover");
    const button = (label: string) =>
      page.getByRole("button", { name: `${label} output speed details` });
    await button("1h").click();
    await expect(help).toContainText("1 samples.");
    await page.goBack();
    await expect(help).toHaveCount(0);
    await expect(parent).toBeVisible();
    await page.goForward();
    await expect(help).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => history.state?.grove?.surfaces?.at(-1)))
      .toBe("weekly");
    await page.goBack();
    await expect(parent).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message Orc" }),
    ).toBeVisible();

    await usage(page);
    await button("1h").click();
    await expect(help).toContainText("1 samples.");
    await button("4h").click();
    await expect(help).toContainText("2 samples.");
    await button("1w").click();
    await expect(help).toContainText("3 samples.");
    await page.goBack();
    await expect(help).toHaveCount(0);
    await expect(parent).toBeVisible();
    await page.goBack();
    await expect(parent).toHaveCount(0);

    await usage(page);
    await button("1h").click();
    await expect(help).toBeVisible();
    await button("1h").click();
    await expect(help).toHaveCount(0);
    await page.goBack();
    await expect(parent).toHaveCount(0);

    await usage(page);
    await button("1h").click();
    await button("1h").click();
    await button("1h").click();
    await expect(help).toBeVisible();
    await page.goBack();
    await expect(help).toHaveCount(0);
    await expect(parent).toBeVisible();
    await page.goBack();
    await expect(parent).toHaveCount(0);

    await usage(page);
    await button("1h").click();
    await page.getByRole("button", { name: "Refresh", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(help).toHaveCount(0);
    await expect(parent).toBeVisible();
    await page.goBack();
    await expect(parent).toHaveCount(0);

    await usage(page);
    await button("1h").click();
    await page.locator(".weekly-number").click();
    await expect(help).toHaveCount(0);
    await expect(parent).toBeVisible();
    await page.goBack();
    await expect(parent).toHaveCount(0);

    await usage(page);
    await button("1h").click();
    await parent.getByRole("button", { name: "Close", exact: true }).click();
    await expect(parent).toHaveCount(0);
    await expect(help).toHaveCount(0);
    await page.goForward();
    await expect(help).toHaveCount(0);

    if (!(await parent.isVisible())) await usage(page);
    await button("1h").click();
    await page.mouse.click(12, 550);
    await expect(parent).toHaveCount(0);
    await expect(help).toHaveCount(0);
    await page.request.post("/fixture/control", {
      data: { distinctWindows: false },
    });
  });
