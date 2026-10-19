import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "./workspace";
import { HostService } from "./hosts";
import { FakeRuntime } from "./testing";
import { MixedRuntime } from "./mixed-runtime";
import { PiRuntime } from "./pi";
import { threadIdentity } from "./backend";
import {
  initializeReviewerConfig,
  reviewerSnapshot,
  researcherSnapshot,
} from "./reviewer-config";
import type { Agent } from "../src/contracts";
import type { RuntimeAgent, RuntimeEvent, RuntimeHandle } from "./runtime";

test("real Pi and Codex adapter form both mixed trees, with questions, reports, role snapshots and readonly restart", async () => {
  if (!process.env.GROVE_MIXED_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-mixed-home-"));
    try {
      const child = Bun.spawn([process.execPath, "test", import.meta.path], {
        env: {
          PATH: process.env.PATH,
          LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
          HOME: home,
          CODEX_HOME: join(home, "codex"),
          PI_CODING_AGENT_DIR: join(home, "agent"),
          PI_OFFLINE: "1",
          GROVE_MIXED_CHILD: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo"),
    directory = join(home, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const plans: ({ name: string; args: unknown } | undefined)[] = [];
  let requests = 0;
  let blocked = false,
    releaseBlocked!: () => void;
  let blocker = Promise.resolve();
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      const plan = plans.shift();
      requests++;
      if (blocked) await blocker;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      const delta = plan
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${requests}`,
                type: "function",
                function: {
                  name: plan.name,
                  arguments: JSON.stringify(plan.args),
                },
              },
            ],
          }
        : { role: "assistant", content: "Fixture settled" };
      return new Response(
        chunk(delta, null) +
          chunk({}, plan ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(join(agentDir, "auth.json"), "{}");
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "mixed-owned-key",
          models: [
            {
              id: "fake",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  const configured = JSON.parse(
    await readFile(join(agentDir, "models.json"), "utf8"),
  );
  configured.providers.alternate = {
    ...configured.providers.fixture,
    apiKey: "alternate-owned-key",
  };
  await writeFile(join(agentDir, "models.json"), JSON.stringify(configured));
  const captured = new Map<string, RuntimeAgent>();
  class CapturedPi extends PiRuntime {
    override async open(
      agent: RuntimeAgent,
      notify: (event: RuntimeEvent) => void,
    ): Promise<RuntimeHandle> {
      captured.set(agent.id, structuredClone(agent));
      return super.open(agent, notify);
    }
  }
  const codex = new FakeRuntime();
  let app: Workspace;
  const pi = new CapturedPi({
    agentDir,
    tool: (token, name, args) => app.tool(token, name, args),
  });
  const runtime = new MixedRuntime(codex, pi);
  const snapshot = {
    backend: "pi" as const,
    provider: "fixture",
    model: "fake",
    effort: "off",
    prompt: "Owned configured role prompt",
  };
  const configPath = join(home, "config", "config.toml");
  await initializeReviewerConfig(configPath);
  const config = (await readFile(configPath, "utf8"))
    .replaceAll('backend = "codex"', 'backend = "pi"\nprovider = "fixture"')
    .replace(/^model = .*$/gm, 'model = "fake"')
    .replace(/^reasoning_effort = .*$/gm, 'reasoning_effort = "off"');
  await writeFile(configPath, config);
  for (const role of [
    "standards",
    "spec",
    "high_risk_spec",
    "penpot",
    "researcher",
  ])
    await writeFile(
      join(home, "config", "prompts", role + ".md"),
      snapshot.prompt,
    );
  const options = {
    directory,
    runtime,
    projects: async () => [{ alias: "owned", name: "Owned", path: cwd }],
    reviewerSnapshot: (profile: Parameters<typeof reviewerSnapshot>[1]) =>
      reviewerSnapshot(configPath, profile),
    researcherSnapshot: () => researcherSnapshot(configPath),
  };
  app = new Workspace(options);
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 1000; i++) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw Error("Fixture condition did not settle");
  };
  const finish = (id: string) => {
    const a = app.detail(id);
    if (a.turnId)
      codex.emit(id, {
        type: "completed",
        turnId: a.turnId,
        status: "completed",
      });
  };
  const token = (id: string) =>
    captured.get(id)?.token ?? codex.agents.get(id)!.token;
  const start = {
    project: "owned",
    title: "Mixed worker",
    spec: "#4298",
    message: "Perform owned fixture work",
  };
  try {
    const owner = await app.createOrc("owned", {
      fast: true,
      orc: { backend: "codex", model: "sol", effort: "medium" },
      worker: {
        backend: "pi",
        provider: "fixture",
        model: "fake",
        effort: "off",
      },
    });
    plans.push(
      {
        name: "request_user_input_async",
        args: {
          questions: [
            {
              title: "Choice",
              question: "Choose a value",
              options: ["A", "B"],
            },
          ],
        },
      },
      undefined,
    );
    const worker = (await app.tool(
      token(owner.id),
      "worker_start",
      start,
    )) as Agent;
    await until(
      () =>
        app.detail(worker.id).questions.length === 1 &&
        app.detail(worker.id).state === "idle",
    );
    const projection = new HostService(app, {
      directory: join(home, "host"),
      origin: () => "http://127.0.0.1:1",
    });
    expect(
      projection.snapshot().agents.find((a) => a.id.endsWith(":" + worker.id)),
    ).toMatchObject({ backend: "pi", provider: "fixture" });
    projection.dispose();
    expect(worker.backend).toBe("pi");
    expect(worker.serviceTier).toBe("default");
    expect(owner.serviceTier).toBe("priority");
    const question = app.detail(worker.id).questions[0];
    finish(owner.id);
    const stranger = await app.createOrc("owned");
    await expect(
      app.tool(token(stranger.id), "worker_send", {
        workerId: worker.id,
        message: "intrude",
      }),
    ).rejects.toThrow("does not belong");
    await expect(
      app.tool(token(worker.id), "worker_start", start),
    ).rejects.toThrow("not available");
    plans.push(
      { name: "worker_report", args: { message: "Native Pi report" } },
      undefined,
    );
    await app.tool(token(owner.id), "worker_send", {
      workerId: worker.id,
      questionIds: [question.id],
      message: "A",
    });
    await until(
      () =>
        app.detail(worker.id).state === "idle" &&
        app
          .detail(owner.id)
          .deliveries.some(
            (d) => d.reportingWorkerId === worker.id && d.status === "sent",
          ),
    );
    expect(app.questionHistory(worker.id)[0]).toMatchObject({
      state: "answered",
      answer: "A",
    });
    codex.interruptOverride = async (id, turnId) =>
      codex.emit(id, { type: "completed", turnId, status: "interrupted" });
    const codexTurn = app.detail(owner.id).turnId!;
    await app.stop(owner.id, codexTurn);
    expect(app.detail(owner.id).state).toBe("idle");
    codex.interruptOverride = undefined;
    await app.tool(token(owner.id), "worker_close", { workerId: worker.id });
    await until(
      () => !app.snapshot().agents.some((agent) => agent.id === worker.id),
    );
    // Same raw native id in both adapters remains a separate history identity.
    const native = threadIdentity(worker.threadId!).id;
    codex.historySessions.set(native, {
      threadId: native,
      title: "Codex collision",
      preview: "Codex only",
      cwd,
      updatedAt: 1,
      source: "fixture",
      role: "session",
      archived: false,
    });
    codex.historyItems.set(native, [
      { id: "codex-collision", role: "assistant", text: "Codex only", at: 1 },
    ]);
    expect((await runtime.historyMessages(native)).messages[0].text).toBe(
      "Codex only",
    );
    expect(
      (await runtime.historyMessages(worker.threadId!)).messages.some(
        (m) => m.text === "Codex only",
      ),
    ).toBe(false);
    // Native Pi Orc invokes the same management bridge to create a Codex child.
    const piOwner = await app.createOrc("owned", {
      fast: false,
      orc: { backend: "pi", provider: "fixture", model: "fake", effort: "off" },
      worker: { backend: "codex", model: "sol", effort: "medium" },
    });
    plans.push({ name: "worker_start", args: start }, undefined);
    await app.send(piOwner.id, "Dispatch a Codex worker", "dispatch");
    await until(
      () =>
        app.snapshot().agents.some((a) => a.ownerId === piOwner.id) &&
        app.detail(piOwner.id).state === "idle",
    );
    const codexWorker = app
      .snapshot()
      .agents.find((a) => a.ownerId === piOwner.id)!;
    expect(codexWorker.backend).toBe("codex");
    await app.updateSettings(piOwner.id, {
      provider: "alternate",
      model: "fake",
      effort: "off",
    });
    expect(app.detail(piOwner.id).provider).toBe("alternate");

    const turnId = app.detail(codexWorker.id).turnId!;
    plans.push(
      {
        name: "worker_send",
        args: {
          workerId: codexWorker.id,
          questionIds: ["codex-question:0"],
          message: "B",
        },
      },
      undefined,
    );
    codex.emit(codexWorker.id, {
      type: "item",
      turnId,
      item: {
        id: "codex-question",
        type: "agentMessage",
        delivery: "async",
        questions: [{ question: "Which value?" }],
      },
    });
    await until(
      () =>
        app.detail(codexWorker.id).questions[0]?.state === "answered" &&
        app.detail(piOwner.id).state === "idle",
    );
    finish(codexWorker.id);
    plans.push(
      { name: "worker_close", args: { workerId: codexWorker.id } },
      undefined,
    );
    await app.tool(token(codexWorker.id), "worker_report", {
      message: "Codex child report",
    });
    await until(
      () =>
        !app.snapshot().agents.some((agent) => agent.id === codexWorker.id) &&
        app.detail(piOwner.id).state === "idle",
    );
    expect(
      app
        .detail(piOwner.id)
        .deliveries.some((d) => d.reportingWorkerId === codexWorker.id),
    ).toBe(true);
    // Every configured reviewer profile and Researcher takes the native Pi path.
    const target = { spec: "#4298", fixedPoint: "base", reviewedHead: "head" };
    for (const profile of [
      "standards",
      "spec",
      "high_risk_spec",
      "penpot",
    ] as const) {
      plans.push(
        {
          name: "reviewer_report",
          args: { ...target, message: "Native reviewer evidence" },
        },
        undefined,
      );
      const reviewer = (await app.tool(token(owner.id), "reviewer_start", {
        project: "owned",
        title: profile,
        profile,
        ...target,
        message: "Review owned evidence",
      })) as Agent;
      await until(() => app.detail(reviewer.id).state === "idle");
      expect(captured.get(reviewer.id)?.reviewerSnapshot).toMatchObject(
        snapshot,
      );
      expect(
        app
          .detail(owner.id)
          .deliveries.some(
            (d) =>
              d.reportingReviewerId === reviewer.id &&
              d.reviewTarget?.profile === profile,
          ),
      ).toBe(true);
      finish(owner.id);
      await app.tool(token(owner.id), "reviewer_close", {
        reviewerId: reviewer.id,
      });
      await until(
        () => !app.snapshot().agents.some((agent) => agent.id === reviewer.id),
      );
    }
    plans.push(
      {
        name: "researcher_report",
        args: {
          question: "Owned research question",
          message: "Native researcher evidence",
        },
      },
      undefined,
    );
    const researcher = (await app.tool(token(owner.id), "researcher_start", {
      project: "owned",
      title: "Research",
      question: "Owned research question",
      message: "Find evidence",
    })) as Agent;
    await until(() => app.detail(researcher.id).state === "idle");
    expect(captured.get(researcher.id)?.researcherSnapshot).toMatchObject(
      snapshot,
    );
    expect(
      app
        .detail(owner.id)
        .deliveries.some(
          (d) =>
            d.reportingResearcherId === researcher.id &&
            d.researchQuestion === "Owned research question",
        ),
    ).toBe(true);
    finish(owner.id);
    await app.tool(token(owner.id), "researcher_close", {
      researcherId: researcher.id,
    });
    await until(
      () => !app.snapshot().agents.some((agent) => agent.id === researcher.id),
    );
    const beforeInvalid = requests;
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({ providers: { fixture: configured.providers.fixture } }),
    );
    await app.send(
      piOwner.id,
      "Unavailable model must not fall back",
      "invalid-model",
    );
    expect(
      app.detail(piOwner.id).deliveries.find((d) => d.id === "invalid-model")
        ?.status,
    ).toBe("failed");
    expect(app.detail(piOwner.id).provider).toBe("alternate");
    expect(requests).toBe(beforeInvalid);
    await writeFile(join(agentDir, "models.json"), JSON.stringify(configured));
    await app.deleteFailedSubmission(piOwner.id, "invalid-model");
    blocked = true;
    blocker = new Promise<void>((resolve) => (releaseBlocked = resolve));
    const beforeStop = requests;
    await app.send(piOwner.id, "Start interruptible native work", "stop-start");
    await until(() => requests > beforeStop);
    const queued = app.send(
      piOwner.id,
      "Queued native input",
      "queued-unknown",
    );
    await until(() =>
      app
        .detail(piOwner.id)
        .deliveries.some(
          (d) => d.id === "queued-unknown" && d.status === "sending",
        ),
    );
    await app.stop(piOwner.id, app.detail(piOwner.id).turnId!);
    await queued;
    expect(
      app.detail(piOwner.id).deliveries.find((d) => d.id === "queued-unknown")
        ?.status,
    ).toBe("uncertain");
    expect(app.lookup(piOwner.id, "queued-unknown")).toBeNull();
    blocked = false;
    releaseBlocked();
    const calls = requests;
    await app.synchronizeDetail(piOwner.id);
    await app.reconcileSettings(piOwner.id);
    expect(requests).toBe(calls);
    await app.closeTree(piOwner.id, ["queued-unknown"]);
    await app.closeTree(owner.id);
    app.dispose();
    await runtime.close();
    app = new Workspace(options);
    await app.historyMessages("owned", worker.threadId!);
    expect(requests).toBe(calls);
    expect(JSON.stringify(app.snapshot())).not.toContain("mixed-owned-key");
  } finally {
    releaseBlocked?.();
    app.dispose();
    await runtime.close();
    upstream.stop(true);
  }
}, 30000);
