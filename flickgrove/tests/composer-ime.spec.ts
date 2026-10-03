import { expect, test } from "@playwright/test";

const origin = "http://127.0.0.1:14319";

test("IME confirmation keeps the draft; a subsequent ordinary Enter sends", async ({
  page,
  request,
}) => {
  await request.post(`${origin}/fixture/reset`, {
    data: { mode: "no-workers" },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Streaming voice input Orc" })
    .click();
  const input = page.getByRole("textbox", { name: "Message Orc" });
  await input.fill("中文草稿");
  // Count actual Chord calls without touching a model or installed state.
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    const state = window as typeof window & { imeSends: number };
    state.imeSends = 0;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string" && JSON.parse(data).call?.member === "send")
        state.imeSends++;
      return send.call(this, data);
    };
  });
  const sends = () =>
    page.evaluate(
      () => (window as typeof window & { imeSends: number }).imeSends,
    );

  await input.dispatchEvent("compositionstart", { data: "" });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  expect(await sends()).toBe(0);
  // A composing input must remain protected even if the key event flag is absent.
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: false,
    keyCode: 13,
  });
  expect(await sends()).toBe(0);
  // WebKit can dispatch compositionend before its IME confirmation keydown.
  await input.dispatchEvent("compositionend", { data: "中文草稿" });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: false,
    keyCode: 229,
  });
  expect(await sends()).toBe(0);
  await expect(input).toHaveValue("中文草稿");
  await input.press("Shift+Enter");
  expect(await sends()).toBe(0);
  await expect(input).toHaveValue("中文草稿\n");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  expect(await sends()).toBe(1);
  await expect(
    page.locator(".user-message").filter({ hasText: "中文草稿" }),
  ).toHaveCount(1);
});
