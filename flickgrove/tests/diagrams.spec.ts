import { expect, test } from "@playwright/test";
const origin = "http://127.0.0.1:14320";
const diagram =
  "```mermaid\nflowchart LR\nA[Read message] --> B[Check formula] --> C[Review generated report] --> D[Continue conversation]\n```";
for (const width of [1440, 390]) {
  test(`${width} Mermaid renders safely with math, history and reports and keeps errors readable`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.request.post(origin + "/fixture/reset");
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: { title: "Rich reading", text: "Math $x^2$\n\n" + diagram },
      })
    ).json();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Rich reading Orc", exact: true })
      .click();
    const history = page.locator(".historical-messages");
    await expect(history.locator(".mermaid-svg svg")).toBeVisible();
    await expect(history.locator(".katex")).toHaveCount(1);
    const viewport = history.locator(".mermaid-svg");
    expect(
      await viewport.evaluate((el) => el.scrollWidth > el.clientWidth),
    ).toBe(width === 390);
    if (width === 390) {
      await viewport.evaluate((el) => (el.scrollLeft = el.scrollWidth));
      expect(await viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../.scratch/flickgrove-rich/${width}-mermaid-history.png`,
    });
    const malicious =
      '```mermaid\n%%{init: {"securityLevel":"loose","htmlLabels":true}}%%\nflowchart LR\nA["<img src=x onerror=window.diagramInjected=true>"] --> B[Safe]\nclick B "javascript:alert(1)"\n```';
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        input: diagram,
        text: malicious,
        report: "Diagram report\n\n" + diagram + "\n\n[Worker chart](plot.png)",
      },
    });
    const transcript = page.locator(".conversation"),
      live = transcript.locator('[data-message-id="live-item"]');
    await expect(live.locator(".mermaid-svg svg")).toBeVisible();
    await expect(
      transcript.locator(".user-message .mermaid-svg svg"),
    ).toHaveCount(1);
    await expect(
      live.locator("script, img, foreignObject, a, [onclick], [onerror]"),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          (window as Window & { diagramInjected?: boolean }).diagramInjected,
      ),
    ).toBeUndefined();
    const report = page.locator(".worker-report");
    await report.locator("summary").click();
    await expect(report.locator(".mermaid-svg svg")).toBeVisible();
    await report.getByRole("link", { name: "Worker chart" }).click();
    await expect(page.locator(".file-preview img")).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    await report.locator("summary").click();
    const invalid = "```mermaid\nflowchart LR\nA --> [\n```";
    await page.request.post(origin + "/fixture/history-live", {
      data: { id, stream: true, text: invalid },
    });
    await expect(live).toContainText("Unable to render diagram.");
    await expect(live.locator("pre code")).toHaveText("flowchart LR\nA --> [");
    await expect(live.locator("svg")).toHaveCount(0);
    await live.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../.scratch/flickgrove-rich/${width}-mermaid-invalid.png`,
    });
    await page.request.post(origin + "/fixture/history-live", {
      data: { id, stream: true, text: diagram },
    });
    await expect(live.locator(".mermaid-svg svg")).toBeVisible();
    await expect(
      page.locator(
        "body > [id^='dgrove-diagram-'], body > [id^='grove-diagram-']",
      ),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test("Mermaid lazy load ignores a replaced row and an unmounted conversation", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  const { id } = await (
    await page.request.post(origin + "/fixture/history", {
      data: { title: "Lazy diagram", text: "Before diagram" },
    })
  ).json();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/assets\/mermaid[^/]*\.js$/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Lazy diagram Orc", exact: true })
    .click();
  await page.request.post(origin + "/fixture/history-live", {
    data: { id, text: diagram },
  });
  await expect(page.locator(".mermaid-status")).toContainText(
    "Loading diagram",
  );
  await page.request.post(origin + "/fixture/history-live", {
    data: { id, stream: true, text: "Replacement remains" },
  });
  await expect(page.locator(".conversation")).toContainText(
    "Replacement remains",
  );
  await expect(page.locator(".mermaid-renderer")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(page.locator(".agent-detail")).toHaveAttribute(
    "aria-label",
    "Local reports",
  );
  release();
  await page
    .getByRole("button", { name: "Open Lazy diagram Orc", exact: true })
    .click();
  await expect(page.locator(".conversation")).toContainText(
    "Replacement remains",
  );
  await expect(page.locator(".mermaid-renderer")).toHaveCount(0);
  await page.request.post(origin + "/fixture/history-live", {
    data: { id, stream: true, text: diagram },
  });
  await expect(page.locator(".mermaid-svg svg")).toBeVisible();
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(
    page.locator(".mermaid-staging, body > [id^='dgrove-diagram-']"),
  ).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`${width} TanStack highlights shared Markdown without changing code text or unknown languages`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.request.post(origin + "/fixture/reset");
    const source =
      'const greeting: string = "Hello <world>";\n// Keep dollars $x$ and $$y$$ literal\nconst long = "' +
      "long source ".repeat(30) +
      '";';
    const unknown =
      '<script>window.codeInjected=true</script>\n$literal$ & "quotes"';
    const text =
      "Math $x^2$ and inline `$literal$`.\n\n" +
      diagram +
      "\n\n```typescript\n" +
      source +
      "\n```\n\n```not-a-language\n" +
      unknown +
      "\n```\n\n```\n" +
      unknown +
      "\n```";
    const { id } = await (
      await page.request.post(origin + "/fixture/history", {
        data: { title: "Code reading", text },
      })
    ).json();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Open Code reading Orc", exact: true })
      .click();
    const history = page.locator(".historical-messages");
    await expect(history.locator(".mermaid-svg svg")).toBeVisible();
    await expect(history.locator(".katex")).toHaveCount(1);
    const code = history.locator("pre.th-code").first();
    await expect(code.locator("code")).toHaveText(source);
    await expect(code.locator(".th-keyword").first()).toHaveText("const");
    expect(
      await code
        .locator(".th-keyword")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    ).not.toBe(
      await code.locator("code").evaluate((el) => getComputedStyle(el).color),
    );
    expect(await code.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(
      true,
    );
    await code.evaluate((el) => (el.scrollLeft = el.scrollWidth));
    expect(await code.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    const plain = history.locator("pre.th-code--plaintext code");
    await expect(plain).toHaveCount(2);
    for (const block of await plain.all())
      await expect(block).toHaveText(unknown);
    await expect(plain.locator("span")).toHaveCount(0);
    await expect(
      history.locator("script, pre .katex, pre .mermaid-svg"),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as Window & { codeInjected?: boolean }).codeInjected,
      ),
    ).toBeUndefined();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `../.scratch/flickgrove-rich/${width}-highlight-history.png`,
    });
    await page.request.post(origin + "/fixture/history-live", {
      data: {
        id,
        input: "```python\ndef answer():\n    return 42\n```",
        text: '```json\n{"ready": true}\n```',
        report: "Shared report\n\n" + text + "\n\n[Worker chart](plot.png)",
      },
    });
    await expect(page.locator(".user-message .th-keyword").first()).toHaveText(
      "def",
    );
    await expect(
      page.locator('[data-message-id="live-item"] .th-property'),
    ).toHaveText('"ready"');
    const report = page.locator(".worker-report");
    await report.locator("summary").click();
    await expect(report.locator(".mermaid-svg svg")).toBeVisible();
    await expect(report.locator(".katex")).toHaveCount(1);
    await expect(
      report.locator("pre.th-code").first().locator("code"),
    ).toHaveText(source);
    await expect(report.locator(".th-keyword").first()).toHaveText("const");
    await report.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `../.scratch/flickgrove-rich/${width}-highlight-report.png`,
    });
    await report.getByRole("link", { name: "Worker chart" }).click();
    await expect(page.locator(".file-preview img")).toBeVisible();
    await page.getByRole("button", { name: "Close preview" }).click();
    await expect(report.locator(".th-keyword").first()).toHaveText("const");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
}

test("virtual timeline recycles diagram rows without leaving temporary render DOM", async ({
  page,
}) => {
  await page.request.post(origin + "/fixture/reset");
  const { id } = await (
    await page.request.post(origin + "/fixture/history", {
      data: { title: "Recycled diagrams", count: 20, text: diagram },
    })
  ).json();
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Open Recycled diagrams Orc", exact: true })
    .click();
  const transcript = page.locator(".conversation");
  await expect(
    transcript.locator('[data-message-id="history-19"] .mermaid-svg svg'),
  ).toBeVisible();
  await expect
    .poll(() =>
      transcript.evaluate(
        (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
      ),
    )
    .toBeLessThanOrEqual(1);
  await transcript.evaluate((el) => (el.scrollTop = 0));
  await expect(
    transcript.locator('[data-message-id="history-0"] .mermaid-svg svg'),
  ).toBeVisible();
  await expect(
    transcript.locator('[data-message-id="history-19"]'),
  ).toHaveCount(0);
  await expect
    .poll(() => transcript.locator(".mermaid-status").count())
    .toBe(0);
  const anchor = await transcript
    .locator('[data-message-id="history-0"]')
    .evaluate((el) => el.getBoundingClientRect().top);
  await page.request.post(origin + "/fixture/history-live", {
    data: { id, text: diagram },
  });
  await expect
    .poll(async () =>
      Math.abs(
        (await transcript
          .locator('[data-message-id="history-0"]')
          .evaluate((el) => el.getBoundingClientRect().top)) - anchor,
      ),
    )
    .toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Jump to bottom" }).click();
  await expect(
    transcript.locator('[data-message-id="live-item"] .mermaid-svg svg'),
  ).toBeVisible();
  await expect
    .poll(() => transcript.locator(".mermaid-status").count())
    .toBe(0);
  expect(
    await transcript.locator(".timeline-message").count(),
  ).toBeLessThanOrEqual(14);
  await expect(
    page.locator(".mermaid-staging > *, body > [id^='dgrove-diagram-']"),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Open Local reports Orc", exact: true })
    .click();
  await expect(page.locator(".mermaid-staging")).toHaveCount(0);
});
