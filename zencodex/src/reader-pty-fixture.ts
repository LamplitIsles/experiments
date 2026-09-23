/** Isolated PTY fixture. Never connects to Codex or reads user state. */
import { writeSync } from "node:fs";
import { createConversationReader, createTerminalRenderer } from "./reader";
import type { TranscriptMessage } from "./types";

const renderer = await createTerminalRenderer();
renderer.footerHeight = 7;
renderer.screenMode = "split-footer";
renderer.useMouse = false;
renderer.externalOutputMode = "capture-stdout";
const reader = await createConversationReader({
  renderer,
  session: {
    id: "fixture",
    name: "Fixture reader",
    cwd: "/fixture",
    path: "",
    activityMs: 0,
  },
  messages: [],
});
let messages: TranscriptMessage[] = [];
const mark = async (phase: string) => {
  await reader.waitForIdle();
  await renderer.idle();
  // Non-printing, test-owned acknowledgement ordered with terminal output.
  writeSync(2, `\x1b]777;zencodex-test:${phase}\x07`);
};
let pending = Promise.resolve();
process.on(
  "message",
  (command: { action: string; cols?: number; rows?: number }) => {
    pending = pending
      .then(async () => {
        if (command.action === "history") {
          messages = Array.from({ length: 40 }, (_, i) => ({
            role: "assistant",
            timestampLabel: "fixture",
            body: `HISTORY ${String(i).padStart(3, "0")}`,
          }));
          await reader.loadHistory(messages);
        } else if (command.action === "append") {
          messages = [
            ...messages,
            {
              role: "assistant",
              timestampLabel: "fixture",
              body: "NEW OUTPUT\n\n" + "additional line  \n".repeat(35),
            },
          ];
          reader.project(messages);
        } else if (command.action === "resize") {
          if (
            renderer.terminalWidth !== command.cols ||
            renderer.terminalHeight !== command.rows
          )
            await new Promise<void>((resolve) =>
              renderer.once("resize", () => resolve()),
            );
        } else if (command.action === "quit") {
          reader.dispose();
          renderer.destroy();
          process.exit(0);
        }
        await mark(command.action);
      })
      .catch((error) => {
        reader.dispose();
        renderer.destroy();
        console.error(error);
        process.exit(1);
      });
  },
);
await reader.start();
await mark("shell");
