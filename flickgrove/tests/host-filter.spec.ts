import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
test.use({ serviceWorkers: "block" });
for (const width of [1440, 390]) {
  test(`device selection remembers qualified sessions, drafts and refresh at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", {
      data: { mode: "host-selection" },
    });
    const info = await (await request.get(origin + "/fixture/info")).json();
    await page.goto(origin);
    const filters = page.getByRole("group", {
      name: "Host filter",
      includeHidden: true,
    });
    const mac = filters.locator('button[title="Neil’s Mac"]');
    const nuc = filters.locator('button[title="NUC"]');
    const title = page.locator(".agent-detail h1");
    const composer = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    const list = async () => {
      if (width === 390 && (await page.locator(".agent-detail").count()))
        await page
          .getByRole("button", { name: "‹ Sessions", exact: true })
          .click();
    };
    const choose = async (name: string) => {
      await list();
      await page
        .getByRole("button", { name: `Open ${name} Orc`, exact: true })
        .click();
      await expect(title).toHaveText(name);
    };
    await expect(
      filters.getByRole("button", { name: "All", exact: true }),
    ).toHaveCount(0);
    await expect(filters.getByRole("button")).toHaveCount(2);
    await expect(nuc).toHaveAttribute("aria-pressed", "true");
    await choose("Streaming voice input");
    await composer.fill("NUC first draft");
    await choose("NUC second session");
    await composer.fill("NUC second draft");
    const conversation = page.locator(".conversation");
    const reading = async (offset: number) => {
      const atMeasuredEnd = () =>
        conversation.evaluate((el) => {
          const timeline = el.querySelector<HTMLElement>(".message-timeline")!;
          const last = el.querySelector<HTMLElement>(
            '[data-message-id="row-39"]',
          );
          const footer = el.querySelector<HTMLElement>(".timeline-footer")!;
          return (
            !!last &&
            Math.abs(
              last.getBoundingClientRect().bottom -
                timeline.getBoundingClientRect().top -
                footer.offsetTop,
            ) <= 1 &&
            Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 1
          );
        });
      await expect.poll(atMeasuredEnd).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
      await expect.poll(atMeasuredEnd).toBe(true);
      await conversation.evaluate((el, offset) => {
        el.scrollTop = offset;
      }, offset);
      await expect
        .poll(() =>
          conversation.evaluate(
            (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
          ),
        )
        .toBeGreaterThan(1000);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      return conversation.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = [
          ...el.querySelectorAll<HTMLElement>(".timeline-message"),
        ].find((row) => row.getBoundingClientRect().bottom > top)!;
        return {
          id: row.dataset.messageId!,
          offset: row.getBoundingClientRect().top - top,
        };
      });
    };
    const sameReading = async (anchor: { id: string; offset: number }) => {
      await expect
        .poll(() =>
          conversation.evaluate((el, anchor) => {
            const row = [
              ...el.querySelectorAll<HTMLElement>(".timeline-message"),
            ].find((row) => row.dataset.messageId === anchor.id);
            return row
              ? Math.abs(
                  row.getBoundingClientRect().top -
                    el.getBoundingClientRect().top -
                    anchor.offset,
                )
              : Infinity;
          }, anchor),
        )
        .toBeLessThanOrEqual(1);
    };
    const nucReading = await reading(800);
    await list();
    await mac.click();
    await expect(title).toHaveText("Reader performance");
    await composer.fill("Mac first draft");
    await choose("Mac second session");
    await composer.fill("Mac second draft");
    const macReading = await reading(1200);
    await list();
    await nuc.click();
    await expect(title).toHaveText("NUC second session");
    await expect(composer).toHaveValue("NUC second draft");
    await sameReading(nucReading);
    await list();
    await mac.click();
    await expect(title).toHaveText("Mac second session");
    await expect(composer).toHaveValue("Mac second draft");
    await sameReading(macReading);
    await page.reload();
    await expect(title).toHaveText("Mac second session");
    await expect(mac).toHaveAttribute("aria-pressed", "true");
    await expect(composer).toHaveValue("Mac second draft");
    // A new browser route restores preferences, not only the current history entry.
    await page.evaluate(() => {
      history.replaceState(null, "");
    });
    await page.reload();
    await expect(title).toHaveText("Mac second session");
    // Explicit history wins over a different saved device/session preference.
    await page.evaluate(({ hub }) => {
      const key = `flickgrove/${location.origin}/selection`;
      const value = JSON.parse(localStorage.getItem(key)!);
      value.host = hub;
      localStorage.setItem(key, JSON.stringify(value));
    }, info);
    await page.reload();
    await expect(title).toHaveText("Mac second session");
    await expect(mac).toHaveAttribute("aria-pressed", "true");
    await composer.press("Alt+j");
    await expect(title).toHaveText("Reader performance");
    await expect(composer).toHaveValue("Mac first draft");
    await expect(composer).toBeFocused();
    await list();
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/flickgrove-navigation-perf/host-memory-${width}-buttons.png`,
    });
    await nuc.click();
    await expect(title).toHaveText("NUC second session");
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/flickgrove-navigation-perf/host-memory-${width}-selected.png`,
    });
    await composer.press("Alt+x");
    await expect(title).toHaveText("Streaming voice input");
    await expect(composer).toHaveValue("NUC first draft");
    await composer.press("Alt+x");
    await expect(page.locator(".agent-detail")).toHaveCount(0);
    await expect(nuc).toHaveAttribute("aria-pressed", "true");
    await mac.click();
    await expect(title).toHaveText("Reader performance");
    await list();
    await nuc.click();
    await expect(page.locator(".agent-detail")).toHaveCount(0);
    // Stale remembered identity is discarded only after an authoritative host snapshot.
    await page.evaluate(({ hub }) => {
      history.replaceState(null, "");
      const key = `flickgrove/${location.origin}/selection`;
      const value = JSON.parse(localStorage.getItem(key)!);
      value.sessions[hub] = hub + ":missing";
      localStorage.setItem(key, JSON.stringify(value));
    }, info);
    await page.reload();
    await expect(nuc).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".agent-detail")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          ({ hub }) =>
            JSON.parse(
              localStorage.getItem(`flickgrove/${location.origin}/selection`)!,
            ).sessions[hub] ?? null,
          info,
        ),
      )
      .toBe(null);
    // Add an empty configured device with a long name, then delete the active device.
    const empty = await (
      await request.get(info.emptyUrl + "/api/identity")
    ).json();
    const longName =
      "Configured device with a very long descriptive name ".repeat(2);
    await page.evaluate(
      ({ empty, info, longName }) => {
        const key = `flickgrove/${location.origin}/peers`;
        const peers = JSON.parse(localStorage.getItem(key)!);
        peers.push({
          id: empty.id,
          name: longName,
          url: info.emptyUrl,
          credential: info.emptyToken,
        });
        localStorage.setItem(key, JSON.stringify(peers));
      },
      { empty, info, longName },
    );
    await page.reload();
    await expect(filters.getByRole("button")).toHaveCount(3);
    const long = filters.getByRole("button", {
      name: longName.trim(),
      exact: true,
    });
    await long.click();
    await expect(long).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".session-open")).toHaveCount(0);
    await expect(page.locator(".agent-detail")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const filter = document
            .querySelector(".host-filter-control")!
            .getBoundingClientRect();
          const actions = document
            .querySelector(".header-actions")!
            .getBoundingClientRect();
          const header = document
            .querySelector(".app-header")!
            .getBoundingClientRect();
          return (
            document.documentElement.scrollWidth <= innerWidth &&
            filter.left >= 0 &&
            filter.right <= innerWidth &&
            filter.bottom <= header.bottom &&
            (filter.right <= actions.left || filter.top >= actions.bottom)
          );
        }),
      )
      .toBe(true);
    await page.screenshot({
      animations: "disabled",
      path: `../.scratch/flickgrove-navigation-perf/host-memory-${width}.png`,
    });
    await page.getByRole("button", { name: "Hosts", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Hosts", exact: true });
    await panel
      .locator(".host-row")
      .filter({ hasText: longName.trim() })
      .getByRole("button", { name: "Remove host", exact: true })
      .click();
    await panel.getByRole("button", { name: "Close", exact: true }).click();
    await expect(nuc).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".agent-detail")).toHaveCount(0);
  });
}

test("offline without cached rows preserves device memory until an authoritative snapshot", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "host-selection" },
  });
  const info = await (await request.get(origin + "/fixture/info")).json();
  await page.goto(origin);
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true })
    .click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await request.post(origin + "/fixture/change", { data: { outage: true } });
  await page.evaluate(({ peer }) => {
    const prefix = `flickgrove/${location.origin}`;
    localStorage.removeItem(prefix + "/peer-cache/" + peer);
    localStorage.removeItem(prefix + "/snapshot");
    history.replaceState(null, "");
    localStorage.setItem(
      prefix + "/selection",
      JSON.stringify({
        host: peer,
        sessions: { [peer]: peer + ":not-yet-known" },
      }),
    );
  }, info);
  await page.reload();
  const mac = page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true });
  await expect(mac).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  const offlinePanel = page.getByRole("dialog", { name: "Hosts", exact: true });
  await expect(
    offlinePanel.locator(".host-row").filter({ hasText: "Neil’s Mac" }),
  ).toContainText("Disconnected");
  expect(
    await page.evaluate(
      ({ peer }) =>
        JSON.parse(
          localStorage.getItem(`flickgrove/${location.origin}/selection`)!,
        ).sessions[peer],
      info,
    ),
  ).toBe(info.peer + ":not-yet-known");
  await offlinePanel
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await request.post(origin + "/fixture/change", { data: { outage: false } });
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await expect(mac).toHaveAttribute("aria-pressed", "true");
});

test("zero known hosts still exposes Hosts management", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: {} });
  await page.route("**/api/identity", (route) =>
    route.fulfill({ status: 503, body: "Synthetic unconfigured entry" }),
  );
  await page.goto(origin);
  await expect(
    page.getByRole("group", { name: "Host filter" }).getByRole("button"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Hosts", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Hosts", exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Add host", exact: true }).click();
  await expect(
    panel.getByRole("textbox", { name: "Backend URL", exact: true }),
  ).toBeVisible();
});

test("switching devices preserves a nested Worker's remembered selection", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", { data: {} });
  const { hub, peer } = await (
    await request.get(origin + "/fixture/info")
  ).json();
  await page.goto(origin);
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  // Restore the existing legal owner -> Worker history journey.
  await page.evaluate(
    ({ hub }) =>
      history.pushState(
        { grove: { details: [hub + ":orc", hub + ":voice"], surfaces: [] } },
        "",
      ),
    { hub },
  );
  await page.reload();
  await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
  const selection = () =>
    page.evaluate(() =>
      JSON.parse(
        localStorage.getItem(`flickgrove/${location.origin}/selection`)!,
      ),
    );
  await expect
    .poll(async () => (await selection()).sessions[hub])
    .toBe(hub + ":voice");
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true })
    .click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  expect((await selection()).sessions[hub]).toBe(hub + ":voice");
  await expect
    .poll(async () => (await selection()).sessions[peer])
    .toBe(peer + ":orc");
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "NUC", exact: true })
    .click();
  await expect(page.locator(".agent-detail h1")).toHaveText("Voice input");
  // Ordinary owner navigation is a real selection and must still update memory.
  await page.locator(".owner-link").click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Streaming voice input",
  );
  await expect
    .poll(async () => (await selection()).sessions[hub])
    .toBe(hub + ":orc");
});
