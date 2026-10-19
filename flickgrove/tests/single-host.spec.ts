import { expect, test } from "@playwright/test";
import { newSession, createSession } from "./browser-actions";
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`single-origin creation and collaboration without host controls at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(() => {
      localStorage.setItem(
        `flickgrove/${location.origin}/peers`,
        JSON.stringify([
          {
            id: "obsolete-remote",
            name: "Old remote",
            url: "http://remote.invalid",
            credential: "stale",
          },
        ]),
      );
    });
    const sockets: string[] = [];
    const requests: string[] = [];
    page.on("websocket", (socket) => {
      sockets.push(socket.url());
    });
    page.on("request", (request) => {
      if (request.url().includes("/api/")) requests.push(request.url());
    });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "Settings", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Hosts", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Host filter" })).toHaveCount(
      0,
    );
    await newSession(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Access token", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".host-choices")).toHaveCount(0);
    await page.getByRole("option", { name: "Alpha", exact: true }).click();
    await page.screenshot({
      path: `../.scratch/single-host/project-${viewport.width}.png`,
    });
    await createSession(page);
    const input = page.getByRole("textbox", { name: "Message Orc" });
    await input.fill("Build a reader");
    await input.press("Enter");
    await expect(
      page.getByText("The reader is ready.", { exact: true }),
    ).toBeVisible();
    await input.fill("Request Worker report");
    await input.press("Enter");
    await expect(page.locator(".worker-report")).toHaveCount(1);
    const target = await page.evaluate(() =>
      history.state.grove.details.at(-1),
    );
    await page.reload();
    await expect(page.locator(".worker-report")).toHaveCount(1);
    expect(await page.evaluate(() => history.state.grove.details.at(-1))).toBe(
      target,
    );
    expect(sockets.length).toBeGreaterThan(0);
    expect(
      sockets.every((url) => new URL(url).host === "127.0.0.1:14318"),
    ).toBe(true);
    expect(
      requests.every((url) => new URL(url).host === "127.0.0.1:14318"),
    ).toBe(true);
    await page.screenshot({
      path: `../.scratch/single-host/conversation-${viewport.width}.png`,
    });
    await input.fill("Close the workers");
    await input.press("Enter");
    await expect(
      page.getByText("Workers are closed.", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Alt+x");
    await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  });
}
