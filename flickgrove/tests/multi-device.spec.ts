import { expect, test } from "@playwright/test";
import { newSession, openSettings } from "./browser-actions";

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
test.use({ baseURL: "http://127.0.0.1:14319", colorScheme: "dark" });
const output = resolve("../.scratch/flickgrove-multi-device/implementation");
mkdirSync(output, { recursive: true });
async function selected(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  await expect(page.locator(".agent-detail")).toBeVisible();
}
async function capture(page: import("@playwright/test").Page, file: string) {
  await page.evaluate(() => document.fonts.ready);
  // Visibility assertions do not wait for daisyUI's dialog opacity transition.
  await page.evaluate(async () => {
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    document.querySelectorAll("dialog[open]").forEach((dialog) => {
      dialog
        .getAnimations({ subtree: true })
        .forEach((animation) => animation.finish());
    });
  });
  await page.screenshot({
    path: `${output}/${file}.png`,
    animations: "disabled",
  });
}
test("all 29 mapped design states use the real UI with isolated Hub fixtures", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await selected(page);
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.getByRole("button", { name: "Expand Workers" }).click();
  await capture(page, "multi-01");
  await page.getByRole("combobox", { name: "Host filter" }).click();
  await expect(
    page.getByRole("combobox", { name: "Host filter" }),
  ).toContainText("All hosts");
  await capture(page, "multi-02");
  const info = await (await request.get("/fixture/info")).json();
  await page.getByRole("option", { name: "NUC Connected" }).click();
  await capture(page, "multi-10");
  await page.getByRole("combobox", { name: "Host filter" }).click();
  await page.getByRole("option", { name: "All hosts" }).click();
  await openSettings(page);
  await page.locator(".settings-hosts > summary").click();
  await capture(page, "multi-03");
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Workstation");
  await page.getByRole("textbox", { name: "Backend URL" }).fill(info.emptyUrl);
  await page
    .getByRole("textbox", { name: "Access token", exact: true })
    .fill("invalid-fixture-token");
  await capture(page, "multi-04");
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(page.getByRole("alert")).toContainText("authorization");
  await capture(page, "multi-05");
  await page
    .getByRole("textbox", { name: "Access token", exact: true })
    .fill(info.emptyToken);
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(page.getByText("Connection verified and saved.")).toBeVisible();
  await capture(page, "multi-06");
  await page.getByRole("button", { name: "Edit host Neil’s Mac" }).click();
  await expect(page.getByRole("textbox", { name: /Access token/ })).toHaveValue(
    "",
  );
  await capture(page, "multi-11");
  await page.locator(".modal-close").click();
  await capture(page, "multi-15");
  await request.post("/fixture/reset", { data: {} });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await newSession(page);
  await expect(
    page.getByRole("textbox", { name: "Search projects" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Neil’s Mac Connected", exact: true })
    .click();
  await page.getByRole("button", { name: "Experiments", exact: true }).click();
  await capture(page, "multi-07");
  await page.getByRole("button", { name: "Create on Neil’s Mac" }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeFocused();
  await capture(page, "multi-12");
  await request.post("/fixture/reset", { data: {} });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await openSettings(page);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await capture(page, "multi-09");
  await page.locator(".modal-close").click();
  await request.post("/fixture/reset", { data: {} });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await request.post("/fixture/change", { data: { outage: true } });
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeDisabled();
  await capture(page, "multi-08");
  await request.post("/fixture/change", { data: { outage: false } });
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeEnabled();
  await request.post("/fixture/reset", { data: {} });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await page.getByRole("button", { name: "Close detail" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".host-summary")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /NUC.*Streaming voice input/ }),
  ).toContainText("2 open Workers · 1 working");
  await expect(
    page.getByRole("button", { name: /Neil’s Mac.*Reader performance/ }),
  ).toContainText("1 open Workers · 1 working");
  await capture(page, "multi-13");
  await page
    .getByRole("button", { name: /NUC.*Streaming voice input/ })
    .click();
  await capture(page, "multi-14");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.getByRole("button", { name: "Expand Workers" }).click();
  await capture(page, "controls-01");
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("/");
  await capture(page, "controls-02");
  await input.press("Enter");
  await expect(input).toHaveValue("/stop");
  await capture(page, "controls-12");
  await input.fill("/close");
  await input.press("Enter");
  await capture(page, "controls-13");
  await input.fill("/stop");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await capture(page, "controls-03");
  await request.post("/fixture/change", { data: { complete: "interrupted" } });
  await expect(
    page.getByText("Orc stopped. Workers continue independently."),
  ).toBeVisible();
  await capture(page, "controls-04");
  await input.fill("/close");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Workers first");
  await capture(page, "controls-06");
  await request.post("/fixture/reset", { data: {} });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.getByRole("button", { name: "Expand Workers" }).click();
  await page.getByRole("button", { name: "Close detail" }).click();
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await capture(page, "controls-09");
  await request.post("/fixture/change", { data: { usage: 12 } });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".weekly-number strong")).toHaveText("12%");
  await capture(page, "controls-10");
  await request.post("/fixture/change", { data: { usage: null } });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".weekly-number strong")).toHaveText("—");
  await capture(page, "controls-11");
  await request.post("/fixture/reset", { data: {} });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await page.getByRole("button", { name: "Expand Workers" }).first().click();
  await page.getByRole("button", { name: "Expand Workers" }).click();
  await request.post("/fixture/change", { data: { stopMode: "unknown" } });
  await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
  await expect(page.getByText(/Stop outcome unknown/)).toBeVisible();
  await capture(page, "controls-05");
  await request.post("/fixture/reset", { data: { mode: "idle" } });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await input.fill("/close");
  await input.press("Enter");
  await capture(page, "controls-07");
  await request.post("/fixture/reset", { data: { mode: "no-workers" } });
  await page.evaluate(() => localStorage.clear());
  await selected(page);
  await input.fill("/close");
  await input.press("Enter");
  await capture(page, "controls-14");
  await input.fill("/close");
  await input.press("Enter");
  await input.press("Enter");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await capture(page, "controls-08");
});
test("two access devices keep independent view/drafts while answers and outages are shared", async ({
  browser,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
  });
  try {
    const left = await desktop.newPage();
    const right = await mobile.newPage();
    await left.goto("http://127.0.0.1:14319/");
    await right.goto("http://127.0.0.1:14319/");
    const info = await (await request.get("/fixture/info")).json();
    await left.getByRole("combobox", { name: "Host filter" }).click();
    await left.getByRole("option", { name: "NUC Connected" }).click();
    await left
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    await expect(
      right.getByRole("combobox", { name: "Host filter" }),
    ).toContainText("All hosts");
    await right
      .getByRole("button", { name: /NUC.*Streaming voice input/ })
      .click();
    await left
      .getByRole("textbox", { name: "Message Orc" })
      .fill("Desktop draft");
    await right
      .getByRole("textbox", { name: "Message Orc" })
      .fill("Mobile draft");
    await request.post("/fixture/change", { data: { question: true } });
    await Promise.all([
      left.getByRole("radio", { name: "Recommended choice" }).check(),
      right.getByRole("radio", { name: "Recommended choice" }).check(),
    ]);
    let arrivals = 0;
    const release = Promise.withResolvers<void>();
    for (const page of [left, right])
      await page.route("**/api/agents/*/answer", async (route) => {
        if (++arrivals === 2) release.resolve();
        await release.promise;
        await route.continue();
      });
    await Promise.all([
      left.getByRole("button", { name: "Send answer", exact: true }).click(),
      right.getByRole("button", { name: "Send answer", exact: true }).click(),
    ]);
    await expect(left.getByText("All 1 answers sent")).toBeVisible();
    await expect(right.getByText("All 1 answers sent")).toBeVisible();
    await expect(
      left.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveValue("Desktop draft");
    await expect(
      right.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveValue("Mobile draft");
    const snapshot = await (await request.get("/api/snapshot")).json();
    const orc = snapshot.agents.find(
      (a: { hostId: string; role: string }) =>
        a.hostId === info.hub && a.role === "orc",
    );
    const detail = await (await request.get(`/api/agents/${orc.id}`)).json();
    expect(
      detail.messages.filter((m: { text: string }) =>
        m.text.includes("Answer: Recommended choice"),
      ),
    ).toHaveLength(1);
    await right.getByRole("button", { name: "‹ Sessions" }).click();
    await right
      .getByRole("button", { name: /Neil’s Mac.*Reader performance/ })
      .click();
    await request.post("/fixture/change", { data: { outage: true } });
    await expect(
      right.getByRole("textbox", { name: "Message Orc" }),
    ).toBeDisabled();
    await expect(
      left.getByRole("textbox", { name: "Message Orc" }),
    ).toBeEnabled();
    await request.post("/fixture/change", { data: { restartHub: true } });
    await right.reload();
    await expect(
      right.getByRole("heading", { name: "Reader performance", exact: true }),
    ).toBeVisible();
    await expect(
      right.getByRole("textbox", { name: "Message Orc" }),
    ).toBeDisabled();
    await request.post("/fixture/change", { data: { outage: false } });
    await expect(
      right.getByRole("textbox", { name: "Message Orc" }),
    ).toBeEnabled();
    expect(
      await right.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  } finally {
    await desktop.close();
    await mobile.close();
  }
});

test("mobile supplementary forms, Stop and quota stay operable within 390 pixels", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await openSettings(page);
  await page.locator(".settings-hosts > summary").click();
  await page.getByRole("button", { name: "Add host", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Mobile host");
  await page
    .getByRole("textbox", { name: "Backend URL" })
    .fill("http://127.0.0.1:14319");
  await page
    .getByRole("textbox", { name: "Access token", exact: true })
    .fill("synthetic-mobile-secret");
  await expect(
    page.getByRole("textbox", { name: "Access token", exact: true }),
  ).toHaveAttribute("type", "password");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "synthetic-mobile-secret",
  );
  await capture(page, "mobile-host-form");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.locator(".modal-close").click();
  await openSettings(page);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("heading", { name: "Settings", exact: true }),
  ).toBeVisible();
  await capture(page, "mobile-settings");
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeVisible();
  await page.locator(".modal-close").click();
  await newSession(page);
  await page
    .getByRole("button", { name: "Neil’s Mac Connected", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Search projects" }),
  ).toBeVisible();
  await capture(page, "mobile-new");
  await page.getByRole("button", { name: "Experiments", exact: true }).click();
  await page
    .getByRole("button", { name: "Create on Neil’s Mac", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await expect(
    page
      .locator(".weekly-source dd")
      .getByText("fixture-mac-account", { exact: true }),
  ).toBeVisible();
  await page
    .locator(".weekly-popover")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByRole("button", { name: "‹ Sessions" }).click();
  await page
    .getByRole("button", { name: /NUC.*Streaming voice input/ })
    .click();
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await expect(
    page
      .locator(".weekly-source dd")
      .getByText("fixture-nuc-account", { exact: true }),
  ).toBeVisible();
  await capture(page, "mobile-controls");
  await page.keyboard.press("Escape");
  await expect(page.locator(".weekly-popover")).toHaveCount(0);
  await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await request.post("/fixture/change", { data: { complete: "interrupted" } });
  await expect(
    page.getByText("Orc stopped. Workers continue independently."),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
});

test("compact detail uses the full height and keeps metadata above the title", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await selected(page);
  const detail = page.locator(".agent-detail");
  const panel = await detail.boundingBox();
  expect(panel!.y).toBeLessThanOrEqual(8);
  expect(panel!.height).toBeGreaterThanOrEqual(880);
  const meta = page.locator(".detail-meta");
  await expect(meta).toContainText("NUC");
  await expect(meta).toContainText("Working");
  await expect(meta).toContainText("gpt-6.1-sol");
  const bounds = await meta.boundingBox();
  const title = await detail.locator("h1").boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(title!.y);
  expect(
    (await page.locator(".detail-heading").boundingBox())!.height,
  ).toBeLessThan(115);
  await expect(
    page
      .locator(".app-header")
      .getByRole("button", { name: "New session", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Shortcuts", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".host-summary")).toHaveCount(0);
  await capture(page, "compact-detail-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(meta).toContainText("gpt-6.1-sol");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await capture(page, "compact-detail-mobile");
  await page.getByRole("button", { name: "‹ Sessions" }).click();
  await openSettings(page);
  await page.locator(".settings-hosts > summary").click();
  await expect(
    page.getByRole("button", { name: "Edit host Neil’s Mac" }),
  ).toBeVisible();
  await capture(page, "compact-settings-hosts");
});

test("arrow navigation pans an offscreen session into view without changing zoom", async ({
  page,
  request,
}) => {
  await request.post("/fixture/reset", { data: {} });
  await page.goto("/");
  const snapshot = await (await request.get("/api/snapshot")).json();
  const roots = snapshot.agents.filter(
    (a: { role: string }) => a.role === "orc",
  );
  await page.evaluate(
    (ids: string[]) => {
      const prefix = `flickgrove/${location.origin}`;
      localStorage.removeItem(`${prefix}/selected`);
      localStorage.setItem(`${prefix}/host-filter`, "");
      localStorage.setItem(`${prefix}/expanded`, "[]");
      localStorage.setItem(
        `${prefix}/viewport`,
        JSON.stringify({ x: 0, y: 0, zoom: 1 }),
      );
      localStorage.setItem(
        `${prefix}/positions`,
        JSON.stringify(
          Object.fromEntries(
            ids.map((id, i) => [id, { x: 90, y: 136 + i * 1300 }]),
          ),
        ),
      );
    },
    roots.map((a: { id: string }) => a.id),
  );
  await page.reload();
  await expect(page.locator(".node-open").first()).toBeVisible();
  await page.keyboard.press("ArrowDown");
  const target = page.locator(".navigation-focus .node-open");
  await expect(target).toHaveAttribute("data-agent-id", roots[1].id);
  await expect
    .poll(async () => {
      const node = await target.boundingBox();
      const canvas = await page.locator(".canvas-region").boundingBox();
      return (
        !!node &&
        !!canvas &&
        node.y >= 60 &&
        node.y + node.height <= canvas.y + canvas.height &&
        node.x >= canvas.x &&
        node.x + node.width <= canvas.x + canvas.width
      );
    })
    .toBe(true);
  await expect(page.locator(".zoom-readout")).toHaveText("100%");
  await page.keyboard.press("Enter");
  await expect(page.locator(".agent-detail h1")).toContainText(roots[1].title);
});
