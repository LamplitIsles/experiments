import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
const artifacts = resolve("../.scratch/codex-tps-workspace");
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
      data: { quotaFailure: false, logFailure: false, delay: 0 },
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
    expect(
      await page
        .locator(".output-speed dl > div")
        .first()
        .getAttribute("title"),
    ).toContain("2 samples");
    await page.screenshot({
      path: `${artifacts}/${width}-usage.png`,
      animations: "disabled",
    });
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
    await expect
      .poll(() =>
        page.locator(".output-speed dl > div").first().getAttribute("title"),
      )
      .toContain("unavailable");
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
    await page.screenshot({
      path: `${artifacts}/${width}-usage-empty.png`,
      animations: "disabled",
    });
    if (width === 390) {
      await page.goBack();
      await expect(page.locator(".weekly-popover")).toHaveCount(0);
      await expect(input).toBeVisible();
    }
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
