import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-execution-feedback/screenshots";
for (const width of [1440, 390]) {
  test(`fixed single execution feedback and recovery at ${width}`, async ({
    page,
    request,
  }) => {
    let publications = 0;
    page.on("websocket", (socket) =>
      socket.on("framereceived", () => publications++),
    );
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", { name: "Message Orc" });
    await input.fill("Keep 中文 draft");
    await input.focus();
    const reason =
      "Selected model is at capacity. " +
      "Native reason with a long_unbroken_identifier_".repeat(80);
    const change = async (event: object, agentId = "orc") => {
      const before = publications;
      await request.post(origin + "/fixture/change", {
        data: { execution: { agentId, event } },
      });
      await expect.poll(() => publications).toBeGreaterThan(before);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
    };
    await change({
      type: "error",
      willRetry: true,
      errorKind: "capacity",
      error: reason,
    });
    const feedback = page.locator(".detail-heading .execution-feedback");
    await expect(feedback).toContainText("Retrying");
    await expect(input).toBeFocused();
    await expect(page.getByRole("button", { name: "Stop Orc" })).toBeEnabled();
    await page.locator(".conversation").evaluate((el) => (el.scrollTop = 600));
    await feedback.click();
    await expect(page.locator(".execution-reason")).toHaveText(reason);
    expect(
      await page
        .locator(".execution-reason")
        .evaluate((el) => el.scrollHeight > el.clientHeight),
    ).toBe(true);
    await expect(page.locator(".conversation")).not.toContainText(reason);
    await expect(input).toHaveValue("Keep 中文 draft");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(width);
    await page.screenshot({ path: `${shots}/${width}-retry-expanded.png` });
    await change({ type: "progress" });
    await expect(feedback).toHaveCount(0);
    await expect(page.locator(".detail-status")).toContainText("Working");
    await change({
      type: "error",
      willRetry: false,
      errorKind: "capacity",
      error: reason,
    });
    await expect(feedback).toHaveText("Model at capacity");
    await expect(page.getByRole("button", { name: "Stop Orc" })).toHaveCount(0);
    await feedback.click();
    await page.screenshot({ path: `${shots}/${width}-capacity-expanded.png` });
    await change(
      {
        type: "error",
        willRetry: false,
        errorKind: "error",
        error: "Other Worker failure",
      },
      "voice",
    );
    await expect(feedback).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".execution-reason")).toHaveText(reason);
    await change({
      type: "error",
      willRetry: false,
      errorKind: "capacity",
      error: reason,
    });
    await expect(feedback).toHaveAttribute("aria-expanded", "true");
    await page.screenshot({
      path: `${shots}/${width}-review-disclosure-preserved.png`,
    });
    await change({
      type: "error",
      willRetry: false,
      errorKind: "error",
      error: "Changed native cause",
    });
    await expect(feedback).toHaveAttribute("aria-expanded", "false");
    await feedback.click();
    await expect(page.locator(".execution-reason")).toHaveText(
      "Changed native cause",
    );
    await change({ type: "completed", status: "completed" });
    await expect(feedback).toHaveCount(0);
    await expect(page.locator(".detail-status")).toContainText("Idle");
    // Read-only Workers use the same heading with no Composer/skill action.
    if (width === 390) await page.locator(".mobile-back > button").click();
    await page.getByRole("button", { name: "Expand Workers" }).first().click();
    await page.getByRole("button", { name: "Open Voice input Worker" }).click();
    await change(
      {
        type: "error",
        willRetry: false,
        errorKind: "error",
        error: "Opaque Worker error\n" + reason,
      },
      "voice",
    );
    await expect(feedback).toHaveText("Execution error");
    await feedback.click();
    await expect(page.locator(".read-only")).toBeVisible();
    await page.keyboard.press("Alt+KeyS");
    await expect(page.locator(".skill-search")).toHaveCount(0);
    await page.screenshot({ path: `${shots}/${width}-worker-error.png` });
  });
  test(`explicit skill entry preserves selection, IME and foreground at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", { name: "Message Orc" });
    const search = page.getByRole("combobox", { name: "Search skills…" });
    const icon = page.getByRole("button", {
      name: "Search skills…",
      exact: true,
    });
    await page.locator(".image-picker").setInputFiles({
      name: "fixture.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Add images", exact: true }),
    ).toBeEnabled();
    await input.fill("abcdef $manual");
    await input.press("End");
    await input.press("$");
    await expect(search).toHaveCount(0);
    await input.fill("abcdef $manual");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(2, 5),
    );
    await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", {
      key: "ß",
      code: "KeyS",
      altKey: true,
    });
    await expect(search).toHaveCount(0);
    await input.dispatchEvent("compositionend");
    await input.dispatchEvent("keydown", {
      key: "ß",
      code: "KeyS",
      altKey: true,
      isComposing: true,
    });
    await expect(search).toHaveCount(0);
    for (const extra of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      await input.dispatchEvent("keydown", {
        key: "s",
        code: "KeyS",
        altKey: true,
        ...extra,
      });
      await expect(search).toHaveCount(0);
    }
    if (width === 390) {
      await expect(icon).toBeVisible();
      await icon.click();
    } else {
      await expect(icon).toBeHidden();
      await input.dispatchEvent("keydown", {
        key: "ß",
        code: "KeyS",
        altKey: true,
      });
    }
    await expect(search).toBeFocused();
    await search.fill("grdo");
    await page.screenshot({ path: `${shots}/${width}-skill-open.png` });
    await search.press("Escape");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("abcdef $manual");
    expect(
      await input.evaluate((el) => [
        (el as HTMLTextAreaElement).selectionStart,
        (el as HTMLTextAreaElement).selectionEnd,
      ]),
    ).toEqual([2, 5]);
    // Open from the non-editing detail without losing the saved selection.
    await page.locator(".role-project").click();
    await page.keyboard.press("Alt+KeyS");
    await expect(search).toBeFocused();
    await search.fill("grdo");
    await search.press("Tab");
    await expect(input).toHaveValue("ab$grill-with-docs f $manual");
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(input).toBeFocused();
    if (width === 390) {
      await page.locator(".role-project").click();
      await page.keyboard.press("n");
    } else
      await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Alt+KeyS");
    await expect(search).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-slot=dialog-overlay]")).toHaveCount(0);
    await page.screenshot({
      path: `${shots}/${width}-skill-entry.png`,
      animations: "disabled",
    });
  });
}
