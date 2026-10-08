import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-device-questions-3501/screenshots";
test.use({ serviceWorkers: "block" });
for (const width of [1440, 390]) {
  test(`device unanswered dot follows authoritative two-Peer questions at ${width}`, async ({
    page,
    request,
  }) => {
    const change = async (data: Record<string, unknown>) => {
      expect(
        (await request.post(origin + "/fixture/change", { data })).ok(),
      ).toBe(true);
    };
    await request.post(origin + "/fixture/reset", {
      data: { mode: "device-questions" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    const filters = page.getByRole("group", {
      name: "Host filter",
      includeHidden: true,
    });
    const mac = filters.getByRole("button", {
      name: /^Neil’s Mac/,
      includeHidden: true,
    });
    const nuc = filters.getByRole("button", {
      name: /^NUC/,
      includeHidden: true,
    });
    const dot = (button: typeof mac) => button.locator(".host-question-dot");
    await expect(mac).toBeVisible();
    await expect(nuc).toHaveAttribute("aria-pressed", "true");
    await expect(filters.locator(".host-question-dot")).toHaveCount(0); // Delegated Worker and working state do not qualify.
    const geometry = () =>
      filters.locator("button").evaluateAll((els) =>
        els.map((el) => {
          const { x, y, width, height } = el.getBoundingClientRect();
          return { x, y, width, height };
        }),
      );
    const before = await geometry();
    await change({
      question: true,
      questionAgent: "peer",
      questionId: "background",
      questionOptions: false,
    });
    await expect(dot(mac)).toHaveCount(1);
    await expect(dot(nuc)).toHaveCount(0);
    expect(await geometry()).toEqual(before);
    await expect(mac).toHaveAttribute("aria-pressed", "false");
    await expect(
      page.locator(".host-filter-control > button .host-question-dot"),
    ).toHaveCount(0);
    const screenshot = async (name: string) => {
      await mac.scrollIntoViewIfNeeded();
      const bounds = await mac.boundingBox();
      const mark = await dot(mac).boundingBox();
      expect(mark!.x).toBeGreaterThan(bounds!.x);
      expect(mark!.x + mark!.width).toBeLessThan(bounds!.x + bounds!.width);
      expect(mark!.y).toBeGreaterThan(bounds!.y);
      expect(mark!.y + mark!.height).toBeLessThan(bounds!.y + bounds!.height);
      await page.screenshot({ path: `${shots}/${width}-${name}.png` });
    };
    await screenshot("normal-background");
    // Browser-owned configured name exercises the same real button with truncation.
    await page.evaluate(() => {
      const key = `flickgrove/${location.origin}/peers`;
      const peers = JSON.parse(localStorage.getItem(key)!);
      peers[0].name =
        "Neil’s Mac with an extremely long device name for truncation";
      localStorage.setItem(key, JSON.stringify(peers));
    });
    await page.reload();
    const longMac = filters.getByRole("button", {
      name: /^Neil’s Mac/,
      includeHidden: true,
    });
    await expect(dot(longMac)).toBeVisible();
    await screenshot("long-background");
    await mac.click();
    if (width === 390 && !(await page.locator(".agent-detail").count()))
      await page
        .getByRole("button", {
          name: "Open Reader performance Orc",
          exact: true,
        })
        .click();
    const panel = page.locator(".question-panel");
    await expect(panel).toBeVisible();
    if (width === 390) {
      await panel.getByRole("button", { name: "Close", exact: true }).click();
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
      await screenshot("long-active");
      await page
        .getByRole("button", {
          name: "Open Reader performance Orc",
          exact: true,
        })
        .click();
      await page
        .getByRole("button", { name: "All questions", exact: true })
        .click();
    } else await screenshot("long-active");
    await change({ sendMode: "held" });
    await panel.locator("textarea").fill("First answer");
    await expect(
      page.getByRole("button", { name: "Add images", exact: true }),
    ).toBeEnabled();
    await panel.locator("textarea").press("Enter");
    await expect(panel).toContainText("Sending");
    await expect(dot(mac)).toHaveCount(1);
    await change({
      question: true,
      questionPeer: true,
      questionAgent: "second",
      questionId: "other-session",
      questionOptions: false,
    });
    await change({ sendMode: "accepted" });
    await expect(panel).toHaveCount(0);
    await expect(dot(mac)).toHaveCount(1); // Second open session still unanswered.
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Open Mac second session Orc", exact: true })
      .click();
    await expect(panel).toBeVisible();
    await change({ sendMode: "rejected" });
    await panel.locator("textarea").fill("Second answer");
    await expect(
      page.getByRole("button", { name: "Add images", exact: true }),
    ).toBeEnabled();
    await panel.locator("textarea").press("Enter");
    await expect(panel).toContainText("Synthetic rejection");
    await expect(dot(mac)).toHaveCount(1);
    // A new question on the other host must remain isolated through remote confirmation.
    await change({
      question: true,
      questionId: "local",
      questionOptions: false,
    });
    await expect(dot(nuc)).toHaveCount(1);
    await change({ sendMode: "accepted" });
    await panel.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(dot(mac)).toHaveCount(0);
    await expect(dot(nuc)).toHaveCount(1);
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    await nuc.click();
    if (width === 390 && !(await page.locator(".agent-detail").count()))
      await page
        .getByRole("button", {
          name: "Open Streaming voice input Orc",
          exact: true,
        })
        .click();
    await expect(panel).toBeVisible();
    await change({ sendMode: "uncertain" });
    await panel.locator("textarea").fill("Null remains unresolved");
    await expect(
      page.getByRole("button", { name: "Add images", exact: true }),
    ).toBeEnabled();
    await panel.locator("textarea").press("Enter");
    await expect(panel).toContainText("Sending");
    await page.reload();
    await expect(panel).toContainText("Null remains unresolved");
    await expect(dot(nuc)).toHaveCount(1);
    await change({ restartHub: true, closedAgent: "orc" });
    await expect(dot(nuc)).toHaveCount(0);
    await expect(dot(mac)).toHaveCount(0);
  });
}

test("genuine unanswered Worker qualifies; delegated Worker and offline snapshots retain semantics", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "device-worker" },
  });
  await page.goto(origin);
  const filters = page.getByRole("group", {
    name: "Host filter",
    includeHidden: true,
  });
  const nuc = filters.getByRole("button", {
    name: /^NUC/,
    includeHidden: true,
  });
  const mac = filters.getByRole("button", {
    name: /^Neil’s Mac/,
    includeHidden: true,
  });
  await expect(nuc.locator(".host-question-dot")).toBeVisible();
  await expect(mac.locator(".host-question-dot")).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: { question: true, questionAgent: "peer", questionId: "offline" },
  });
  await expect(mac.locator(".host-question-dot")).toBeVisible();
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await mac.click();
  await expect(page.locator(".agent-detail .host-outage")).toBeVisible();
  await expect(mac.locator(".host-question-dot")).toBeVisible();
  await request.post(origin + "/fixture/change", {
    data: { restartHub: true, closedAgent: "voice" },
  });
  await expect(nuc.locator(".host-question-dot")).toHaveCount(0);
  await expect(mac.locator(".host-question-dot")).toBeVisible();
});
