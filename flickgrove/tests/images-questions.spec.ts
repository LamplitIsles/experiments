import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
const origin = "http://127.0.0.1:14319";
const shots = "../.scratch/flickgrove-images-questions/screenshots";
const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const png = async (name = "screen.png") => ({
  name,
  mimeType: "image/png",
  buffer: await sharp({
    create: {
      width: 1600,
      height: 900,
      channels: 4,
      background: { r: 40, g: 110, b: 150, alpha: 0.6 },
    },
  })
    .composite([
      {
        input: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect x="40" y="40" width="1500" height="800" fill="#202124"/><text x="70" y="90" fill="white" font-size="28">Screenshot feedback — preserve full dimensions</text><text x="70" y="135" fill="#c7e2f4" font-size="12">Small text: alpha, native start/steer, original Peer, immutable operation, receipt lookup</text><path d="M70 150 H1450 M70 151 H1450" stroke="#a9d6ec" stroke-width="0.5"/></svg>',
        ),
      },
    ])
    .png()
    .toBuffer(),
});
async function setup(page: Page, request: any, width: number, mode = "long") {
  await request.post(origin + "/fixture/reset", { data: { mode } });
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(origin);
  if (width === 390) await page.locator(".session-open").first().click();
  await expect(composer(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
}
async function add(page: Page, count = 1) {
  const image = await png();
  await page.getByLabel("Choose message images").setInputFiles(
    Array.from({ length: count }, (_, i) => ({
      ...image,
      name: `screen-${i}.png`,
    })),
  );
  await expect(page.locator(".image-draft")).toHaveCount(count);
}
async function clipboard(page: Page, kind: "paste" | "drop") {
  const file = await png();
  const data = [...file.buffer];
  await page.evaluate(
    ({ data, kind }) => {
      const file = new File([new Uint8Array(data)], "clipboard.png", {
        type: "image/png",
      });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const target = document.querySelector(
        kind === "paste" ? ".composer textarea" : ".composer",
      )!;
      target.dispatchEvent(
        kind === "paste"
          ? new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            })
          : new DragEvent("drop", {
              dataTransfer: transfer,
              bubbles: true,
              cancelable: true,
            }),
      );
    },
    { data, kind },
  );
}
// Hold the real decoder boundary, not Composer state, to exercise editing during intake.
async function holdImageDecode(page: Page) {
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    const state = window as typeof window & { releaseImageDecode?: () => void };
    const gate = new Promise<void>((resolve) => {
      state.releaseImageDecode = resolve;
    });
    window.createImageBitmap = (async (source: ImageBitmapSource) => {
      await gate;
      return decode(source);
    }) as typeof createImageBitmap;
  });
}
async function releaseImageDecode(page: Page) {
  await page.evaluate(() =>
    (
      window as typeof window & { releaseImageDecode?: () => void }
    ).releaseImageDecode?.(),
  );
}
for (const width of [1440, 390]) {
  for (const failure of [false, true]) {
    test(`image preparation retains usable caret with failure=${failure} at ${width}`, async ({
      page,
      request,
    }) => {
      await setup(page, request, width);
      const before = (
        await (await request.get(origin + "/fixture/info")).json()
      ).inputs.length;
      await holdImageDecode(page);
      await composer(page).fill("before selected after");
      await composer(page).evaluate((input: HTMLTextAreaElement) =>
        input.setSelectionRange(7, 15),
      );
      if (failure) {
        await page.evaluate(() => {
          const transfer = new DataTransfer();
          transfer.items.add(
            new File(["invalid"], "bad.png", { type: "image/png" }),
          );
          document.querySelector(".composer textarea")!.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
      } else await clipboard(page, "paste");
      await expect(
        page.getByText("Preparing images…", { exact: true }),
      ).toBeVisible();
      await expect(composer(page)).toBeFocused();
      expect(
        await composer(page).evaluate((input: HTMLTextAreaElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      ).toEqual([7, 15]);
      await page.keyboard.type("typed");
      await page.keyboard.press("Enter"); // Preparation must still guard submission.
      await expect(composer(page)).toHaveValue("before typed after");
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeDisabled();
      await releaseImageDecode(page);
      await expect(
        page.getByText("Preparing images…", { exact: true }),
      ).toHaveCount(0);
      await expect(page.locator(".image-draft")).toHaveCount(failure ? 0 : 1);
      if (failure) await expect(page.getByRole("alert")).toBeVisible();
      await expect(composer(page)).toBeFocused();
      expect(
        await composer(page).evaluate((input: HTMLTextAreaElement) => [
          input.selectionStart,
          input.selectionEnd,
        ]),
      ).toEqual([12, 12]);
      await page.keyboard.type(" again");
      await expect(composer(page)).toHaveValue("before typed again after");
      expect(
        (await (await request.get(origin + "/fixture/info")).json()).inputs,
      ).toHaveLength(before);
      await page.screenshot({
        path: `../.scratch/image-paste-focus/${width}-${failure ? "failure" : "success"}.png`,
      });
    });
  }
  for (const escape of [false, true]) {
    test(`image completion respects deliberate focus escape=${escape} at ${width}`, async ({
      page,
      request,
    }) => {
      await setup(page, request, width, "host-selection");
      await holdImageDecode(page);
      await composer(page).fill("owned draft");
      await clipboard(page, "paste");
      await expect(
        page.getByText("Preparing images…", { exact: true }),
      ).toBeVisible();
      if (escape) {
        if (width === 390) {
          await page.keyboard.press("Escape");
          await expect(composer(page)).toHaveCount(0);
        }
        await page.locator(".session-open").last().click();
        await composer(page).fill("other draft");
      } else {
        await page
          .getByRole("button", { name: "Edit title", exact: true })
          .click();
        await page
          .getByRole("textbox", { name: "Session title", exact: true })
          .focus();
      }
      await releaseImageDecode(page);
      if (escape) {
        // Wait for the old intake's durable write while another Orc owns focus.
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const name = (await indexedDB.databases()).find((db) =>
                db.name?.endsWith("/images"),
              )!.name!;
              return new Promise<number>((resolve, reject) => {
                const open = indexedDB.open(name);
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                  const db = open.result;
                  const read = db
                    .transaction("drafts")
                    .objectStore("drafts")
                    .getAll();
                  read.onsuccess = () => {
                    db.close();
                    resolve(
                      read.result.reduce(
                        (count, record) => count + record.images.length,
                        0,
                      ),
                    );
                  };
                  read.onerror = () => {
                    db.close();
                    reject(read.error);
                  };
                };
              });
            }),
          )
          .toBe(1);
        await expect(composer(page)).toBeFocused();
        await page.keyboard.type(" continued");
        await expect(page.locator(".image-draft")).toHaveCount(0);
        await expect(composer(page)).toHaveValue("other draft continued");
        if (width === 390) await page.keyboard.press("Escape");
        await page.locator(".session-open").first().click();
        await expect(page.locator(".image-draft")).toHaveCount(1);
        await expect(composer(page)).toHaveValue("owned draft");
      } else {
        await expect(
          page.getByText("Preparing images…", { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByRole("textbox", { name: "Session title", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page.locator(".image-draft")).toHaveCount(1);
        await expect(composer(page)).toHaveValue("owned draft");
      }
    });
  }
}
for (const width of [1440, 390]) {
  test(`image paste preserves focused selection and continued typing at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width);
    const before = (await (await request.get(origin + "/fixture/info")).json())
      .inputs.length;
    await composer(page).fill("before selected after");
    await composer(page).evaluate((input: HTMLTextAreaElement) =>
      input.setSelectionRange(7, 15),
    );
    await expect(composer(page)).toBeFocused();
    await clipboard(page, "paste");
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(composer(page)).toBeFocused();
    expect(
      await composer(page).evaluate((input: HTMLTextAreaElement) => [
        input.selectionStart,
        input.selectionEnd,
      ]),
    ).toEqual([7, 15]);
    await page.keyboard.type("typed");
    await expect(composer(page)).toHaveValue("before typed after");
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toHaveLength(before);
  });
}
for (const width of [1440, 390]) {
  test(`multiline image caption survives browser HTTP upload and Chord send at ${width}`, async ({
    page,
    request,
  }) => {
    let uploaded: any;
    let submitted: any;
    page.on("response", async (response) => {
      if (response.url().includes("/api/images?"))
        uploaded = await response.json();
    });
    page.on("websocket", (socket) =>
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.call?.member === "send") submitted = frame.call.args[0];
      }),
    );
    await setup(page, request, width);
    const before = (await (await request.get(origin + "/fixture/info")).json())
      .inputs.length;
    for (const text of ["a\nb", "ab", "Synthetic first line\nsecond line"]) {
      uploaded = submitted = undefined;
      await add(page);
      await composer(page).fill(text);
      await composer(page).press("Enter");
      await expect.poll(() => !!submitted && !!uploaded).toBe(true);
      expect(submitted.id).toBe(uploaded.agent);
      expect(submitted.operationId).toBe(uploaded.operation);
      expect(submitted.images).toEqual(uploaded.images);
      expect(submitted.text).toBe(text);
      const info = await (await request.get(origin + "/fixture/info")).json();
      const stored = info.imageUploads.find(
        (u: any) => u.operation === submitted.operationId,
      );
      expect(submitted.id).toBe(`${info.hub}:${stored.agent}`);
      expect(stored.images).toEqual(submitted.images);
      expect(stored.text).toBe(text);
      await expect
        .poll(
          async () =>
            (
              await (await request.get(origin + "/fixture/info")).json()
            ).inputs.filter(
              (i: any) => i.text === text && i.images?.length === 1,
            ).length,
        )
        .toBe(1);
      await expect(
        page.getByText(
          "Images do not belong to this conversation and operation",
          { exact: true },
        ),
      ).toHaveCount(0);
      await expect(page.locator(".user-message [role=status]")).toHaveCount(0);
      await expect(page.locator(".image-draft")).toHaveCount(0);
    }
    await page.screenshot({
      path: `../.scratch/flickgrove-image-ownership/screenshots/accepted-${width}.png`,
    });
    await page.reload();
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs,
    ).toHaveLength(before + 3);
  });
}
for (const width of [1440, 390]) {
  test(`images picker/paste/drag, persistent drafts, remove, limits, pure image and full size at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width);
    await add(page, 2);
    await composer(page).fill("Screenshot feedback");
    await page.screenshot({ path: `${shots}/${width}-image-draft.png` });
    await page.reload();
    await expect(page.locator(".image-draft")).toHaveCount(2);
    await expect(composer(page)).toHaveValue("Screenshot feedback");
    await page
      .getByRole("button", { name: "Remove image 2", exact: true })
      .click();
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await clipboard(page, "paste");
    await expect(page.locator(".image-draft")).toHaveCount(2);
    await clipboard(page, "drop");
    await expect(page.locator(".image-draft")).toHaveCount(3);
    await page
      .getByLabel("Choose message images")
      .setInputFiles([
        await png("4.png"),
        await png("5.png"),
        await png("6.png"),
      ]);
    await expect(page.getByRole("alert")).toContainText("up to 5");
    await expect(page.locator(".image-draft")).toHaveCount(3);
    await page.getByLabel("Choose message images").setInputFiles({
      name: "bad.png",
      mimeType: "image/png",
      buffer: Buffer.from("invalid"),
    });
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator(".image-draft")).toHaveCount(3);
    const originals: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/original?")) originals.push(r.url());
    });
    await composer(page).press("Enter");
    await expect(page.locator(".image-draft")).toHaveCount(0);
    await expect(page.locator(".message-image")).toHaveCount(3);
    await expect(
      page.locator(".user-message").filter({ hasText: "Screenshot feedback" }),
    ).toHaveCount(1);
    await expect(page.locator(".user-message [role=status]")).toHaveCount(0);
    expect(originals).toHaveLength(0);
    // An ordinary optimistic bubble no longer proves native admission. Wait for
    // its receipt before testing a viewer whose provisional row can reconcile.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            Object.keys(localStorage).filter((k) => k.includes("/outgoing/"))
              .length,
        ),
      )
      .toBe(0);
    await page.screenshot({ path: `${shots}/${width}-image-message.png` });
    await page.locator(".message-image").first().click();
    await expect(page.locator(".full-image")).toBeVisible();
    expect(
      await page
        .locator(".full-image")
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    ).toBe(1600);
    await page.screenshot({ path: `${shots}/${width}-image-full.png` });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(page.locator(".full-image")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".message-image")).toHaveCount(3);
    await expect(
      page.locator(".user-message").filter({ hasText: "Screenshot feedback" }),
    ).toHaveCount(1);
    await add(page);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(page.locator(".message-image")).toHaveCount(4);
    await expect
      .poll(async () => {
        const info = await (await request.get(origin + "/fixture/info")).json();
        return info.inputs.filter(
          (i: any) => i.text === "Screenshot feedback" || i.text === "",
        ).length;
      })
      .toBe(2);
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.slice(-2).map((i: any) => [i.text, i.images.length]),
    ).toEqual([
      ["Screenshot feedback", 3],
      ["", 1],
    ]);
  });
}

test("slow upload binds original Peer/conversation while new draft remains isolated; rejection retains complete images for Retry", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440, "no-workers");
  const info = await (await request.get(origin + "/fixture/info")).json();
  let release!: () => void;
  let caught!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const arrived = new Promise<void>((r) => (caught = r));
  await page.route("**/api/images?*", async (route) => {
    caught();
    await held;
    await route.continue();
  });
  await add(page);
  await composer(page).fill("Original upload");
  await composer(page).press("Enter");
  await arrived;
  await expect(page.locator(".detail-status")).toContainText("Working");
  await expect(
    page.locator('.session-open[aria-current="true"] [aria-label="Working"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Stop Orc", exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.length,
  ).toBe(info.inputs.length);
  await expect(page.locator(".message-image")).toHaveCount(1);
  await expect(
    page.locator(".user-message").filter({ hasText: "Original upload" }),
  ).toHaveCount(1);
  await expect(page.locator(".user-message [role=status]")).toHaveCount(0);
  await page.screenshot({ path: `${shots}/desktop-uploading.png` });
  await page
    .getByRole("button", { name: "Open Reader performance Orc", exact: true })
    .click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
  await expect(page.locator(".detail-status")).not.toContainText("Working");
  await add(page);
  await composer(page).fill("New Peer draft");
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json()).inputs
          .length,
    )
    .toBe(info.inputs.length + 1);
  await expect(composer(page)).toHaveValue("New Peer draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await composer(page).press("Enter");
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json()).inputs
          .length,
    )
    .toBe(info.inputs.length + 2);
  await expect(page.locator(".message-image")).toHaveCount(1);
  await page
    .getByRole("button", {
      name: "Open Streaming voice input Orc",
      exact: true,
    })
    .click();
  await expect(page.locator(".message-image")).toHaveCount(1);
  await expect(composer(page)).toHaveValue("");
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "rejected" },
  });
  await add(page);
  await composer(page).fill("Restore full message");
  await composer(page).press("Enter");
  await expect(
    page.locator(".delivery-error").filter({ hasText: "Synthetic rejection" }),
  ).toHaveCount(0);
  const failed = page
    .locator(".user-message")
    .filter({ hasText: "Restore full message" });
  await expect(failed.locator("small.failed")).toContainText(
    "Synthetic rejection",
  );
  await expect(composer(page)).toHaveValue("");
  await expect(page.locator(".image-draft")).toHaveCount(0);
  await add(page);
  await composer(page).fill("New image draft");
  // This test owns this journal. Revisit a server-only rejected envelope.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (
        key.includes("/outgoing/") &&
        JSON.parse(localStorage.getItem(key)!).text === "Restore full message"
      )
        localStorage.removeItem(key);
    }
  });
  await page.reload();
  await page
    .locator(".user-message")
    .filter({ hasText: "Synthetic rejection" })
    .getByRole("button", { name: "Read full message", exact: true })
    .click();
  await expect(
    failed.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failed.locator("small.failed")).toHaveCount(0);
  await expect(failed.locator(".message-image")).toHaveCount(1);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(composer(page)).toHaveValue("New image draft");
  await page.screenshot({ path: `${shots}/desktop-image-failed.png` });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "uncertain" },
  });
  const beforeUnknown = (
    await (await request.get(origin + "/fixture/info")).json()
  ).inputs.length;
  await composer(page).fill("Unknown original");
  await composer(page).press("Enter");
  const pending = page
    .locator(".user-message")
    .filter({ hasText: "Unknown original" });
  await expect(pending.locator("small[role=status]")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json()).inputs
          .length,
    )
    .toBe(beforeUnknown + 1);
  const before = (await (await request.get(origin + "/fixture/info")).json())
    .inputs.length;
  await page.reload();
  await expect(pending.locator("small[role=status]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Check receipt", exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.length,
  ).toBe(before);
  await page.screenshot({ path: `${shots}/desktop-image-unknown.png` });
});

test("storage failure keeps complete editable draft; HTTP rejection preserves newer originating draft; long question remains readable", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440);
  await add(page);
  await composer(page).fill("Never discard this");
  const info = await (await request.get(origin + "/fixture/info")).json();
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    (window as any).restorePut = () => (IDBObjectStore.prototype.put = put);
    IDBObjectStore.prototype.put = function (value: any, ...args: any[]) {
      if (value.key.startsWith("operation/"))
        throw new DOMException("Synthetic storage full", "QuotaExceededError");
      return put.call(this, value, ...(args as []));
    };
  });
  await composer(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Synthetic storage full");
  await expect(composer(page)).toHaveValue("Never discard this");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.length,
  ).toBe(info.inputs.length);
  await page.evaluate(() => (window as any).restorePut());
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let arrived!: () => void;
  const arrival = new Promise<void>((r) => (arrived = r));
  await page.route("**/api/images?*", async (route) => {
    arrived();
    await gate;
    await route.fulfill({
      status: 400,
      headers: { "X-Grove-Peer": info.hub },
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic upload rejection" }),
    });
  });
  await composer(page).press("Enter");
  await arrival;
  await add(page);
  await composer(page).fill("Newer original-session draft");
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(composer(page)).toHaveValue("Newer original-session draft");
  const failed = page
    .locator(".user-message")
    .filter({ hasText: "Never discard this" });
  await expect(failed.locator("small.failed")).toContainText(
    "Synthetic upload rejection",
  );
  await page.reload();
  await expect(
    failed.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failed.locator("small.failed")).toHaveCount(0);
  await expect(composer(page)).toHaveValue("Newer original-session draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(page.locator(".delivery-error")).toHaveCount(0);
  await request.post(origin + "/fixture/change", {
    data: {
      question: true,
      questionId: "long",
      questionLong: true,
      questionCount: 2,
    },
  });
  await expect(page.locator(".question-card")).toHaveCount(1);
  await page.screenshot({ path: `${shots}/desktop-questions-long.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".question-panel")).toBeVisible();
  await page.screenshot({ path: `${shots}/mobile-questions-long.png` });
  await page.keyboard.press("Escape");
  await expect(page.locator(".question-panel")).toHaveCount(0);
  await expect(composer(page)).toHaveValue("Newer original-session draft");
});

async function boundedPreview(page: Page, selector: string) {
  await expect
    .poll(() =>
      page
        .locator(selector)
        .first()
        .evaluate(async (node: HTMLImageElement) => ({
          width: node.naturalWidth,
          height: node.naturalHeight,
          bytes: node.src.startsWith("blob:")
            ? (await (await fetch(node.src)).blob()).size
            : 0,
        })),
    )
    .toMatchObject({ width: 480, height: 270 });
  const bytes = await page
    .locator(selector)
    .first()
    .evaluate(
      async (node: HTMLImageElement) =>
        (await (await fetch(node.src)).blob()).size,
    );
  expect(bytes).toBeGreaterThan(0);
  expect(bytes).toBeLessThanOrEqual(160_000);
}

test("bounded local draft/pending/rejected previews retain original and edited recovery caption across reload", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440);
  await add(page);
  await boundedPreview(page, ".image-draft img");
  await composer(page).fill("Original rejected caption");
  const info = await (await request.get(origin + "/fixture/info")).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => (arrived = resolve));
  await page.route("**/api/images?*", async (route) => {
    arrived();
    await gate;
    await route.fulfill({
      status: 400,
      headers: { "X-Grove-Peer": info.hub },
      contentType: "application/json",
      body: JSON.stringify({ error: "Preview test rejection" }),
    });
  });
  await composer(page).press("Enter");
  await arrival;
  await boundedPreview(page, ".message-image img");
  await page.locator(".message-image").first().click();
  await expect(page.locator(".full-image")).toBeVisible();
  expect(
    await page
      .locator(".full-image")
      .evaluate((node: HTMLImageElement) => node.naturalWidth),
  ).toBe(1600);
  await page.keyboard.press("Escape");
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(composer(page)).toHaveValue("");
  await boundedPreview(page, ".message-image img");
  await expect(page.locator(".message-image")).toHaveCount(1);
  await composer(page).fill("Edited recovered caption");
  await page.reload();
  await expect(composer(page)).toHaveValue("Edited recovered caption");
  await boundedPreview(page, ".message-image img");
  const operationText = await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find((d) =>
      d.name?.endsWith("/images"),
    )!.name!;
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
    });
    const rows = await new Promise<any[]>((resolve) => {
      const r = db.transaction("drafts").objectStore("drafts").getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return rows.find((r) => r.key.startsWith("operation/")).text;
  });
  expect(operationText).toBe("Original rejected caption");
  const failed = page
    .locator(".user-message")
    .filter({ hasText: "Original rejected caption" });
  await page.evaluate(async () => {
    const name = (await indexedDB.databases()).find((d) =>
      d.name?.endsWith("/images"),
    )!.name!;
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction("drafts", "readwrite"),
        store = tx.objectStore("drafts"),
        r = store.getAll();
      r.onsuccess = () => {
        const row = r.result.find((r: any) => r.key.startsWith("operation/"));
        (window as any).retryOriginal = row;
        store.delete(row.key);
      };
      tx.oncomplete = () => resolve();
    });
    db.close();
  });
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failed.locator("small.failed")).toContainText(
    "Original images are unavailable",
  );
  await expect(composer(page)).toHaveValue("Edited recovered caption");
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.length,
  ).toBe(info.inputs.length);
  await expect(failed.locator(".message-image")).toHaveCount(1);
  await page.screenshot({ path: `${shots}/review-edited-recovery.png` });
});

test("IndexedDB open SecurityError leaves image error visible and pure text sends once without blob access", async ({
  page,
  request,
}) => {
  await page.addInitScript(() => {
    let opens = 0;
    Object.defineProperty(window, "imageStoreOpens", { get: () => opens });
    indexedDB.open = () => {
      opens++;
      throw new DOMException("Synthetic image storage denied", "SecurityError");
    };
  });
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
  await page.goto(origin);
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole("alert")).toContainText(
    "Image storage unavailable",
  );
  const before = await (await request.get(origin + "/fixture/info")).json();
  await composer(page).fill("Pure text with unavailable image store");
  await expect(
    page.getByRole("button", { name: "Send message", exact: true }),
  ).toBeEnabled();
  await composer(page).press("Enter");
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json()).inputs
          .length,
    )
    .toBe(before.inputs.length + 1);
  const sent = await (await request.get(origin + "/fixture/info")).json();
  expect(sent.inputs.at(-1).text).toBe(
    "Pure text with unavailable image store",
  );
  expect(await page.evaluate(() => (window as any).imageStoreOpens)).toBe(1);
  await expect(page.getByRole("alert")).toContainText(
    "Image storage unavailable",
  );
});

for (const failure of [
  {
    status: 413,
    body: "",
    contentType: "text/plain",
    expected: "Image upload exceeds 20 MiB",
  },
  {
    status: 502,
    body: "<html>proxy failed</html>",
    contentType: "text/html",
    expected: "Image request failed (HTTP 502)",
  },
  {
    status: 400,
    body: JSON.stringify({ error: "Synthetic upload rejection" }),
    contentType: "application/json",
    expected: "Synthetic upload rejection",
  },
  {
    status: 400,
    body: "null",
    contentType: "application/json",
    expected: "Image request failed (HTTP 400)",
  },
  {
    status: 400,
    body: JSON.stringify({ error: { detail: "invalid" } }),
    contentType: "application/json",
    expected: "Image request failed (HTTP 400)",
  },
  {
    status: 200,
    body: JSON.stringify({ images: [] }),
    contentType: "application/json",
    expected: "Peer identity changed",
  },
]) {
  test(`image HTTP ${failure.status} ${failure.body.slice(0, 35) || "empty"} missing identity header classification`, async ({
    page,
    request,
  }) => {
    await setup(page, request, 1440);
    const before = (await (await request.get(origin + "/fixture/info")).json())
      .inputs.length;
    await add(page);
    await composer(page).fill("Preserve failed upload");
    await page.route("**/api/images?*", (route) =>
      route.fulfill({
        status: failure.status,
        body: failure.body,
        contentType: failure.contentType,
      }),
    );
    await composer(page).press("Enter");
    await expect(page.locator(".user-message small.failed")).toContainText(
      failure.expected,
    );
    await expect(composer(page)).toHaveValue("");
    await expect(page.locator(".image-draft")).toHaveCount(0);
    await expect(
      page
        .locator(".user-message")
        .getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs
        .length,
    ).toBe(before);
  });
}

test("virtual image recycling retains only an open viewer row, releases URLs and explicitly retries a failed cached preview", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "virtual-images" },
  });
  await page.addInitScript(() => {
    const urls = new Set<string>();
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    (window as any).__imageUrls = () => urls.size;
  });
  await page.goto(origin);
  await expect(composer(page)).toBeVisible();
  await add(page);
  await composer(page).fill("Virtual image fixture");
  await composer(page).press("Enter");
  await expect(page.locator(".message-image")).toHaveCount(1);
  // An optimistic local preview is not upload/send confirmation. Wait for the
  // test-owned provider input before clearing its local recovery files.
  await expect
    .poll(async () => {
      const info = await (await request.get(origin + "/fixture/info")).json();
      return info.inputs.some(
        (input: any) =>
          input.text === "Virtual image fixture" && input.images.length === 1,
      );
    })
    .toBe(true);
  // Only this isolated browser's draft DB: force the real media preview path.
  await page.evaluate(async () => {
    for (const info of await indexedDB.databases())
      if (info.name?.endsWith("/images")) {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open(info.name!);
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("drafts", "readwrite");
          tx.objectStore("drafts").clear();
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }
  });
  let reads = 0;
  await page.route("**/api/images/*/preview?*", async (route) => {
    reads++;
    if (reads === 1)
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"Synthetic unavailable preview"}',
      });
    else await route.continue();
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Retry image", exact: true }),
  ).toBeVisible();
  expect(reads).toBe(1);
  await page.getByRole("button", { name: "Retry image", exact: true }).click();
  await expect(page.locator(".message-image img")).toBeVisible();
  expect(reads).toBe(2);
  const transcript = page.locator(".conversation");
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByRole("button", { name: /earlier messages/i }).click();
  await expect(page.locator(".history-controls [role=status]")).toHaveCount(0);
  await page.getByRole("button", { name: "Jump to bottom" }).click();
  await page.locator(".message-image").click();
  await expect(page.locator(".full-image")).toBeVisible();
  await transcript.evaluate((el) => (el.scrollTop = 0));
  await expect(transcript).toContainText("Row 0.");
  await expect(page.locator(".message-image")).toHaveCount(1);
  expect(
    await transcript.locator(".timeline-message").count(),
  ).toBeLessThanOrEqual(15);
  await page.keyboard.press("Escape");
  await expect(page.locator(".image-viewer")).toHaveCount(0);
  await transcript.evaluate(async (el) => {
    el.scrollTop = 0;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  await expect(page.locator(".message-image")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).__imageUrls()))
    .toBe(0);
  await page.getByRole("button", { name: "Jump to bottom" }).click();
  await expect(page.locator(".message-image img")).toBeVisible();
  expect(reads).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "‹ Sessions", exact: true }).click();
  await expect(page.locator(".agent-detail")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as any).__imageUrls()))
    .toBe(0);
});

for (const width of [1440, 390]) {
  test(`submission results: image admission, rejection and disconnected null lookup at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width);
    const before = (await (await request.get(origin + "/fixture/info")).json())
      .inputs.length;
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await add(page);
    await composer(page).fill("Image awaiting native receipt");
    await composer(page).press("Enter");
    const image = page
      .locator(".user-message")
      .filter({ hasText: "Image awaiting native receipt" });
    await expect(image.locator("small[role=status]")).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await (await request.get(origin + "/fixture/info")).json()).inputs
            .length,
      )
      .toBe(before + 1);
    await composer(page).fill("New draft survives native wait");
    await page.screenshot({
      path: `../.scratch/flickgrove-results/image-pending-${width}.png`,
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect(image.locator("small[role=status]")).toHaveCount(0);
    await expect(composer(page)).toHaveValue("New draft survives native wait");
    await page.screenshot({
      path: `../.scratch/flickgrove-results/image-accepted-${width}.png`,
    });
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await add(page);
    await composer(page).fill("Rejected image caption");
    await composer(page).press("Enter");
    await expect
      .poll(
        async () =>
          (await (await request.get(origin + "/fixture/info")).json()).inputs
            .length,
      )
      .toBe(before + 2);
    await composer(page).fill("Newer image draft");
    await add(page);
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "rejected" },
    });
    await expect(composer(page)).toHaveValue("Newer image draft");
    await expect(page.locator(".image-draft")).toHaveCount(1);
    await expect(
      page
        .locator(".user-message")
        .filter({ hasText: "Rejected image caption" })
        .getByRole("button", { name: "Retry", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".delivery-error")).toHaveCount(0);
    await page.screenshot({
      path: `../.scratch/flickgrove-results/image-rejected-${width}.png`,
    });
    // Upload succeeds, then the synthetic native call has no confirmed admission.
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "uncertain" },
    });
    let wireId = "",
      operationId = "",
      dropped = false;
    const calls: string[] = [];
    await page.routeWebSocket("**/api/socket", (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.call?.member === "send") {
          wireId = frame.id;
          operationId = frame.call.args[0].operationId;
          calls.push(operationId);
        }
        server.send(raw);
      });
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (wireId && !dropped && frame.type === "update") return;
        if (!dropped && frame.type === "result" && frame.id === wireId) {
          dropped = true;
          ws.close({
            code: 1011,
            reason: "Synthetic lost admission acknowledgement",
          });
          return;
        }
        ws.send(raw);
      });
    });
    await page.reload(); // Apply interception to a new socket; retain drafts and image blobs.
    await expect(composer(page)).toHaveValue("Newer image draft");
    await composer(page).fill("Uploaded image without native confirmation");
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await composer(page).press("Enter");
    await expect.poll(() => dropped).toBe(true);
    const pending = page
      .locator(".user-message")
      .filter({ hasText: "Uploaded image without native confirmation" });
    await expect(pending.locator("small[role=status]")).toHaveCount(0);
    await page.reload();
    await expect(pending.locator("small[role=status]")).toHaveCount(0);
    await expect(pending.locator(".message-image")).toHaveCount(1);
    await expect(composer(page)).toHaveValue("");
    await expect(page.locator(".image-draft")).toHaveCount(0); // Null did not authorize recovery.
    expect(calls).toEqual([operationId]);
    expect(
      (await (await request.get(origin + "/fixture/info")).json()).inputs
        .length,
    ).toBe(before + 3);
    await expect(
      page.getByRole("button", { name: "Check receipt", exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: `../.scratch/flickgrove-results/image-disconnected-pending-${width}.png`,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}

test("server image ownership rejection keeps originals and Retry preserves newer draft/images", async ({
  page,
  request,
}) => {
  let reject = true;
  await page.routeWebSocket("**/api/socket", (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (
        reject &&
        frame.call?.member === "send" &&
        frame.call.args[0].images?.length
      )
        frame.call.args[0].text += " changed";
      server.send(JSON.stringify(frame));
    });
    server.onMessage((raw) => ws.send(raw));
  });
  await setup(page, request, 1440);
  const before = (await (await request.get(origin + "/fixture/info")).json())
    .inputs.length;
  await add(page);
  await composer(page).fill("Original\ncaption");
  await composer(page).press("Enter");
  const failed = page.locator(".user-message").filter({ hasText: "Original" });
  await expect(failed.locator("small.failed")).toContainText(
    "Images do not belong",
  );
  await add(page);
  await composer(page).fill("Newer draft");
  await page.reload();
  await expect(
    failed.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  reject = false;
  await failed.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(failed.locator("small.failed")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await request.get(origin + "/fixture/info")).json()).inputs
          .length,
    )
    .toBe(before + 1);
  await expect(failed).toHaveCount(1);
  await expect(failed.locator(".message-image")).toHaveCount(1);
  await expect(composer(page)).toHaveValue("Newer draft");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  const last = (
    await (await request.get(origin + "/fixture/info")).json()
  ).inputs.at(-1);
  expect(last.text).toBe("Original\ncaption");
  expect(last.images).toHaveLength(1);
});
