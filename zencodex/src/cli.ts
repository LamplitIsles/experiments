#!/usr/bin/env bun
/** Direct utterlog picker/reader transplants wired only to official app-server. */
import { createConversationReader, createTerminalRenderer } from "./reader";
import { pickSession, type PickerState } from "./picker";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { createHerdrReporter } from "./herdr";
import { discoverSessions, latestTokenUsage } from "./discovery";
import { resumeAdmission } from "./admission";
import type { NamedSession, TranscriptMessage } from "./types";
import {
  defaultTraceDirectory,
  fileExporter,
  noTrace,
  PerformanceTrace,
  type Trace,
} from "./tracing";

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

const defaults = {
  createTerminalRenderer,
  pickSession,
  connect,
  discoverSessions,
  createConversationReader,
  createHerdrReporter,
  waitFrame: (renderer: Awaited<ReturnType<typeof createTerminalRenderer>>) =>
    new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        renderer.off("frame", ready);
        renderer.off("destroy", destroyed);
      };
      const ready = () => {
        cleanup();
        resolve();
      };
      const destroyed = () => {
        cleanup();
        reject(new Error("Terminal closed before first frame"));
      };
      if (renderer.isDestroyed) {
        destroyed();
        return;
      }
      renderer.once("frame", ready);
      renderer.once("destroy", destroyed);
      renderer.requestRender();
    }),
};
const usage = "Usage: zencodex [--resume <thread-id>]";

export async function main(
  argv = process.argv.slice(2),
  overrides: Partial<typeof defaults> = {},
  performance: Trace = noTrace,
): Promise<void> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    console.log(usage);
    return;
  }
  let resumeId: string | undefined;
  if (argv.length) {
    if (
      argv.length !== 2 ||
      argv[0] !== "--resume" ||
      !argv[1]?.trim() ||
      argv[1].startsWith("-") ||
      /[\s\p{Cc}]/u.test(argv[1])
    )
      throw new Error(usage);
    resumeId = argv[1];
  }
  const {
    createTerminalRenderer,
    pickSession,
    connect,
    discoverSessions,
    createConversationReader,
    createHerdrReporter,
    waitFrame,
  } = { ...defaults, ...overrides };
  const cwd = process.cwd();
  const startup = performance.begin(
    resumeId ? "startup.direct_resume" : "startup.session_list",
    {
      mode: resumeId ? "resume" : "picker",
      "schema.version": 1,
      "startup.pre_instrumentation_ms": process.uptime() * 1000,
    },
    Date.now() - process.uptime() * 1000,
  );
  const renderer = await startup
    .run(() =>
      performance.measure("renderer.initialize", createTerminalRenderer),
    )
    .catch((error) => {
      startup.end("error");
      throw error;
    });
  const picker: PickerState = { query: "" };
  startup.span.setAttributes({
    width: renderer.width,
    height: renderer.height,
  });
  let firstList = true;
  try {
    while (!renderer.isDestroyed) {
      const listing = firstList
        ? startup
        : performance.begin("session_list.load");
      firstList = false;
      renderer.screenMode = "alternate-screen";
      const sessions = resumeId
        ? []
        : await listing.run(() =>
            performance.measure("sessions.discover", () =>
              discoverSessions(cwd, undefined, performance),
            ),
          );
      const choice: NamedSession | undefined = resumeId
        ? {
            id: resumeId,
            name: resumeId,
            cwd,
            path: "",
            activityMs: 0,
          }
        : await listing.run(() =>
            pickSession(
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
              0,
              () => {
                listing.end();
              },
              performance,
            ),
          );
      if (!choice) {
        listing.end("cancel");
        break;
      }
      if (!resumeId) listing.end();
      const beginLoading = () =>
        performance.begin("session.load", {
          mode: resumeId
            ? "direct_resume"
            : choice.id === NEW
              ? "new"
              : "selected",
        });
      const loading = resumeId ? startup.run(beginLoading) : beginLoading();
      const measure = <T>(name: string, fn: () => Promise<T> | T) =>
        loading.run(() => performance.measure(name, fn));
      const isNew = !resumeId && choice.id === NEW;
      const cancellation = new AbortController();
      let server: Awaited<ReturnType<typeof connect>> | undefined;
      let conversation: ReaderConversation | undefined;
      let reader:
        | Awaited<ReturnType<typeof createConversationReader>>
        | undefined;
      let preparing: Promise<void> | undefined;
      let ready = false;
      let phase = "Connecting backend · draft only";
      let reportWarning = "";
      const project = () =>
        reader?.project(conversation ? toTranscript(conversation) : []);
      // Attach rejection handling immediately: UI construction runs concurrently.
      const connection = measure("app_server.connect", () =>
        connect(cwd, undefined, { performance, signal: cancellation.signal }),
      ).then((connected) => {
        server = connected;
        return connected;
      });
      void connection.catch(() => {});
      try {
        reader = await measure("reader.construct", () =>
          createConversationReader({
            session: choice,
            messages: [],
            renderer,
            trace: performance,
            canSubmit: () => ready,
            hasEarlierHistory: () => conversation?.hasEarlierHistory() ?? false,
            loadEarlierHistory: async () => {
              await conversation!.loadEarlierHistory();
              return toTranscript(conversation!);
            },
            onQueue: async (input) => {
              if (!ready) return;
              await conversation!.queue(input);
              project();
            },
            onInterrupt: () => (ready ? conversation!.interrupt() : undefined),
            queuedInputs: () => conversation?.queuedInputs() ?? [],
            takeRestoredDraft: () => conversation?.takeRestoredDraft() ?? "",
            onSubmit: async (input) => {
              if (!ready) return;
              const submitted = conversation!.submit(input);
              project();
              await submitted;
              project();
            },
            loadSkills: () =>
              conversation?.listSkills(cwd) ?? Promise.resolve([]),
            skillsVersion: () =>
              conversation ? conversation.skillVersion + 1 : 0,
            title: () => conversation?.runtime.name,
            statusLines: () => ({
              cwd,
              runtime: [
                conversation?.runtime.model ?? "model unavailable",
                conversation?.runtime.effort,
              ]
                .filter(Boolean)
                .join(" · "),
              telemetry: !ready
                ? phase
                : [
                    bar(
                      conversation?.tokenUsage?.last?.totalTokens,
                      conversation?.tokenUsage?.modelContextWindow,
                    ),
                    conversation?.recoveryLabel() ||
                      conversation?.notice ||
                      clock(conversation?.workingDurationMs()),
                    reportWarning,
                  ]
                    .filter(Boolean)
                    .join(" · "),
            }),
          }),
        );
        await measure("reader.shell", () => reader!.start());
        await measure("reader.shell_first_frame", () => waitFrame(renderer));
        const exiting = reader.waitForExit();
        preparing = (async () => {
          const connected = await connection;
          cancellation.signal.throwIfAborted();
          phase = "Opening thread · draft only";
          project();
          const opened = await measure(
            isNew ? "thread.start" : "thread.resume",
            () =>
              isNew
                ? connected.startThread()
                : connected.resumeThread(choice.id),
          );
          cancellation.signal.throwIfAborted();
          conversation = new ReaderConversation(
            connected,
            opened.id,
            createHerdrReporter(process.env, undefined, (message) => {
              reportWarning = message;
            }),
          );
          conversation.performance = performance;
          conversation.setRuntime(opened);
          phase = "Loading history · draft only";
          project();
          if (!isNew && choice.path)
            conversation.seedTokenUsage(
              await measure("token_usage.seed", () =>
                latestTokenUsage(choice.path),
              ),
            );
          cancellation.signal.throwIfAborted();
          await measure("history.load", () =>
            conversation!.loadRecentHistory(),
          );
          cancellation.signal.throwIfAborted();
          await measure("reader.prepare", () =>
            reader!.loadHistory(toTranscript(conversation!)),
          );
          cancellation.signal.throwIfAborted();
          ready = true;
          project();
          await measure("reader.first_frame", () => waitFrame(renderer));
          loading.end();
          if (resumeId) startup.end();
        })();
        const result = await Promise.race([
          preparing.then(() => ({ kind: "ready" as const })),
          exiting.then((exit) => ({ kind: "exit" as const, exit })),
        ]);
        if (result.kind === "exit") {
          loading.end("cancel");
          if (result.exit === "quit" || resumeId) break;
          continue;
        }
        picker.notice = undefined;
        const ticker = setInterval(project, 200);
        try {
          const exit = await exiting;
          if (exit === "quit" || resumeId) break;
        } finally {
          clearInterval(ticker);
        }
      } catch (error) {
        loading.end("error");
        if (resumeId)
          throw new Error(
            `Cannot resume ${resumeId}: ${resumeAdmission(error)}`,
          );
        picker.notice = resumeAdmission(error);
      } finally {
        ready = false;
        cancellation.abort();
        reader?.dispose();
        await preparing?.catch(() => {});
        await connection.catch(() => {});
        loading.end("error");
        if (conversation) await conversation.close();
        else await server?.close();
      }
    }
  } catch (error) {
    startup.end("error");
    throw error;
  } finally {
    startup.end("cancel");
    if (!renderer.isDestroyed) renderer.destroy();
  }
}
if (import.meta.main) {
  const performance: Trace =
    process.env.ZENCODEX_TRACE === "0"
      ? noTrace
      : new PerformanceTrace(fileExporter(defaultTraceDirectory()));
  void main(undefined, undefined, performance)
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => performance.close());
}
