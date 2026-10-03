import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Workspace } from "../server/workspace";
import { HostService } from "../server/hosts";
import { createHandler } from "../server/http";
import { FakeRuntime, fixtureProjects } from "../server/testing";
const directory = mkdtempSync(join(tmpdir(), "flickgrove-browser-"));
const runtime = new FakeRuntime();
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
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 14318,
  idleTimeout: 0,
  fetch: createHandler(app, {
    origin: () => "http://127.0.0.1:14318",
    service,
    assets: resolve("dist"),
  }),
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
