import { test, expect, spyOn } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPiSession } from "./pi-session";
import { PiRuntime } from "./pi";
import { readPiStorage } from "./pi-storage";
import { Workspace } from "./workspace";
import { WorkspaceStore } from "./workspace-store";
import { FakeRuntime } from "./testing";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  Harness,
  ROOT_CONVERSATION_ID,
  type SubmissionId,
} from "@earendil-works/pi-durable";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

test("native Pi tool turns do not create timestamp-only assistant rows in live or history", async () => {
  if (!process.env.GROVE_CONVERSATION_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-conversation-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_CONVERSATION_CHILD: "1",
        GROVE_NO_TOOL: process.env.GROVE_NO_TOOL,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      for (const line of out.split("\n"))
        if (
          line.startsWith("native assistant content types") ||
          line.startsWith("conversation rows")
        )
          console.log(line);
      if (code) console.log(out + err);
      expect(code).toBe(0);
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo");
  await mkdir(agentDir);
  await mkdir(cwd);
  let requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      const first = ++requests === 1 && !process.env.GROVE_NO_TOOL;
      const delta = first
        ? {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call-fixture",
                type: "function",
                function: {
                  name: "codemode",
                  arguments: JSON.stringify({ code: 'text("tool result")' }),
                },
              },
            ],
          }
        : { role: "assistant", content: "Meaningful assistant text" };
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) +
          chunk({}, first ? "tool_calls" : "stop") +
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
          apiKey: "fixture-only",
          models: [
            {
              id: "fake",
              name: "Fake",
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
  const agent: RuntimeAgent = {
    id: "orc",
    token: "fixture",
    role: "orc",
    ownerId: "orc",
    project: { alias: "fixture", name: "fixture", path: cwd },
    title: "New session",
    model: "fake",
    effort: "off",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [],
    deliveries: [],
  };
  const events: RuntimeEvent[] = [];
  let finish!: () => void;
  const done = new Promise<void>((r) => (finish = r));
  const handle = await openPiSession(
    agent,
    (e) => {
      events.push(e);
      if (e.type === "completed") finish();
    },
    {
      agentDir,
      sessionDir: join(agentDir, "grove-durable"),
      selection: { provider: "fixture", model: "fake", effort: "off" },
      tool: async () => ({}),
    },
  );
  try {
    await handle.send("Use a tool then answer", undefined, [], "operation");
    await done;
    const live = events
      .filter((e) => e.type === "item" && e.item.type === "agentMessage")
      .map((e) => (e as Extract<RuntimeEvent, { type: "item" }>).item.text);
    const history = (
      await new PiRuntime({ agentDir, tool: async () => ({}) }).historyMessages(
        handle.threadId,
      )
    ).messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.text);
    const storage = await readPiStorage(
      join(agentDir, "grove-durable", `${handle.threadId}.sqlite`),
    );
    const entries = await storage.scanEntries(
      { conversationId: ROOT_CONVERSATION_ID, order: "ascending" },
      100,
      undefined,
      ctx,
    );
    const completed = [...events].reverse().find((e) => e.type === "completed");
    expect(completed?.type).toBe("completed");
    const submission = await storage.submissionByRequest(
      ROOT_CONVERSATION_ID,
      "operation",
      ctx,
    );
    expect(submission?.status).toBe("done");
    if (
      completed?.type !== "completed" ||
      submission?.status !== "done" ||
      submission.type !== "input"
    )
      throw new Error("Fixture did not finish its original run");
    const answer = await storage.entry(
      ROOT_CONVERSATION_ID,
      submission.answer,
      ctx,
    );
    expect(answer?.entry.byTaskId).toBeDefined();
    const finalTask = await storage.task(answer!.entry.byTaskId!, ctx);
    expect(finalTask?.endedAt).toEqual(expect.any(Number));
    const generations = await storage.scanTasks(
      {
        conversationId: ROOT_CONVERSATION_ID,
        kind: "pi.generation",
        status: "terminal",
      },
      100,
      undefined,
      ctx,
    );
    const intermediate = generations.items.find(
      (task) => task.id < finalTask!.id,
    );
    if (!process.env.GROVE_NO_TOOL) expect(intermediate).toBeDefined();
    console.log(
      "native assistant content types",
      JSON.stringify(
        entries.items
          .filter((e) => e.kind === "pi.assistant")
          .map((e) =>
            e.model?.flatMap((m) =>
              Array.isArray(m.content) ? m.content.map((p) => p.type) : [],
            ),
          ),
      ),
    );
    await storage.close(ctx);
    console.log(
      `conversation rows live=${JSON.stringify(live)} history=${JSON.stringify(history)} requests=${requests}`,
    );
    expect(live).toEqual(["Meaningful assistant text"]);
    expect(history).toEqual(["Meaningful assistant text"]);
    expect(
      events.find((e) => e.type === "item" && e.item.type === "agentMessage")
        ?.replayed,
    ).toBe(false);
    await handle.close();
    const replay: RuntimeEvent[] = [];
    const reopened = await openPiSession(
      {
        ...agent,
        threadId: handle.threadId,
        turnId: completed.turnId,
        state: "working",
        deliveries: [
          {
            id: "operation",
            text: "Use a tool then answer",
            source: "user",
            status: "sent",
            at: 1,
            questionIds: [],
            turnId: completed.turnId,
          },
        ],
      },
      (event) => replay.push(event),
      {
        agentDir,
        sessionDir: join(agentDir, "grove-durable"),
        selection: { provider: "fixture", model: "fake", effort: "off" },
        tool: async () => ({}),
      },
    );
    try {
      expect(replay.find((e) => e.type === "completed")).toMatchObject({
        type: "completed",
        turnId: completed.turnId,
        replayed: true,
        recoveredActivityAt: finalTask!.endedAt,
      });
      expect(
        replay.some(
          (e) =>
            e.type === "item" && e.item.type === "agentMessage" && e.replayed,
        ),
      ).toBe(true);
    } finally {
      await reopened.close();
    }
    if (intermediate) {
      const expectedActivity = Math.max(
        ...generations.items
          .filter(
            (task) =>
              task.id >= intermediate.id &&
              task.startedAt !== undefined &&
              task.endedAt !== undefined,
          )
          .map((task) => task.endedAt!),
      );
      const handoverReplay: RuntimeEvent[] = [];
      const reopenedHandover = await openPiSession(
        {
          ...agent,
          threadId: handle.threadId,
          turnId: String(intermediate.id),
          state: "working",
        },
        (event) => handoverReplay.push(event),
        {
          agentDir,
          sessionDir: join(agentDir, "grove-durable"),
          selection: { provider: "fixture", model: "fake", effort: "off" },
          tool: async () => ({}),
        },
      );
      try {
        expect(
          handoverReplay.find((e) => e.type === "completed"),
        ).toMatchObject({
          turnId: String(intermediate.id),
          replayed: true,
          recoveredActivityAt: expectedActivity,
        });
      } finally {
        await reopenedHandover.close();
      }
    }
    // Persist the pre-observation Workspace state, then reopen the same native
    // session: the timestamp must come from the final native task, not restart.
    const directory = join(home, "workspace");
    await mkdir(directory);
    const store = new WorkspaceStore(join(directory, "workspace.sqlite"));
    store.track(
      {
        ...agent,
        backend: "pi",
        threadId: handle.threadId,
        turnId: completed.turnId,
        state: "working",
        lastActivityAt: finalTask!.endedAt! - 10000,
        deliveries: [
          {
            id: "operation",
            text: "Use a tool then answer",
            source: "user",
            status: "sent",
            at: 1,
            questionIds: [],
            turnId: completed.turnId,
          },
        ],
      },
      true,
    );
    store.flush();
    store.close();
    const runtime = new FakeRuntime();
    let recoveryHandle: Awaited<ReturnType<typeof openPiSession>> | undefined;
    runtime.open = async (saved, notify) => {
      recoveryHandle = await openPiSession(saved, notify, {
        agentDir,
        sessionDir: join(agentDir, "grove-durable"),
        selection: { provider: "fixture", model: "fake", effort: "off" },
        tool: async () => ({}),
      });
      return recoveryHandle;
    };
    const workspace = new Workspace({
      directory,
      runtime,
      projects: async () => [agent.project],
    });
    try {
      for (
        let i = 0;
        i < 200 && (!recoveryHandle || workspace.detail(agent.id).turnId);
        i++
      )
        await Bun.sleep(5);
      expect(recoveryHandle).toBeDefined();
      expect(workspace.detail(agent.id).turnId).toBeUndefined();
      expect(workspace.detail(agent.id).lastActivityAt).toBe(
        finalTask!.endedAt,
      );
      expect(requests).toBe(process.env.GROVE_NO_TOOL ? 1 : 2);
    } finally {
      await recoveryHandle?.close();
      workspace.dispose();
    }
    const restored = new WorkspaceStore(join(directory, "workspace.sqlite"));
    try {
      expect(restored.byId(agent.id)?.lastActivityAt).toBe(finalTask!.endedAt);
    } finally {
      restored.close();
    }
    // Delay the real submit response until native completion has been committed.
    // This forces send's actual LiveDoc fallback to return the submission ID.
    let finished!: () => void;
    const nativeFinished = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const nativeOpen = Harness.open.bind(Harness);
    const intercept = spyOn(Harness, "open").mockImplementation(
      async (...args) => {
        const harness = await nativeOpen(...args);
        const openRoot = harness.root.bind(harness);
        Object.defineProperty(harness, "root", {
          value: async (...rootArgs: Parameters<typeof harness.root>) => {
            const root = await openRoot(...rootArgs);
            const submit = root.submit.bind(root);
            Object.defineProperty(root, "submit", {
              value: async (...submitArgs: Parameters<typeof root.submit>) => {
                const result = await submit(...submitArgs);
                await nativeFinished;
                return result;
              },
            });
            return root;
          },
        });
        return harness;
      },
    );
    const fallbackDirectory = join(home, "fallback-workspace");
    const fallbackRuntime = new FakeRuntime();
    fallbackRuntime.models = async () => [
      {
        id: "fake",
        name: "Fake",
        backend: "pi",
        provider: "fixture",
        efforts: ["off"],
        defaultEffort: "off",
        isDefault: true,
        fastTier: null,
      },
    ];
    let fallbackHandle: Awaited<ReturnType<typeof openPiSession>> | undefined;
    let dropEvents = true;
    fallbackRuntime.open = async (saved, notify) => {
      fallbackHandle = await openPiSession(
        saved,
        (event) => {
          if (event.type === "completed") finished();
          if (!dropEvents) notify(event);
        },
        {
          agentDir,
          sessionDir: join(agentDir, "grove-durable"),
          selection: { provider: "fixture", model: "fake", effort: "off" },
          tool: async () => ({}),
        },
      );
      fallbackHandle.title = async () => undefined;
      return fallbackHandle;
    };
    const makeWorkspace = () =>
      new Workspace({
        directory: fallbackDirectory,
        runtime: fallbackRuntime,
        projects: async () => [agent.project],
      });
    let fallbackWorkspace = makeWorkspace();
    try {
      const setting = {
        backend: "pi" as const,
        provider: "fixture",
        model: "fake",
        effort: "off",
      };
      const current = await fallbackWorkspace.createOrc("fixture", {
        fast: false,
        orc: setting,
        worker: setting,
      });
      await fallbackWorkspace.send(
        current.id,
        "fast completion",
        "fallback-operation",
      );
      const saved = fallbackWorkspace.detail(current.id);
      const fallbackTurn = saved.turnId!;
      const fallbackThread = saved.threadId!;
      const native = await readPiStorage(
        join(agentDir, "grove-durable", `${fallbackThread}.sqlite`),
      );
      const receipt = await native.submission(
        Number(fallbackTurn) as SubmissionId,
        ctx,
      );
      expect(receipt).toMatchObject({
        id: Number(fallbackTurn),
        requestId: "fallback-operation",
        type: "input",
        status: "done",
      });
      if (receipt?.status !== "done" || receipt.type !== "input")
        throw new Error("Fallback was not a completed input");
      const entry = await native.entry(
        ROOT_CONVERSATION_ID,
        receipt.answer,
        ctx,
      );
      const terminal = await native.task(entry!.entry.byTaskId!, ctx);
      expect(terminal?.endedAt).toEqual(expect.any(Number));
      await native.close(ctx);
      const providerCalls = requests;
      await fallbackHandle?.close();
      fallbackWorkspace.dispose();
      intercept.mockRestore();
      // Set an earlier previously persisted activity to expose the recovered timestamp.
      const prior = new WorkspaceStore(
        join(fallbackDirectory, "workspace.sqlite"),
      );
      const tracked = prior.track(prior.byId(current.id)!);
      tracked.lastActivityAt = terminal!.endedAt! - 10000;
      prior.flush();
      prior.close();
      dropEvents = false;
      fallbackHandle = undefined;
      fallbackWorkspace = makeWorkspace();
      for (
        let i = 0;
        i < 200 &&
        (!fallbackHandle || fallbackWorkspace.detail(current.id).turnId);
        i++
      )
        await Bun.sleep(5);
      expect(fallbackHandle).toBeDefined();
      expect(fallbackWorkspace.detail(current.id).turnId).toBeUndefined();
      expect(fallbackWorkspace.detail(current.id).lastActivityAt).toBe(
        terminal!.endedAt,
      );
      expect(requests).toBe(providerCalls);
    } finally {
      intercept.mockRestore();
      await fallbackHandle?.close();
      fallbackWorkspace.dispose();
    }
  } finally {
    await handle.close();
    upstream.stop(true);
  }
}, 20000);
