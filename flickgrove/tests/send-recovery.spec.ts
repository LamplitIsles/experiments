import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

const origin = "http://127.0.0.1:14319";
const evidence = "../.scratch/conversation-region-spinner";
const input = (page: Page) =>
  page.getByRole("textbox", { name: "Message Orc", exact: true });
const bubble = (page: Page, text: string) =>
  page.locator(".user-message").filter({ hasText: text });
const retry = (page: Page, text: string) =>
  bubble(page, text).getByRole("button", { name: "Retry", exact: true });
async function open(page: Page) {
  await page.goto(origin);
  await page
    .getByRole("button", {
      name: "Open Streaming voice input Orc",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Add images", exact: true }),
  ).toBeEnabled();
}
function observe(page: Page) {
  const sends: any[] = [],
    results: any[] = [],
    lookups: any[] = [];
  page.on("websocket", (socket) => {
    const calls = new Map<string, any>();
    socket.on("framesent", ({ payload }) => {
      const f = JSON.parse(String(payload));
      if (["send", "lookup"].includes(f.call?.member)) {
        calls.set(f.id, { member: f.call.member, args: f.call.args[0] });
        if (f.call.member === "send") sends.push(f.call.args[0]);
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const f = JSON.parse(String(payload)),
        call = calls.get(f.id);
      if (call && f.type === "result")
        (call.member === "send" ? results : lookups).push({
          request: call.args,
          result: f.result,
        });
    });
  });
  return { sends, results, lookups };
}
const records = (page: Page) =>
  page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.includes("/outgoing/"))
      .map((k) => JSON.parse(localStorage.getItem(k)!)),
  );
async function media(page: Page) {
  return page.evaluate(async () => {
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
    return Promise.all(
      rows.map(async (row) => ({
        key: row.key,
        text: row.text,
        images: await Promise.all(
          row.images.map(async (i: any) => ({
            id: i.id,
            name: i.file.name,
            bytes: i.file.size,
            hash: Array.from(
              new Uint8Array(
                await crypto.subtle.digest(
                  "SHA-256",
                  await i.file.arrayBuffer(),
                ),
              ),
            )
              .map((b) => b.toString(16).padStart(2, "0"))
              .join(""),
          })),
        ),
      })),
    );
  });
}

test("explicit retry with a stale predecessor converges to the rejected owner attempt without resending", async ({
  page: first,
  context,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "rejected" },
  });
  const native = async () =>
    (await (await request.get(origin + "/fixture/info")).json()).inputs;
  const text = "Shared rejected original",
    draft = "Newer page two draft";
  const one = observe(first);
  await open(first);
  await input(first).fill(text);
  await input(first).press("Enter");
  await expect(retry(first, text)).toBeVisible();
  const A = one.sends[0].operationId;
  const second = await context.newPage(),
    two = observe(second);
  await open(second);
  await expect(retry(second, text)).toBeVisible();
  await input(second).fill(draft);
  await input(second).evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(2, 7);
  });
  await retry(first, text).click();
  await expect
    .poll(() => one.results.filter((r) => r.request.retry).length)
    .toBe(1);
  const B = one.sends[1].retry.attempt;
  expect(await native()).toHaveLength(2);
  await expect(retry(second, text)).toBeVisible();
  await retry(second, text).evaluate((el) => (el as HTMLButtonElement).click());
  await expect.poll(() => two.results.length).toBe(1);
  const C = two.sends[0].retry.attempt;
  expect(two.sends[0]).toMatchObject({
    operationId: A,
    text,
    retry: { after: A },
  });
  expect(C).not.toBe(B);
  expect(
    two.results[0].result.deliveries.find((d: any) => d.id === A),
  ).toMatchObject({ attemptId: B, status: "failed" });
  // The response to this explicit C must restore B, not strand C as pending.
  await expect(bubble(second, text).locator("small.failed")).toContainText(
    "Synthetic rejection",
  );
  await expect(retry(second, text)).toBeVisible();
  expect((await records(second)).find((o) => o.id === A)).toMatchObject({
    attemptId: B,
    status: "failed",
  });
  expect(await native()).toHaveLength(2);
  await expect(bubble(second, text)).toHaveCount(1);
  await expect(input(second)).toHaveValue(draft);
  expect(
    await input(second).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  await second.screenshot({ path: `${evidence}/repaired-stale-attempt.png` });
  await first.close(); // No other page can rewrite the shared journal during reload.
  await second.reload();
  await expect(retry(second, text)).toBeVisible();
  await expect(input(second)).toHaveValue(draft);
  expect(await native()).toHaveLength(2);
  await second.screenshot({
    path: `${evidence}/repaired-stale-attempt-reload.png`,
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await input(second).evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(2, 7);
  });
  await retry(second, text).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(async () => (await native()).length).toBe(3);
  await expect.poll(() => two.results.length).toBe(2);
  expect(two.sends[1]).toMatchObject({
    operationId: A,
    text,
    retry: { after: B },
  });
  expect(two.sends).toHaveLength(2);
  await expect(bubble(second, text)).toHaveCount(1);
  await expect(retry(second, text)).toHaveCount(0);
  await expect(input(second)).toHaveValue(draft);
  expect(
    await input(second).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 7]);
  await second.reload();
  await expect(bubble(second, text)).toHaveCount(1);
  await expect(input(second)).toHaveValue(draft);
  expect(await native()).toHaveLength(3);
  console.log(
    JSON.stringify({
      case: "stale predecessor repaired",
      A,
      B,
      C,
      nativeCounts: [1, 2, 2, 2, 3, 3],
    }),
  );
});

test("draft cleanup abort after durable preparation retains a rejected original for explicit image retry", async ({
  page,
  request,
}) => {
  await request.post(origin + "/fixture/reset", {
    data: { mode: "no-workers" },
  });
  const native = async () =>
    (await (await request.get(origin + "/fixture/info")).json()).inputs;
  const wire = observe(page),
    caption = "Original image caption",
    draft = "Newer image draft";
  await open(page);
  const file = {
    name: "owned.png",
    mimeType: "image/png",
    buffer: await sharp({
      create: { width: 32, height: 32, channels: 4, background: "#3377aa" },
    })
      .png()
      .toBuffer(),
  };
  await page.getByLabel("Choose message images").setInputFiles(file);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input(page).fill(caption);
  const originalMedia = (await media(page))[0].images;
  await page.evaluate((caption) => {
    const remove = IDBObjectStore.prototype.delete;
    let armed = true;
    IDBObjectStore.prototype.delete = function (key) {
      const r = remove.call(this, key);
      const journal = Object.keys(localStorage)
        .filter((k) => k.includes("/outgoing/"))
        .map((k) => JSON.parse(localStorage.getItem(k)!));
      if (
        armed &&
        String(key).startsWith("draft/") &&
        journal.some((o) => o.text === caption && o.status === "sending")
      ) {
        armed = false;
        (window as any).cleanupJournal = journal;
        this.transaction.abort();
      }
      return r;
    };
  }, caption);
  await input(page).press("Enter");
  await expect(page.locator(".composer-wrap [role=alert]")).toContainText(
    "Image storage full or unavailable",
  );
  const atAbort = await page.evaluate(() => (window as any).cleanupJournal);
  expect(atAbort).toHaveLength(1);
  const A = atAbort[0].id;
  expect(await native()).toHaveLength(0);
  expect(wire.sends).toHaveLength(0);
  expect(
    (await media(page)).find((r) => r.key.endsWith("/" + A)),
  ).toMatchObject({ text: caption, images: originalMedia });
  await expect(bubble(page, caption).locator("small.failed")).toContainText(
    "Image storage full or unavailable",
  );
  await expect(retry(page, caption)).toBeVisible();
  await expect(page.locator(".detail-status")).not.toContainText("Working");
  expect((await records(page)).find((o) => o.id === A)).toMatchObject({
    status: "failed",
  });
  await expect(input(page)).toHaveValue(caption);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await input(page).fill(draft);
  await page.reload();
  await expect(retry(page, caption)).toBeVisible();
  await expect(input(page)).toHaveValue(draft);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(await native()).toHaveLength(0);
  expect(
    (await media(page)).find((r) => r.key.endsWith("/" + A)),
  ).toMatchObject({ text: caption, images: originalMedia });
  await page.screenshot({
    path: `${evidence}/repaired-draft-cleanup-reload.png`,
  });
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "held" },
  });
  await input(page).evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(2, 6);
  });
  await retry(page, caption).evaluate((el) => {
    (el as HTMLButtonElement).click();
    (el as HTMLButtonElement).click();
  });
  await expect.poll(async () => (await native()).length).toBe(1);
  expect(wire.sends).toHaveLength(1);
  expect(wire.sends[0]).toMatchObject({ operationId: A, text: caption });
  expect(wire.sends[0].images).toHaveLength(1);
  const duringRetry = await media(page);
  expect(duringRetry.find((r) => r.key.endsWith("/" + A))).toMatchObject({
    text: caption,
    images: originalMedia,
  });
  expect(duringRetry.find((r) => r.key.startsWith("draft/"))!.images).toEqual(
    originalMedia,
  );
  await expect(input(page)).toHaveValue(draft);
  expect(
    await input(page).evaluate((el: HTMLTextAreaElement) => [
      el.selectionStart,
      el.selectionEnd,
    ]),
  ).toEqual([2, 6]);
  await request.post(origin + "/fixture/change", {
    data: { sendMode: "accepted" },
  });
  await expect.poll(() => wire.results.length).toBe(1);
  await expect(bubble(page, caption)).toHaveCount(1);
  await expect(retry(page, caption)).toHaveCount(0);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  await expect(input(page)).toHaveValue(draft);
  const finalNative = await native();
  expect(finalNative).toHaveLength(1);
  expect(finalNative[0]).toMatchObject({
    text: caption,
    images: expect.arrayContaining([expect.any(String)]),
  });
  await page.reload();
  await expect(bubble(page, caption)).toHaveCount(1);
  await expect(input(page)).toHaveValue(draft);
  await expect(page.locator(".image-draft")).toHaveCount(1);
  expect(await native()).toHaveLength(1);
  console.log(
    JSON.stringify({
      case: "draft cleanup repaired",
      A,
      nativeCounts: [0, 0, 1, 1],
      originalMedia,
    }),
  );
});
