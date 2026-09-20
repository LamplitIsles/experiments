import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerInvalidRequestError } from "@jaminzhou/codex-app-server-client";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";
import { resumeAdmission } from "./admission";

async function requests(cwd: string): Promise<Array<{ method: string }>> {
  const path = join(cwd, ".fake-app-server-requests.jsonl");
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string });
}

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
