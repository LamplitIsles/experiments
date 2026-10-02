import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexRuntime } from "./codex";
import type { RuntimeAgent, RuntimeEvent } from "./runtime";

test("the SDK adapter initializes isolated role configuration, discovers enabled skills and resumes threads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flickgrove-sdk-"));
  const argsPath = join(directory, "args.json");
  const runtime = new CodexRuntime({
    cwd: directory,
    origin: () => "http://127.0.0.1:14318",
    codexPath: fileURLToPath(
      new URL("../tests/fake-codex.mjs", import.meta.url),
    ),
    env: {
      ...process.env,
      CODEX_HOME: join(directory, "codex-home"),
      FAKE_SERVER_ROOT: directory,
      FAKE_SERVER_ARGS: argsPath,
    },
  });
  try {
    expect(await runtime.models()).toEqual([
      {
        id: "fixture-model",
        name: "Fixture model",
        efforts: ["medium"],
        defaultEffort: "medium",
        isDefault: true,
      },
    ]);
    expect(await runtime.skills(directory)).toEqual([
      { name: "review-code", description: "Review code" },
    ]);
    const agent: RuntimeAgent = {
      id: "orc",
      token: "test-token",
      role: "orc",
      project: { alias: "fixture", name: "Fixture", path: directory },
      title: "New session",
      model: "fixture-model",
      effort: "medium",
      state: "idle",
      closed: false,
      questions: [],
      messages: [],
      deliveries: [],
    };
    const events: RuntimeEvent[] = [];
    const completed = Promise.withResolvers<void>();
    const handle = await runtime.open(agent, (event) => {
      events.push(event);
      if (event.type === "completed") completed.resolve();
    });
    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args).toContain(
      'mcp_servers.flickgrove.env.FLICKGROVE_AGENT_TOKEN="test-token"',
    );
    expect(args).toContain(
      'mcp_servers.flickgrove.env.FLICKGROVE_ORIGIN="http://127.0.0.1:14318"',
    );
    expect(args).toContain("features.multi_agent=false");
    expect(
      args.some(
        (arg) =>
          arg.startsWith("mcp_servers.flickgrove.args=") &&
          arg.includes("/flickgrove/server/mcp.ts"),
      ),
    ).toBe(true);
    await handle.send("Build a reader");
    await Promise.race([
      completed.promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("No completed turn")), 3000),
      ),
    ]);
    expect(events.some((e) => e.type === "working")).toBe(true);
    expect(
      events.some(
        (e) =>
          e.type === "item" && e.item.phase === "final_answer" && !!e.item.text,
      ),
    ).toBe(true);
    expect(
      events.find((e) => e.type === "item" && e.item.id === "async-question"),
    ).toMatchObject({
      type: "item",
      item: {
        delivery: "async",
        questions: [
          {
            question: "Which color?",
            options: [{ label: "Blue" }, { label: "Green" }],
          },
          { question: "Any context?" },
        ],
      },
    });
    const title = await handle.title("Build a reader");
    expect(title).toBeTruthy();
    await handle.close();
    const resumed = await runtime.open(
      { ...agent, threadId: handle.threadId },
      () => {},
    );
    expect(resumed.threadId).toBe(handle.threadId);
    await resumed.close();
    const requests = (
      await readFile(join(directory, ".fake-app-server-requests.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      requests.some(
        (r) =>
          r.method === "thread/resume" && r.params.threadId === handle.threadId,
      ),
    ).toBe(true);
    expect(
      requests.find((r) => r.method === "thread/start" && !r.params.ephemeral)
        .params,
    ).toMatchObject({
      model: "fixture-model",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(
      requests.find((r) => r.method === "thread/start" && !r.params.ephemeral)
        .params.developerInstructions,
    ).toContain("worker_send");
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
