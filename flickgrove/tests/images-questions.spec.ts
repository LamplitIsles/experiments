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
async function setup(page: Page, request: any, width: number) {
  await request.post(origin + "/fixture/reset", { data: { mode: "long" } });
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
    await page.screenshot({ path: `${shots}/${width}-image-message.png` });
    await page.locator(".message-image").first().click();
    await expect(page.locator(".full-image")).toBeVisible();
    expect(
      await page
        .locator(".full-image")
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    ).toBe(1600);
    await page.screenshot({ path: `${shots}/${width}-image-full.png` });
    await page.keyboard.press("Escape");
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
  test(`question region keys, missing first, Shift Enter/IME, immutable batch and readable history at ${width}`, async ({
    page,
    request,
  }) => {
    await setup(page, request, width);
    await composer(page).fill("Keep composer draft");
    await request.post(origin + "/fixture/change", {
      data: {
        question: true,
        questionId: "required",
        questionCount: 2,
        questionOptions: false,
      },
    });
    await expect(page.locator(".question-card")).toHaveCount(1);
    await expect(composer(page)).toBeFocused();
    const region = page.locator(".questions-content");
    await page.locator(".question-card h3").click();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator(".question-card h3")).toHaveText(
      "required question 2",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".question-card h3")).toHaveText(
      "required question 1",
    );
    let answer = page.locator(".question-card textarea");
    await answer.fill("first");
    await answer.press("Shift+Enter");
    await expect(answer).toHaveValue("first\n");
    await answer.dispatchEvent("compositionstart");
    await answer.press("Enter");
    await answer.dispatchEvent("compositionend");
    await expect(page.locator(".answer-batch")).toHaveCount(0);
    await answer.press("ArrowRight");
    await expect(page.locator(".question-card h3")).toHaveText(
      "required question 1",
    );
    await region.focus();
    await page.keyboard.press("ArrowRight");
    await answer.fill("second");
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "held" },
    });
    await answer.press("Enter");
    await page.keyboard.press("Enter");
    await expect(page.locator(".answer-batch")).toContainText("Sending");
    await expect(
      page
        .locator(".user-message")
        .filter({ hasText: "Question: required question 1" }),
    ).toHaveCount(1);
    await expect(page.locator(".user-message [role=status]")).toHaveText([
      "Sending…",
    ]);
    await page.screenshot({ path: `${shots}/${width}-questions-pending.png` });
    await request.post(origin + "/fixture/change", {
      data: { question: true, questionId: "next", questionOptions: true },
    });
    await expect(page.locator(".question-card h3")).toHaveText(
      "next question 1",
    );
    await request.post(origin + "/fixture/change", {
      data: { sendMode: "accepted" },
    });
    await expect(page.locator(".answered-summary .answered-item")).toHaveCount(
      2,
    );
    await expect(page.locator(".answered-summary details")).toHaveCount(0);
    await expect(page.locator(".user-message [role=status]")).toHaveCount(0);
    await page.locator(".answer-radio").first().focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".answer-radio").last()).toBeChecked();
    await page.screenshot({ path: `${shots}/${width}-questions-history.png` });
    await page.locator(".question-panel-heading button").click();
    await page.reload();
    await expect(page.locator(".question-panel")).toHaveCount(0);
    await expect(
      page
        .locator(".user-message")
        .filter({ hasText: "Question: required question 1" }),
    ).toHaveCount(1);
    const info = await (await request.get(origin + "/fixture/info")).json();
    expect(
      info.inputs.filter((i: any) =>
        i.text.includes("Question: required question 1"),
      ),
    ).toHaveLength(1);
  });
}

test("slow upload binds original Peer/conversation while new draft remains isolated; rejection merges complete images", async ({
  page,
  request,
}) => {
  await setup(page, request, 1440);
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
  await expect(page.locator(".message-image")).toHaveCount(1);
  await expect(
    page.locator(".user-message").filter({ hasText: "Original upload" }),
  ).toHaveCount(1);
  await expect(page.locator(".user-message [role=status]")).toHaveText([
    "Sending…",
  ]);
  await page.screenshot({ path: `${shots}/desktop-uploading.png` });
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "Neil’s Mac", exact: true })
    .click();
  await expect(page.locator(".agent-detail h1")).toHaveText(
    "Reader performance",
  );
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
        (await (await request.get(origin + "/fixture/info")).json()).peerInputs
          .length,
    )
    .toBe(info.peerInputs.length + 1);
  await expect(page.locator(".message-image")).toHaveCount(1);
  await page
    .getByRole("group", { name: "Host filter" })
    .getByRole("button", { name: "NUC", exact: true })
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
  ).toBeVisible();
  await expect(composer(page)).toHaveValue("Restore full message");
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await page.screenshot({ path: `${shots}/desktop-image-failed.png` });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "uncertain" },
  });
  await composer(page).fill("Unknown original");
  await composer(page).press("Enter");
  const pending = page
    .locator(".user-message")
    .filter({ hasText: "Unknown original" });
  await expect(pending.locator("small[role=status]")).toHaveText("Sending…");
  const before = (await (await request.get(origin + "/fixture/info")).json())
    .inputs.length;
  await page.reload();
  await expect(pending.locator("small[role=status]")).toHaveText("Sending…");
  await expect(
    page.getByRole("button", { name: "Check receipt", exact: true }),
  ).toHaveCount(0);
  expect(
    (await (await request.get(origin + "/fixture/info")).json()).inputs.length,
  ).toBe(before);
  await page.screenshot({ path: `${shots}/desktop-image-unknown.png` });
});

test("storage failure keeps complete editable draft; HTTP rejection merges newer originating draft; long question remains readable", async ({
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
  await expect(page.locator(".image-draft")).toHaveCount(2);
  await expect(composer(page)).toHaveValue(
    "Newer original-session draft\n\nNever discard this",
  );
  await expect(page.locator(".delivery-error")).toContainText(
    "Synthetic upload rejection",
  );
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
  await expect(composer(page)).toHaveValue(
    "Newer original-session draft\n\nNever discard this",
  );
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
  await expect(composer(page)).toHaveValue("Original rejected caption");
  await boundedPreview(page, ".image-draft img");
  await boundedPreview(page, ".message-image img");
  await composer(page).fill("Edited recovered caption");
  await page.reload();
  await expect(composer(page)).toHaveValue("Edited recovered caption");
  await boundedPreview(page, ".image-draft img");
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
    await expect(page.locator(".delivery-error")).toContainText(
      failure.expected,
    );
    await expect(composer(page)).toHaveValue("Preserve failed upload");
    await expect(page.locator(".image-draft")).toHaveCount(1);
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
    await expect(image.locator("small[role=status]")).toHaveText("Sending…");
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
    await expect(composer(page)).toHaveValue(
      "Newer image draft\n\nRejected image caption",
    );
    await expect(page.locator(".image-draft")).toHaveCount(2);
    await expect(page.locator(".delivery-error")).toContainText(
      "Synthetic rejection",
    );
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
    await expect(composer(page)).toHaveValue(
      "Newer image draft\n\nRejected image caption",
    );
    await composer(page).fill("Uploaded image without native confirmation");
    await composer(page).press("Enter");
    await expect.poll(() => dropped).toBe(true);
    const pending = page
      .locator(".user-message")
      .filter({ hasText: "Uploaded image without native confirmation" });
    await expect(pending.locator("small[role=status]")).toHaveText("Sending…");
    await page.reload();
    await expect(pending.locator("small[role=status]")).toHaveText("Sending…");
    await expect(pending.locator(".message-image")).toHaveCount(2);
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
