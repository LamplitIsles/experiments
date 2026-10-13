import { expect, test } from "@playwright/test";
import type { HistorySession } from "../src/contracts";
import { newSession } from "./browser-actions";

test.afterEach(async ({ request }) => {
  await request.delete("/fixture/history-filter");
});

const session = (
  threadId: string,
  role: HistorySession["role"],
  updatedAt: number,
  extra: Partial<HistorySession> = {},
): HistorySession => ({
  threadId,
  role,
  ...(role === "orc" ? { agentId: `fixture-${threadId}` } : {}),
  updatedAt,
  title: threadId,
  preview: "filter keyword",
  cwd: "/fixture/alpha",
  source: "cli",
  archived: false,
  ...extra,
});
const fixtures = [
  session("orc-z", "orc", 400, { closed: true }),
  session("worker", "worker", 900),
  session("orc-b", "orc", 500, { archived: true }),
  session("reviewer", "reviewer", 800),
  session("orc-a", "orc", 500),
  session("researcher", "researcher", 700),
  session("native", "session", 600),
  session("other-project", "orc", 1000, { cwd: "/fixture/beta" }),
];

for (const width of [1440, 390]) {
  test(`Only Orc filters resolved roles, preserves preview and resets on reentry (${width})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post("/fixture/history-filter", {
      data: { sessions: fixtures },
    });
    await page.goto("/");
    await newSession(page);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await page
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    const toggle = page.getByRole("switch", { name: "Only Orc" });
    const search = page.getByRole("textbox", {
      name: "Search title or first message…",
    });
    const titles = page.locator(".history-result strong");
    await expect(toggle).toBeChecked();
    await expect(titles).toHaveText(["orc-a", "orc-b", "orc-z"]);
    await expect(page.locator(".history-result-meta").nth(1)).toContainText(
      "Archived",
    );
    await expect(page.locator(".history-result-meta").nth(2)).toContainText(
      "Closed",
    );
    await page.screenshot({
      path: `../.scratch/history-orc-filter/${width}-only-orc.png`,
    });
    await search.press("Tab");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Space");
    await expect(toggle).not.toBeChecked();
    await expect(titles).toHaveText([
      "worker",
      "reviewer",
      "researcher",
      "native",
      "orc-a",
      "orc-b",
      "orc-z",
    ]);
    await search.fill("keyword");
    await expect(titles).toHaveCount(7);
    await page.screenshot({
      path: `../.scratch/history-orc-filter/${width}-all.png`,
    });
    await page.getByRole("button", { name: /^native/ }).click();
    await expect(page.locator(".history-transcript")).toContainText(
      "filter keyword",
    );
    await page.goBack();
    await expect(search).toHaveValue("keyword");
    await expect(toggle).not.toBeChecked();
    await expect(titles).toHaveCount(7);
    await toggle.click();
    await expect(titles).toHaveText(["orc-a", "orc-b", "orc-z"]);
    await search.fill("orc-b");
    await expect(titles).toHaveText(["orc-b"]);
    await toggle.click();
    await expect(titles).toHaveText(["orc-b"]);
    await search.fill("native");
    await expect(titles).toHaveText(["native"]);
    await toggle.click();
    await expect(titles).toHaveCount(0);
    await expect(
      page.getByText("No matching sessions.", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    expect(
      await page
        .locator(".new-modal")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await toggle.click();
    await page.goBack();
    await page
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    await expect(toggle).toBeChecked();
    await expect(search).toHaveValue("");
    await expect(titles).toHaveText(["orc-a", "orc-b", "orc-z"]);
  });
}

test("empty filtered pages retain scanning; mode and query changes reject stale pages and reset cursors", async ({
  page,
}) => {
  const entries = Array.from({ length: 30 }, (_, i) =>
    session(`native-${i}`, "session", 1000 + i),
  );
  entries.push(session("older-orc", "orc", 10));
  await page.request.post("/fixture/history-filter", {
    data: { sessions: entries, delayedCall: 2 },
  });
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Only Orc" });
  const titles = page.locator(".history-result strong");
  const more = page.getByRole("button", { name: "Load more", exact: true });
  await expect(titles).toHaveCount(0);
  await expect(more).toBeEnabled();
  await more.click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/history-filter")).json())
          .length,
    )
    .toBe(2);
  await toggle.click();
  await expect(titles).toHaveCount(30);
  await expect(more).toBeEnabled();
  // The delayed old pagination response must not append older-orc or clear the new cursor.
  await expect
    .poll(
      async () =>
        await (await page.request.get("/fixture/history-filter")).json(),
    )
    .toEqual([null, "30", null]);
  await page.waitForTimeout(1000);
  await expect(titles).toHaveCount(30);
  await expect(more).toBeEnabled();
  await toggle.click();
  await expect(titles).toHaveCount(0);
  await expect(more).toBeEnabled();
  await more.click();
  await expect(titles).toHaveText(["older-orc"]);
  await expect(more).toBeHidden();
  await page.getByRole("button", { name: /^older-orc/ }).click();
  await expect(page.locator(".history-transcript")).toContainText(
    "filter keyword",
  );
  await page.goBack();
  await expect(titles).toHaveText(["older-orc"]);
  await expect(more).toBeHidden();
  const search = page.getByRole("textbox", {
    name: "Search title or first message…",
  });
  await search.fill("older");
  await expect(titles).toHaveText(["older-orc"]);
  const reads = await (
    await page.request.get("/fixture/history-filter")
  ).json();
  expect(reads.slice(3)).toEqual([null, "30", null, "30"]);
});

test("a late query response cannot replace the current keyword results", async ({
  page,
}) => {
  await page.request.post("/fixture/history-filter", {
    data: { sessions: fixtures, delayedCall: 1 },
  });
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/history-filter")).json())
          .length,
    )
    .toBe(1);
  await page
    .getByRole("textbox", { name: "Search title or first message…" })
    .fill("orc-b");
  await expect(page.locator(".history-result strong")).toHaveText(["orc-b"]);
  await page.waitForTimeout(1000);
  await expect(page.locator(".history-result strong")).toHaveText(["orc-b"]);
});
