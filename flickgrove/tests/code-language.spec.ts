import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14320";
const code = 'const message = "hello";\nconsole.log(message);';
const unknown = "unknown-language-" + "long".repeat(30);
const markdown = `\`\`\`typescript\n${code}\n\`\`\`\n\n\`\`\`${unknown}\nplain\n\`\`\`\n\n\`\`\`\nno language\n\`\`\``;

for (const width of [1440, 390]) {
  test(`shows fenced code languages without affecting copy at ${width}px`, async ({
    page,
    request,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            (window as Window & { copiedText?: string }).copiedText = text;
          },
        },
      }),
    );
    await request.post(`${origin}/fixture/reset`);
    await request.post(`${origin}/fixture/history`, {
      data: { title: "Code language", text: markdown },
    });
    await page.goto(origin);
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Code language Orc", exact: true })
      .click();
    const blocks = page.locator(".historical-messages .code-block");
    await expect(blocks).toHaveCount(3);
    await expect(blocks.nth(0).locator(".code-language")).toHaveText(
      "typescript",
    );
    await expect(blocks.nth(1).locator(".code-language")).toHaveText(unknown);
    await expect(blocks.nth(2).locator(".code-language")).toHaveCount(0);
    const longLabel = await blocks
      .nth(1)
      .locator(".code-language")
      .boundingBox();
    const copy = await blocks
      .nth(1)
      .getByRole("button", { name: "Copy code" })
      .boundingBox();
    expect(longLabel!.x + longLabel!.width).toBeLessThanOrEqual(copy!.x);
    await blocks.nth(0).getByRole("button", { name: "Copy code" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe(code);
    await expect(blocks.nth(0).locator("pre code")).toHaveText(code);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`${width}-code-language.png`),
    });
  });
}
