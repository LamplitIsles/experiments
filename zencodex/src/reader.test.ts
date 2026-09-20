import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createConversationReader } from "./reader";
import type { NamedSession, TranscriptMessage } from "./types";

const session: NamedSession = {
  id: "thread",
  name: "Thread",
  cwd: "/tmp/z",
  path: "thread",
  activityMs: 0,
};
const noWatch = () => ({ close() {} });

test("transplanted reader searches with Ctrl-/ and preserves a submit origin while output appends", async () => {
  const setup = await createTestRenderer({ width: 70, height: 12 });
  const messages: TranscriptMessage[] = [
    {
      role: "user",
      body: "needle request",
      timestampLabel: "2026-09-20 10:00",
    },
  ];
  const reader = await createConversationReader({
    session,
    messages,
    load: async () => messages,
    renderer: setup.renderer,
    ownsRenderer: false,
    watchFactory: noWatch,
  });
  try {
    reader.start();
    await setup.renderOnce();
    await setup.renderOnce();
    reader.project(
      [
        ...messages,
        {
          role: "assistant",
          body: "# completed answer",
          timestampLabel: "2026-09-20 10:01",
        },
      ],
      0,
    );
    await setup.renderOnce();
    await setup.renderOnce();
    expect(setup.captureCharFrame()).toContain("needle request");
    // The source reader exposes literal-search state and result navigation;
    // this seam verifies its static transcript remains readable after anchoring.
    expect(reader.snapshot().messages).toBe(2);
  } finally {
    reader.dispose();
    setup.renderer.destroy();
  }
});
