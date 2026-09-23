import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerInvalidRequestError } from "@jaminzhou/codex-app-server-client";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { resumeAdmission } from "./admission";

async function requests(
  cwd: string,
): Promise<Array<{ method: string; params: any }>> {
  const path = join(cwd, ".fake-app-server-requests.jsonl");
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("native compact lifecycle delivers held and immediate later input exactly once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-compact-"));
  let server: Awaited<ReturnType<typeof connect>> | undefined;
  let conversation: ReaderConversation | undefined;
  try {
    const fake = fileURLToPath(
      new URL("./fake-app-server-entry.mjs", import.meta.url),
    );
    server = await connect(cwd, fake, {
      env: { ...process.env, FAKE_COMPACT_DELAY_MS: "100" },
    });
    conversation = new ReaderConversation(
      server,
      (await server.startThread()).id,
    );
    let finish!: () => void;
    const completed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    server.onNotification("turn/completed", () => finish());
    await conversation.submit("/compact");
    await conversation.submit("during compact");
    await completed;
    await conversation.submit("after compact");
    const native = JSON.parse(
      await readFile(join(cwd, ".fake-app-server-state.json"), "utf8"),
    );
    const accepted = native.turns.flatMap((t: any) =>
      t.items
        .filter((i: any) => i.type === "userMessage")
        .map((i: any) => i.content.map((p: any) => p.text).join("")),
    );
    expect(accepted).toEqual(["during compact", "after compact"]);
    expect(
      conversation.visible
        .filter((message) => message.role === "user")
        .map((message) => message.body),
    ).toEqual(accepted);
    expect(conversation.compacting).toBe(false);
  } finally {
    try {
      if (conversation) await conversation.close();
      else await server?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("published client initializes against the test-owned stdio fake", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-client-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  try {
    const client = await connect(cwd, fake);
    await client.close();
    expect((await requests(cwd)).map((request) => request.method)).toContain(
      "initialize",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("start and resume preserve pane environment and disable only the discovered Herdr session hook", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-herdr-owner-"));
  let server: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await writeFile(
      join(cwd, ".fake-app-server-control.json"),
      JSON.stringify({
        hooks: [
          {
            key: "native-herdr",
            command: `bash '${cwd}/herdr-agent-state.sh' session`,
          },
          { key: "other", command: "echo other-session-hook" },
          { key: "mention", command: "echo herdr-agent-state.sh session" },
          {
            key: "different-event",
            eventName: "stop",
            command: `bash '${cwd}/herdr-agent-state.sh' session`,
          },
          {
            key: "different-action",
            command: `bash '${cwd}/herdr-agent-state.sh' working`,
          },
        ],
      }),
    );
    server = await connect(
      cwd,
      fileURLToPath(new URL("./fake-app-server-entry.mjs", import.meta.url)),
      {
        env: {
          HERDR_ENV: "1",
          HERDR_PANE_ID: "test:p1",
          FAKE_EXPECT_HERDR_PANE: "test:p1",
        },
      },
    );
    expect((await server.startThread()).id).toBeTruthy();
    await server.resumeThread("thread-fake");
    const calls = await requests(cwd);
    for (const method of ["thread/start", "thread/resume"]) {
      expect(calls.find((r) => r.method === method)?.params.config).toEqual({
        "hooks.state": { "native-herdr": { enabled: false } },
      });
    }
    expect(calls.filter((r) => r.method === "hooks/list")).toHaveLength(2);
    expect(calls.some((r) => r.method.startsWith("config/"))).toBe(false);
  } finally {
    await server?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("managed conflicting hooks are rejected before starting or resuming a thread", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-managed-hook-"));
  let server: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await writeFile(
      join(cwd, ".fake-app-server-control.json"),
      JSON.stringify({
        hooks: [
          {
            key: "managed-herdr",
            isManaged: true,
            command: `sh '${cwd}/herdr-agent-state.sh' session`,
          },
        ],
      }),
    );
    server = await connect(
      cwd,
      fileURLToPath(new URL("./fake-app-server-entry.mjs", import.meta.url)),
      { env: { HERDR_ENV: "1", HERDR_PANE_ID: "fixture:p1" } },
    );
    await expect(server.startThread()).rejects.toThrow("managed");
    await expect(server.resumeThread("thread-fake")).rejects.toThrow("managed");
    expect(
      (await requests(cwd)).some((r) => r.method.startsWith("thread/")),
    ).toBe(false);
  } finally {
    await server?.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("published client exposes capacity failure and resumes native history without another user message", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-capacity-"));
  let server: Awaited<ReturnType<typeof connect>> | undefined;
  let conversation: ReaderConversation | undefined;
  try {
    const control = join(cwd, ".fake-app-server-control.json");
    await writeFile(control, JSON.stringify({ turnError: "serverOverloaded" }));
    server = await connect(
      cwd,
      fileURLToPath(new URL("./fake-app-server-entry.mjs", import.meta.url)),
    );
    let retry: (() => void) | undefined;
    conversation = new ReaderConversation(
      server,
      (await server.startThread()).id,
      undefined,
      {
        now: () => 0,
        setTimeout(callback, ms) {
          expect(ms).toBe(15 * 60_000);
          retry = callback;
          return {} as ReturnType<typeof setTimeout>;
        },
        clearTimeout() {
          retry = undefined;
        },
      },
    );
    const nextCompletion = () =>
      new Promise<void>((resolve) => {
        const off = server!.onNotification("turn/completed", () => {
          off();
          resolve();
        });
      });
    const failed = nextCompletion();
    await conversation.submit("original request");
    await failed;
    expect(conversation.status).toBe("capacity wait");
    await writeFile(control, "{}");
    const succeeded = nextCompletion();
    retry!();
    await succeeded;
    const native = JSON.parse(
      await readFile(join(cwd, ".fake-app-server-state.json"), "utf8"),
    );
    expect(native.turns.map((turn: any) => turn.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(
      native.turns.flatMap((turn: any) =>
        turn.items.filter((item: any) => item.type === "userMessage"),
      ),
    ).toHaveLength(1);
    expect(conversation.recoveryLabel()).toBe("");
    expect(conversation.notice).toBe("");
  } finally {
    try {
      if (conversation) await conversation.close();
      else await server?.close();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test("published client narrows enabled skills through its typed adapter", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-skills-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  const client = await connect(cwd, fake);
  try {
    expect(await client.listSkills(cwd)).toEqual([
      { name: "review-code", description: "Review code" },
    ]);
    expect((await requests(cwd)).map((request) => request.method)).toContain(
      "skills/list",
    );
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("published client lists models through the official catalogue", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-models-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  const client = await connect(cwd, fake);
  try {
    expect(await client.listModels()).toEqual([
      {
        name: "fixture-model",
        description: "Fixture model · A test-owned model catalogue entry",
        efforts: [{ name: "medium", description: "Balanced" }],
        defaultEffort: "medium",
      },
    ]);
    expect((await requests(cwd)).map((request) => request.method)).toContain(
      "model/list",
    );
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("published-client active-writer admission is narrowly classified", async () => {
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  const caseError = async (code: number, message: string) => {
    const cwd = await mkdtemp(join(tmpdir(), "zencodex-resume-error-"));
    await writeFile(
      join(cwd, ".fake-app-server-control.json"),
      JSON.stringify({ resumeError: { code, message } }),
    );
    const client = await connect(cwd, fake);
    try {
      let received: unknown;
      try {
        await client.resumeThread("thread-fake");
      } catch (error) {
        received = error;
      }
      if (received === undefined)
        throw new Error("resume unexpectedly succeeded");
      return received;
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  };
  const activeWriter = await caseError(-32600, "thread has an active writer");
  expect(activeWriter).toBeInstanceOf(AppServerInvalidRequestError);
  expect(activeWriter).toMatchObject({
    code: -32600,
    rpcMessage: "thread has an active writer",
  });
  expect(resumeAdmission(activeWriter)).toBe(
    "This session is already open in another Codex client.",
  );
  expect(
    resumeAdmission(await caseError(-32602, "thread has an active writer")),
  ).not.toBe("This session is already open in another Codex client.");
  expect(
    resumeAdmission(await caseError(-32600, "thread does not exist")),
  ).not.toBe("This session is already open in another Codex client.");
  expect(
    resumeAdmission({
      code: -32600,
      rpcMessage: "thread has an active writer",
    }),
  ).not.toBe("This session is already open in another Codex client.");
});

test("resume prefers canonical response reasoning effort", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-resume-effort-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  await writeFile(
    join(cwd, ".fake-app-server-control.json"),
    JSON.stringify({ resumeReasoningEffort: "high" }),
  );
  const client = await connect(cwd, fake);
  try {
    expect((await client.resumeThread("thread-fake")).effort).toBe("high");
  } finally {
    await client.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dropped start response reconciles official clientId history without retry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-start-reconcile-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  const server = await connect(cwd, fake, {
    env: { ...process.env, FAKE_DROP_RESPONSE_METHOD: "turn/start" },
    requestTimeoutMs: 1_000,
  });
  const threadId = (await server.startThread()).id;
  const conversation = new ReaderConversation(server, threadId);
  try {
    await conversation.submit("accepted despite lost start response");
    expect(
      (await requests(cwd)).filter(
        (request) => request.method === "turn/start",
      ),
    ).toHaveLength(1);
  } finally {
    await conversation.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("dropped steer response reconciles its official clientId without duplicate steering", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-steer-reconcile-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  await writeFile(
    join(cwd, ".fake-app-server-control.json"),
    JSON.stringify({ hold: true }),
  );
  const server = await connect(cwd, fake, {
    env: { ...process.env, FAKE_DROP_RESPONSE_METHOD: "turn/steer" },
    requestTimeoutMs: 1_000,
  });
  const threadId = (await server.startThread()).id;
  const conversation = new ReaderConversation(server, threadId);
  try {
    await conversation.submit("first active input");
    await conversation.submit("accepted despite lost steer response");
    expect(
      (await requests(cwd)).filter(
        (request) => request.method === "turn/steer",
      ),
    ).toHaveLength(1);
  } finally {
    await conversation.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
