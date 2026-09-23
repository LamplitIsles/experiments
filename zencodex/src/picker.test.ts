import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { pickSession } from "./picker";

test("an empty resume list can be dismissed without a new-session entry", async () => {
  const setup = await createTestRenderer({ width: 80, height: 12 });
  try {
    const pending = pickSession(setup.renderer, [], "/test", { query: "" });
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("No matching sessions");
    await setup.mockInput.pressKey("q");
    expect(await pending).toBeUndefined();
  } finally {
    setup.renderer.destroy();
  }
});

test("picker tolerates finite activity values outside Date's representable range", async () => {
  const setup = await createTestRenderer({ width: 80, height: 12 });
  const pending = pickSession(
    setup.renderer,
    [
      {
        id: "thread",
        name: "Out of range",
        cwd: "/test",
        path: "thread",
        activityMs: Number.MAX_VALUE,
      },
    ],
    "/test",
    { query: "" },
  );
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("unknown time");
  setup.mockInput.pressKey("q");
  await pending;
  setup.renderer.destroy();
});
