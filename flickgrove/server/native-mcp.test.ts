import { expect, test } from "bun:test";
import { CodexAppServerClient } from "@jaminzhou/codex-app-server-client";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { createHandler } from "./http";
import { FakeRuntime } from "./testing";
import { roleTools } from "./tools";

// Installed-native discovery/config and out-of-band MCP only. No provider turn.
test("installed shared native isolates all role tool catalogs and authenticated reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grove-native-mcp-"));
  const home = join(directory, "home"),
    codexHome = join(directory, "codex"),
    project = join(directory, "project");
  for (const path of [home, codexHome, project]) mkdirSync(path);
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => [{ alias: "alpha", name: "Alpha", path: project }],
    reviewerSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "Synthetic review",
    }),
    researcherSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "Synthetic research",
    }),
  });
  let origin = "";
  const service = new HostService(app, { directory, origin: () => origin });
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHandler(app, { service, origin: () => origin }),
  });
  origin = `http://127.0.0.1:${http.port}`;
  const client = new CodexAppServerClient({
    cwd: project,
    codexPath: "codex",
    clientInfo: {
      name: "grove-mcp-probe",
      title: "Grove MCP probe",
      version: "1",
    },
    capabilities: { experimentalApi: true },
    protocolValidation: "strict",
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_DATA_HOME: join(directory, "data"),
    },
  });
  try {
    const orc = await app.createOrc("alpha");
    const token = runtime.agents.get(orc.id)!.token;
    const target = { spec: "#3607", fixedPoint: "base", reviewedHead: "head" };
    await app.tool(token, "worker_start", {
      project: "alpha",
      title: "Worker",
      spec: "#3607",
      message: "Synthetic task",
    });
    await app.tool(token, "reviewer_start", {
      ...target,
      project: "alpha",
      title: "Reviewer",
      profile: "standards",
      message: "Synthetic review",
    });
    await app.tool(token, "researcher_start", {
      project: "alpha",
      title: "Researcher",
      question: "Synthetic question",
      message: "Synthetic research",
    });
    await client.connect();
    const threads = new Map<string, string>();
    for (const agent of runtime.agents.values()) {
      const thread = await client.threadStart({
        cwd: project,
        model: "gpt-6.1-sol",
        approvalPolicy: "never",
        sandbox:
          agent.role === "reviewer" || agent.role === "researcher"
            ? "read-only"
            : "danger-full-access",
        developerInstructions: "Synthetic role context",
        config: {
          "agents.enabled": false,
          "features.multi_agent": false,
          "features.multi_agent_v2": false,
          "mcp_servers.flickgrove": {
            command: process.execPath,
            args: [fileURLToPath(new URL("./mcp.ts", import.meta.url))],
            env: {
              FLICKGROVE_ORIGIN: origin,
              FLICKGROVE_AGENT_TOKEN: agent.token,
            },
            enabled_tools: [...roleTools[agent.role]],
            tools: Object.fromEntries(
              roleTools[agent.role].map((name) => [
                name,
                { approval_mode: "approve" },
              ]),
            ),
          },
        },
        historyMode: "paginated",
      });
      threads.set(agent.id, thread.thread.id);
      const status = await client.call("mcpServerStatus/list", {
        threadId: thread.thread.id,
        detail: "toolsAndAuthOnly",
      });
      const grove = status.data.find((s) => s.name === "flickgrove")!;
      expect(grove.toolsError).toBeNull();
      expect(
        Object.values(grove.tools)
          .map((t) => t!.name)
          .sort(),
      ).toEqual([...roleTools[agent.role]].sort());
      for (const tool of Object.values(grove.tools))
        expect(tool?.annotations ?? {}).not.toMatchObject({
          readOnlyHint: true,
        });
    }
    // Re-read earlier threads after all same-name servers initialize: no role cache bleed.
    for (const agent of runtime.agents.values()) {
      const threadId = threads.get(agent.id)!;
      const status = await client.call("mcpServerStatus/list", {
        threadId,
        detail: "toolsAndAuthOnly",
      });
      expect(
        Object.values(status.data.find((s) => s.name === "flickgrove")!.tools)
          .map((t) => t!.name)
          .sort(),
      ).toEqual([...roleTools[agent.role]].sort());
      if (agent.role === "orc") continue;
      const args =
        agent.role === "reviewer"
          ? { ...target, message: "Synthetic report" }
          : agent.role === "researcher"
            ? { question: "Synthetic question", message: "Synthetic report" }
            : { message: "Synthetic report" };
      const result = await client.call("mcpServer/tool/call", {
        threadId,
        server: "flickgrove",
        tool: roleTools[agent.role][0],
        arguments: args,
      });
      expect(result.isError).not.toBe(true);
      expect(app.detail(orc.id).deliveries.at(-1)?.source).toBe(agent.role);
      if (agent.role === "reviewer") {
        const stale = await client.call("mcpServer/tool/call", {
          threadId,
          server: "flickgrove",
          tool: "reviewer_report",
          arguments: {
            ...target,
            reviewedHead: "stale",
            message: "Synthetic stale report",
          },
        });
        expect(stale.isError).toBe(true);
      }
    }
  } finally {
    await client.close();
    await http.stop(true);
    service.dispose();
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
