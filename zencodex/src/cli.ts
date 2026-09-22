#!/usr/bin/env bun
/** Direct utterlog picker/reader transplants wired only to official app-server. */
import { createConversationReader, createTerminalRenderer } from "./reader";
import { pickSession, type PickerState } from "./picker";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { createHerdrReporter } from "./herdr";
import { discoverSessions, latestTokenUsage } from "./discovery";
import { resumeAdmission } from "./admission";
import type { TranscriptMessage } from "./types";

const noWatch = () => ({ close() {} });
const NEW = "zencodex:new";

function bar(total?: number, max?: number): string {
  if (typeof total !== "number" || typeof max !== "number" || max <= 0)
    return "context unavailable";
  const ratio = Math.min(1, total / max);
  const filled = Math.round(ratio * 12);
  return `context ${"━".repeat(filled)}${"─".repeat(12 - filled)} ${Math.round(ratio * 100)}%`;
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
      let opened;
      try {
        opened =
          choice.id === NEW
            ? await server.startThread()
            : await server.resumeThread(choice.id);
      } catch (error) {
        await server.close();
        picker.notice = resumeAdmission(error);
        continue;
      }
      const threadId = opened.id;
      const selected =
        choice.id === NEW
          ? {
              ...choice,
              id: threadId,
              name: opened.name ?? "New session",
              path: threadId,
            }
          : { ...choice, name: opened.name ?? choice.name };
      picker.notice = undefined;
      let reportWarning = "";
      const conversation = new ReaderConversation(
        server,
        threadId,
        createHerdrReporter(process.env, undefined, (message) => {
          reportWarning = message;
        }),
      );
      conversation.setRuntime(opened);
      if (choice.id !== NEW)
        conversation.seedTokenUsage(await latestTokenUsage(choice.path));
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
        loadSkills: () => conversation.listSkills(cwd),
        skillsVersion: () => conversation.skillVersion,
        title: () => conversation.runtime.name,
        statusLines: () => ({
          cwd,
          runtime: [
            conversation.runtime.model ?? "model unavailable",
            conversation.runtime.effort,
          ]
            .filter(Boolean)
            .join(" · "),
          telemetry: [
            bar(
              conversation.tokenUsage?.last?.totalTokens,
              conversation.tokenUsage?.modelContextWindow,
            ),
            conversation.recoveryLabel() ||
              conversation.notice ||
              clock(conversation.workingDurationMs()),
            reportWarning,
          ]
            .filter(Boolean)
            .join(" · "),
        }),
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
