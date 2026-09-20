#!/usr/bin/env bun
/** Direct utterlog picker/reader transplants wired only to official app-server. */
import { createConversationReader, createTerminalRenderer } from "./reader";
import { pickSession, type PickerState } from "./picker";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { createHerdrReporter } from "./herdr";
import { discoverSessions } from "./discovery";
import type { NamedSession, TranscriptMessage } from "./types";

const noWatch = () => ({ close() {} });
const NEW = "zencodex:new";

function bar(total?: number, max?: number): string {
  if (typeof total !== "number" || typeof max !== "number" || max <= 0)
    return "context unavailable";
  const ratio = Math.min(1, total / max);
  const filled = Math.round(ratio * 12);
  return `context [${"█".repeat(filled)}${"░".repeat(12 - filled)}] ${Math.round(ratio * 100)}% (${total}/${max})`;
}
function clock(ms?: number): string {
  return ms === undefined
    ? ""
    : `working ${Math.floor(ms / 60000)}m${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}s`;
}
function toTranscript(conversation: ReaderConversation): TranscriptMessage[] {
  return conversation.visible.map((message) => ({
    role: message.role,
    body: message.body,
    timestampLabel: message.timestamp,
    workedMs: message.workedMs,
  }));
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const renderer = await createTerminalRenderer();
  const picker: PickerState = { query: "" };
  try {
    while (!renderer.isDestroyed) {
      const sessions = await discoverSessions(cwd);
      const choice = await pickSession(
        renderer,
        [
          ...sessions,
          {
            id: NEW,
            name: "+ New session",
            cwd,
            path: NEW,
            activityMs: Number.MAX_SAFE_INTEGER,
          },
        ],
        cwd,
        picker,
      );
      if (!choice) break;
      const server = await connect(cwd);
      const threadId =
        choice.id === NEW ? await server.startThread() : choice.id;
      if (choice.id !== NEW) await server.resumeThread(threadId);
      const selected =
        choice.id === NEW
          ? { ...choice, id: threadId, name: "New session", path: threadId }
          : choice;
      const conversation = new ReaderConversation(
        server,
        threadId,
        createHerdrReporter(),
      );
      await conversation.loadHistory();
      let reader:
        | Awaited<ReturnType<typeof createConversationReader>>
        | undefined;
      const project = () => reader?.project(toTranscript(conversation));
      reader = await createConversationReader({
        session: selected,
        messages: toTranscript(conversation),
        load: async () => toTranscript(conversation),
        renderer,
        ownsRenderer: false,
        watchFactory: noWatch,
        onSubmit: async (input) => {
          const submitted = conversation.submit(input);
          reader?.project(
            toTranscript(conversation),
            conversation.consumeReadingOrigin(),
          );
          await submitted;
          project();
        },
        onInterrupt: () => {
          if (!conversation.activeTurnId) return false;
          void conversation.interrupt();
          return true;
        },
        footerInfo: () =>
          `${bar(conversation.tokenUsage?.last?.totalTokens, conversation.tokenUsage?.modelContextWindow)} · ${clock(conversation.workingDurationMs()) || conversation.status}`,
      });
      reader.start();
      const ticker = setInterval(project, 200);
      const exit = await reader.waitForExit();
      clearInterval(ticker);
      reader.dispose();
      await conversation.close();
      if (exit === "quit") break;
    }
  } finally {
    if (!renderer.isDestroyed) renderer.destroy();
  }
}
void main();
