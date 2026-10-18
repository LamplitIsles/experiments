import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
for (const [width, source] of [
  [1440, "worker"],
  [390, "user"],
] as const) {
  test(`${width} first reading checks server submissions before displaying recovery rows`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post(origin + "/fixture/reset");
    const { id, provisional } = await (
      await page.request.post(origin + "/fixture/reading-transition", {
        data: { source },
      })
    ).json();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    await page.route("**/api/read/messages?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("agent") === id) {
        entered.resolve();
        await release.promise;
      }
      await route.continue().catch(() => {});
    });
    try {
      await page.goto(origin);
      expect(
        await page.evaluate(
          (id) =>
            Object.keys(localStorage).filter(
              (k) =>
                k.endsWith(`/detail/${id}`) ||
                k.includes(`/outgoing/${encodeURIComponent(id)}/`),
            ),
          id,
        ),
      ).toEqual([]);
      await page
        .getByRole("button", {
          name: "Open First reading transition Orc",
          exact: true,
        })
        .click();
      await entered.promise;
      // Chord already backfilled native reading; the separate HTTP refresh must not obscure it.
      await expect(
        page.locator(`[data-message-id="${provisional}"]`),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-message-id="transition-native-2"]'),
      ).toBeVisible();
      await expect(page.locator(".delivery-error")).toHaveCount(0);
      await expect(page.locator(".conversation-loading")).toHaveCount(0);
      await expect(page.locator(".conversation-region")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      const input = page.getByRole("textbox", {
        name: "Message Orc",
        exact: true,
      });
      await input.fill("Retain this draft");
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeEnabled();
      await page.screenshot({
        path: `../.scratch/conversation-region-spinner/${width}-pending.png`,
      });
      const completed = page.waitForResponse(
        (r) =>
          r.url().includes("/api/read/messages?") &&
          new URL(r.url()).searchParams.get("agent") === id,
      );
      release.resolve();
      expect(
        (await (await completed).json()).messages.map(
          (m: { id: string }) => m.id,
        ),
      ).toEqual([
        "transition-native-0",
        "transition-native-1",
        "transition-native-2",
      ]);
      await page.locator(".conversation").evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(
        page.locator('[data-message-id="transition-native-0"]'),
      ).toBeVisible();
      await expect(
        page.locator(`[data-message-id="${provisional}"]`),
      ).toHaveCount(0);
      await expect(input).toHaveValue("Retain this draft");
      await expect(page.locator(".conversation-loading")).toHaveCount(0);
      await expect(page.locator(".conversation-region")).toHaveAttribute(
        "aria-busy",
        "false",
      );
      await page.screenshot({
        path: `../.scratch/conversation-region-spinner/${width}-ready.png`,
      });
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
for (const width of [1440, 390])
  test(`${width} first-page failure keeps local pending and server recovery available; Retry checks identities without replay`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post(origin + "/fixture/reset");
    const { id, provisional } = await (
      await page.request.post(origin + "/fixture/reading-transition", {
        data: {},
      })
    ).json();
    await page.addInitScript(
      ({ id }) => {
        localStorage.setItem(
          `flickgrove/${location.origin}/outgoing/${encodeURIComponent(id)}/local-pending`,
          JSON.stringify({
            agentId: id,
            id: "local-pending",
            text: "Local pending stays readable",
            at: 100,
            status: "uncertain",
          }),
        );
        localStorage.setItem(
          `flickgrove/${location.origin}/outgoing/${encodeURIComponent(id)}/local-failed`,
          JSON.stringify({
            agentId: id,
            id: "local-failed",
            text: "Local failed remains recoverable",
            at: 101,
            status: "failed",
            error: "Fixture local rejection",
          }),
        );
      },
      { id },
    );
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const retryEntered = Promise.withResolvers<void>(),
      retryRelease = Promise.withResolvers<void>();
    let first = true;
    await page.route("**/api/read/messages?**", async (route) => {
      if (
        new URL(route.request().url()).searchParams.get("agent") === id &&
        first
      ) {
        first = false;
        entered.resolve();
        await release.promise;
        await route.fulfill({
          status: 503,
          json: { error: "Fixture initial history unavailable" },
        });
      } else {
        retryEntered.resolve();
        await retryRelease.promise;
        await route.continue().catch(() => {});
      }
    });
    try {
      await page.goto(origin);
      await page
        .getByRole("button", {
          name: "Open First reading transition Orc",
          exact: true,
        })
        .click();
      await entered.promise;
      await expect(
        page.locator('[data-message-id="local-pending"]'),
      ).toContainText("Local pending stays readable");
      await expect(page.locator(".delivery-error")).toHaveCount(0);
      await expect(page.locator(".conversation-loading")).toHaveCount(0);
      await expect(
        page.locator(`[data-message-id="${provisional}"]`),
      ).toHaveCount(0);
      release.resolve();
      await expect(page.locator(".history-controls [role=alert]")).toHaveText(
        "Fixture initial history unavailable",
      );
      await expect(
        page.locator(`[data-message-id="${provisional}"]`),
      ).toBeVisible();
      await expect(page.locator(".delivery-error")).toHaveCount(1);
      await expect(page.locator(".conversation-loading")).toHaveCount(0);
      await expect(
        page
          .locator('[data-message-id="local-failed"]')
          .getByRole("button", { name: "Retry", exact: true }),
      ).toBeEnabled();
      await page.locator(".conversation").evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: `../.scratch/conversation-region-spinner/${width}-error.png`,
      });
      const input = page.getByRole("textbox", {
        name: "Message Orc",
        exact: true,
      });
      await input.fill("Failure draft");
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeEnabled();
      await page
        .locator(".history-controls")
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await retryEntered.promise;
      await expect(page.locator(".conversation-loading")).toHaveCount(0);
      retryRelease.resolve();
      await expect(page.locator(".conversation-loading")).toHaveCount(0);
      await expect(page.locator(".history-controls [role=alert]")).toHaveCount(
        0,
      );
      await expect(
        page.locator(`[data-message-id="${provisional}"]`),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-message-id="local-pending"]'),
      ).toContainText("Local pending stays readable");
      await expect(input).toHaveValue("Failure draft");
      expect(
        await page.evaluate(
          ({ id }) =>
            JSON.parse(
              localStorage.getItem(
                `flickgrove/${location.origin}/outgoing/${encodeURIComponent(id)}/local-pending`,
              )!,
            ).status,
          { id },
        ),
      ).toBe("uncertain");
    } finally {
      retryRelease.resolve();
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

test("successful history without client identity keeps server reports unresolved and fully readable", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  const { provisional } = await (
    await page.request.post(origin + "/fixture/reading-transition", {
      data: { unlinked: true },
    })
  ).json();
  await page.goto(origin);
  await page
    .getByRole("button", {
      name: "Open First reading transition Orc",
      exact: true,
    })
    .click();
  await expect(page.locator(".conversation-loading")).toHaveCount(0);
  await expect(page.locator(".delivery-error")).toHaveCount(3);
  const report = page.locator(
    `[data-message-id="${provisional}"] .worker-report`,
  );
  await expect(report).toBeVisible();
  await report.locator("summary").click();
  await expect(report.locator(".report-content")).toContainText("Report 0");
  await expect(page.locator(".delivery-error")).toHaveCount(3);
});
