import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
const artifacts = resolve("../.scratch/user-message-outline");
async function setup(page: Page, width: number) {
  page.on("pageerror", (error) => console.log("PAGE_ERROR", String(error)));
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.request.post("/fixture/reset");
  const fixture = await (await page.request.post("/fixture/outline")).json();
  await page.goto("/");
  if (width === 390)
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Open Outline fixture Orc", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".conversation")).toContainText("Instruction 089");
  return fixture;
}
async function centered(page: Page, operation: string) {
  const target = page.locator(`[data-message-id="native-${operation}"]`);
  await expect(target).toBeVisible();
  await expect
    .poll(async () => {
      const row = await target.boundingBox(),
        viewport = await page.locator(".conversation").boundingBox();
      if (!row || !viewport) return 9999;
      return Math.abs(
        row.y + row.height / 2 - (viewport.y + viewport.height / 2),
      );
    })
    .toBeLessThan(45);
}
test("ordinary read finishing after outline replacement preserves detached adjacency", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    let intercepted = false;
    Object.assign(window, {
      fetch: async (...args: Parameters<typeof window.fetch>) => {
        const response = await original(...args);
        if (
          !intercepted &&
          response.url.includes("/api/read/messages?") &&
          (await response.clone().text()).includes('"native-outline-89"')
        ) {
          intercepted = true;
          await new Promise<void>((resolve) => {
            Object.assign(window, { releaseOrdinaryRead: resolve });
          });
        }
        return response;
      },
    });
  });
  const fixture = await setup(page, 1440);
  await page.waitForFunction(() => "releaseOrdinaryRead" in window);
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Message outline", exact: true })
    .getByRole("button", { name: "Instruction 015", exact: true })
    .click();
  await centered(page, "outline-15");
  await page.evaluate(() =>
    (
      window as unknown as { releaseOrdinaryRead: () => void }
    ).releaseOrdinaryRead(),
  );
  const later = page.getByRole("button", {
    name: "Later messages",
    exact: true,
  });
  await expect(later).toBeEnabled();
  await centered(page, "outline-15");
  const conversation = page.locator(".conversation");
  await conversation.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await later.click();
  await expect(later).toBeEnabled();
  // Inspect the bounded window, including rows recycled between its endpoints.
  await conversation.hover();
  await page.mouse.wheel(0, -100000);
  await expect(
    conversation.locator('[data-message-id="native-outline-9"]'),
  ).toBeVisible();
  for (let step = 0; step < 100; step++) {
    await conversation.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(
      conversation.locator('[data-message-id="native-outline-89"]'),
    ).toHaveCount(0);
    const end = await conversation.evaluate((el) => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) return true;
      el.scrollTop += el.clientHeight / 2;
      return false;
    });
    if (end) break;
    expect(step).toBeLessThan(99);
  }
  // The next native page ends at input 38; the live tail at 89 is not adjacent.
  await conversation.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(conversation).toContainText("Context 38");
  await expect(conversation).not.toContainText("Instruction 089");
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}/1440-outline-race-continuation.png`,
  });
  expect(
    (await (await page.request.get("/fixture/input-count")).json()).inputs,
  ).toBe(fixture.inputs);
});
for (const width of [1440, 390])
  test(`${width} outline locates old input, reads both directions and returns live without sending`, async ({
    page,
  }) => {
    const fixture = await setup(page, width);
    const draft = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await draft.fill("Draft stays intact");
    await page
      .getByRole("button", { name: "Message outline", exact: true })
      .click();
    const nav = page.getByRole("navigation", {
      name: "Message outline",
      exact: true,
    });
    await expect(nav.getByRole("button")).toHaveCount(90);
    await expect(nav.locator("[aria-current]")).toBeInViewport();
    await page.screenshot({
      animations: "disabled",
      path: `${artifacts}/${width}-outline-open.png`,
    });
    await nav
      .getByRole("button", { name: "Instruction 015", exact: true })
      .click();
    if (width === 390) await expect(page.getByRole("dialog")).toHaveCount(0);
    await centered(page, "outline-15");
    await expect(
      page.getByText("Locating message…", { exact: true }),
    ).toHaveCount(0);
    await expect(draft).toHaveValue("Draft stays intact");
    await page.screenshot({
      animations: "disabled",
      path: `${artifacts}/${width}-outline-located.png`,
    });
    if (width === 1440) {
      const before = (await page.locator(".conversation").boundingBox())!.width;
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await page.locator(".conversation").boundingBox())!.width,
        )
        .toBeGreaterThan(before + 200);
      await expect(nav).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: `${artifacts}/1440-outline-sidebar-collapsed.png`,
      });
      await page
        .getByRole("button", { name: "Toggle Sidebar", exact: true })
        .click();
    }
    // Explicit native continuation at both boundaries retains real adjacency.
    await page.locator(".conversation").evaluate((el) => (el.scrollTop = 0));
    await page
      .getByRole("button", { name: "Load earlier messages", exact: true })
      .click();
    await page
      .locator(".conversation")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page
      .getByRole("button", { name: "Later messages", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Jump to bottom", exact: true })
      .click();
    await expect(page.locator(".conversation")).toContainText(
      "Instruction 089",
    );
    if (width === 1440) {
      await page
        .getByRole("button", { name: "Message outline", exact: true })
        .click();
      await expect(nav).toHaveCount(0);
    }
    await page.screenshot({
      animations: "disabled",
      path: `${artifacts}/${width}-outline-closed.png`,
    });
    expect(
      (await (await page.request.get("/fixture/input-count")).json()).inputs,
    ).toBe(fixture.inputs);
  });
test("outline duplicate identities, long/image inputs, local failure retry, late cancellation and responsive layers", async ({
  page,
}) => {
  const fixture = await setup(page, 1440);
  const draft = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await draft.fill("Keep this draft");
  await draft.evaluate((el) => {
    (el as HTMLTextAreaElement).setSelectionRange(4, 8);
  });
  const trigger = page.getByRole("button", {
    name: "Message outline",
    exact: true,
  });
  await trigger.click();
  const nav = page.getByRole("navigation", {
    name: "Message outline",
    exact: true,
  });
  const same = nav.getByRole("button", {
    name: "Same instruction",
    exact: true,
  });
  await same.nth(0).focus();
  await page.keyboard.press("Enter");
  await centered(page, "outline-30");
  await expect(
    page.getByText("Locating message…", { exact: true }),
  ).toHaveCount(0);
  await same.nth(1).click();
  await centered(page, "outline-60");
  await expect(
    page.getByText("Locating message…", { exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Image input", exact: true }).click();
  await expect(
    page.locator('[data-message-id="native-outline-45"] img'),
  ).toBeVisible();
  await expect(
    page.getByText("Locating message…", { exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: /^Long input / }).click();
  await expect(
    page.locator('[data-message-id="native-outline-20"]'),
  ).toBeVisible();
  await expect(
    page.getByText("Locating message…", { exact: true }),
  ).toHaveCount(0);
  const long = await page
      .locator('[data-message-id="native-outline-20"]')
      .boundingBox(),
    viewport = await page.locator(".conversation").boundingBox();
  expect(long!.y).toBeGreaterThan(viewport!.y - 10);
  expect(long!.y).toBeLessThan(viewport!.y + viewport!.height * 0.7);
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}/1440-outline-long.png`,
  });
  await page
    .getByRole("button", { name: "Jump to bottom", exact: true })
    .click();
  await page.request.post("/fixture/history-control", { data: { fail: true } });
  await nav
    .getByRole("button", { name: "Instruction 001", exact: true })
    .click();
  await expect(nav.getByRole("alert")).toHaveText(
    "Fixture navigation unavailable",
  );
  await expect(page.locator(".conversation")).toContainText("Instruction 089");
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}/1440-outline-failure.png`,
  });
  await page.request.post("/fixture/history-control", {
    data: { fail: false },
  });
  await nav.getByRole("button", { name: "Retry", exact: true }).click();
  await centered(page, "outline-1");
  await page
    .getByRole("button", { name: "Jump to bottom", exact: true })
    .click();
  await page.request.post("/fixture/history-control", { data: { delay: 500 } });
  await nav
    .getByRole("button", { name: "Instruction 005", exact: true })
    .click();
  await page.locator(".conversation").hover();
  await page.mouse.wheel(0, -160);
  await page.waitForTimeout(650);
  await expect(
    page.locator('[data-message-id="native-outline-5"]'),
  ).toHaveCount(0);
  await page.request.post("/fixture/history-control", { data: { delay: 0 } });
  await trigger.click();
  await trigger.click();
  // Desktop rail becomes exactly one Sheet; left sidebar preference is retained.
  const sidebar = await page.evaluate(() =>
    Object.entries(localStorage).filter(([key]) => /sidebar/.test(key)),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("dialog", { name: "Message outline", exact: true }),
  ).toBeVisible();
  await expect(nav).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Message outline", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".agent-detail")).toBeVisible();
  await trigger.click();
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: "Message outline", exact: true }),
  ).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(
    await page.evaluate(() =>
      Object.entries(localStorage).filter(([key]) => /sidebar/.test(key)),
    ),
  ).toEqual(sidebar);
  await expect(draft).toHaveValue("Keep this draft");
  expect(
    await draft.evaluate((el) => [
      (el as HTMLTextAreaElement).selectionStart,
      (el as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([4, 8]);
  expect(
    (await (await page.request.get("/fixture/input-count")).json()).inputs,
  ).toBe(fixture.inputs);
});
test("live directory refresh, disconnect and session changes never pull a historical reader or replay", async ({
  page,
}) => {
  const fixture = await setup(page, 1440);
  await page
    .getByRole("textbox", { name: "Message Orc", exact: true })
    .fill("Reconnect guard draft");
  const trigger = page.getByRole("button", {
    name: "Message outline",
    exact: true,
  });
  await trigger.click();
  const nav = page.getByRole("navigation", {
    name: "Message outline",
    exact: true,
  });
  await nav
    .getByRole("button", { name: "Instruction 015", exact: true })
    .click();
  await centered(page, "outline-15");
  await expect(
    page.getByText("Locating message…", { exact: true }),
  ).toHaveCount(0);
  await page.request.post("/fixture/history-live", {
    data: {
      id: fixture.id,
      input: "Newest explicit user",
      text: "Fresh streaming context",
    },
  });
  await expect(
    nav.getByRole("button", { name: "Newest explicit user", exact: true }),
  ).toBeVisible();
  await centered(page, "outline-15");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(nav).toBeVisible();
  await page.request.post("/fixture/history-control", { data: { delay: 500 } });
  await nav
    .getByRole("button", { name: "Instruction 001", exact: true })
    .click();
  await page.request.post("/fixture/offline");
  await page.waitForTimeout(650);
  await centered(page, "outline-15");
  await expect(
    page.locator('[data-message-id="native-outline-1"]'),
  ).toHaveCount(0);
  await page.request.post("/fixture/history-control", { data: { delay: 0 } });
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await nav
    .getByRole("button", { name: "Instruction 014", exact: true })
    .click();
  await centered(page, "outline-14");
  await nav
    .getByRole("button", { name: "Instruction 001", exact: true })
    .click();
  await expect(nav.getByRole("alert")).toHaveText(
    "Reconnect to locate this message.",
  );
  await centered(page, "outline-14");
  await page.request.post("/fixture/online");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await centered(page, "outline-14");
  await page.request.post("/fixture/history-control", { data: { delay: 500 } });
  await nav
    .getByRole("button", { name: "Instruction 002", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    "Local reports",
  );
  await page.waitForTimeout(650);
  await expect(
    page.locator('[data-message-id="native-outline-2"]'),
  ).toHaveCount(0);
  await page.request.post("/fixture/history-control", { data: { delay: 0 } });
  expect(
    (await (await page.request.get("/fixture/input-count")).json()).inputs,
  ).toBe(fixture.inputs + 1);
});
test("forward pages close the live gap, retain a bounded virtual DOM and resume following at the real tail", async ({
  page,
}) => {
  const fixture = await setup(page, 1440);
  await page
    .getByRole("button", { name: "Message outline", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Message outline", exact: true })
    .getByRole("button", { name: "Instruction 004", exact: true })
    .click();
  await centered(page, "outline-4");
  await expect(
    page.getByText("Locating message…", { exact: true }),
  ).toHaveCount(0);
  let pages = 0;
  const later = page.getByRole("button", {
    name: "Later messages",
    exact: true,
  });
  while ((await later.count()) && pages++ < 10) {
    await page
      .locator(".conversation")
      .evaluate((el) => (el.scrollTop = el.scrollHeight));
    await later.click();
    await expect(later)
      .not.toBeDisabled()
      .catch(async () => {
        await expect(later).toHaveCount(0);
      });
  }
  expect(pages).toBeGreaterThan(3);
  await page
    .locator(".conversation")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator(".conversation")).toContainText("Instruction 089");
  const ids = await page
    .locator("[data-message-id]")
    .evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-message-id")),
    );
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.length).toBeLessThan(30);
  await page.request.post("/fixture/history-live", {
    data: {
      id: fixture.id,
      input: "After gap closes",
      text: "Newest tail context",
    },
  });
  await expect(page.locator(".conversation")).toContainText(
    "Newest tail context",
  );
  await expect
    .poll(() =>
      page
        .locator(".conversation")
        .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop),
    )
    .toBeLessThan(85);
});
test("mobile outline failure restores its Sheet and keeps image draft/caret with foreground priority", async ({
  page,
}) => {
  const fixture = await setup(page, 390);
  const draft = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await draft.fill("Mobile draft selection");
  await draft.evaluate((el) =>
    (el as HTMLTextAreaElement).setSelectionRange(7, 12),
  );
  const { default: sharp } = await import("sharp");
  await page.getByLabel("Choose message images").setInputFiles({
    name: "owned.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 2, height: 2, channels: 4, background: "#355d98" },
    })
      .png()
      .toBuffer(),
  });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await page.request.post("/fixture/history-control", { data: { fail: true } });
  const trigger = page.getByRole("button", {
    name: "Message outline",
    exact: true,
  });
  await trigger.click();
  const nav = page.getByRole("navigation", {
    name: "Message outline",
    exact: true,
  });
  await nav
    .getByRole("button", { name: "Instruction 001", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Message outline", exact: true }),
  ).toBeVisible();
  await expect(nav.getByRole("alert")).toHaveText(
    "Fixture navigation unavailable",
  );
  await expect(nav.getByRole("alert")).toBeInViewport();
  await page.screenshot({
    animations: "disabled",
    path: `${artifacts}/390-outline-failure.png`,
  });
  await page.request.post("/fixture/history-control", {
    data: { fail: false },
  });
  await nav.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Message outline", exact: true }),
  ).toHaveCount(0);
  await centered(page, "outline-1");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(draft).toHaveValue("Mobile draft selection");
  expect(
    await draft.evaluate((el) => [
      (el as HTMLTextAreaElement).selectionStart,
      (el as HTMLTextAreaElement).selectionEnd,
    ]),
  ).toEqual([7, 12]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".agent-detail")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (await (await page.request.get("/fixture/input-count")).json()).inputs,
  ).toBe(fixture.inputs);
  // Existing question and preview surfaces keep priority over the directory.
  await page.request.post("/fixture/change", {
    data: { question: "Outline foreground" },
  });
  await page
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(page.locator(".question-panel")).toBeVisible();
  await expect(trigger).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.locator(".question-panel")).not.toBeVisible();
  await expect(trigger).toBeEnabled();
  await page
    .locator(".conversation")
    .getByRole("link", { name: "Chart", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "File preview", exact: true }),
  ).toBeVisible();
  await expect(trigger).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("region", { name: "File preview", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    "Local reports",
  );
});
