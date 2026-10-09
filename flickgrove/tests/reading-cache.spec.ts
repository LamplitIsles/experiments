import { expect, test } from "@playwright/test";
import { newSession, createSession } from "./browser-actions";

for (const failure of ["QuotaExceededError", "SecurityError"]) {
  test(`persistent ${failure} preserves live questions and receipts but refuses an unjournalled message`, async ({
    page,
    browser,
  }) => {
    await page.goto("/");
    await newSession(page);
    await page.getByRole("button", { name: "Alpha", exact: true }).click();
    await createSession(page);
    const id = await page.evaluate(
      () => history.state.grove.details.at(-1) as string,
    );
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await input.fill("Quota confirmation");
    await page.evaluate((failure) => {
      const original = Storage.prototype.setItem;
      let full = false;
      Storage.prototype.setItem = function (key, value) {
        if (full) throw new DOMException("Storage write refused", failure);
        original.call(this, key, value);
        // Required journal succeeds; every subsequent write fails.
        if (key.includes("/outgoing/")) full = true;
      };
    }, failure);
    await input.press("Enter");
    await expect(page.getByText("Received.", { exact: true })).toBeVisible();
    await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
    expect(
      await page.evaluate(
        (id) =>
          Object.keys(localStorage).some((key) =>
            key.includes(`/accepted/${encodeURIComponent(id)}/`),
          ),
        id,
      ),
    ).toBe(false);
    const other = await browser.newContext();
    try {
      const writer = await other.newPage();
      await writer.goto("http://127.0.0.1:14318/");
      await writer.locator(`[data-agent-id="${id}"]`).click();
      const writerInput = writer.getByRole("textbox", {
        name: "Message Orc",
        exact: true,
      });
      await writerInput.fill("Ask me questions");
      await writerInput.press("Enter");
      await expect(page.getByText("Question 1", { exact: true })).toBeVisible();
      await expect(
        page.locator(
          '.session-open[aria-current="true"] [aria-label="Needs input"]',
        ),
      ).toBeVisible();
      await page
        .locator(".question-panel-heading")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await writerInput.fill("Snapshot after closing the question panel");
      await writerInput.press("Enter");
      await expect(page.getByText("Received.", { exact: true })).toHaveCount(3);
      await expect(
        page.getByRole("button", { name: "All questions", exact: true }),
      ).toHaveAttribute("aria-expanded", "false");
      await input.fill("Must not reach execution host");
      await input.press("Enter");
      await expect(page.getByRole("alert")).toContainText(
        "Storage write refused",
      );
      const detail = await (
        await page.request.get(`/fixture/agents/${encodeURIComponent(id)}`)
      ).json();
      expect(
        detail.messages.some(
          (message: { text: string }) =>
            message.text === "Must not reach execution host",
        ),
      ).toBe(false);
      expect(
        await page.evaluate(
          () =>
            Object.keys(localStorage).filter((key) =>
              key.includes("/outgoing/"),
            ).length,
        ),
      ).toBe(0);
      await expect(input).toHaveValue("Must not reach execution host");
      await writer
        .getByRole("button", { name: "Send all answers", exact: true })
        .click();
      await expect(
        writer.locator(".session-open [aria-label='Needs input']"),
      ).toHaveCount(0);
      await writerInput.press("Alt+x");
      await expect(
        writer.getByText("Tree closed.", { exact: true }),
      ).toBeVisible();
      await expect(page.getByText("Question 1", { exact: true })).toHaveCount(
        0,
      );
    } finally {
      await other.close();
    }
  });
}

test("a quota failure while caching the snapshot does not disconnect the conversation", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const prefix = `flickgrove/${location.origin}`;
    localStorage.setItem(`${prefix}/detail/unused`, "old reading cache");
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        key === `${prefix}/snapshot` &&
        this.getItem(`${prefix}/detail/unused`)
      ) {
        throw new DOMException(
          `Setting the value of '${key}' exceeded the quota.`,
          "QuotaExceededError",
        );
      }
      setItem.call(this, key, value);
    };
  });
  await page.goto("/");
  await newSession(page);
  await page.getByRole("button", { name: "Alpha", exact: true }).click();
  await createSession(page);
  // Fill again after startup cleanup so the live update must handle a rejected
  // write, rather than relying only on reclaiming obsolete startup records.
  await page.evaluate(() =>
    localStorage.setItem(
      `flickgrove/${location.origin}/detail/unused`,
      JSON.stringify({ at: 0, value: {} }),
    ),
  );
  const input = page.getByRole("textbox", { name: "Message Orc", exact: true });
  await input.fill("Quota recovery test");
  await input.press("Enter");
  await expect(page.getByText("Received.", { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem(`flickgrove/${location.origin}/detail/unused`),
    ),
  ).toBeNull();
  const id = await page.evaluate(
    () => history.state.grove.details.at(-1) as string,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          !!localStorage.getItem(`flickgrove/${location.origin}/detail/${id}`),
        id,
      ),
    )
    .toBe(true);
  await input.fill("Keep my draft after closing");
  await input.press("Alt+x");
  await expect(page.getByText("Tree closed.", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          localStorage.getItem(`flickgrove/${location.origin}/detail/${id}`),
        id,
      ),
    )
    .toBeNull();
  expect(
    await page.evaluate(
      (id) =>
        localStorage.getItem(`flickgrove/${location.origin}/composer/${id}`),
      id,
    ),
  ).toBe("Keep my draft after closing");
});
