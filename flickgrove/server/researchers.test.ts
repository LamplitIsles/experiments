import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import { DeliveryRejected } from "./runtime";
import { HostService, qualify } from "./hosts";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket } from "./chord-socket";
import { openGrove } from "../src/chord-client";
import { socketWithHeaders } from "./socket-testing";
import { detailSchema } from "../src/chord-contract";
import type { Detail } from "../src/contracts";
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Researcher state did not settle");
}
async function peer() {
  const directory = await mkdtemp(join(tmpdir(), "grove-researcher-peer-"));
  let runtime = new FakeRuntime();
  let prompt = "Initial research scope",
    model = "sol",
    effort = "high";
  const make = () =>
    new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      researcherSnapshot: async () => ({
        model,
        effort,
        prompt,
      }),
      reviewerSnapshot: async () => ({
        model: "sol",
        effort: "high",
        prompt: "Review scope",
      }),
    });
  let app = make(),
    origin = "";
  let service = new HostService(app, { directory, origin: () => origin });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    websocket: groveWebsocket,
    fetch(req, server) {
      const options = { service, origin: () => origin };
      const upgrade = createUpgrade(app, options)(req, server);
      return upgrade === true
        ? undefined
        : (upgrade ?? createHandler(app, options)(req));
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  const client = await openGrove(
    socketWithHeaders(origin.replace("http:", "ws:") + "/api/socket", {
      Origin: origin,
    }),
    () => {},
    () => {},
  );
  return {
    get app() {
      return app;
    },
    get runtime() {
      return runtime;
    },
    get service() {
      return service;
    },
    client,
    configure(value: string) {
      prompt = value;
      model = "luna";
      effort = "low";
    },
    restart() {
      service.dispose();
      app.dispose();
      runtime = new FakeRuntime();
      app = make();
      service = new HostService(app, { directory, origin: () => origin });
    },
    async close() {
      client.close();
      await server.stop(true);
      service.dispose();
      app.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("Researcher survives two real Peer/Chord boundaries, async questions/reports, immutable capture and guarded release/restart without replay", async () => {
  const a = await peer(),
    b = await peer();
  const start = {
    project: "beta",
    title: "Native gates",
    question: "Which supported override disables model-aware collaboration?",
    message: "Read primary documentation; return evidence and unknowns.",
  };
  try {
    const owner = await a.app.createOrc("alpha"),
      stranger = await a.app.createOrc("beta"),
      remote = await b.app.createOrc("alpha");
    const token = a.runtime.agents.get(owner.id)!.token;
    const r = (await a.app.tool(token, "researcher_start", start)) as Detail;
    const other = (await a.app.tool(token, "researcher_start", {
      ...start,
      title: "Another question",
      question: "What is the persistence boundary?",
    })) as Detail;
    const rt = a.runtime.agents.get(r.id)!.token;
    const id = qualify(a.service.identity.id, r.id);
    expect(r).toMatchObject({
      role: "researcher",
      ownerId: owner.id,
      researchQuestion: start.question,
      model: "sol",
      effort: "high",
    });
    expect(r.reviewTarget).toBeUndefined();
    expect(r.threadId).not.toBe(other.threadId);
    expect(a.app.identity(rt).tools).toEqual(["researcher_report"]);
    for (const name of ["worker_report", "reviewer_report", "researcher_start"])
      await expect(a.app.tool(rt, name, {})).rejects.toThrow("role");
    expect(await a.app.tool(token, "worker_list", {})).toEqual([]);
    expect(await a.app.tool(token, "reviewer_list", {})).toEqual([]);
    expect(
      ((await a.app.tool(token, "researcher_list", {})) as Detail[]).map(
        (r) => r.id,
      ),
    ).toEqual([r.id, other.id]);
    for (const [name, args] of [
      ["worker_read", { workerId: r.id }],
      [
        "reviewer_send",
        {
          reviewerId: r.id,
          spec: "s",
          fixedPoint: "b",
          reviewedHead: "h",
          message: "wrong",
        },
      ],
    ] as const)
      await expect(a.app.tool(token, name, args)).rejects.toThrow("belong");
    await expect(
      a.app.tool(a.runtime.agents.get(stranger.id)!.token, "researcher_read", {
        researcherId: r.id,
      }),
    ).rejects.toThrow("belong");
    await expect(
      b.app.tool(b.runtime.agents.get(remote.id)!.token, "researcher_read", {
        researcherId: r.id,
      }),
    ).rejects.toThrow("not found");
    await expect(b.client.call("detail", { id })).rejects.toThrow();
    const read = detailSchema.parse(await a.client.call("detail", { id }));
    expect(read.researchQuestion).toBe(start.question);
    expect(read).not.toHaveProperty("researcherSnapshot");
    await expect(
      a.client.call("send", { id, text: "direct", operationId: "direct" }),
    ).rejects.toThrow("Orc");
    await expect(
      a.client.call("updateSettings", { id, model: "luna", effort: "low" }),
    ).rejects.toThrow("profile");
    await expect(
      a.app.tool(rt, "researcher_report", {
        question: "wrong task",
        message: "evidence",
      }),
    ).rejects.toThrow("question");
    const hold = Promise.withResolvers<string>();
    a.runtime.sendOverride = async (agentId, _text, turn) =>
      agentId === owner.id ? hold.promise : turn!;
    const reporting = a.app.tool(rt, "researcher_report", {
      question: start.question,
      message:
        "Verified fact [source](https://example.org); interpretation, conflict and unknown.",
    });
    await until(
      () => a.app.detail(owner.id).deliveries.at(-1)?.source === "researcher",
    );
    // Slow report delivery leaves unrelated Orc and other Peer usable.
    await a.app.tool(token, "researcher_send", {
      researcherId: other.id,
      message: "Bound the evidence",
    });
    await b.client.call("detail", {
      id: qualify(b.service.identity.id, remote.id),
    });
    hold.resolve("owner-turn");
    await reporting;
    a.runtime.sendOverride = undefined;
    const report = detailSchema
      .parse(
        await a.client.call("detail", {
          id: qualify(a.service.identity.id, owner.id),
        }),
      )
      .deliveries.at(-1)!;
    expect(report).toMatchObject({
      source: "researcher",
      reportingResearcherId: id,
      researchQuestion: start.question,
    });
    expect(report.reviewTarget).toBeUndefined();
    a.configure("New research scope");
    const fresh = (await a.app.tool(
      token,
      "researcher_start",
      start,
    )) as Detail;
    expect(a.runtime.agents.get(fresh.id)!.researcherSnapshot).toEqual({
      model: "luna",
      effort: "low",
      prompt: "New research scope",
    });
    await a.app.tool(token, "researcher_send", {
      researcherId: r.id,
      message: "Follow up the same question",
    });
    expect(a.runtime.agents.get(r.id)!.researcherSnapshot?.prompt).toBe(
      "Initial research scope",
    );
    a.runtime.emit(r.id, {
      type: "item",
      turnId: a.app.detail(r.id).turnId!,
      item: {
        id: "rq",
        type: "agentMessage",
        delivery: "async",
        text: "Need framing",
        questions: [{ question: "Which installed version?" }],
      },
    });
    await until(() =>
      a.app
        .detail(owner.id)
        .deliveries.some((d) => d.text.includes("Which installed version?")),
    );
    expect(a.app.detail(r.id).questions[0].state).toBe("delegated");
    expect(
      await a.app.tool(token, "researcher_close", { researcherId: r.id }),
    ).toMatchObject({ closing: true });
    await expect(
      a.app.tool(token, "researcher_send", {
        researcherId: r.id,
        message: "New task",
      }),
    ).rejects.toThrow("closure");
    await a.app.tool(token, "researcher_send", {
      researcherId: r.id,
      message: "Installed version only",
      questionIds: ["rq:0"],
    });
    a.runtime.closeOverride = async (agentId) => {
      if (agentId === r.id) throw new Error("fixture release timeout");
    };
    a.runtime.emit(r.id, {
      type: "completed",
      turnId: a.app.detail(r.id).turnId!,
      status: "completed",
    });
    await until(
      () =>
        a.app
          .detail(r.id)
          .closeRequest?.reason.includes("fixture release timeout") ?? false,
    );
    expect(a.app.detail(r.id).closed).toBe(false);
    a.runtime.closeOverride = undefined;
    expect(
      await a.app.tool(token, "researcher_close", { researcherId: r.id }),
    ).toMatchObject({ closed: true, researcherId: r.id });
    expect(a.app.detail(other.id).closed).toBe(false);
    // A rejected report keeps real release guarded until explicit retry.
    a.runtime.sendOverride = async () => {
      throw new DeliveryRejected("fixture rejected report");
    };
    await a.app.tool(
      a.runtime.agents.get(other.id)!.token,
      "researcher_report",
      { question: other.researchQuestion, message: "Rejected evidence" },
    );
    expect(a.app.detail(owner.id).deliveries.at(-1)?.status).toBe("failed");
    a.runtime.emit(other.id, {
      type: "completed",
      turnId: a.app.detail(other.id).turnId!,
      status: "completed",
    });
    expect(
      await a.app.tool(token, "researcher_close", { researcherId: other.id }),
    ).toMatchObject({ closing: true });
    expect(a.app.detail(other.id).closeRequest?.reason).toContain(
      "report delivery",
    );
    a.runtime.sendOverride = undefined;
    await a.client.call("retryDelivery", {
      id: qualify(a.service.identity.id, owner.id),
      deliveryId: a.app.detail(owner.id).deliveries.at(-1)!.id,
    });
    await until(() => !a.app.snapshot().agents.some((r) => r.id === other.id));
    a.runtime.sendOverride = async () => {
      throw new Error("Admission unknown");
    };
    await a.app.tool(token, "researcher_send", {
      researcherId: fresh.id,
      message: "Unconfirmed follow-up",
    });
    const originalThread = fresh.threadId;
    a.restart();
    await until(() => a.runtime.agents.has(fresh.id));
    expect(a.runtime.inputs).toHaveLength(0);
    expect(a.app.detail(fresh.id)).toMatchObject({
      role: "researcher",
      ownerId: owner.id,
      threadId: originalThread,
      researchQuestion: start.question,
      state: "error",
    });
    expect(a.runtime.agents.get(fresh.id)!.researcherSnapshot).toEqual({
      model: "luna",
      effort: "low",
      prompt: "New research scope",
    });
    expect(
      a.app
        .detail(owner.id)
        .deliveries.some((d) => d.reportingResearcherId === r.id),
    ).toBe(true);
    const history = await a.app.history("beta", "");
    expect(history.sessions.find((s) => s.agentId === fresh.id)).toMatchObject({
      role: "researcher",
      ownerThreadId: owner.threadId,
      ownerProject: "alpha",
    });
    await expect(a.app.closeTree(owner.id)).rejects.toThrow("Researchers");
    expect(
      await a.app.tool(token, "researcher_close", {
        researcherId: fresh.id,
        confirmInterrupted: true,
      }),
    ).toMatchObject({ closing: true });
    expect(a.app.detail(fresh.id).closeRequest?.reason).toContain(
      "delivery confirmation",
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("unknown Researcher startup remains inspectable without implicit retry", async () => {
  const p = await peer();
  try {
    const owner = await p.app.createOrc("alpha"),
      token = p.runtime.agents.get(owner.id)!.token;
    const open = p.runtime.open.bind(p.runtime);
    let attempts = 0;
    p.runtime.open = async (agent, notify) => {
      if (agent.role === "researcher") {
        attempts++;
        throw new Error("Disconnected during creation");
      }
      return open(agent, notify);
    };
    const r = (await p.app.tool(token, "researcher_start", {
      project: "beta",
      title: "Unknown",
      question: "What happened?",
      message: "Inspect only",
    })) as Detail;
    expect(r).toMatchObject({
      role: "researcher",
      state: "error",
      closed: false,
    });
    await expect(
      p.app.tool(token, "researcher_send", {
        researcherId: r.id,
        message: "Retry",
      }),
    ).rejects.toThrow("startup is unconfirmed");
    expect(attempts).toBe(1);
    expect(p.runtime.inputs).toHaveLength(0);
  } finally {
    await p.close();
  }
});
