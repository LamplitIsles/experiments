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
  const expectedSettings = {
    searchableAttributes: ["content"],
    filterableAttributes: ["deviceId", "agent", "cwd", "sessionId", "role"],
    sortableAttributes: ["createdAt"],
    typoTolerance: { disableOnNumbers: true },
    rankingRules: [
      "words",
      "typo",
      "proximity",
      "attributeRank",
      "wordPosition",
      "exactness",
      "sort",
    ],
  };
  await writeFile(join(root, "master-key"), key);
  let task = 0,
    indexExists = false;
  const polled = new Set<number>(),
    pending = new Map<number, () => void>(),
    failed = new Map<number, string>(),
    documents: any[] = [],
    searchLimits: number[] = [],
    settings: unknown[] = [];
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
        settings.push(await request.json());
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
      if (path.endsWith("/search")) {
        const body = (await request.json()) as any;
        searchLimits.push(body.limit);
        expect(body).toMatchObject({
          q: "中文",
          attributesToRetrieve: [
            "id",
            "kind",
            "sessionId",
            "sessionName",
            "cwd",
            "role",
            "phase",
            "createdAt",
          ],
          attributesToCrop: ["content:36"],
          cropMarker: "…",
          attributesToHighlight: ["content"],
          highlightPreTag: "<mark>",
          highlightPostTag: "</mark>",
        });
        expect(body.filter).toEqual([
          `deviceId = ${JSON.stringify(hostname())}`,
          'cwd = "/p"',
        ]);
        expect(body.sort).toEqual(["createdAt:desc"]);
        return Response.json({
          estimatedTotalHits: 1,
          hits: documents.map(
            ({
              content: _content,
              sourcePath: _sourcePath,
              sourceRecordIndex: _sourceRecordIndex,
              ...item
            }) => ({
              ...item,
              _formatted: { content: "…<mark>中文</mark> English…" },
            }),
          ),
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
  const client = meili({
    FLICKLOG_STATE_DIR: root,
    FLICKLOG_MEILI_PORT: String(server.port),
  });
  await client.configure();
  await client.configure();
  expect(settings).toEqual([expectedSettings, expectedSettings]);
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
  const search = await client.search("中文", "/p", false);
  await client.search("中文", "/p", false, 12);
  expect(searchLimits).toEqual([5, 12]);
  expect(search).toEqual({
    query: "中文",
    estimatedTotalHits: 1,
    hits: [
      {
        id: "a",
        kind: "message",
        sessionId: "s",
        cwd: "/p",
        role: "user",
        snippet: "…<mark>中文</mark> English…",
      },
    ],
  });
});
