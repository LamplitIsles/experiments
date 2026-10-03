import { expect, test } from "@playwright/test";

for (const surface of [
  "detail",
  "settings",
  "new",
  "skill",
  "worker",
  "weekly",
  "title",
  "host-filter",
] as const) {
  test(`mobile browser Back stays in Grove from ${surface}`, async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://127.0.0.1:14318/");
    await page.goto("http://127.0.0.1:14319/");
    await expect(page.locator(".session-open").first()).toBeVisible();

    if (surface === "host-filter") {
      await page.getByRole("combobox", { name: "Host filter" }).click();
      await expect(page.locator(".host-filter-menu")).toBeVisible();
    } else if (surface === "settings")
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    else if (surface === "new")
      await page
        .getByRole("button", { name: "New session", exact: true })
        .click();
    else {
      await page.locator(".session-open").first().click();
      await expect(page.locator(".agent-detail")).toBeVisible();
      if (surface === "skill") {
        await page
          .getByRole("textbox", { name: "Message Orc", exact: true })
          .press("$");
        await expect(page.locator(".skill-search")).toBeVisible();
      }
      if (surface === "weekly") {
        await page.locator(".mobile-back .weekly-button").click();
        await expect(page.locator(".weekly-popover")).toBeVisible();
      }
      if (surface === "title")
        await page
          .getByRole("button", { name: "Edit title", exact: true })
          .click();
      if (surface === "worker") {
        await page.locator(".mobile-workers summary").click();
        await page.locator(".mobile-workers button").first().click();
      }
    }

    await page.goBack();
    const dismissed = {
      detail: ".agent-detail",
      settings: "[role=dialog]",
      new: "[role=dialog]",
      skill: ".skill-search",
      weekly: ".weekly-popover",
      title: ".title-edit",
      "host-filter": ".host-filter-menu",
    };
    if (surface === "worker")
      await expect(page.locator(".agent-detail .role-project")).toContainText(
        "Orc",
      );
    else await expect(page.locator(dismissed[surface])).toHaveCount(0);
    expect(
      new URL(page.url()).port,
      "Back must dismiss the current Grove view before leaving the app",
    ).toBe("14319");
  });
}

test("mobile on-screen Back returns to sessions without leaving Grove", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:14319/");
  await page.locator(".session-open").first().click();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page.locator(".mobile-back > button").click();
  await expect(page.locator(".session-list")).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  expect(new URL(page.url()).port).toBe("14319");
});

test("Orc → Worker → Back preserves the parent draft; Forward and refresh restore without submitting", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("http://127.0.0.1:14318/");
  await page.goto("http://127.0.0.1:14319/");
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Unsent parent draft");
  const id = await page.evaluate(() => history.state.grove.details[0]);
  const before = await (
    await request.get(`http://127.0.0.1:14319/api/agents/${id}`)
  ).json();
  await page.locator(".mobile-workers summary").click();
  await page.locator(".mobile-workers button").first().click();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.reload();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.goBack();
  await expect(input).toHaveValue("Unsent parent draft");
  await page.goForward();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.getByRole("button", { name: "‹ Orc", exact: true }).click();
  await expect(input).toHaveValue("Unsent parent draft");
  await page.getByRole("button", { name: "Edit title" }).click();
  await page
    .getByRole("textbox", { name: "Session title", exact: true })
    .fill("Never saved");
  await page.goBack();
  await expect(page.locator(".title-edit")).toHaveCount(0);
  await input.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(0, 0),
  );
  await input.press("$");
  await expect(page.locator(".skill-search")).toBeVisible();
  await page.goBack();
  await expect(input).toHaveValue("Unsent parent draft");
  await page.goBack();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.goBack();
  expect(new URL(page.url()).port).toBe("14318");
  const after = await (
    await request.get(`http://127.0.0.1:14319/api/agents/${id}`)
  ).json();
  expect(after.messages).toEqual(before.messages);
  expect(after.title).toBe(before.title);
  expect(after.turnId).toBe(before.turnId);
});

test("close and Esc consume only the top layer, same-level switching does not pile up history", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
  await page.goto("http://127.0.0.1:14318/");
  await page.goto("http://127.0.0.1:14319/");
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const length = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator(".modal-close").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for (let i = 0; i < 4; i++) {
    await page
      .getByRole("button", { name: "Open Reader performance Orc" })
      .click();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Reader performance",
    );
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Streaming voice input",
    );
  }
  // The dismissed settings entry occupies the existing Forward slot only.
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.getByRole("button", { name: "Close detail" }).click();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.goBack();
  expect(new URL(page.url()).port).toBe("14318");
});

for (const origin of ["parent", "nested-current", "nested-sibling"]) {
  test(`list Worker selection replaces ${origin} detail history`, async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
    await page.goto("http://127.0.0.1:14318/");
    await page.goto("http://127.0.0.1:14319/");
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (origin !== "parent") {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".mobile-workers summary").click();
      const workers = page.locator(".mobile-workers button");
      await (
        origin === "nested-current" ? workers.first() : workers.last()
      ).click();
      await expect(page.locator(".role-project")).toContainText("Worker");
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.getByRole("button", { name: "Expand Workers" }).first().click();
    await page.getByRole("button", { name: "Open Voice input Worker" }).click();
    await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
    await page.goBack();
    await expect(page.locator(".agent-detail")).toHaveCount(0);
    await page.goForward();
    await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
    await page.goBack();
    await page.goBack();
    expect(new URL(page.url()).port).toBe("14318");
  });
}

for (const surface of ["weekly", "title"]) {
  test(`list switching unwinds active ${surface} history`, async ({
    page,
    request,
  }) => {
    await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
    await page.goto("http://127.0.0.1:14318/");
    await page.goto("http://127.0.0.1:14319/");
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    if (surface === "weekly")
      await page.locator("header .weekly-button").click();
    else await page.getByRole("button", { name: "Edit title" }).click();
    const transient = page.locator(
      surface === "weekly" ? ".weekly-popover" : ".title-edit",
    );
    await expect(transient).toBeVisible();
    await page
      .getByRole("button", { name: "Open Reader performance Orc" })
      .click();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Reader performance",
    );
    await expect(transient).toHaveCount(0);
    await page.goBack();
    await expect(page.locator(".agent-detail")).toHaveCount(0);
    await page.goForward();
    await expect(page.locator(".agent-detail h1")).toHaveText(
      "Reader performance",
    );
    await expect(transient).toHaveCount(0);
    await page.goBack();
    await page.goBack();
    expect(new URL(page.url()).port).toBe("14318");
  });
}

test("a late detail response cannot reopen a dismissed conversation", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
  await page.goto("http://127.0.0.1:14319/");
  await expect(page.locator(".session-open").first()).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const started = new Promise<void>((resolve) => (arrived = resolve));
  await page.route("**/api/agents/*", async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  await page.locator(".session-open").first().click();
  await started;
  await expect(
    page.getByRole("button", { name: "‹ Sessions", exact: true }),
  ).toBeVisible();
  await page.goBack();
  release();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(page.locator(".session-list")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
});

test("a closed historical target stays closed on Forward", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await page.goto("http://127.0.0.1:14319/");
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(page.locator(".role-project")).toContainText("Orc");
  await page.keyboard.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open Streaming voice input Orc" }),
  ).toHaveCount(0);
});

test("visible tree keyboard navigation scrolls, preserves expansion and drafts, and renders compact desktop/mobile", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", {
    data: { mode: "dense" },
  });
  await page.goto("http://127.0.0.1:14319/");
  const list = page.locator(".session-list");
  await expect(page.locator(".worker-item")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(
    page.locator(".navigation-focus .session-open"),
  ).toHaveAccessibleName("Open Streaming voice input Orc");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".worker-item")).toHaveCount(2);
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator(".navigation-focus .session-open"),
  ).toHaveAccessibleName("Open Voice input Worker");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("e");
  await expect(page.locator(".worker-item")).toHaveCount(0);
  for (let i = 0; i < 17; i++) await page.keyboard.press("ArrowDown");
  const target = page.locator(".navigation-focus .session-open");
  const bounds = (await list.boundingBox())!;
  const item = (await target.boundingBox())!;
  expect(item.y).toBeGreaterThanOrEqual(bounds.y);
  expect(item.y + item.height).toBeLessThanOrEqual(bounds.y + bounds.height);
  let scroll = await list.evaluate((el) => el.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await page.keyboard.press("Enter");
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("Keep this draft");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Keep this draft");
  const titleBefore = await page.locator(".agent-detail h1").textContent();
  await page.locator(".role-project").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".agent-detail h1")).not.toHaveText(titleBefore!);
  scroll = await list.evaluate((el) => el.scrollTop);
  await page.keyboard.press("Escape");
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  expect(await list.evaluate((el) => el.scrollTop)).toBe(scroll);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(input).toHaveValue("Keep this draft");
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  const longTitle = page
    .locator(".worker-item strong")
    .filter({ hasText: "Documentation for a very long" });
  await expect(longTitle).toBeVisible();
  expect((await longTitle.boundingBox())!.height).toBeLessThanOrEqual(36);
  const panel = (await page.locator(".agent-detail").boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(bounds.x + bounds.width);
  await page.screenshot({
    path: "../.scratch/flickgrove-compact-tree/desktop-tree-detail.png",
  });
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "../.scratch/flickgrove-compact-tree/mobile-tree-long-worker.png",
  });
  await page.getByRole("button", { name: "Open Voice input Worker" }).click();
  await expect(page.locator(".role-project")).toContainText("Worker");
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await expect(list).toBeVisible();
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await page.locator(".mobile-workers summary").click();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "../.scratch/flickgrove-compact-tree/mobile-detail.png",
  });
  await page.reload();
  await expect(page.locator(".agent-detail")).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(page.locator(".worker-item")).toHaveCount(2);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "../.scratch/flickgrove-compact-tree/mobile-settings.png",
    animations: "disabled",
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: "../.scratch/flickgrove-compact-tree/desktop-settings.png",
    animations: "disabled",
  });
});
