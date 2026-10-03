import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { createHandler, createUpgrade } from "../server/http";
import { groveWebsocket } from "../server/chord-socket";
import { FakeRuntime, fixtureProjects } from "../server/testing";
const directory = mkdtempSync(join(tmpdir(), "flickgrove-browser-"));
const runtime = new FakeRuntime();
for (const [threadId, title, preview, archived] of [
  [
    "history-reader",
    "Previous reader task",
    "Investigate slow scrolling",
    false,
  ],
  ["history-archived", "Archived reader task", "Earlier archived work", true],
  [
    "history-locked",
    "Session open in CLI",
    "Another instance owns this session",
    false,
  ],
] as const) {
  runtime.historySessions.set(threadId, {
    threadId,
    title,
    preview,
    cwd: fixtureProjects[0].path,
    role: "session",
    archived,
    source: "cli",
    updatedAt: 1000,
    model: "sol",
    effort: "medium",
  });
  runtime.names.set(threadId, title);
  runtime.historyItems.set(threadId, [
    { id: threadId + "-user", role: "user", text: preview, at: 1 },
    {
      id: threadId + "-assistant",
      role: "assistant",
      text: "Previous result preserved in Codex.",
      at: 2,
    },
  ]);
}
runtime.lockedThreads.add("history-locked");
const app = new Workspace({
  directory,
  runtime,
  projects: async () => fixtureProjects,
});
let turn = 0;
runtime.sendOverride = async (id, text) => {
  const turnId = `turn-${++turn}`;
  runtime.emit(id, { type: "working", turnId });
  setTimeout(
    async () => {
      const agent = runtime.agents.get(id)!;
      let result = "Received.";
      if (text === "Build a reader") {
        await app.tool(agent.token, "worker_start", {
          project: "alpha",
          title: "Reader",
          spec: "fixture spec",
          message: "Build a reader",
        });
        result = "The reader is ready.";
      } else if (text === "Start a long Worker") {
        await app.tool(agent.token, "worker_start", {
          project: "alpha",
          title: "Long Reader",
          spec: "fixture",
          message: "Wait for explicit completion",
        });
        result = "Long Worker started.";
      } else if (
        agent.role === "worker" &&
        text.endsWith("\n\nWait for explicit completion")
      ) {
        return;
      } else if (text === "Finish the long Worker") {
        const worker = app.snapshot().agents.find((a) => a.ownerId === id)!;
        await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
          message: "Long Worker final report",
        });
        runtime.emit(worker.id, {
          type: "completed",
          turnId: app.detail(worker.id).turnId!,
          status: "completed",
        });
        result = "Long Worker finished.";
      } else if (text === "Request Worker report") {
        const worker = app.snapshot().agents.find((a) => a.ownerId === id)!;
        await app.tool(runtime.agents.get(worker.id)!.token, "worker_report", {
          message:
            "Implementation complete.\n\n**Full diagnostic details.**\n\nThe report preserves its complete content.",
        });
        result = "Report received.";
      } else if (text === "Close the workers") {
        for (const worker of app
          .snapshot()
          .agents.filter((a) => a.ownerId === id))
          await app.tool(agent.token, "worker_close", { workerId: worker.id });
        result = "Workers are closed.";
      } else if (text === "Show Markdown") {
        result =
          "# Reader notes\n\n**Ready** with `safe code`.\n\n[Documentation](https://example.com/docs)\n\n[Unsafe](javascript:alert(1))\n\n<script>window.injected = true</script>";
      } else if (text === "Ask me questions") {
        runtime.emit(id, {
          type: "item",
          turnId,
          item: {
            id: `questions-${turnId}`,
            type: "agentMessage",
            delivery: "async",
            questions: Array.from({ length: 8 }, (_, i) => ({
              question: `Question ${i + 1}`,
              options: [
                { label: "Recommended choice" },
                { label: "Alternative choice" },
              ],
            })),
          },
        });
      }
      runtime.emit(id, {
        type: "item",
        turnId,
        item: {
          id: `final-${turnId}`,
          type: "agentMessage",
          phase: "final_answer",
          text:
            agent.role === "worker"
              ? "Reader implementation complete."
              : result,
        },
      });
      runtime.emit(id, { type: "completed", turnId, status: "completed" });
    },
    text === "Build a reader" && runtime.agents.get(id)?.role === "worker"
      ? 10
      : 50,
  );
  return turnId;
};
const service = new HostService(app, {
  directory,
  hub: true,
  name: "NUC",
  origin: () => "http://127.0.0.1:14318",
});
const handler = createHandler(app, {
  origin: () => "http://127.0.0.1:14318",
  service,
  assets: resolve("dist"),
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14318,
  idleTimeout: 0,
  websocket: groveWebsocket,
  async fetch(request, server) {
    const upgraded = createUpgrade(app, {
      service,
      origin: () => "http://127.0.0.1:14318",
    })(request, server);
    if (upgraded) return upgraded === true ? undefined : upgraded;
    if (
      request.method === "POST" &&
      new URL(request.url).pathname === "/fixture/history-continuation"
    ) {
      const { id } = (await request.json()) as { id: string };
      const detail = app.detail(id.slice(service.identity.id.length + 1));
      const threadId = detail.threadId!;
      runtime.names.set(threadId, "Restored report task");
      runtime.historySessions.get(threadId)!.title = "Restored report task";
      runtime.historyItems.set(threadId, [
        ...detail.messages.map((message) => ({
          ...message,
          id: message.role === "user" ? `native-${message.id}` : message.id,
        })),
        ...Array.from({ length: 31 }, (_, i) => ({
          id: `external-${threadId}-${i}`,
          turnId: `external-turn-${i}`,
          role: "assistant" as const,
          text: `CLI continuation ${i}`,
          at: Date.now() + i,
        })),
      ]);
      return Response.json({ threadId });
    }
    return handler(request);
  },
});
function cleanup() {
  server.stop(true);
  service.dispose();
  app.dispose();
  rmSync(directory, { recursive: true, force: true });
  process.exit();
}
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
