import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./app-server";
import { ReaderConversation } from "./conversation";

async function requests(cwd: string): Promise<Array<{ method: string }>> {
  const path = join(cwd, ".fake-app-server-requests.jsonl");
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string });
}

test("published client connects to the test-owned CFL stdio fake", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zencodex-client-"));
  const fake = fileURLToPath(
    new URL("./fake-app-server-entry.mjs", import.meta.url),
  );
  try {
    const client = await connect(cwd, fake);
    expect(await client.sessions()).toEqual([]);
    await client.close();
  } finally {
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
    requestTimeoutMs: 100,
  });
  const threadId = await server.startThread();
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
    requestTimeoutMs: 100,
  });
  const threadId = await server.startThread();
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
