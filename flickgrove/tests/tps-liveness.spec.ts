import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

test("B selected behind slow valid A reaches its own completed result without Refresh or remount", async ({
  page,
}) => {
  test.setTimeout(55000);
  const start = Date.now();
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open Fast fixture Orc", exact: true })
    .click();
  await page.getByRole("button", { name: "Weekly usage", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/fixture/info")).json()).diagnostics
          .tasks,
    )
    .toBe(1);
  await page
    .getByRole("button", { name: "Open Standard fixture Orc", exact: true })
    .click();
  await page.getByRole("button", { name: "Weekly usage", exact: true }).click();
  await expect(page.locator(".output-speed dd")).toHaveText(["—", "—", "—"]);
  // Actual production deadlines: A 18s < 20s, then B 18s < 20s.
  // Wait past both, without further selection, refresh or remount.
  await page.waitForTimeout(38000);
  const backend = await (await page.request.get("/fixture/result")).json();
  const info = await (await page.request.get("/fixture/info")).json();
  const reads = info.tpsReads.map((r: any) => ({
    ms: r.at - start,
    tier: r.tier,
    status: r.status,
  }));
  console.log(
    JSON.stringify({
      elapsed: Date.now() - start,
      backend,
      starts: info.diagnostics.starts,
      tasks: info.diagnostics.tasks,
      sends: info.inputs.length,
      reads,
    }),
  );
  await page.screenshot({
    path: resolve("../.scratch/codex-tps-workspace/liveness.png"),
  });
  expect(backend.status).toBe("ready");
  expect(info.diagnostics.starts).toBe(1);
  expect(info.diagnostics.tasks).toBe(2);
  expect(info.inputs).toHaveLength(0);
  await expect(page.locator(".output-speed dd")).toHaveText([
    "22.0",
    "22.0",
    "22.0",
  ]);
});

test("exhausted finite polling surfaces unavailable and stops without an extra send", async ({
  page,
}) => {
  test.setTimeout(30000);
  await page.request.post("/fixture/control", { data: { forceLoading: true } });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto("/");
  await page
    .getByRole("button", { name: "Open Empty fixture Orc", exact: true })
    .click();
  const before = await (await page.request.get("/fixture/info")).json();
  await page.getByRole("button", { name: "Weekly usage", exact: true }).click();
  for (let i = 1; i <= 90; i++) {
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/fixture/info")).json()).tpsReads
            .length,
      )
      .toBe(before.tpsReads.length + i);
    await page.clock.runFor(500);
  }
  await expect(page.locator(".output-speed dl > div").first()).toHaveAttribute(
    "title",
    /unavailable/,
  );
  await expect(page.locator(".output-speed dd")).toHaveText(["—", "—", "—"]);
  const exhausted = await (await page.request.get("/fixture/info")).json();
  await page.clock.runFor(10000);
  const after = await (await page.request.get("/fixture/info")).json();
  expect(after.tpsReads.length).toBe(exhausted.tpsReads.length);
  expect(after.inputs).toHaveLength(0);
  console.log(
    JSON.stringify({
      polls: after.tpsReads.length - before.tpsReads.length,
      virtualMs: 55000,
      sends: after.inputs.length,
      unavailable: true,
    }),
  );
  await page.request.post("/fixture/control", {
    data: { forceLoading: false },
  });
});
