import { expect, test, type Page } from "@playwright/test";
import { openSidebar } from "./browser-actions";
const origin = "http://127.0.0.1:14319";
const rows = (page: Page) =>
  page.locator('.session-open[data-location="tree"]');
const heading = (page: Page) => page.locator(".agent-detail h1");
for (const width of [1440, 390])
  test(`Composer Escape releases only ordinary input focus at ${width}`, async ({
    page,
    request,
  }) => {
    await request.post(origin + "/fixture/reset", {
      data: { mode: "no-workers" },
    });
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto(origin);
    await openSidebar(page);
    await rows(page).first().click();
    const input = page.getByRole("textbox", {
      name: "Message Orc",
      exact: true,
    });
    await expect(
      page.getByRole("button", { name: "Add images", exact: true }),
    ).toBeEnabled();
    const sharp = (await import("sharp")).default;
    await page.getByLabel("Choose message images").setInputFiles({
      name: "escape.png",
      mimeType: "image/png",
      buffer: await sharp({
        create: { width: 8, height: 8, channels: 4, background: "blue" },
      })
        .png()
        .toBuffer(),
    });
    await expect(page.locator(".image-draft")).toHaveCount(1);
    const initial = (await (await request.get(origin + "/fixture/info")).json())
      .inputs;
    await input.fill("Keep Escape draft and selection");
    await input.evaluate((el: HTMLTextAreaElement) =>
      el.setSelectionRange(5, 11),
    );
    await input.press("Escape");
    await expect(input).not.toBeFocused();
    await expect(heading(page)).toHaveText("Streaming voice input");
    await expect(input).toHaveValue("Keep Escape draft and selection");
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([5, 11]);
    expect(
      await page.evaluate(() =>
        document.activeElement?.matches(".session-open"),
      ),
    ).toBe(false);
    await page.keyboard.press("i");
    await expect(input).toBeFocused();
    await input.dispatchEvent("compositionstart");
    await input.press("Escape");
    await expect(input).toBeFocused();
    await input.dispatchEvent("compositionend");
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      await input.dispatchEvent("keydown", {
        key: "Escape",
        code: "Escape",
        ...init,
      });
      await expect(input).toBeFocused();
    }
    await input.press("Alt+KeyS");
    const search = page.getByRole("combobox", { name: "Search skills…" });
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(search).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    expect(
      await input.evaluate((el: HTMLTextAreaElement) => [
        el.selectionStart,
        el.selectionEnd,
      ]),
    ).toEqual([5, 11]);
    await input.press("Escape");
    await expect(input).not.toBeFocused();
    await input.click();
    await input.type("x");
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(/x/);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toEqual(initial);
  });
