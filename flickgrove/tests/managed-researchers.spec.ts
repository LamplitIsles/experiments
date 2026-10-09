import sharp from "sharp";
import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-managed-researchers/screenshots";
for (const width of [1440, 390])
  test(`Research insertion, evidence and owned history at ${width}`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "researchers" },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Streaming voice input Orc" })
      .click();
    const input = page.getByRole("textbox", { name: "Message Orc" }),
      tools = page.locator(".workflow-tools"),
      research = tools.getByRole("button", { name: "Research", exact: true });
    await expect(tools.getByRole("button")).toHaveText([
      "Discuss",
      "Implement",
      "Review",
      "Re-review",
      "Research",
    ]);
    await input.fill("leftright");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(4, 4),
    );
    await research.click();
    await expect(input).toHaveValue("left $grove-research right");
    await expect(input).toBeFocused();
    expect(
      await input.evaluate((el) => (el as HTMLTextAreaElement).selectionStart),
    ).toBe(21);
    await input.fill("before replace after");
    await input.evaluate((el) =>
      (el as HTMLTextAreaElement).setSelectionRange(7, 14),
    );
    await research.click();
    await expect(input).toHaveValue("before $grove-research after");
    const draft = await input.inputValue();
    await input.dispatchEvent("compositionstart");
    await research.click();
    await expect(input).toHaveValue(draft);
    await input.dispatchEvent("compositionend");
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
    await research.click();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(input).toBeFocused();
    if (width === 390) {
      expect(
        await page
          .locator(".composer-tools")
          .evaluate((el) => el.scrollWidth > el.clientWidth),
      ).toBe(true);
      await research.scrollIntoViewIfNeeded();
    }
    await page.screenshot({ path: `${shots}/${width}-composer.png` });
    const state = await (await request.get(`${origin}/fixture/info`)).json();
    expect(
      state.inputs.filter((i: { text: string }) =>
        i.text.includes("$grove-research"),
      ),
    ).toHaveLength(0);
    const report = page
      .locator(".worker-report")
      .filter({ hasText: "Researcher report" })
      .first();
    await expect(report).toBeVisible();
    await report.locator("summary").click();
    await expect(report.locator(".report-content")).toContainText(
      "remaining unknown is paid-turn inventory",
    );
    await page.screenshot({ path: `${shots}/${width}-report.png` });
    await page.getByRole("button", { name: "Stop Orc", exact: true }).click();
    await expect(research).toBeDisabled();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    if (width === 390)
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
    await page.locator(".worker-disclosure").first().click();
    await page
      .getByRole("button", {
        name: /Open Native collaboration evidence.* Researcher/,
      })
      .click();
    await expect(page.locator(".role-project")).toContainText("Researcher");
    await expect(page.locator(".review-target")).toContainText(
      "Which supported override",
    );
    await expect(
      page.getByRole("textbox", { name: "Message Orc" }),
    ).toHaveCount(0);
    await expect(page.locator(".model-trigger")).toHaveCount(0);
    await expect(page.locator(".read-only")).toBeVisible();
    await page.screenshot({ path: `${shots}/${width}-detail.png` });
    await page
      .getByRole("button", { name: "All questions", exact: true })
      .click();
    await expect(page.locator(".delegated-questions")).toContainText(
      "Which installed version",
    );
    await page.screenshot({ path: `${shots}/${width}-question.png` });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // History retains Researcher identity and routes through original owner.
    await request.post(`${origin}/fixture/reset`, {
      data: { mode: "researchers" },
    });
    await page.goto(origin);
    if (width === 390)
      await page
        .getByRole("button", { name: "New session", exact: true })
        .click();
    else await page.keyboard.press("n");
    await page
      .getByRole("button", { name: "Experiments", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Find history", exact: true })
      .click();
    const row = page
      .locator(".history-result")
      .filter({ hasText: "Native collaboration evidence" });
    await expect(row.locator(".history-result-meta")).toContainText(
      "Researcher",
    );
    await row.click();
    await expect(page.locator(".history-action")).toContainText(
      "Continue this Researcher through its original Orc.",
    );
    await expect(
      page.getByRole("button", { name: "Open session", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "View owning Orc", exact: true }),
    ).toBeEnabled();
    await page.screenshot({ path: `${shots}/${width}-history.png` });
    await page
      .getByRole("button", { name: "View owning Orc", exact: true })
      .click();
    await expect(page.locator(".history-title")).toHaveText(
      "Streaming voice input",
    );
    await page
      .getByRole("button", { name: "Open session", exact: true })
      .click();
    await expect(input).toBeVisible();
  });
