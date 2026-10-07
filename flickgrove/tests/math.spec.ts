import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
const origin = "http://127.0.0.1:14320";
const formula = String.raw`Inline energy $E=mc^2$ and standard \(a^2+b^2=c^2\).

$$
\int_0^1 x^2\,dx=\frac{1}{3}
$$

\[\sum_{i=1}^n i=\frac{n(n+1)}{2}\]

$$a_1+a_2+a_3+a_4+a_5+a_6+a_7+a_8+a_9+a_{10}+a_{11}+a_{12}+a_{13}+a_{14}+a_{15}=\sum_{i=1}^{15}a_i$$`;
const literals = String.raw`Invalid $\frac{1}{$ remains readable.

Unclosed $x+1

Prices $5 and $10, budget $5,000. Escaped \$20.

Inline code: \`$literal$\`.

\`\`\`tex
$$code = literal$$
\`\`\`

Unsafe $\href{javascript:alert(1)}{unsafe}$ and $\htmlClass{injected}{x}$.

<script>window.mathInjected=true</script>

[Unsafe link](javascript:alert(1))

Unclosed block $$x+1`.replaceAll("\\`", "`");
for (const width of [1440, 390]) {
  test(`${width} chat math renders history, user, assistant and reports with safe literals and local overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.post(origin + "/fixture/reset");
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: { title: "Math reading", text: formula },
      })
    ).json();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Math reading Orc", exact: true })
      .click();
    const history = page.locator(".historical-messages");
    await expect(history.locator(".katex")).toHaveCount(5);
    await expect(history.locator(".katex-display")).toHaveCount(3);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: `../.scratch/flickgrove-math/${width}-history.png`,
    });
    const long = history.locator(".math-block").last();
    expect(await long.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      width === 390,
    );
    if (width === 390) {
      await long.evaluate((el) => (el.scrollLeft = el.scrollWidth));
      expect(await long.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        input: "User inline $u^2$\n\n$$u=\\sqrt{2}$$",
        text: formula + "\n\n" + literals,
      },
    });
    const transcript = page.locator(".conversation");
    const assistant = transcript.locator('[data-message-id="live-item"]');
    await expect(assistant.locator(".katex")).toHaveCount(7);
    await expect(transcript.locator(".user-message .katex")).toHaveCount(2);
    await expect(assistant).toContainText(String.raw`$\frac{1}{$`);
    await expect(assistant).toContainText("Unclosed $x+1");
    await expect(assistant).toContainText("Unclosed block $$x+1");
    await expect(assistant).toContainText(
      "Prices $5 and $10, budget $5,000. Escaped $20.",
    );
    await expect(assistant.locator("code").first()).toHaveText("$literal$");
    await expect(assistant.locator("pre code")).toHaveText(
      "$$code = literal$$",
    );
    await expect(
      assistant.locator(
        "code .katex, script, .injected, a[href^='javascript:']",
      ),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as Window & { mathInjected?: boolean }).mathInjected,
      ),
    ).toBeUndefined();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../.scratch/flickgrove-math/${width}-literals.png`,
    });
    // Same-message resize still follows the measured end; no timeline changes required.
    await page.request.post(origin + "/fixture/history-live", {
      data: { id, stream: true, text: formula },
    });
    await expect(assistant.locator(".katex")).toHaveCount(5);
    await expect
      .poll(() =>
        transcript.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        text: "Report received.",
        report: "Math report\n\n" + formula + "\n\n[Worker chart](plot.png)",
      },
    });
    const report = page.locator(".worker-report");
    await expect(report).not.toHaveAttribute("open");
    await report.locator("summary").click();
    await expect(report.locator(".katex")).toHaveCount(5);
    await expect
      .poll(() =>
        transcript.evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `../.scratch/flickgrove-math/${width}-report.png`,
    });
    await report.getByRole("link", { name: "Worker chart" }).click();
    await expect(page.locator(".file-preview img")).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(report.locator(".katex")).toHaveCount(5);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // An unmatched math opener must not consume the following fenced code.
    const unmatched = "Unclosed $$x+1\n\n```tex\n$$code = literal$$\n```";
    await page.request.post(origin + "/fixture/history-live", {
      data: { id, stream: true, text: unmatched },
    });
    await expect(assistant.locator("pre code")).toHaveCount(1);
    await expect(assistant.locator("pre code")).toHaveText(
      "$$code = literal$$",
    );
    await expect(assistant.locator("p")).toContainText("Unclosed $$x+1");
    await expect(assistant.locator(".katex")).toHaveCount(0);
    await assistant.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../.scratch/flickgrove-math/${width}-unmatched-fence.png`,
    });
    await writeFile(
      `../.scratch/flickgrove-math/${width}-unmatched-fence.json`,
      JSON.stringify(
        {
          input: unmatched,
          expected:
            "Unclosed $$x+1 as literal text, followed by a fenced code block containing $$code = literal$$",
          actual: await assistant.evaluate((el) => ({
            text: el.textContent,
            html: el.innerHTML,
            codeBlocks: el.querySelectorAll("pre code").length,
          })),
        },
        null,
        2,
      ),
    );
    for (const text of [
      "$$\n    x + 1\n$$",
      "$$\n\n    x + 1\n\n$$",
      "$$\n    x + 1\n\n    y + 2\n$$",
    ]) {
      await page.request.post(origin + "/fixture/history-live", {
        data: { id, stream: true, text },
      });
      await expect(assistant.locator(".katex-display")).toHaveCount(1);
      await expect(assistant.locator("pre code")).toHaveCount(0);
    }
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        stream: true,
        text: "Unclosed $$x+1\n\n    $$code = literal$$",
      },
    });
    await expect(assistant.locator("pre code")).toHaveText(
      "$$code = literal$$",
    );
    await expect(assistant.locator("p")).toContainText("Unclosed $$x+1");
    expect(errors).toEqual([]);
  });
}
