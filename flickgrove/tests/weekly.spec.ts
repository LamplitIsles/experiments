import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
test("page Peer quota cache survives failure, missing data, reload and a different selected Peer", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", { data: { usage: 64 } });
  await page.goto(origin);
  const ring = page.locator(".app-header .weekly-button strong");
  await expect(ring).toHaveText("64%");
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await expect(page.locator(".weekly-source")).toContainText("Resets");
  await request.post(origin + "/fixture/change", {
    data: { quotaFailure: true },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("64%");
  await page.reload();
  await expect(ring).toHaveText("64%");
  await page.getByRole("button", { name: "Neil’s Mac", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await request.post(origin + "/fixture/change", {
    data: { quotaFailure: false, usage: null },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("64%");
  await request.post(origin + "/fixture/change", {
    data: { usage: 47, quotaResets: null },
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("47%");
  await expect(page.locator(".weekly-source")).not.toContainText("Resets");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-back .weekly-button strong")).toHaveText(
    "47%",
  );
});

test("model refresh failure retains available choices and recovery refreshes them", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await expect(page.locator(".app-header .weekly-button strong")).toHaveText(
    "72%",
  );
  await request.post(origin + "/fixture/change", {
    data: { modelFailure: true },
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.locator(".role-settings").first().getByRole("combobox").first(),
  ).toHaveValue("gpt-6.1-sol");
  await page.keyboard.press("Escape");
  await request.post(origin + "/fixture/change", {
    data: { modelFailure: false },
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.locator(".role-settings").first().getByRole("combobox").first(),
  ).toHaveValue("gpt-6.1-sol");
});

const week = 7 * 24 * 60 * 60 * 1000;
const instant = Date.UTC(2026, 9, 10, 12);
const resetAt = (instant + week * 0.4) / 1000;
for (const width of [1440, 390]) {
  test(`elapsed and quota measures at ${width}px`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    await request.post(origin + "/fixture/change", {
      data: { usage: 30, quotaResets: resetAt },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install({ time: instant });
    await page.goto(origin);
    const button = page.locator(".app-header .weekly-button");
    await expect(button.locator("strong")).toHaveText("30%");
    await expect(button).toHaveAccessibleDescription(
      "Remaining account quota: 30%; Period elapsed: 60%",
    );
    await expect(button.locator(".elapsed-value")).toHaveAttribute(
      "stroke-dasharray",
      /^60(?:\.\d+)? 100$/,
    );
    await expect(button.locator(".ring-value")).toHaveAttribute(
      "stroke-dasharray",
      "30 100",
    );
    await page.screenshot({
      path: `../.scratch/weekly-elapsed-ring/${width}-collapsed.png`,
    });
    await button.click();
    const detail = page.locator(".weekly-popover");
    await expect(detail.locator(".elapsed-value")).toHaveAttribute(
      "stroke-dasharray",
      /^60(?:\.\d+)? 100$/,
    );
    await expect(detail).toContainText("Period elapsed60%");
    await expect(detail).toContainText("Remaining account quota");
    await expect(detail).toContainText("Resets");
    await page.screenshot({
      path: `../.scratch/weekly-elapsed-ring/${width}-expanded.png`,
    });
    if (width === 390) {
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", { name: "Open Streaming voice input Orc" })
        .click();
      const mobile = page.locator(".mobile-back .weekly-button");
      await expect(mobile).toHaveAccessibleDescription(
        "Remaining account quota: 30%; Period elapsed: 60%",
      );
      await page.screenshot({
        path: "../.scratch/weekly-elapsed-ring/390-conversation-collapsed.png",
      });
      await mobile.click();
      await page.screenshot({
        path: "../.scratch/weekly-elapsed-ring/390-conversation-expanded.png",
      });
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await button.click();
    }
    await request.post(origin + "/fixture/change", {
      data: { quotaFailure: true },
    });
    await page.clock.fastForward(week * 0.1);
    await expect(button).toHaveAccessibleDescription(
      "Remaining account quota: 30%; Period elapsed: 70%",
    );
    await page.clock.fastForward(week);
    await expect(button.locator(".elapsed-value")).toHaveAttribute(
      "stroke-dasharray",
      "100 100",
    );
    await expect(button.locator("strong")).toHaveText("30%");
    await request.post(origin + "/fixture/change", {
      data: {
        quotaFailure: false,
        usage: 15,
        quotaResets: (instant + week * 2.5) / 1000,
      },
    });
    await detail.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(button.locator("strong")).toHaveText("15%");
    await expect(button.locator(".elapsed-value")).toHaveAttribute(
      "stroke-dasharray",
      "0 100",
    );
    const quotaColor = await button
      .locator(".ring-value")
      .evaluate((el) => getComputedStyle(el).stroke);
    expect(
      await button
        .locator(".elapsed-value")
        .evaluate((el) => getComputedStyle(el).stroke),
    ).not.toBe(quotaColor);
    await request.post(origin + "/fixture/change", {
      data: { quotaResets: (instant + week * 1.5) / 1000 },
    });
    await detail.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(button).toHaveAccessibleDescription(
      "Remaining account quota: 15%; Period elapsed: 60%",
    );
    await page.screenshot({
      path: `../.scratch/weekly-elapsed-ring/${width}-low-quota.png`,
    });
    for (const quotaResets of [null, 0, -1]) {
      await request.post(origin + "/fixture/change", { data: { quotaResets } });
      await detail
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await expect(page.locator(".elapsed-value")).toHaveCount(0);
      await expect(detail).not.toContainText("Period elapsed");
    }
  });
}

test("unknown quota and tab return keep time semantics", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", { data: { usage: null } });
  await page.clock.install({ time: instant });
  await page.goto(origin);
  const button = page.locator(".app-header .weekly-button");
  await expect(button.locator("strong")).toHaveText("—");
  await expect(button.locator(".elapsed-value")).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: { usage: 30, quotaResets: resetAt },
  });
  await button.click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(button).toHaveAccessibleDescription(
    "Remaining account quota: 30%; Period elapsed: 60%",
  );
  await page.clock.setSystemTime(instant + week * 0.1);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(button).toHaveAccessibleDescription(
    "Remaining account quota: 30%; Period elapsed: 70%",
  );
});
