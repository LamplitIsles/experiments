import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { meili } from "./core";

let server: ReturnType<typeof Bun.serve> | undefined;
let root: string | undefined;
afterEach(async () => {
  server?.stop();
  if (root) await rm(root, { recursive: true, force: true });
});
test("uses managed key and waits for fake async tasks", async () => {
  root = await mkdtemp(join(tmpdir(), "flicklog-meili-fake-"));
  const key = "test-managed-key";
  await writeFile(join(root, "master-key"), key);
  let task = 0,
    indexExists = false;
  const polled = new Set<number>(),
    pending = new Map<number, () => void>(),
    failed = new Map<number, string>(),
    documents: any[] = [];
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${key}`);
      const path = new URL(request.url).pathname;
      if (path === "/indexes" && request.method === "POST") {
        const id = ++task;
        if (indexExists)
          failed.set(id, "Index `flicklog_messages` already exists.");
        else pending.set(id, () => (indexExists = true));
        return Response.json({ taskUid: id });
      }
      if (path === "/indexes/flicklog_messages" && request.method === "GET")
        return indexExists
          ? Response.json({ uid: "flicklog_messages" })
          : new Response("missing", { status: 404 });
      if (path.includes("/settings")) {
        const id = ++task;
        pending.set(id, () => {});
        return Response.json({ taskUid: id });
      }
      if (path.includes("/documents")) {
        const values = (await request.json()) as any[];
        const id = ++task;
        pending.set(id, () => documents.push(...values));
        return Response.json({ taskUid: id });
      }
      if (path.startsWith("/tasks/")) {
        const id = Number(path.split("/").pop());
        polled.add(id);
        const error = failed.get(id);
        if (error)
          return Response.json({ status: "failed", error: { message: error } });
        pending.get(id)?.();
        pending.delete(id);
        return Response.json({ status: "succeeded" });
      }
      if (path.endsWith("/search")) return Response.json({ hits: documents });
      return new Response("missing", { status: 404 });
    },
  });
  const client = meili({
    FLICKLOG_STATE_DIR: root,
    FLICKLOG_MEILI_PORT: String(server.port),
  });
  await client.configure();
  await client.configure();
  await client.add([
    {
      id: "a",
      kind: "message",
      agent: "codex",
      deviceId: hostname(),
      sessionId: "s",
      cwd: "/p",
      role: "user",
      content: "中文 English code",
      sourcePath: "/x",
      sourceRecordIndex: 1,
    },
  ]);
  expect(polled.size).toBeGreaterThanOrEqual(3);
  expect(((await client.search("中文", "/p", false)) as any).hits).toHaveLength(
    1,
  );
});
