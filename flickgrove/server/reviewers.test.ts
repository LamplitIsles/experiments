import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryRejected } from "./runtime";
import { Workspace } from "./workspace";
import { FakeRuntime, fixtureProjects } from "./testing";
import type { Detail } from "../src/contracts";
import { HostService, qualify } from "./hosts";
import { createHandler, createUpgrade } from "./http";
import { groveWebsocket } from "./chord-socket";
import { openGrove } from "../src/chord-client";
import { socketWithHeaders } from "./socket-testing";

async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Reviewer state did not settle");
}
test("Reviewer lifecycle crosses real Peer/Chord with target-bound reports, isolation, snapshot, unknown delivery and guarded native close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-reviewers-"));
  let runtime = new FakeRuntime();
  let prompt = "Original prompt";
  const make = () =>
    new Workspace({
      directory,
      runtime,
      projects: async () => fixtureProjects,
      reviewerSnapshot: async () => ({ model: "sol", effort: "high", prompt }),
    });
  let app = make();
  let origin = "";
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
  const start = {
    project: "beta",
    title: "Standards",
    profile: "standards",
    spec: "#3573",
    fixedPoint: "base",
    reviewedHead: "head1",
    message: "Read diff",
  };
  try {
    const orc = await app.createOrc("alpha");
    const other = await app.createOrc("beta");
    const token = runtime.agents.get(orc.id)!.token;
    const a = (await app.tool(token, "reviewer_start", start)) as Detail;
    const b = (await app.tool(token, "reviewer_start", {
      ...start,
      profile: "high_risk_spec",
      title: "Spec",
    })) as Detail;
    expect(a.role).toBe("reviewer");
    expect(a.threadId).not.toBe(b.threadId);
    expect(runtime.agents.get(a.id)!.reviewerSnapshot).toEqual({
      model: "sol",
      effort: "high",
      prompt,
    });
    expect(await app.tool(token, "worker_list", {})).toEqual([]);
    expect(
      ((await app.tool(token, "reviewer_list", {})) as Detail[]).map(
        (a) => a.id,
      ),
    ).toEqual([a.id, b.id]);
    const rt = runtime.agents.get(a.id)!.token;
    expect(app.identity(rt).tools).toEqual(["reviewer_report"]);
    await expect(
      app.tool(rt, "worker_report", { message: "wrong role" }),
    ).rejects.toThrow("role");
    await expect(
      app.tool(runtime.agents.get(other.id)!.token, "reviewer_read", {
        reviewerId: a.id,
      }),
    ).rejects.toThrow("belong");
    await expect(
      app.tool(token, "worker_read", { workerId: a.id }),
    ).rejects.toThrow("belong");
    const id = qualify(service.identity.id, a.id);
    const detail = await client.call<Detail>("detail", { id });
    expect(detail.reviewTarget?.reviewedHead).toBe("head1");
    await expect(
      client.call("send", { id, text: "direct", operationId: "direct" }),
    ).rejects.toThrow("Orc");
    await expect(
      client.call("updateSettings", { id, model: "luna", effort: "low" }),
    ).rejects.toThrow("profile");
    await expect(
      app.tool(rt, "reviewer_report", {
        message: "PASS",
        spec: "#3573",
        fixedPoint: "base",
        reviewedHead: "stale",
      }),
    ).rejects.toThrow("HEAD");
    await app.tool(rt, "reviewer_report", {
      message: "PASS head1",
      spec: "#3573",
      fixedPoint: "base",
      reviewedHead: "head1",
    });
    const report = (
      await client.call<Detail>("detail", {
        id: qualify(service.identity.id, orc.id),
      })
    ).deliveries.at(-1)!;
    expect(report).toMatchObject({
      source: "reviewer",
      reportingReviewerId: id,
      reviewTarget: {
        profile: "standards",
        reviewedHead: "head1",
        spec: "#3573",
        fixedPoint: "base",
      },
    });
    prompt = "New prompt";
    const c = (await app.tool(token, "reviewer_start", start)) as Detail;
    expect(runtime.agents.get(c.id)!.reviewerSnapshot?.prompt).toBe(prompt);
    const target = {
      reviewerId: a.id,
      spec: "#3573",
      fixedPoint: "base",
      reviewedHead: "head2",
      message: "Focused repair",
    };
    runtime.sendOverride = async () => {
      throw new DeliveryRejected("Explicit rejection");
    };
    const rejected = (await app.tool(token, "reviewer_send", target)) as Detail;
    expect(rejected.reviewTarget?.reviewedHead).toBe("head1");
    expect(app.detail(a.id).reviewTarget?.reviewedHead).toBe("head1");
    await expect(
      client.call("retryDelivery", {
        id,
        deliveryId: app.detail(a.id).deliveries.at(-1)!.id,
      }),
    ).rejects.toThrow("through Orc");
    runtime.sendOverride = undefined;
    await app.tool(token, "reviewer_send", target);
    expect(app.detail(a.id).reviewTarget?.reviewedHead).toBe("head2");
    expect(runtime.agents.get(a.id)!.reviewerSnapshot?.prompt).toBe(
      "Original prompt",
    );
    await expect(
      app.tool(rt, "reviewer_report", {
        message: "old PASS",
        spec: "#3573",
        fixedPoint: "base",
        reviewedHead: "head1",
      }),
    ).rejects.toThrow("HEAD");
    runtime.emit(a.id, {
      type: "item",
      turnId: app.detail(a.id).turnId!,
      item: {
        id: "question",
        type: "agentMessage",
        delivery: "async",
        text: "Need evidence",
        questions: [{ question: "Which evidence?" }],
      },
    });
    await until(() =>
      app
        .detail(orc.id)
        .deliveries.some((d) => d.text.includes("Which evidence?")),
    );
    expect(app.detail(a.id).questions[0].state).toBe("delegated");
    expect(
      await app.tool(token, "reviewer_close", { reviewerId: a.id }),
    ).toMatchObject({ closing: true });
    await expect(
      app.tool(token, "reviewer_send", { ...target, message: "new task" }),
    ).rejects.toThrow("only accepts");
    await app.tool(token, "reviewer_send", {
      ...target,
      message: "Use Worker evidence",
      questionIds: ["question:0"],
    });
    runtime.closeOverride = async (id) => {
      if (id === a.id) throw new Error("fixture release failure");
    };
    runtime.emit(a.id, {
      type: "completed",
      turnId: app.detail(a.id).turnId!,
      status: "completed",
    });
    await until(
      () =>
        app
          .detail(a.id)
          .closeRequest?.reason.includes("fixture release failure") ?? false,
    );
    runtime.closeOverride = undefined;
    expect(
      await app.tool(token, "reviewer_close", { reviewerId: a.id }),
    ).toMatchObject({ closed: true });
    expect(app.detail(b.id).closed).toBe(false);
    runtime.sendOverride = async () => {
      throw new Error("Admission unknown");
    };
    await app.tool(token, "reviewer_send", { ...target, reviewerId: b.id });
    expect(app.detail(b.id).deliveries.at(-1)?.status).toBe("uncertain");
    const oldRuntime = runtime;
    service.dispose();
    app.dispose();
    runtime = new FakeRuntime();
    app = make();
    service = new HostService(app, { directory, origin: () => origin });
    await until(() => runtime.agents.has(b.id));
    expect(runtime.inputs).toHaveLength(0);
    expect(app.detail(b.id)).toMatchObject({
      role: "reviewer",
      ownerId: orc.id,
      state: "error",
      reviewTarget: { reviewedHead: "head2" },
    });
    expect(runtime.agents.get(b.id)!.reviewerSnapshot?.prompt).toBe(
      "Original prompt",
    );
    expect(
      app
        .detail(orc.id)
        .deliveries.some(
          (d) =>
            d.reportingReviewerId === a.id &&
            d.reviewTarget?.reviewedHead === "head1",
        ),
    ).toBe(true);
    expect(oldRuntime.inputs.filter((i) => i.agentId === b.id)).toHaveLength(2);
    await expect(app.closeTree(orc.id)).rejects.toThrow("Reviewers");
    expect(
      await app.tool(token, "reviewer_close", {
        reviewerId: b.id,
        confirmInterrupted: true,
      }),
    ).toMatchObject({ closing: true });
    expect(app.detail(b.id).closeRequest?.reason).toContain(
      "delivery confirmation",
    );
  } finally {
    client.close();
    await server.stop(true);
    service.dispose();
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconfirmed Reviewer startup remains inspectable and cannot replay creation through send", async () => {
  const directory = await mkdtemp(join(tmpdir(), "grove-reviewer-start-"));
  const runtime = new FakeRuntime();
  const open = runtime.open.bind(runtime);
  let attempts = 0;
  runtime.open = async (agent, notify) => {
    if (agent.role === "reviewer") {
      attempts++;
      throw new Error("Native creation disconnected");
    }
    return open(agent, notify);
  };
  const app = new Workspace({
    directory,
    runtime,
    projects: async () => fixtureProjects,
    reviewerSnapshot: async () => ({
      model: "sol",
      effort: "high",
      prompt: "Snapshot",
    }),
  });
  const target = { spec: "#3573", fixedPoint: "base", reviewedHead: "head" };
  try {
    const owner = await app.createOrc("alpha");
    const token = runtime.agents.get(owner.id)!.token;
    const reviewer = (await app.tool(token, "reviewer_start", {
      ...target,
      project: "alpha",
      profile: "standards",
      title: "Standards",
      message: "Read branch",
    })) as Detail;
    expect(reviewer).toMatchObject({
      role: "reviewer",
      state: "error",
      closed: false,
    });
    expect(
      ((await app.tool(token, "reviewer_list", {})) as Detail[]).map(
        (a) => a.id,
      ),
    ).toEqual([reviewer.id]);
    await expect(
      app.tool(token, "reviewer_send", {
        ...target,
        reviewerId: reviewer.id,
        message: "Retry",
      }),
    ).rejects.toThrow("startup is unconfirmed");
    expect(attempts).toBe(1);
    expect(runtime.inputs).toHaveLength(0);
  } finally {
    app.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
