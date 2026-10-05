import { expect, test } from "@playwright/test";
test.setTimeout(90_000);
const origin = "http://127.0.0.1:14320";
const output = "../.scratch/flickgrove-file-preview";
async function open(page: import("@playwright/test").Page, name = "Local") {
  await page.request.post(origin + "/fixture/reset");
  await page.goto(origin);
  await page
    .getByRole("button", { name: `Open ${name} reports Orc`, exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Chart", exact: true }),
  ).toBeVisible();
}
for (const width of [1440, 390]) {
  test(`${width} local image opens on its execution Peer in a full height overlay and new tab`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const composer = page.getByRole("textbox", { name: "Message Orc" });
    await composer.fill("Keep my draft");
    const detail = await page.locator(".agent-detail").boundingBox();
    await page.getByRole("link", { name: "Chart", exact: true }).click();
    const drawer = page.getByRole("region", { name: "File preview" });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        drawer
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(900);
    const box = (await drawer.boundingBox())!;
    expect(box.width).toBeCloseTo(detail!.width * (width === 390 ? 1 : 0.8), 0);
    expect(box.height).toBeCloseTo(detail!.height, 0);
    expect((await drawer.locator("header").boundingBox())!.height).toBe(48);
    await page.screenshot({
      path: `${output}/${width}-image-longfilename.png`,
    });
    const [tab] = await Promise.all([
      page.waitForEvent("popup"),
      drawer.getByRole("link", { name: "Open in new tab" }).click(),
    ]);
    await tab.waitForLoadState();
    expect(tab.url()).toContain("/preview/");
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await drawer.getByRole("button", { name: "Close preview" }).click();
    await expect(drawer).toHaveCount(0);
    await expect(composer).toHaveValue("Keep my draft");
    await tab.reload();
    expect(
      await tab
        .locator("img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBe(900);
    await tab.close();
    for (const name of ["Absolute chart", "File URL"]) {
      await page.getByRole("link", { name, exact: true }).click();
      await expect
        .poll(() =>
          drawer
            .locator("img")
            .evaluate((img: HTMLImageElement) => img.naturalWidth),
        )
        .toBe(900);
      await drawer.getByRole("button", { name: "Close preview" }).click();
    }
    if (width === 390) await page.keyboard.press("Alt+j");
    else
      await page
        .getByRole("button", { name: "Open Remote reports Orc", exact: true })
        .click();
    await page.getByRole("link", { name: "Chart", exact: true }).click();
    await expect(drawer.locator("img")).toBeVisible();
    expect(
      new URL((await drawer.locator("img").getAttribute("src")) as string)
        .origin,
    ).toBe("http://127.0.0.1:14321");
    await drawer.getByRole("button", { name: "Close preview" }).click();
    await page.locator(".worker-report summary").click();
    await page.getByRole("link", { name: "Worker chart" }).click();
    await expect(drawer.locator("img")).toBeVisible();
    await expect
      .poll(() =>
        drawer
          .locator("img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(900);
  });
  test(`${width} HTML runs local resources and test CDN while iframe and direct tab remain isolated`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await page.getByRole("link", { name: "HTML", exact: true }).click();
    const frame = page.frameLocator(".file-preview iframe");
    await expect(frame.locator("#module")).toHaveText(
      "Local module loaded / Local",
    );
    await expect(frame.locator("#isolation")).toHaveText(
      JSON.stringify({
        cdn: true,
        parent: false,
        storage: false,
        api: false,
        ws: false,
        font: true,
      }),
    );
    await frame.getByRole("button", { name: "Count 0" }).click();
    await expect(frame.getByRole("button", { name: "Count 1" })).toBeVisible();
    const iframe = page.locator(".file-preview iframe");
    const previous = await iframe
      .contentFrame()
      .locator("body")
      .evaluate(() => (window as unknown as { instance: string }).instance);
    await request.post(origin + "/fixture/change", { data: {} });
    await expect(frame.getByRole("button", { name: "Count 1" })).toBeVisible();
    expect(
      await iframe
        .contentFrame()
        .locator("body")
        .evaluate(() => (window as unknown as { instance: string }).instance),
    ).toBe(previous);
    await page.screenshot({ path: `${output}/${width}-html.png` });
    const [tab] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Open in new tab" }).click(),
    ]);
    await expect(tab.locator("#module")).toHaveText(
      "Local module loaded / Local",
    );
    // A sandboxed top level has parent === self; directly test inaccessible origin storage/API instead.
    expect(
      await tab.evaluate(() => {
        try {
          localStorage.getItem("x");
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(false);
    expect(
      await tab.evaluate(async () => {
        try {
          return (await fetch("/api/identity")).ok;
        } catch {
          return false;
        }
      }),
    ).toBe(false);
    expect(await tab.evaluate(() => window.opener)).toBeNull();
    await tab.close();
    await page.getByRole("button", { name: "Close preview" }).click();
    await page.getByRole("link", { name: "Markdown", exact: true }).click();
    const markdown = page.frameLocator(".file-preview iframe");
    await expect(
      markdown.getByRole("heading", { name: "Local analysis" }),
    ).toBeVisible();
    await expect(markdown.locator("img")).toBeVisible();
    expect(
      await markdown
        .locator("body")
        .evaluate(
          () =>
            (window as unknown as { markdownUnsafe?: boolean }).markdownUnsafe,
        ),
    ).toBeUndefined();
    expect(
      await markdown
        .locator("main")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: `${output}/${width}-markdown.png` });
    const [markdownTab] = await Promise.all([
      page.waitForEvent("popup"),
      page.getByRole("link", { name: "Open in new tab" }).click(),
    ]);
    await expect(
      markdownTab.getByRole("heading", { name: "Local analysis" }),
    ).toBeVisible();
    expect(
      await markdownTab.evaluate(() => {
        try {
          localStorage.getItem("x");
          return true;
        } catch {
          return false;
        }
      }),
    ).toBe(false);
    expect(
      await markdownTab.evaluate(
        () =>
          (window as unknown as { markdownUnsafe?: boolean }).markdownUnsafe,
      ),
    ).toBeUndefined();
    await markdownTab.close();
  });
  test(`${width} Questions drafts, foreground arrivals, replacement, errors and Back retain the conversation`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    await request.post(origin + "/fixture/change", {
      data: { question: `draft-${width}` },
    });
    const questions = page.locator(".question-panel");
    await expect(questions).toBeVisible();
    const answer = questions.locator("textarea");
    await answer.fill("Preserved answer draft");
    // Dispatch from the original transcript link; the question overlay can cover it on mobile.
    await page
      .getByRole("link", { name: "HTML", exact: true })
      .evaluate((link: HTMLAnchorElement) => link.click());
    await expect(questions).toBeHidden();
    await request.post(origin + "/fixture/change", {
      data: { question: `new-${width}` },
    });
    await expect(page.locator(".file-preview")).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(questions).toBeVisible();
    await expect(answer).toHaveValue("Preserved answer draft");
    await page.screenshot({ path: `${output}/${width}-questions-draft.png` });
    await questions.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("link", { name: "Missing", exact: true }).click();
    await expect(page.locator(".file-preview [role=alert]")).toContainText(
      "File missing",
    );
    await page.screenshot({ path: `${output}/${width}-error.png` });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.locator(".file-preview [role=alert]")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".file-preview")).toHaveCount(0);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    await page.route(origin + "/api/file-preview", async (route) => {
      if (!held) {
        held = true;
        await gate;
      }
      await route.continue();
    });
    await page.getByRole("link", { name: "Chart", exact: true }).click();
    await expect(page.locator(".file-preview [role=status]")).toBeVisible();
    await page.screenshot({ path: `${output}/${width}-loading.png` });
    await page
      .getByRole("link", { name: "Other file", exact: true })
      .evaluate((link: HTMLAnchorElement) => link.click());
    await expect
      .poll(() =>
        page
          .locator(".file-preview img")
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(900);
    release();
    await expect(page.locator(".file-preview header strong")).toHaveText(
      "plot.png",
    );
    await page.goBack();
    await expect(page.locator(".file-preview")).toHaveCount(0);
    await page.getByRole("link", { name: "HTML", exact: true }).click();
    await page.setViewportSize({
      width: width === 1440 ? 390 : 1440,
      height: 900,
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goBack();
    await expect(page.locator(".file-preview")).toHaveCount(0);
    await expect(page.locator(".agent-detail")).toBeVisible();
    if (width === 390) {
      await page.goBack();
      await expect(page.locator(".agent-detail")).toHaveCount(0);
    }
  });
}
test("Forward/refresh reauthorize, remote documents keep identity and local drafts/scroll survive switching", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("link", { name: "HTML", exact: true }).click();
  const first = await page.locator(".file-preview iframe").getAttribute("src");
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.goForward();
  await expect(page.locator(".file-preview iframe")).toBeVisible();
  expect(
    await page.locator(".file-preview iframe").getAttribute("src"),
  ).not.toBe(first);
  await page.reload();
  await expect(page.locator(".file-preview iframe")).toBeVisible();
  expect(
    await page.evaluate(() => JSON.stringify(history.state)),
  ).not.toContain("/preview/");
  expect(
    await page.evaluate(async () =>
      (await caches.open((await caches.keys())[0]))
        .keys()
        .then((keys) =>
          keys.some((key) => new URL(key.url).pathname.startsWith("/preview/")),
        ),
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Open Remote reports Orc", exact: true })
    .click();
  await expect(page.locator(".file-preview")).toHaveCount(0);
  await page.getByRole("link", { name: "HTML", exact: true }).click();
  await expect(
    page.frameLocator(".file-preview iframe").locator("#module"),
  ).toHaveText("Local module loaded / Remote");
  await page.getByRole("button", { name: "Close preview" }).click();
  await page.getByRole("link", { name: "Markdown", exact: true }).click();
  await expect(
    page
      .frameLocator(".file-preview iframe")
      .getByRole("heading", { name: "Remote analysis" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  const draft = page.getByRole("textbox", { name: "Message Orc" });
  await draft.fill("Local draft stays");
  for (let i = 0; i < 12; i++)
    await page.request.post(origin + "/fixture/change", { data: {} });
  const transcript = page.locator(".conversation");
  await transcript.evaluate((el) => (el.scrollTop = 30));
  await page.getByRole("link", { name: "HTML", exact: true }).click();
  const before = await transcript.evaluate((el) => el.scrollTop);
  await page
    .getByRole("button", { name: "Open Remote reports Orc", exact: true })
    .click();
  await expect(page.locator(".file-preview")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(draft).toHaveValue("Local draft stays");
  await expect
    .poll(() => transcript.evaluate((el) => el.scrollTop))
    .toBe(before);
});
test("historical transcript links and reading position retain their restored agent context", async ({
  page,
}) => {
  await open(page);
  await page.request.post(origin + "/fixture/history");
  await page
    .getByRole("button", { name: "Open Historical reports Orc", exact: true })
    .click();
  const link = page
    .locator(".historical-messages")
    .getByRole("link", { name: "History chart" });
  await expect(link).toBeVisible();
  const transcript = page.locator(".conversation");
  await expect
    .poll(() =>
      transcript.evaluate(
        (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
      ),
    )
    .toBe(0);
  await transcript.evaluate((el) => (el.scrollTop = 30));
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(30);
  await link.click();
  await expect
    .poll(() =>
      page
        .locator(".file-preview img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(900);
  await page.getByRole("button", { name: "Close preview" }).click();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Open Historical reports Orc", exact: true })
    .click();
  await expect(link).toBeVisible();
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(30);
});
test("foreground Settings retains the preview and a remote outage gives explicit retry", async ({
  page,
}) => {
  await open(page);
  await page.getByRole("link", { name: "HTML", exact: true }).click();
  const src = await page.locator(".file-preview iframe").getAttribute("src");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".file-preview")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-preview")).toBeVisible();
  expect(await page.locator(".file-preview iframe").getAttribute("src")).toBe(
    src,
  );
  await page.getByRole("button", { name: "Close preview" }).click();
  await page
    .getByRole("button", { name: "Open Remote reports Orc", exact: true })
    .click();
  let block = true;
  await page.route("http://127.0.0.1:14321/api/file-preview", (route) =>
    block ? route.abort() : route.continue(),
  );
  await page.getByRole("link", { name: "HTML", exact: true }).click();
  await expect(page.locator(".file-preview [role=alert]")).toBeVisible();
  block = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.frameLocator(".file-preview iframe").locator("#module"),
  ).toHaveText("Local module loaded / Remote");
});
test("New and skill finish before a requested preview; Questions width roundtrip leaves no ghost layer", async ({
  page,
  request,
}) => {
  await open(page);
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .fill("Foreground draft");
  await page.keyboard.press("Alt+s");
  await expect(page.locator(".skill-search")).toBeVisible();
  await page
    .getByRole("link", { name: "HTML", exact: true })
    .evaluate((el: HTMLAnchorElement) => el.click());
  await expect(page.locator(".skill-search")).toBeVisible();
  await expect(page.locator(".file-preview")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-preview")).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await page
    .getByRole("textbox", { name: "Message Orc" })
    .evaluate((el) => el.blur());
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("link", { name: "HTML", exact: true })
    .evaluate((el: HTMLAnchorElement) => el.click());
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".file-preview")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".file-preview")).toBeVisible();
  await page.getByRole("button", { name: "Close preview" }).click();
  await request.post(origin + "/fixture/change", {
    data: { question: "width-question" },
  });
  await expect(page.locator(".question-panel")).toBeVisible();
  await page.locator(".question-panel textarea").fill("Width answer draft");
  await page
    .getByRole("link", { name: "HTML", exact: true })
    .evaluate((el: HTMLAnchorElement) => el.click());
  await page.setViewportSize({ width: 390, height: 900 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("button", { name: "Close preview" }).click();
  await expect(page.locator(".question-panel textarea")).toHaveValue(
    "Width answer draft",
  );
  await page
    .locator(".question-panel")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  expect(await page.evaluate(() => history.state.grove.surfaces)).toEqual([]);
  await expect(page.getByRole("textbox", { name: "Message Orc" })).toHaveValue(
    "Foreground draft",
  );
});
