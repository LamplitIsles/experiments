import { expect, test } from "@playwright/test";
import { newSession } from "./browser-actions";

const origin = "http://127.0.0.1:14320";
const code =
  'const value = "<hello>";\n  console.log(value);\n// ' + "wide ".repeat(100);
const markdown = `A [link](https://example.com)\n\n\`\`\`typescript\n${code}\n\`\`\``;

for (const width of [1440, 390]) {
  test(`${width} copies message Markdown and code in history, live and reports`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      const state = window as Window & {
        copiedText?: string;
        failCopy?: boolean;
      };
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text: string) => {
            if (state.failCopy) throw new Error("Clipboard denied");
            state.copiedText = text;
          },
        },
      });
    });
    await page.request.post(origin + "/fixture/reset");
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: { title: "Copy reading", text: markdown },
      })
    ).json();
    await page.goto(origin);
    if (width === 390)
      await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await page
      .getByRole("button", { name: "Open Copy reading Orc", exact: true })
      .click();
    const history = page.locator(".historical-messages");
    const historyCopy = history.getByRole("button", { name: "Copy message" });
    await historyCopy.click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe(markdown);
    await expect(historyCopy).toHaveAttribute("title", "Copied");
    const codeBlock = history.locator(".code-block");
    await codeBlock.getByRole("button", { name: "Copy code" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe(code);
    await expect(codeBlock.locator("pre code")).toHaveText(code);
    const codeViewport = codeBlock.locator("pre");
    const copyCode = codeBlock.getByRole("button", { name: "Copy code" });
    const beforeScroll = await copyCode.boundingBox();
    expect(
      await codeViewport.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(true);
    await codeViewport.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    expect((await copyCode.boundingBox())?.x).toBe(beforeScroll?.x);
    await page.screenshot({
      path: `../.scratch/flickgrove-browser/copy-${width}.png`,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);

    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        input: "User input",
        text: markdown,
        report: "Report\n\n" + markdown,
      },
    });
    const live = page.locator('[data-message-id="live-item"]');
    await live.getByRole("button", { name: "Copy message" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe(markdown);
    await expect(
      page
        .locator(".user-message")
        .getByRole("button", { name: "Copy message" }),
    ).toHaveCount(0);
    const report = page.locator(".worker-report");
    await report.locator("summary").click();
    await report.getByRole("button", { name: "Copy message" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as Window & { copiedText?: string }).copiedText,
        ),
      )
      .toBe("Worker “Math reporter” reports:\n\nReport\n\n" + markdown);

    await page.evaluate(() => {
      (window as Window & { failCopy?: boolean }).failCopy = true;
    });
    await live.getByRole("button", { name: "Copy message" }).click();
    await expect(
      page.getByText("Copy failed. Please try again."),
    ).toBeVisible();
    await page.evaluate(() => {
      (window as Window & { failCopy?: boolean }).failCopy = false;
    });
    await live.getByRole("button", { name: "Copy message" }).click();
    await expect(
      live.getByRole("button", { name: "Copy message" }),
    ).toHaveAttribute("title", "Copied");
  });
}

test("only copies an oversized message after the complete body loads", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedText?: string }).copiedText = text;
        },
      },
    }),
  );
  await page.request.post(origin + "/fixture/reset");
  const text = "Beginning\n\n" + "Long paragraph. ".repeat(80000) + "\n\nEnd";
  await page.request.post(origin + "/fixture/history", {
    data: {
      title: "Large copy",
      messages: [{ id: "large", role: "assistant", text, at: 1 }],
    },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Large copy Orc", exact: true })
    .click();
  const message = page.locator('[data-message-id="large"]');
  await expect(
    message.getByRole("button", { name: "Copy message" }),
  ).toHaveCount(0);
  await message.getByRole("button", { name: "Read full message" }).click();
  await message.getByRole("button", { name: "Copy message" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { copiedText?: string }).copiedText,
      ),
    )
    .toBe(text);
});

test("copies an assistant message from the read-only history preview", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => {
          (window as Window & { copiedText?: string }).copiedText = text;
        },
      },
    }),
  );
  await page.goto("/");
  await newSession(page);
  await page.getByRole("option", { name: "Alpha", exact: true }).click();
  await page.getByRole("button", { name: "Find history", exact: true }).click();
  await page.getByRole("switch", { name: "Only Orc" }).click();
  await page
    .getByRole("textbox", { name: "Search title or first message…" })
    .fill("scrolling");
  await page.locator(".history-result").click();
  const transcript = page.locator(".history-transcript");
  await transcript.getByRole("button", { name: "Copy message" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as Window & { copiedText?: string }).copiedText,
      ),
    )
    .toBe("Previous result preserved in Codex.");
  await expect(
    transcript
      .locator(".user-message")
      .getByRole("button", { name: "Copy message" }),
  ).toHaveCount(0);
});
