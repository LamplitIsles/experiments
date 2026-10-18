import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
for (const width of [1440, 390]) {
  test(`${width} cold reading waits, reports failure, retries and keeps device reading across empty publications and reload`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.request.post(origin + "/fixture/reset");
    const { id } = await (
      await page.request.post(origin + "/fixture/cold-reading", {
        data: { delay: 800, fail: true },
      })
    ).json();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Cold reading Orc", exact: true })
      .click();
    await expect(
      page.getByRole("status", { name: "Loading conversation" }),
    ).toBeVisible();
    const bounds = await page.locator(".conversation-loading").boundingBox();
    expect(bounds).toEqual(await page.locator(".conversation").boundingBox());
    const seat = await page.locator(".input-seat").boundingBox();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(seat!.y);
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await page
        .locator(".conversation-spinner")
        .evaluate((el) => getComputedStyle(el).animationName),
    ).toBe("none");
    await page.screenshot({
      path: `../.scratch/closed-session-save-isolation/product-${width}-spinner.png`,
    });
    await expect(
      page.getByText("Fixture history unavailable", { exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".conversation-loading")).toHaveCount(0);
    await page.request.post(origin + "/fixture/history-control", {
      data: { fail: false, delay: 0 },
    });
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .last()
      .click();
    await expect(
      page.getByText("Native history survives empty server memory", {
        exact: true,
      }),
    ).toBeVisible();
    // Store a real successful device copy, then clear only the server window.
    await page.request.post(origin + "/fixture/clear-reading", {
      data: { id },
    });
    await expect(
      page.getByText("Native history survives empty server memory", {
        exact: true,
      }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByText("Native history survives empty server memory", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".conversation-loading")).toHaveCount(0);
    await expect(
      page.getByText("Fixture history unavailable", { exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: `../.scratch/closed-session-save-isolation/product-${width}-cached-error.png`,
    });
    await page.request.post(origin + "/fixture/history-control", {
      data: { fail: false },
    });
    await page
      .getByRole("button", { name: "Retry", exact: true })
      .last()
      .click();
    await expect(
      page.getByText("Fixture history unavailable", { exact: true }),
    ).toHaveCount(0);
    await page.request.post(origin + "/fixture/offline");
    await expect(page.locator(".host-outage")).toBeVisible();
    await expect(
      page.getByText("Native history survives empty server memory", {
        exact: true,
      }),
    ).toBeVisible();
    await page.request.post(origin + "/fixture/clear-reading", {
      data: { id, continuation: true, fail: false },
    });
    await page.request.post(origin + "/fixture/online");
    await expect(
      page.getByText("External continuation after reconnect", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
  });
}
test("successful empty native conversation ends loading without an error", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  await page.request.post(origin + "/fixture/cold-reading", {
    data: { empty: true, delay: 200 },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Cold reading Orc", exact: true })
    .click();
  await expect(page.locator(".conversation-loading")).toHaveCount(0);
  await expect(page.getByText("Fixture history unavailable")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeVisible();
});

test("a timed out cold native HTTP read ends loading and offers explicit Retry", async ({
  page,
}) => {
  test.setTimeout(40_000);
  await page.request.post(origin + "/fixture/reset");
  await page.request.post(origin + "/fixture/cold-reading", {
    data: { fail: true },
  });
  const release = Promise.withResolvers<void>();
  await page.route("**/api/read/messages?**", async (route) => {
    await release.promise;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Cold reading Orc", exact: true })
      .click();
    await expect(
      page.getByRole("status", { name: "Loading conversation" }),
    ).toBeVisible();
    await expect(page.locator(".history-controls [role=alert]")).toContainText(
      /timed out|timeout/i,
      { timeout: 20_000 },
    );
    await expect(page.locator(".conversation-loading")).toHaveCount(0);
    await expect(
      page
        .locator(".history-controls")
        .getByRole("button", { name: "Retry", exact: true }),
    ).toBeEnabled();
  } finally {
    release.resolve();
    await page.unrouteAll({ behavior: "wait" });
  }
});

for (const phase of ["load", "refresh"] as const) {
  test(`a captured ${phase} response across reconnect cannot satisfy the reused native revision`, async ({
    page,
  }) => {
    await page.request.post(origin + "/fixture/reset");
    const { id } = await (
      await page.request.post(origin + "/fixture/cold-reading", { data: {} })
    ).json();
    await page.goto(origin);
    if (phase === "refresh") {
      const first = page.waitForResponse(
        (r) =>
          r.url().includes("/api/read/messages?") &&
          new URL(r.url()).searchParams.get("agent") === id,
      );
      await page
        .getByRole("button", { name: "Open Cold reading Orc", exact: true })
        .click();
      await (await first).finished();
      await page
        .getByRole("button", { name: "Open Local reports Orc", exact: true })
        .click();
    }
    const captured = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let reads = 0;
    await page.route("**/api/read/messages?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("agent") !== id) {
        await route.continue();
        return;
      }
      if (++reads === 1) {
        const response = await route.fetch();
        captured.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
      } else await route.continue();
    });
    try {
      await page
        .getByRole("button", { name: "Open Cold reading Orc", exact: true })
        .click();
      await captured.promise;
      await page.request.post(origin + "/fixture/history-control", {
        data: { skipDetailSync: true },
      });
      await page.request.post(origin + "/fixture/offline");
      await expect(page.locator(".host-outage")).toBeVisible();
      await page.request.post(origin + "/fixture/clear-reading", {
        data: {
          id,
          continuation: true,
          fail: false,
          revision: phase === "load" ? 1 : 2,
        },
      });
      await page.request.post(origin + "/fixture/online");
      await expect(page.locator(".host-outage")).toHaveCount(0);
      release.resolve();
      await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
      await expect(
        page.getByText("External continuation after reconnect", {
          exact: true,
        }),
      ).toBeVisible();
    } finally {
      release.resolve();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
