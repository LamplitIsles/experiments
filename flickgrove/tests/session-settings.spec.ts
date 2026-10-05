import { expect, test, type Page } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const info = async (page: Page) =>
  (await page.request.get(origin + "/fixture/info")).json();
const change = (page: Page, data: object) =>
  page.request.post(origin + "/fixture/change", { data });
async function choose(page: Page, title: string) {
  const row = page.getByRole("button", {
    name: `Open ${title} Orc`,
    exact: true,
  });
  if (!(await row.isVisible())) await page.keyboard.press("Escape");
  await row.click();
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    title,
  );
}
async function setup(page: Page, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.request.post(origin + "/fixture/reset", {
    data: { mode: "working" },
  });
  await page.goto(origin);
  await choose(page, "Reader performance");
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toBeEnabled();
}
for (const width of [1440, 390])
  test(`${width} opened remote settings atomic save/cancel, quick fast, next-turn and draft/caret; mobile click and Worker isolation`, async ({
    page,
  }) => {
    await setup(page, width);
    const before = await info(page);
    const composer = page.getByRole("textbox", { name: "Message Orc" });
    await composer.fill("draft with selection");
    await composer.evaluate((el: HTMLTextAreaElement) => {
      el.focus();
      el.setSelectionRange(3, 8);
    });
    await page.keyboard.press("Alt+f");
    await expect(page.locator(".detail-model [aria-label='Fast']")).toHaveCount(
      0,
    );
    await expect
      .poll(
        async () =>
          (await info(page)).peerAgents.find((a: any) => a.id === "orc")
            .serviceTier,
      )
      .toBe("default");
    await expect(composer).toHaveValue("draft with selection");
    expect(
      await composer.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
        document.activeElement === el,
      ]),
    ).toEqual([3, 8, true]);
    await expect(
      page.getByRole("button", { name: "Session settings", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Alt+m");
    const panel = page.getByRole("dialog", { name: "Session settings" });
    await expect(panel).toBeVisible();
    await panel
      .getByRole("combobox", { name: "Reasoning effort" })
      .selectOption("high");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel).toBeHidden();
    expect(
      (await info(page)).peerAgents.find((a: any) => a.id === "orc").effort,
    ).toBe("low");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([3, 8]);
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await panel
      .getByRole("combobox", { name: "Reasoning effort" })
      .selectOption("high");
    await panel
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("gpt-6-luna");
    await expect(
      panel.getByRole("combobox", { name: "Reasoning effort" }),
    ).toHaveValue("low");
    await expect(panel.getByRole("switch", { name: "Fast" })).toHaveCount(0); // remote catalogue differs from page Peer
    await panel.getByRole("button", { name: "Save changes" }).click();
    await expect(panel).toBeHidden();
    await expect(page.locator(".detail-model")).toContainText(
      "gpt-6-luna / low",
    );
    const after = await info(page);
    expect(after.localAgents).toEqual(before.localAgents);
    expect(after.peerAgents.find((a: any) => a.id === "reader")).toEqual({
      ...before.peerAgents.find((a: any) => a.id === "reader"),
      serviceTier: "default",
      treeFast: false,
    });
    expect(after.peerInputs).toEqual(before.peerInputs);
    await expect(composer).toBeFocused();
    await page.waitForTimeout(150);
    await page.screenshot({
      path: `../.scratch/flickgrove-first-detail-tree-fast/${width}-saved.png`,
    });
    await page.reload();
    await expect(page.locator(".detail-model")).toContainText(
      "gpt-6-luna / low",
    );
    await page
      .getByRole("button", { name: "Session settings", exact: true })
      .click();
    await panel
      .getByRole("combobox", { name: "Model", exact: true })
      .selectOption("gpt-6.1-sol");
    await expect(panel.getByRole("switch", { name: "Fast" })).toHaveCount(0);
    await page.waitForTimeout(150);
    await page.screenshot({
      path: `../.scratch/flickgrove-first-detail-tree-fast/${width}-panel.png`,
    });
    const box = await panel.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width - 32);
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    // Worker Fast targets its owning tree, including while Working.
    if (width === 390) await page.keyboard.press("Escape");
    await page
      .locator(".session-item")
      .filter({
        has: page.getByRole("button", {
          name: "Open Reader performance Orc",
          exact: true,
        }),
      })
      .getByRole("button", { name: "Expand Workers" })
      .click();
    await page
      .getByRole("button", { name: "Open Reader implementation Worker" })
      .click();
    await expect(page.locator(".agent-detail")).toHaveAttribute(
      "aria-label",
      "Reader implementation",
    );
    await expect(
      page.getByRole("button", { name: "Tree Fast", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Alt+f");
    await expect
      .poll(
        async () =>
          (await info(page)).peerAgents.find((a: any) => a.id === "reader")
            .serviceTier,
      )
      .toBe("priority");
    const treeAfter = await info(page);
    expect(treeAfter.peerAgents.find((a: any) => a.id === "orc").model).toBe(
      "gpt-6-luna",
    );
    expect(treeAfter.peerAgents.find((a: any) => a.id === "orc").treeFast).toBe(
      true,
    );
    expect(treeAfter.localAgents).toEqual(before.localAgents);
    await choose(page, "Reader performance");
    const zap = page.getByRole("button", { name: "Tree Fast", exact: true });
    await expect(zap).toHaveAttribute("aria-pressed", "true");
    await expect(zap).toHaveAttribute(
      "title",
      /Fast is unavailable for this model/,
    );
    expect(
      treeAfter.peerAgents.find((a: any) => a.id === "orc").serviceTier,
    ).toBe("default");
    await page.screenshot({
      path: `../.scratch/flickgrove-first-detail-tree-fast/${width}-tree-fast.png`,
    });
  });
test("foreground/IME/repeat guards, unknown failure, busy late target and offline do not cross sessions or type characters", async ({
  page,
}) => {
  await setup(page);
  const composer = page.getByRole("textbox", { name: "Message Orc" });
  await composer.fill("protected draft");
  const original = await info(page);
  await composer.evaluate((el) => {
    el.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keydown", { altKey: true, code: "KeyF", key: "ƒ" }),
    );
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        altKey: true,
        code: "KeyF",
        key: "ƒ",
        repeat: true,
      }),
    );
  });
  expect((await info(page)).peerAgents).toEqual(original.peerAgents);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Alt+f");
  await expect(
    page.getByRole("dialog", { name: "Session settings" }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Edit title" }).click();
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Alt+f");
  await expect(
    page.getByRole("dialog", { name: "Session settings" }),
  ).toBeHidden();
  await page.keyboard.press("Escape");
  await change(page, { settingsFailure: true });
  await composer.focus();
  await page.keyboard.press("Alt+f");
  await expect(page.getByRole("alert")).toContainText(
    "settings outcome unknown",
  );
  expect(
    (await info(page)).peerAgents.find((a: any) => a.id === "orc").serviceTier,
  ).toBe("priority");
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/1440-failure.png",
  });
  await change(page, { settingsFailure: false, settingsDelay: 700 });
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await page.keyboard.press("Alt+f");
  await choose(page, "Streaming voice input");
  await choose(page, "Reader performance");
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toBeEnabled({ timeout: 10000 });
  await choose(page, "Streaming voice input");
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  expect((await info(page)).localAgents).toEqual(original.localAgents);
  await choose(page, "Reader performance");
  await expect(page.locator(".detail-model [aria-label='Fast']")).toHaveCount(
    0,
  );
  await expect(composer).toHaveValue("protected draft");
  await change(page, { outage: true });
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await composer.focus();
  await page.keyboard.press("Alt+f");
  await expect(
    page.getByRole("button", { name: "Tree Fast", exact: true }),
  ).toBeDisabled();
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/1440-offline.png",
  });
});
test("390 long model, unavailable current choice, retained catalogue on failure and busy atomic save", async ({
  page,
}) => {
  await setup(page, 390);
  await change(page, { settingsLong: true });
  await page
    .getByRole("button", { name: "Session settings", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "Session settings" });
  const long =
    "fixture-model-with-an-extremely-long-name-for-mobile-overflow-verification";
  await panel
    .getByRole("combobox", { name: "Model", exact: true })
    .selectOption(long);
  await expect(
    panel.getByRole("combobox", { name: "Reasoning effort" }),
  ).toHaveValue("medium");
  await expect(panel.getByRole("switch", { name: "Fast" })).toHaveCount(0);
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/390-long-panel.png",
  });
  await change(page, { settingsDelay: 700 });
  await panel.getByRole("button", { name: "Save changes" }).click();
  await expect(
    panel.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/390-busy.png",
  });
  await expect(panel).toBeHidden();
  await expect(page.locator(".detail-model")).toContainText(long);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    390,
  );
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/390-long-saved.png",
  });
  await change(page, { modelFailure: true, settingsDelay: 0 });
  await page
    .getByRole("button", { name: "Session settings", exact: true })
    .click();
  await expect(panel.getByRole("alert")).toContainText("model outage");
  await expect(
    panel.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue(long);
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/390-catalogue-failure.png",
  });
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await change(page, { modelFailure: false, settingsLong: false });
  await page
    .getByRole("button", { name: "Session settings", exact: true })
    .click();
  await expect(
    panel.getByRole("combobox", { name: "Model", exact: true }),
  ).toContainText("unavailable");
  await expect(
    panel.getByRole("button", { name: "Save changes" }),
  ).toBeDisabled();
  await page.waitForTimeout(150);
  await page.screenshot({
    path: "../.scratch/flickgrove-first-detail-tree-fast/390-unavailable.png",
  });
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+m");
  await page.keyboard.press("Alt+f");
  await expect(panel).toBeHidden(); // no opened detail
});
