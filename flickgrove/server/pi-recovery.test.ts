import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { watch } from "node:fs";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openPiSession, piSessionPath } from "./pi-session";
import { readPiStorage, acquirePiWriter } from "./pi-storage";
import { PiRuntime } from "./pi";
import type { RuntimeAgent, RuntimeEvent, RuntimeHandle } from "./runtime";

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await Bun.sleep(5);
  }
  throw new Error("Owned fixture did not reach expected state");
};
test("Durable accepted/queued work resumes without resubmission; scoped Stop withdraws input and read-only history never runs work", async () => {
  if (!process.env.GROVE_RECOVERY_CHILD) {
    const home = await mkdtemp(join(tmpdir(), "grove-recovery-"));
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: {
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        PATH: process.env.PATH,
        HOME: home,
        CODEX_HOME: join(home, "codex"),
        PI_CODING_AGENT_DIR: join(home, "agent"),
        GROVE_RECOVERY_CHILD: "1",
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
      expect({ code, output: code ? out + err : "" }).toEqual({
        code: 0,
        output: "",
      });
    } finally {
      child.kill();
      await child.exited;
      await rm(home, { recursive: true, force: true });
    }
    return;
  }
  const home = process.env.HOME!,
    agentDir = process.env.PI_CODING_AGENT_DIR!,
    cwd = join(home, "repo"),
    sessionDir = join(agentDir, "grove-durable");
  await mkdir(agentDir);
  await mkdir(cwd);
  await writeFile(join(agentDir, "auth.json"), "{}");
  let hold = true,
    toolPlan = false,
    requests = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      await req.json();
      requests++;
      const chunk = (delta: object, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: "owned", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      if (toolPlan)
        return new Response(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "owned-unsafe",
                  type: "function",
                  function: {
                    name: "mcp__crash__echo",
                    arguments: JSON.stringify({ value: "hold" }),
                  },
                },
              ],
            },
            null,
          ) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      if (!hold)
        return new Response(
          chunk({ role: "assistant", content: "Owned answer" }, null) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                chunk({ role: "assistant", content: "" }, null),
              ),
            );
          },
          cancel() {},
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "owned",
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
    id: "owned",
    backend: "pi",
    role: "worker",
    ownerId: "owner",
    token: "owned-token",
    title: "Owned",
    project: { alias: "owned", name: "Owned", path: cwd },
    provider: "fixture",
    model: "fake",
    effort: "off",
    serviceTier: "default",
    closed: false,
    state: "idle",
    messages: [],
    questions: [],
    deliveries: [],
  };
  const options = {
    agentDir,
    sessionDir,
    selection: { provider: "fixture", model: "fake", effort: "off" },
    tool: async () => ({ ok: true }),
  };
  const crashLog = join(home, "crash-mcp.log");
  let handle: RuntimeHandle | undefined, other: RuntimeHandle | undefined;
  const events: RuntimeEvent[] = [];
  const records = async (id: string) => {
    const storage = await readPiStorage(piSessionPath(sessionDir, id));
    try {
      return (
        await storage.scanSubmissions(
          { conversationId: ROOT_CONVERSATION_ID },
          100,
          undefined,
          BACKGROUND_CONTEXT,
        )
      ).items;
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  };
  try {
    handle = await openPiSession(agent, (e) => events.push(e), options);
    const threadId = handle.threadId;
    const run = await handle.send(
      "same text",
      undefined,
      [],
      "first",
      "immutable-source",
    );
    await until(() => requests === 1);
    expect((await records(threadId)).map((s) => s.status)).toEqual(["placed"]);
    expect(
      await handle.send("same text", run, [], "second", "immutable-source"),
    ).toBe(run);
    expect((await records(threadId)).map((s) => s.status)).toEqual([
      "placed",
      "queued",
    ]);
    expect(
      await handle.send("same text", run, [], "first", "immutable-source"),
    ).toBe(run);
    await expect(
      handle.send("different text", run, [], "first", "immutable-source"),
    ).rejects.toThrow("different content");
    await expect(
      openPiSession({ ...agent, threadId }, () => {}, options),
    ).rejects.toThrow();
    await handle.close();
    handle = undefined;
    expect((await records(threadId)).map((s) => s.status)).toEqual([
      "placed",
      "queued",
    ]);
    const before = (await stat(piSessionPath(sessionDir, threadId))).mtimeMs;
    const reader = new PiRuntime({
      agentDir,
      tool: async () => {
        throw new Error("Read invoked tool");
      },
    });
    const page = await reader.historyMessages(threadId);
    expect(
      page.messages.filter((m) => m.role === "user").map((m) => m.clientId),
    ).toEqual(["first"]);
    expect(requests).toBe(1);
    expect((await stat(piSessionPath(sessionDir, threadId))).mtimeMs).toBe(
      before,
    );
    await expect(
      openPiSession(
        { ...agent, id: "foreign-owner", threadId },
        () => {},
        options,
      ),
    ).rejects.toThrow("original Pi session");
    hold = false;
    const resumed: RuntimeEvent[] = [];
    handle = await openPiSession(
      {
        ...agent,
        threadId,
        turnId: run,
        state: "working",
        deliveries: [
          {
            id: "first",
            text: "same text",
            source: "user",
            status: "uncertain",
            at: 1,
            questionIds: [],
          },
          {
            id: "second",
            text: "same text",
            source: "user",
            status: "uncertain",
            at: 2,
            questionIds: [],
          },
        ],
      },
      (e) => resumed.push(e),
      options,
    );
    expect(resumed[0]?.type).toBe("working");
    await until(() => resumed.some((e) => e.type === "completed"));
    const accepted = await records(threadId);
    expect(accepted).toHaveLength(2);
    expect(accepted.every((s) => s.status === "done")).toBe(true);
    expect(
      (await reader.historyMessages(threadId)).messages
        .filter((m) => m.role === "user")
        .map((m) => m.clientId),
    ).toEqual(["first", "second"]);
    // A stopped run cannot cancel a later submission, and another owner keeps running.
    hold = true;
    other = await openPiSession({ ...agent, id: "other" }, () => {}, options);
    const otherRun = await other.send(
      "other work",
      undefined,
      [],
      "other-operation",
    );
    const stopped = await handle.send("stop me", undefined, [], "stop-first");
    await handle.send("withdraw me", stopped, [], "stop-queued");
    await handle.interrupt(stopped);
    await until(async () =>
      (await records(threadId))
        .filter((s) => s.requestId?.startsWith("stop-"))
        .every((s) => s.status === "unanswered"),
    );
    expect((await records(other.threadId))[0]?.status).toBe("placed");
    const queued = (await records(threadId)).find(
      (s) => s.requestId === "stop-queued",
    );
    expect(queued?.status).toBe("unanswered");
    expect(queued?.status === "unanswered" && queued.reason).toBe("aborted");
    const withdrawnHistory = await new PiRuntime({
      agentDir,
      tool: options.tool,
    }).historyMessages(threadId);
    expect(
      withdrawnHistory.messages
        .filter((message) => message.clientId === "stop-queued")
        .map((message) => message.text),
    ).toEqual(["withdraw me"]);
    await other.interrupt(otherRun);
    hold = false;
    // Existing handle observer remains active; inspect the exact terminal receipt.
    await handle.send("new work", undefined, [], "after-stop");
    await until(
      async () =>
        (await records(threadId)).find((s) => s.requestId === "after-stop")
          ?.status === "done",
    );
    await expect(handle.interrupt(stopped)).rejects.toThrow("settled");
    hold = true;
    toolPlan = true;
    await writeFile(crashLog, "");
    await writeFile(
      join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          crash: {
            command: process.execPath,
            args: [join(import.meta.dir, "../tests/pi-mcp-fixture.ts")],
            env: { GROVE_MCP_LOG: crashLog },
            exposure: "direct",
          },
        },
      }),
    );
    const crashAgent = { ...agent, id: "crash-owned" };
    const crashing = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../tests/pi-crash-fixture.ts"),
        JSON.stringify(crashAgent),
      ],
      { env: process.env, stdout: "pipe", stderr: "pipe" },
    );
    let crashIdentity: { threadId: string; run: string };
    try {
      crashIdentity = await new Promise((resolve, reject) => {
        const lines = createInterface({
          input: Readable.fromWeb(crashing.stdout as never),
        });
        lines.on("line", (line) => {
          if (line.startsWith("owned-crash ")) {
            lines.close();
            resolve(JSON.parse(line.slice(12)));
          }
        });
        void crashing.exited.then((code) =>
          reject(new Error(`Owned crash fixture exited ${code}`)),
        );
      });
      await until(async () =>
        (await readFile(crashLog, "utf8")).includes('"event":"hold"'),
      );
      crashing.kill("SIGKILL");
      await crashing.exited;
    } finally {
      crashing.kill("SIGKILL");
      await crashing.exited;
    }
    expect(
      (await records(crashIdentity.threadId)).map((s) => s.status),
    ).toEqual(["placed", "queued"]);
    // No native connections remain after SIGKILL and the completed records() read.
    // A missing shared-memory sidecar must refuse reads, but never gate writer recovery.
    await rm(`${piSessionPath(sessionDir, crashIdentity.threadId)}-shm`);
    await expect(
      readPiStorage(piSessionPath(sessionDir, crashIdentity.threadId)),
    ).rejects.toThrow("WAL files are unavailable");
    hold = false;
    toolPlan = false;
    const crashedEvents: RuntimeEvent[] = [];
    const recovered = await openPiSession(
      {
        ...crashAgent,
        threadId: crashIdentity.threadId,
        turnId: crashIdentity.run,
        state: "working",
        deliveries: [
          {
            id: "crash-first",
            text: "crash accepted",
            source: "user",
            status: "uncertain",
            at: 1,
            questionIds: [],
          },
          {
            id: "crash-queued",
            text: "crash queued",
            source: "user",
            status: "uncertain",
            at: 2,
            questionIds: [],
          },
        ],
      },
      (e) => crashedEvents.push(e),
      options,
    );
    try {
      await until(() => crashedEvents.some((e) => e.type === "completed"));
      expect(await records(crashIdentity.threadId)).toHaveLength(2);
      expect(
        (await records(crashIdentity.threadId)).every(
          (s) => s.status === "done",
        ),
      ).toBe(true);
    } finally {
      await recovered.close();
    }
    const mutations: string[] = [];
    const observer = watch(sessionDir, (_event, name) =>
      mutations.push(String(name)),
    );
    try {
      await records(crashIdentity.threadId);
      await Bun.sleep(20);
      expect(mutations).toEqual([]);
    } finally {
      observer.close();
    }
    const lease = acquirePiWriter(
      piSessionPath(sessionDir, crashIdentity.threadId),
    );
    await lease();
    const crashEvents = (await readFile(crashLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(crashEvents.filter((event) => event.event === "echo")).toHaveLength(
      1,
    );
    for (const child of crashEvents.filter(
      (event) => event.event === "start",
    )) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await reader.close();
  } finally {
    const cleanupCrashProcesses = async () => {
      try {
        for (const line of (await readFile(crashLog, "utf8"))
          .trim()
          .split("\n")) {
          if (!line) continue;
          const child = JSON.parse(line);
          if (child.event === "start")
            try {
              process.kill(child.pid, "SIGTERM");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
            }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    };
    const releases = Promise.all([
      cleanupCrashProcesses(),
      handle?.close(),
      other?.close(),
    ]);
    upstream.stop(true);
    await releases;
  }
}, 20000);
