import { expect, test } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
const origin = "http://127.0.0.1:14320";
// Fixture routes must receive delayed image requests, including after reload.
test.use({ serviceWorkers: "block" });
test("message timeline mounts a bounded window at representative nested Markdown scale", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  await page.request.post(origin + "/fixture/history", {
    data: { title: "Virtual A", count: 120, rich: true },
  });
  await page.request.post(origin + "/fixture/history", {
    data: { title: "Virtual B", count: 120, rich: true },
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Virtual A Orc", exact: true })
    .click();
  await expect(page.locator(".conversation")).toContainText(
    "Virtual A item 119",
  );
  await page
    .getByRole("button", { name: "Open Virtual B Orc", exact: true })
    .click();
  await expect(page.locator(".conversation")).toContainText(
    "Virtual B item 119",
  );
  await page
    .getByRole("button", { name: "Open Virtual A Orc", exact: true })
    .click();
  const stats = await page.locator(".conversation").evaluate((el) => ({
    mounted: el.querySelectorAll(
      ".assistant-message, .user-message, .worker-report",
    ).length,
    nodes: el.querySelectorAll("*").length,
    bottom: el.scrollHeight - el.scrollTop - el.clientHeight,
  }));
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const before = await session.send("Performance.getMetrics");
  const samples: number[] = [];
  const frames: unknown[] = [];
  const browser = await session.send("Browser.getVersion");
  for (let i = 0; i < 6; i++) {
    await page.evaluate(
      (target) => {
        (window as any).__virtualSample = new Promise((resolve) => {
          const key = (e: KeyboardEvent) => {
            if (!e.isTrusted || !e.altKey || !["KeyJ", "KeyK"].includes(e.code))
              return;
            const start = performance.now();
            document.removeEventListener("keydown", key, true);
            requestAnimationFrame(() =>
              resolve({
                duration: performance.now() - start,
                selected:
                  document
                    .querySelector('.session-open[aria-current="true"]')
                    ?.getAttribute("aria-label") === `Open ${target} Orc`,
                title:
                  document
                    .querySelector(".agent-detail h1")
                    ?.textContent?.trim() === target,
                content:
                  document
                    .querySelector(".conversation")
                    ?.textContent?.includes(`${target} item 119`) ?? false,
                focus:
                  document.activeElement?.matches(".composer textarea") ??
                  false,
              }),
            );
          };
          document.addEventListener("keydown", key, true);
        });
      },
      i % 2 ? "Virtual A" : "Virtual B",
    );
    await page.keyboard.press(i % 2 ? "Alt+k" : "Alt+j");
    const frame = await page.evaluate(() => (window as any).__virtualSample);
    samples.push(frame.duration);
    frames.push(frame);
    expect(frame).toMatchObject({
      selected: true,
      title: true,
      content: true,
      focus: true,
    });
    await expect(page.locator(".agent-detail")).toHaveAttribute(
      "aria-label",
      i % 2 ? "Virtual A" : "Virtual B",
    );
    await page.waitForTimeout(180);
  }
  const after = await session.send("Performance.getMetrics");
  const metrics = (m: typeof before) =>
    Object.fromEntries(
      m.metrics
        .filter((x) =>
          [
            "LayoutCount",
            "LayoutDuration",
            "RecalcStyleCount",
            "RecalcStyleDuration",
            "Nodes",
            "JSHeapUsedSize",
          ].includes(x.name),
        )
        .map((x) => [x.name, x.value]),
    );
  await mkdir("../.scratch/flickgrove-navigation-perf", { recursive: true });
  await writeFile(
    `../.scratch/flickgrove-navigation-perf/virtual-${process.env.VIRTUAL_PHASE ?? "current"}-metrics.json`,
    JSON.stringify(
      {
        stats,
        samples,
        frames,
        browser,
        before: metrics(before),
        after: metrics(after),
      },
      null,
      2,
    ),
  );
  expect(stats.mounted).toBeLessThanOrEqual(14);
  expect(stats.nodes).toBeLessThan(4500);
  expect(stats.bottom).toBeLessThanOrEqual(1);
});

for (const width of [1440, 390])
  test(`${width} virtual timeline preserves reading on append, follows same-message growth and delayed images, and reaches all loaded pages`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.post(origin + "/fixture/reset");
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: { title: "Virtual reading", count: 90, rich: true },
      })
    ).json();
    await page.addInitScript(() => {
      const observed = new Map<ResizeObserver, Set<Element>>();
      const NativeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeObserver {
        observe(target: Element, options?: ResizeObserverOptions) {
          if (!observed.has(this)) observed.set(this, new Set());
          observed.get(this)!.add(target);
          super.observe(target, options);
        }
        unobserve(target: Element) {
          observed.get(this)?.delete(target);
          super.unobserve(target);
        }
        disconnect() {
          observed.delete(this);
          super.disconnect();
        }
      };
      (window as any).__timelineObservers = () => {
        const counts = new Map<Element, number>();
        for (const targets of observed.values())
          for (const target of targets)
            if (
              target.matches(
                ".conversation, .timeline-message, .timeline-header, .timeline-footer",
              )
            )
              counts.set(target, (counts.get(target) ?? 0) + 1);
        return {
          total: counts.size,
          disconnected: [...counts.keys()].filter((el) => !el.isConnected)
            .length,
          duplicate: [...counts.values()].some((n) => n > 1),
        };
      };
      (window as any).__lateTimelineWrites = 0;
      const scrollTo = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (...args: any[]) {
        if (this.matches(".conversation") && !this.isConnected)
          (window as any).__lateTimelineWrites++;
        return (scrollTo as any).apply(this, args);
      };
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Virtual reading Orc", exact: true })
      .click();
    const transcript = page.locator(".conversation");
    await expect(transcript).toContainText("Virtual reading item 89");
    const bottom = () =>
      transcript.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      );
    await expect.poll(bottom).toBeLessThanOrEqual(1);
    const anchor = () =>
      transcript.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const row = [
          ...el.querySelectorAll<HTMLElement>(".timeline-message"),
        ].find(
          (row) =>
            row.getBoundingClientRect().bottom > top &&
            row.getBoundingClientRect().top < top + el.clientHeight,
        )!;
        return {
          id: row.dataset.messageId!,
          offset: row.getBoundingClientRect().top - top,
        };
      });
    const sameAnchor = async (saved: { id: string; offset: number }) => {
      await expect
        .poll(() =>
          transcript.evaluate((el, saved) => {
            const row = [
              ...el.querySelectorAll<HTMLElement>(".timeline-message"),
            ].find((row) => row.dataset.messageId === saved.id);
            return row
              ? Math.abs(
                  row.getBoundingClientRect().top -
                    el.getBoundingClientRect().top -
                    saved.offset,
                )
              : Infinity;
          }, saved),
        )
        .toBeLessThanOrEqual(1);
    };
    // Each page is still data, not permanently mounted rows. Prepend holds the
    // currently visible message; explicitly scroll up to reach the new page.
    for (const first of [60, 30]) {
      await transcript.evaluate((el) => (el.scrollTop = 0));
      await expect(transcript).toContainText(`Virtual reading item ${first}`);
      const before = await anchor();
      await page.getByRole("button", { name: "Earlier messages" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: "Loading history" }),
      ).toBeHidden();
      await sameAnchor(before);
      expect(
        await transcript.locator(".timeline-message").count(),
      ).toBeLessThanOrEqual(14);
    }
    await transcript.evaluate((el) => (el.scrollTop = 0));
    await expect(transcript).toContainText("Virtual reading item 0");
    await expect(
      page.getByRole("button", { name: "Earlier messages" }),
    ).toHaveCount(0);
    const reading = await anchor();
    await page.setViewportSize({ width, height: 820 });
    await sameAnchor(reading);
    await page.setViewportSize({ width, height: 900 });
    await sameAnchor(reading);
    await page.request.post(origin + "/fixture/history-live", {
      data: { id, text: "Streaming fixture" },
    });
    await sameAnchor(reading);
    await expect(
      page.getByRole("button", { name: "Jump to bottom" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Jump to bottom" }).click();
    await expect(transcript).toContainText("Streaming fixture");
    await expect.poll(bottom).toBeLessThanOrEqual(1);
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        stream: true,
        text:
          "Streaming fixture\n\n" +
          "A measured stream paragraph.\n\n".repeat(20),
      },
    });
    await expect(transcript).toContainText("A measured stream paragraph.");
    await expect.poll(bottom).toBeLessThanOrEqual(1);
    let release!: () => void;
    const loaded = new Promise<void>((resolve) => (release = resolve));
    await page.route(origin + "/fixture/delayed-image", async (route) => {
      await loaded;
      await route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#426697"/></svg>',
      });
    });
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        stream: true,
        text: `Dynamic image fixture\n\n${"Reading before image growth.\n\n".repeat(12)}![Anonymous image](${origin}/fixture/delayed-image)`,
      },
    });
    await expect(transcript).toContainText("Dynamic image fixture");
    await expect.poll(bottom).toBeLessThanOrEqual(1);
    // Native bottom alone can precede the last row's resize measurement.
    await expect
      .poll(() =>
        transcript.evaluate(async (el) => {
          const gap = () => {
            const row = el.querySelector<HTMLElement>(
              '[data-message-id="live-item"]',
            )!;
            const footer = el.querySelector<HTMLElement>(".timeline-footer")!;
            return Math.max(
              Math.abs(
                row.getBoundingClientRect().bottom -
                  footer.getBoundingClientRect().top,
              ),
              Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight),
            );
          };
          const before = gap();
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          );
          return Math.max(before, gap());
        }),
      )
      .toBeLessThanOrEqual(1);
    await transcript.evaluate((el) => (el.scrollTop -= 240));
    await expect(
      page.getByRole("button", { name: "Jump to bottom" }),
    ).toBeVisible();
    const beforeImage = await anchor();
    release();
    await expect
      .poll(() =>
        transcript
          .locator('img[alt="Anonymous image"]')
          .evaluate((img: HTMLImageElement) => img.naturalHeight),
      )
      .toBe(450);
    await sameAnchor(beforeImage);
    await expect(
      page.getByRole("button", { name: "Jump to bottom" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Jump to bottom" }).click();
    await expect.poll(bottom).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width, height: 760 });
    await expect.poll(bottom).toBeLessThanOrEqual(1);
    await page.screenshot({
      path: `../.scratch/flickgrove-navigation-perf/virtual-${width}-latest-image.png`,
    });
    await expect
      .poll(() => page.evaluate(() => (window as any).__timelineObservers()))
      .toMatchObject({ disconnected: 0, duplicate: false });
    expect(
      await transcript.locator(".timeline-message").count(),
    ).toBeLessThanOrEqual(14);
    if (width === 390) {
      await page
        .getByRole("button", { name: "‹ Sessions", exact: true })
        .click();
      await expect(page.locator(".agent-detail")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).__timelineObservers().total),
        )
        .toBe(0);
      await page.request.post(origin + "/fixture/history-live", {
        data: {
          id,
          stream: true,
          text: "Dynamic image fixture updated while away",
        },
      });
      await page
        .getByRole("button", { name: "Open Virtual reading Orc", exact: true })
        .click();
      await expect(transcript).toContainText("Dynamic image fixture");
    }
    expect(
      await page.evaluate(() => (window as any).__lateTimelineWrites),
    ).toBe(0);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as any).__timelineObservers()))
      .toMatchObject({ disconnected: 0, duplicate: false });
    expect(
      await page.evaluate(() => (window as any).__lateTimelineWrites),
    ).toBe(0);
  });

for (const width of [1440, 390]) {
  test(`remote header resize preserves reading and end anchoring at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.post(origin + "/fixture/reset");
    await page.request.post(origin + "/fixture/history", {
      data: { title: "Header reading", peer: "remote", count: 90, rich: true },
    });
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Header reading Orc", exact: true })
      .click();
    const list = page.locator(".conversation"),
      header = page.locator(".timeline-header");
    await expect(list).toContainText("Header reading item 89");
    const gap = () =>
      list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    const onlineHeight = await header.evaluate(
      (el) => el.getBoundingClientRect().height,
    );
    await list.evaluate((el) => (el.scrollTop = 800));
    await page.waitForTimeout(250);
    let anchor = await list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const row = [
        ...el.querySelectorAll<HTMLElement>(".timeline-message"),
      ].find((row) => row.getBoundingClientRect().bottom > top)!;
      return {
        id: row.dataset.messageId!,
        offset: row.getBoundingClientRect().top - top,
      };
    });
    const offset = () =>
      list.evaluate(
        (el, id) =>
          el
            .querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
            .getBoundingClientRect().top - el.getBoundingClientRect().top,
        anchor.id,
      );
    const toggle = async (online: boolean) => {
      await page.request.post(
        origin + (online ? "/fixture/online" : "/fixture/offline"),
      );
      if (online)
        await expect
          .poll(() =>
            header.evaluate((el) => el.getBoundingClientRect().height),
          )
          .toBe(onlineHeight);
      else
        await expect
          .poll(() =>
            header.evaluate((el) => el.getBoundingClientRect().height),
          )
          .toBeGreaterThan(onlineHeight + 30);
    };
    await toggle(false);
    await expect
      .poll(async () => Math.abs((await offset()) - anchor.offset))
      .toBeLessThanOrEqual(1);
    await toggle(true);
    await expect
      .poll(async () => Math.abs((await offset()) - anchor.offset))
      .toBeLessThanOrEqual(1);
    // Publish from the backward scroll event itself, before the library's
    // 150ms reset. Check again past reset; skipped compensation must not linger.
    await list.evaluate((el) => (el.scrollTop = 900));
    await page.waitForTimeout(250);
    anchor = await list.evaluate(
      (el) =>
        new Promise<{ id: string; offset: number }>((resolve) => {
          el.addEventListener(
            "scroll",
            () => {
              const top = el.getBoundingClientRect().top;
              const row = [
                ...el.querySelectorAll<HTMLElement>(".timeline-message"),
              ].find((row) => row.getBoundingClientRect().bottom > top)!;
              const anchor = {
                id: row.dataset.messageId!,
                offset: row.getBoundingClientRect().top - top,
              };
              void fetch("/fixture/offline", { method: "POST" }).then(() =>
                resolve(anchor),
              );
            },
            { once: true },
          );
          el.scrollTop = 800;
        }),
    );
    await expect
      .poll(() => header.evaluate((el) => el.getBoundingClientRect().height))
      .toBeGreaterThan(onlineHeight + 30);
    await expect
      .poll(async () => Math.abs((await offset()) - anchor.offset))
      .toBeLessThanOrEqual(1);
    await page.waitForTimeout(300);
    await expect
      .poll(async () => Math.abs((await offset()) - anchor.offset))
      .toBeLessThanOrEqual(1);
    await toggle(true);
    await expect
      .poll(async () => Math.abs((await offset()) - anchor.offset))
      .toBeLessThanOrEqual(1);
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await toggle(false);
    await expect.poll(gap).toBeLessThanOrEqual(1);
    await toggle(true);
    await expect.poll(gap).toBeLessThanOrEqual(1);
  });
}
