import { expect, test } from "bun:test";
import { HistoryCache } from "../src/history-cache";
const message = (id: string) => ({
  id,
  role: "assistant" as const,
  text: id,
  at: 0,
});
test("history pages retain cursor, deduplicate in-flight reads and keep data on failure", async () => {
  const cache = new HistoryCache();
  const entry = cache.get("peer:a", "boundary");
  let resolve!: (page: {
    messages: ReturnType<typeof message>[];
    nextCursor: string | null;
  }) => void;
  const pending = cache.load(
    "peer:a",
    entry,
    () => new Promise((done) => (resolve = done)),
  );
  expect(
    cache.load("peer:a", entry, () => {
      throw new Error("duplicate request");
    }),
  ).toBe(pending);
  resolve({ messages: [message("recent")], nextCursor: "earlier" });
  await pending;
  expect(cache.get("peer:a", "boundary")).toBe(entry);
  await cache.load("peer:a", entry, async (cursor) => {
    expect(cursor).toBe("earlier");
    throw new Error("offline");
  });
  expect(entry.messages.map((m) => m.id)).toEqual(["recent"]);
  expect(entry.cursor).toBe("earlier");
  expect(entry.error).toBe("offline");
  await cache.load("peer:a", entry, async () => ({
    messages: [message("old"), message("recent")],
    nextCursor: null,
  }));
  expect(entry.messages.map((m) => m.id)).toEqual(["old", "recent"]);
  expect(entry.error).toBe("");
});
test("Peer, boundary and removed identities reject stale results; count and size evict oldest", async () => {
  const cache = new HistoryCache(2, 1000);
  const a = cache.get("peer:a", "old");
  const remote = cache.get("remote:a", "old");
  expect(remote).not.toBe(a);
  let release!: () => void;
  const pending = cache.load("peer:a", a, async () => {
    await new Promise<void>((done) => (release = done));
    return { messages: [message("stale")], nextCursor: null };
  });
  const replaced = cache.get("peer:a", "new");
  release();
  await pending;
  expect(replaced.messages).toEqual([]);
  expect(a.messages).toEqual([]);
  cache.get("third:a", "old");
  expect(cache.has("remote:a", remote)).toBe(false);
  cache.retain(new Set(["third:a"]));
  expect(cache.has("peer:a", replaced)).toBe(false);
  const huge = cache.get("huge:a", "old");
  await cache.load("huge:a", huge, async () => ({
    messages: [message("x".repeat(1000))],
    nextCursor: "more",
  }));
  expect(cache.has("huge:a", huge)).toBe(false);
  expect(huge.loaded).toBe(true); // current reader still has its response
  await cache.load("huge:a", huge, async () => ({
    messages: [message("earlier")],
    nextCursor: null,
  }));
  expect(huge.messages[0].id).toBe("earlier");
});
test("removed conversations cannot publish an in-flight page into a reopened identity", async () => {
  const cache = new HistoryCache();
  const closed = cache.get("peer:a", "boundary");
  let release!: () => void;
  const pending = cache.load("peer:a", closed, async () => {
    await new Promise<void>((done) => (release = done));
    return { messages: [message("closed")], nextCursor: null };
  });
  cache.retain(new Set());
  const reopened = cache.get("peer:a", "boundary");
  release();
  await pending;
  expect(closed.loaded).toBe(false);
  expect(reopened.messages).toEqual([]);
});
