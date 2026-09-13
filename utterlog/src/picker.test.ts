import { expect, spyOn, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { Renderable } from "@opentui/core";
import { pickSession, type PickerState } from "./picker";
import type { NamedSession } from "./cli";

const sessions: NamedSession[] = Array.from({ length: 30 }, (_, index) => ({
  id: `session-${index}`, name: index < 2 ? "Same name" : `Topic ${index}`, cwd: "/fixture", path: `/fixture/${index}.jsonl`,
  activityMs: Date.parse("2026-09-12T12:00:00Z") - index * 60_000,
}));

async function render(setup: Awaited<ReturnType<typeof createTestRenderer>>) {
  for (let i = 0; i < 3; i++) await setup.renderOnce();
}

test("native picker navigates, filters names, recovers from no matches and selects full identities", async () => {
  const setup = await createTestRenderer({ width: 90, height: 10 });
  const state: PickerState = { query: "" };
  const result = pickSession(setup.renderer, sessions, "/fixture", state);
  const filter = async (query: string) => {
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText(query);
    setup.mockInput.pressEnter();
    await render(setup);
  };
  try {
    await render(setup);
    setup.mockInput.pressKey("G", { shift: true });
    await render(setup);
    expect(state.selectedId).toBe("session-29");
    expect(setup.captureCharFrame()).toContain("Topic 29");
    setup.mockInput.pressKey("g"); setup.mockInput.pressKey("g");
    setup.mockInput.pressKey("j");
    expect(state.selectedId).toBe("session-1");
    setup.mockInput.pressArrow("up");
    expect(state.selectedId).toBe("session-0");
    setup.mockInput.pressArrow("down");
    setup.mockInput.pressKey("k");
    expect(state.selectedId).toBe("session-0");
    await filter("no such name");
    expect(setup.captureCharFrame()).toContain("No matching sessions");
    setup.mockInput.pressEnter();
    await filter("SAME");
    expect(setup.captureCharFrame()).toContain("2/30 sessions");
    setup.mockInput.pressKey("/");
    await setup.mockInput.typeText("cancel this");
    setup.mockInput.pressEscape();
    await Bun.sleep(30);
    expect(state.query).toBe("SAME");
    await filter("");
    expect(setup.captureCharFrame()).toContain("30/30 sessions");
    await filter("same");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressEnter();
    expect((await result)?.id).toBe("session-1");
    expect(setup.renderer.isDestroyed).toBe(false);
    await render(setup);
    expect(setup.captureCharFrame()).not.toContain("Sessions ·");
  } finally {
    setup.renderer.destroy();
    await result;
  }
});

for (const exit of ["q", "ctrl-c", "destroy"] as const) {
  test(`native picker releases its view on ${exit}`, async () => {
    const setup = await createTestRenderer({ width: 80, height: 10 });
    const result = pickSession(setup.renderer, sessions, "/fixture", { query: "" });
    try {
      await render(setup);
      if (exit === "destroy") setup.renderer.destroy();
      else if (exit === "ctrl-c") { setup.mockInput.pressKey("/"); setup.mockInput.pressCtrlC(); }
      else setup.mockInput.pressKey("q");
      expect(await result).toBeUndefined();
      if (!setup.renderer.isDestroyed) {
        await render(setup);
        expect(setup.captureCharFrame()).not.toContain("Sessions ·");
      }
    } finally {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy();
    }
  });
}

test("distinguishes same-name same-minute sessions with colliding UUID prefixes", async () => {
  const setup = await createTestRenderer({ width: 100, height: 10 });
  const candidates = ["019eed3b-1111-7111-8111-111111111111", "019eed3b-2222-7222-8222-222222222222"]
    .map((id) => ({ ...sessions[0], id, name: "Same session" }));
  const result = pickSession(setup.renderer, candidates, "/fixture", { query: "" });
  try {
    await render(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Same session · 019eed3b-1");
    expect(frame).toContain("Same session · 019eed3b-2");
    setup.mockInput.pressKey("j");
    setup.mockInput.pressEnter();
    expect((await result)?.id).toBe(candidates[1].id);
  } finally {
    setup.renderer.destroy();
    await result;
  }
});

test("destroys the partially built picker when attaching its root fails", async () => {
  const setup = await createTestRenderer({ width: 80, height: 10 });
  let partial: Renderable | undefined;
  const add = spyOn(setup.renderer.root, "add").mockImplementation((child) => {
    partial = child as Renderable;
    throw new Error("synthetic attach failure");
  });
  try {
    await expect(pickSession(setup.renderer, sessions, "/fixture", { query: "" }))
      .rejects.toThrow("synthetic attach failure");
    expect(partial?.isDestroyed).toBe(true);
    expect(setup.renderer.isDestroyed).toBe(false);
    add.mockRestore();
    const next = pickSession(setup.renderer, sessions, "/fixture", { query: "" });
    await render(setup);
    setup.mockInput.pressKey("q");
    expect(await next).toBeUndefined();
  } finally {
    add.mockRestore();
    setup.renderer.destroy();
  }
});
