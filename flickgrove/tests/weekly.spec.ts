import { expect, test } from "@playwright/test";

test("quota retains per-host cache through failed refresh, offline remount and reload, then successful refresh updates", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
  await page.clock.install();
  const info = await (
    await request.get("http://127.0.0.1:14319/fixture/info")
  ).json();
  let failure = false;
  let remaining: number | null = 64;
  let resetsAt: number | undefined = 1791158400;
  await page.route("**/api/weekly*", (route) => {
    const hostId =
      new URL(route.request().url()).searchParams.get("host") ?? undefined;
    return route.fulfill({
      status: failure ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        failure
          ? { error: "Synthetic quota outage" }
          : {
              hostId,
              remaining: hostId === info.peer ? 23 : remaining,
              fetchedAt: 1234567890000,
              accountId: `fixture-${hostId}`,
              source: hostId,
              resetsAt,
            },
      ),
    });
  });
  await page.goto("http://127.0.0.1:14319/");
  const ring = page.locator(".app-header .weekly-button strong");
  await expect(ring).toHaveText("64%");
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await expect(page.locator(".weekly-source")).toContainText("Resets");
  await expect(page.locator(".weekly-popover")).not.toContainText("Updated");
  failure = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("64%");
  await page.keyboard.press("Escape");
  await expect(page.locator(".weekly-popover")).toHaveCount(0);
  await page.reload();
  await expect(ring).toHaveText("64%");
  await page.setViewportSize({ width: 390, height: 844 });
  // The desktop selection remains the same conversation after narrowing.
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  const mobileRing = page.locator(".mobile-back .weekly-button strong");
  await expect(mobileRing).toHaveText("64%");
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  failure = false;
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await expect(mobileRing).toHaveText("23%");
  await request.post("http://127.0.0.1:14319/fixture/change", {
    data: { outage: true },
  });
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("textbox", { name: "Message Orc" }),
  ).toBeEnabled();
  await expect(mobileRing).toHaveText("23%");
  await page.reload();
  await expect(mobileRing).toHaveText("23%");
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await expect(ring).toHaveText("64%");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  remaining = null;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("64%");
  remaining = 47;
  resetsAt = undefined;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(ring).toHaveText("47%");
  await expect(page.locator(".weekly-source")).not.toContainText("Resets");
});

test("same-host requests do not overlap and a delayed host response cannot replace the selected host", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
  await page.clock.install();
  const info = await (
    await request.get("http://127.0.0.1:14319/fixture/info")
  ).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let hubCalls = 0;
  await page.route("**/api/weekly*", async (route) => {
    const hostId =
      new URL(route.request().url()).searchParams.get("host") ?? undefined;
    if (hostId === info.hub) {
      hubCalls++;
      await gate;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hostId,
        remaining: hostId === info.hub ? 91 : 26,
        fetchedAt: 1234567890000,
        source: hostId,
      }),
    });
  });
  await page.goto("http://127.0.0.1:14319/");
  await expect.poll(() => hubCalls).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  // The desktop selection remains the same conversation after narrowing.
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await page.clock.fastForward(120000);
  expect(hubCalls).toBe(1);
  await expect(page.locator(".mobile-back .weekly-button strong")).toHaveText(
    "—",
  );
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await page
    .getByRole("button", { name: "Open Reader performance Orc" })
    .click();
  await expect(page.locator(".mobile-back .weekly-button strong")).toHaveText(
    "26%",
  );
  release();
  await page
    .getByRole("button", { name: "Weekly remaining", exact: true })
    .click();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator(".weekly-number strong")).toHaveText("26%");
  await expect(page.locator(".weekly-source")).toContainText(info.peer);
  await expect(page.locator(".weekly-source")).not.toContainText(info.hub);
});

test("60-second polling updates the cached quota without a real-minute wait", async ({
  page,
  request,
}) => {
  await request.post("http://127.0.0.1:14319/fixture/reset", { data: {} });
  await page.clock.install();
  let remaining = 58;
  await page.route("**/api/weekly*", (route) => {
    const hostId =
      new URL(route.request().url()).searchParams.get("host") ?? undefined;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ hostId, remaining, fetchedAt: 1234567890000 }),
    });
  });
  await page.goto("http://127.0.0.1:14319/");
  const ring = page.locator(".app-header .weekly-button strong");
  await expect(ring).toHaveText("58%");
  remaining = 42;
  await page.clock.runFor(60000);
  await expect(ring).toHaveText("42%");
});
