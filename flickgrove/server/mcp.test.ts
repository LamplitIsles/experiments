import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { HostService } from "./hosts";
import { createHandler } from "./http";

test("a real stdio MCP client discovers role tools and delegates through the authenticated bridge", async () => {
  const directory = mkdtempSync(join(tmpdir(), "flickgrove-mcp-"));
  const runtime = new FakeRuntime();
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    researcherSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "Synthetic research scope",
    }),
    reviewerSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "Synthetic Reviewer scope",
    }),
  });
  let origin = "";
  const http = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHandler(app, {
      origin: () => origin,
      service: new HostService(app, {
        directory,

        origin: () => origin,
      }),
    }),
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
      "researcher_start",
      "researcher_list",
      "researcher_read",
      "researcher_send",
      "researcher_close",
      "worker_start",
      "worker_list",
      "worker_read",
      "worker_send",
      "worker_close",
      "reviewer_start",
      "reviewer_list",
      "reviewer_read",
      "reviewer_send",
      "reviewer_close",
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
    const research = await client.callTool({
      name: "researcher_start",
      arguments: {
        project: "beta",
        title: "Evidence",
        question: "Which fact is verified?",
        message: "Read primary evidence",
      },
    });
    expect(research.isError).not.toBe(true);
    const researcher = JSON.parse(
      (research.content as { text: string }[])[0].text,
    ) as { id: string };
    const researcherClient = await connect(
      runtime.agents.get(researcher.id)!.token,
    );
    expect(
      (await researcherClient.listTools()).tools.map((t) => t.name),
    ).toEqual(["researcher_report"]);
    const evidence = await researcherClient.callTool({
      name: "researcher_report",
      arguments: {
        question: "Which fact is verified?",
        message: "Verified fact and source; unknown.",
      },
    });
    expect(evidence.isError).not.toBe(true);
    expect(app.detail(orc.id).deliveries.at(-1)).toMatchObject({
      source: "researcher",
      reportingResearcherId: researcher.id,
      researchQuestion: "Which fact is verified?",
    });
    const target = { spec: "#3573", fixedPoint: "base", reviewedHead: "head" };
    const review = await client.callTool({
      name: "reviewer_start",
      arguments: {
        ...target,
        project: "alpha",
        profile: "standards",
        title: "Standards",
        message: "Read branch",
      },
    });
    expect(review.isError).not.toBe(true);
    const reviewer = JSON.parse(
      (review.content as { text: string }[])[0].text,
    ) as { id: string };
    const reviewerClient = await connect(
      runtime.agents.get(reviewer.id)!.token,
    );
    expect((await reviewerClient.listTools()).tools.map((t) => t.name)).toEqual(
      ["reviewer_report"],
    );
    const conclusion = await reviewerClient.callTool({
      name: "reviewer_report",
      arguments: { ...target, message: "PASS with supplied evidence" },
    });
    expect(conclusion.isError).not.toBe(true);
    expect(app.detail(orc.id).deliveries.at(-1)).toMatchObject({
      source: "reviewer",
      reportingReviewerId: reviewer.id,
      reviewTarget: { ...target, profile: "standards" },
    });
    expect(
      (
        await client.callTool({
          name: "worker_read",
          arguments: { workerId: reviewer.id },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await http.stop(true);
    app.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});
