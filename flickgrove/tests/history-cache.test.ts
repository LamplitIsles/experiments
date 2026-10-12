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

test("reconnect latest pages fill the middle gap in native order and then resume the older cursor", async () => {
  const cache = new HistoryCache();
  const entry = cache.get("peer:agent", "thread");
  const m = (id: string) => ({
    id,
    role: "assistant" as const,
    text: id,
    at: 0,
  });
  await cache.load("peer:agent", entry, async () => ({
    messages: [m("old-1"), m("old-2")],
    nextCursor: "older-history",
  }));
  entry.synchronized = 1;
  await cache.refresh("peer:agent", entry, 2, async () => ({
    messages: [m("new-4"), m("new-5")],
    nextCursor: "gap-3",
  }));
  expect(entry.messages.map((m) => m.id)).toEqual([
    "old-1",
    "old-2",
    "new-4",
    "new-5",
  ]);
  await cache.load("peer:agent", entry, async (cursor) => {
    expect(cursor).toBe("gap-3");
    return { messages: [m("new-3")], nextCursor: "gap-2" };
  });
  expect(entry.messages.map((m) => m.id)).toEqual([
    "old-1",
    "old-2",
    "new-3",
    "new-4",
    "new-5",
  ]);
  await cache.load("peer:agent", entry, async (cursor) => {
    expect(cursor).toBe("gap-2");
    return { messages: [m("old-2")], nextCursor: "unused-native-cursor" };
  });
  expect(entry.messages.map((m) => m.id)).toEqual([
    "old-1",
    "old-2",
    "new-3",
    "new-4",
    "new-5",
  ]);
  expect(entry.cursor).toBe("older-history");
});

test("removed provisional input is not retained as historical reading while native rows remain readable", async () => {
  const cache = new HistoryCache();
  const entry = cache.get("peer:a", "thread");
  await cache.load("peer:a", entry, async () => ({
    messages: [
      { id: "native", role: "assistant", text: "native", at: 1 },
      {
        id: "operation",
        clientId: "operation",
        provisional: true,
        role: "user",
        text: "recover",
        at: 2,
      },
    ],
    nextCursor: null,
  }));
  cache.remember("peer:a", entry, [
    { id: "native", role: "assistant", text: "native", at: 1 },
  ]);
  expect(entry.messages.map((m) => m.id)).toEqual(["native"]);
});
