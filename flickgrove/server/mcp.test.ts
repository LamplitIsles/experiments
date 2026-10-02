import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { createHandler } from "./http";

test("a real stdio MCP client discovers role tools and delegates through the authenticated bridge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flickgrove-mcp-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
  });
  let origin = "";
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHandler(app, { origin: () => origin }),
  });
  origin = `http://127.0.0.1:${http.port}`;
  const clients: Client[] = [];
  async function connect(token: string) {
    const client = new Client({ name: "flickgrove-test", version: "1" });
    clients.push(client);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("./mcp.ts", import.meta.url))],
        env: { FLICKGROVE_ORIGIN: origin, FLICKGROVE_AGENT_TOKEN: token },
      }),
    );
    return client;
  }
  try {
    const orc = await app.createOrc("alpha");
    const client = await connect(runtime.agents.get(orc.id)!.token);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
      "worker_start",
      "worker_list",
      "worker_read",
      "worker_send",
      "worker_close",
    ]);
    const result = await client.callTool({
      name: "worker_start",
      arguments: {
        project: "beta",
        title: "Reader",
        spec: "#3109",
        message: "Implement",
      },
    });
    expect(result.isError).not.toBe(true);
    const worker = JSON.parse(
      (result.content as { text: string }[])[0].text,
    ) as { id: string };
    const workerClient = await connect(runtime.agents.get(worker.id)!.token);
    expect((await workerClient.listTools()).tools.map((t) => t.name)).toEqual([
      "worker_report",
    ]);
    const report = await workerClient.callTool({
      name: "worker_report",
      arguments: { message: "Reader is ready" },
    });
    expect(report.isError).not.toBe(true);
    expect(app.detail(orc.id).messages.at(-1)?.text).toContain(
      "Reader is ready",
    );
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await http.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
