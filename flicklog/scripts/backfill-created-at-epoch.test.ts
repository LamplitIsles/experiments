import { afterEach, expect, test } from "bun:test";
import { run } from "./backfill-created-at-epoch";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop();
  server = undefined;
});

test("backfills paged documents with partial updates and skips stable timestamps", async () => {
  const documents: Array<Record<string, unknown>> = [
    {
      id: "old",
      createdAt: "2026-01-01T00:00:00Z",
      content: "must not be replaced",
    },
    {
      id: "current",
      createdAt: "2026-01-02T00:00:00Z",
      createdAtEpoch: 1767312000,
      content: "already backfilled",
    },
    { id: "missing", content: "no timestamp" },
    { id: "invalid", createdAt: "not a timestamp", content: "bad timestamp" },
  ];
  const pages: Array<{
    fields: string | null;
    limit: string | null;
    offset: string | null;
  }> = [];
  const updates: Array<Array<Record<string, unknown>>> = [];
  const tasks: number[] = [];
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      const url = new URL(request.url);
      if (
        url.pathname === "/indexes/flicklog_messages/documents" &&
        request.method === "GET"
      ) {
        pages.push({
          fields: url.searchParams.get("fields"),
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
        });
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        return Response.json({
          results: documents.slice(offset, offset + limit).map((document) => ({
            id: document.id,
            createdAt: document.createdAt,
            createdAtEpoch: document.createdAtEpoch,
          })),
          offset,
          limit,
          total: documents.length,
        });
      }
      if (
        url.pathname === "/indexes/flicklog_messages/documents" &&
        request.method === "PUT"
      ) {
        const payload = (await request.json()) as Array<
          Record<string, unknown>
        >;
        updates.push(payload);
        for (const item of payload) {
          expect(Object.keys(item).sort()).toEqual(["createdAtEpoch", "id"]);
          Object.assign(
            documents.find((document) => document.id === item.id)!,
            item,
          );
        }
        return Response.json({ taskUid: updates.length });
      }
      if (url.pathname.startsWith("/tasks/")) {
        tasks.push(Number(url.pathname.split("/").pop()));
        return Response.json({ status: "succeeded" });
      }
      return new Response("missing", { status: 404 });
    },
  });
  const output: string[] = [];
  const env = {
    FLICKLOG_MEILI_URL: `http://127.0.0.1:${server.port}`,
    FLICKLOG_MEILI_KEY: "test-key",
  };

  expect(await run(env, { log: (value) => output.push(value) }, 2)).toEqual({
    scanned: 4,
    updated: 1,
    skipped: 3,
  });
  expect(pages).toEqual([
    { fields: "id,createdAt,createdAtEpoch", limit: "2", offset: "0" },
    { fields: "id,createdAt,createdAtEpoch", limit: "2", offset: "2" },
  ]);
  expect(updates).toEqual([[{ id: "old", createdAtEpoch: 1767225600 }]]);
  expect(tasks).toEqual([1]);
  expect(documents[0]).toEqual({
    id: "old",
    createdAt: "2026-01-01T00:00:00Z",
    createdAtEpoch: 1767225600,
    content: "must not be replaced",
  });
  expect(JSON.parse(output[0])).toEqual({ scanned: 4, updated: 1, skipped: 3 });

  expect(await run(env, { log: (value) => output.push(value) }, 2)).toEqual({
    scanned: 4,
    updated: 0,
    skipped: 4,
  });
  expect(updates).toHaveLength(1);
});
