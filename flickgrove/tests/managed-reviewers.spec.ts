import sharp from "sharp";
import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-managed-reviewers/screenshots";
for (const width of [1440, 390])
  test(`workflow insertion and read-only Reviewer at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "reviewers" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", { name: "Message Orc" });
    const tools = page.locator(".workflow-tools");
    await input.fill("leftright");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(4, 4),
    );
    await tools.getByRole("button", { name: "Discuss", exact: true }).click();
    await expect(input).toHaveValue("left $grove-grill-with-docs right");
    await expect(input).toBeFocused();
    await input.fill("before replace after");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(7, 14),
    );
    await tools.getByRole("button", { name: "Implement", exact: true }).click();
    await expect(input).toHaveValue("before $grove-to-orc-impl after");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(0, 0),
    );
    await tools.getByRole("button", { name: "Review", exact: true }).click();
    await expect(input).toHaveValue(
      "$grove-code-review before $grove-to-orc-impl after",
    );
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(
        (el as HTMLTextAreaElement).value.length,
        (el as HTMLTextAreaElement).value.length,
      ),
    );
    await tools.getByRole("button", { name: "Re-review", exact: true }).click();
    await expect(input).toHaveValue(
      "$grove-code-review before $grove-to-orc-impl after $grove-review-again ",
    );
    const draft = await input.inputValue();
    await input.dispatchEvent("compositionstart");
    await tools.getByRole("button", { name: "Discuss", exact: true }).click();
    await expect(input).toHaveValue(draft);
    await input.dispatchEvent("compositionend");
    // Attachment preservation and direct Plus picker; no intermediate menu.
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Add images", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "fixture.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 10, height: 10, channels: 4, background: "#7799cc" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await tools.getByRole("button", { name: "Discuss", exact: true }).click();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(input).toBeFocused();
    await input.press("Alt+KeyS");
    await expect(
      page.getByRole("combobox", { name: "Search skills…" }),
    ).toBeFocused();
    await page
      .getByRole("combobox", { name: "Search skills…" })
      .press("Escape");
    await expect(input).toBeFocused();
    if (width === 390) {
      expect(
        await page
          .locator(".composer-tools")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await page
        .locator(".composer-tools")
        .evaluate((el) => (el.scrollLeft = 0));
    }
    await page.screenshot({ path: `${shots}/${width}-composer.png` });
    const state = await (await request.get(`${origin}/fixture/info`)).json();
    expect(
      state.inputs.filter((i: { text: string }) => i.text.includes("$grove-")),
    ).toHaveLength(0);
    // Distinct Reviewer report card, still collapsed.
    await expect(
      page
        .locator(".worker-report")
        .filter({ hasText: "Reviewer report" })
        .first(),
    ).toBeVisible();
    await page
      .locator(".worker-report")
      .filter({ hasText: "Reviewer report" })
      .first()
      .locator("summary")
      .click();
    await expect(page.locator(".report-content").first()).toContainText(
      "Read-only findings are bound to fixture-head.",
    );
    await page.screenshot({ path: `${shots}/${width}-reviewer-report.png` });
    await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
    for (const label of ["Discuss", "Implement", "Review", "Re-review"])
      await expect(
        tools.getByRole("button", { name: label, exact: true }),
      ).toBeDisabled();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    await page.locator(".worker-disclosure").first().click();
    await page
      .getByRole("button", { name: /Open Standards review.* Reviewer/ })
      .click();
    await expect(page.locator(".role-project")).toContainText("Reviewer");
    await expect(page.locator(".review-target")).toContainText("fixture-head");
    await expect(
      page.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveCount(0);
    await expect(tools).toHaveCount(0);
    await expect(page.locator(".read-only")).toBeVisible();
    await page.screenshot({ path: `${shots}/${width}-reviewer-detail.png` });
    await page
      .getByRole("button", { name: "All questions", exact: true })
      .click();
    await expect(page.locator(".delegated-questions")).toContainText(
      "Please delegate missing screenshot evidence",
    );
    await page.screenshot({ path: `${shots}/${width}-reviewer-question.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test("Reviewer history identifies its role and routes to its owning Orc", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "reviewers" },
  });
  await page.goto(origin);
  await page.keyboard.press("n");
  await page.getByRole("button", { name: "Experiments", exact: true }).click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  const row = page
    .locator(".history-result")
    .filter({ hasText: "Standards review" });
  await expect(row.locator(".history-result-meta")).toContainText("Reviewer");
  await row.click();
  await expect(page.locator(".history-action")).toContainText(
    "Continue this Reviewer through its original Orc.",
  );
  await expect(
    page.getByRole("button", { name: "Open session", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: `${shots}/1440-reviewer-history.png` });
  await page
    .getByRole("button", { name: "View owning Orc", exact: true })
    .click();
  await expect(page.locator(".history-title")).toHaveText(
    "Streaming voice input",
  );
  await page.getByRole("button", { name: "Open session", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Message Orc", exact: true }),
  ).toBeVisible();
});
