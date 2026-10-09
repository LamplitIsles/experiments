import { expect, test } from "bun:test";
import type { Detail, Message } from "../src/contracts";
import { ReadingCache } from "../src/reading-cache";
import { splitMessages } from "../src/conversation-messages";
import {
  retainTranscriptPositions,
  saveTranscriptPosition,
  transcriptPositions,
} from "../src/transcript-state";

test("authoritative removal prevents timeline teardown from restoring a closed position", () => {
  const position = {
    scroll: 120,
    follow: false,
    measurements: [],
    headerHeight: 0,
    width: 800,
    height: 600,
    reports: new Set<string>(),
  };
  saveTranscriptPosition("position-peer:closed", position);
  saveTranscriptPosition("other-position-peer:open", position);
  retainTranscriptPositions("position-peer", new Set(["position-peer:open"]));
  // The mounted timeline destroys after App adopts the authoritative removal.
  saveTranscriptPosition("position-peer:closed", position);
  expect(transcriptPositions.has("position-peer:closed")).toBe(false);
  saveTranscriptPosition("position-peer:open", position);
  expect(transcriptPositions.get("position-peer:open")).toBe(position);
  expect(transcriptPositions.get("other-position-peer:open")).toBe(position);
  // Navigation and disconnection do not supply authoritative removal.
  saveTranscriptPosition("position-peer:open", { ...position, scroll: 240 });
  expect(transcriptPositions.get("position-peer:open")?.scroll).toBe(240);
  transcriptPositions.clear();
});

class MemoryStorage implements Storage {
  records = new Map<string, string>();
  quota = Infinity;
  unavailable = false;
  get length() {
    return this.records.size;
  }
  key(index: number) {
    return [...this.records.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.records.get(key) ?? null;
  }
  removeItem(key: string) {
    this.records.delete(key);
  }
  clear() {
    this.records.clear();
  }
  setItem(key: string, value: string) {
    if (this.unavailable)
      throw new DOMException("Storage unavailable", "SecurityError");
    const entries = new Map(this.records).set(key, value);
    const size = [...entries].reduce(
      (sum, [k, v]) => sum + (k.length + v.length) * 2,
      0,
    );
    if (size > this.quota)
      throw new DOMException("exceeded the quota", "QuotaExceededError");
    this.records = entries;
  }
}
const prefix = "flickgrove/http://fixture.invalid";
const message = (id: string, text = id): Message => ({
  id,
  role: "user",
  text,
  at: 1,
});
function detail(id = "peer:orc"): Detail {
  return {
    id,
    role: "orc",
    project: { alias: "fixture", name: "Fixture", path: "/fixture" },
    title: "Reading",
    model: "fixture",
    effort: "low",
    serviceTier: "default",
    state: "idle",
    closed: false,
    questions: [],
    messages: [message("op")],
    deliveries: [],
  };
}
test("ID boundaries survive prefix insertion and reject a missing boundary", () => {
  const messages = [
    message("inserted"),
    message("old"),
    message("boundary"),
    message("op-1"),
    message("op-2"),
  ];
  expect(
    splitMessages({ messages, historyBoundaryId: "boundary" }).live.map(
      (m) => m.id,
    ),
  ).toEqual(["op-1", "op-2"]);
  expect(splitMessages({ messages }).historical).toEqual([]);
  expect(() =>
    splitMessages({ messages, historyBoundaryId: "missing" }),
  ).toThrow("boundary is missing");
});
test("reading copies keep a bounded suffix and Worker identity without mutating online detail", () => {
  const storage = new MemoryStorage(),
    cache = new ReadingCache(storage, prefix);
  const online = detail();
  online.historyCursor = "native-cursor";
  online.historyBoundaryId = "old";
  online.messages = [
    message("old", "x".repeat(160_000)),
    message("report"),
    message("recent"),
  ];
  online.deliveries = [
    {
      id: "report",
      source: "worker",
      reportingWorkerId: "peer:worker",
      status: "sent",
      text: "duplicate report",
      at: 1,
      questionIds: [],
    },
    {
      id: "recent",
      source: "user",
      status: "sent",
      text: "recent",
      at: 2,
      questionIds: [],
    },
    {
      id: "failed",
      source: "user",
      status: "failed",
      text: "recover me",
      at: 3,
      questionIds: [],
    },
  ];
  const before = structuredClone(online);
  cache.saveDetail(online);
  const saved = cache.readDetail(online.id)!;
  expect(saved.messages.map((m) => m.id)).toEqual(["report", "recent"]);
  expect(saved).not.toHaveProperty("historyBoundaryId");
  expect(saved).not.toHaveProperty("historyCursor");
  expect(
    saved.deliveries.map((d) => [d.id, d.text, d.reportingWorkerId]),
  ).toEqual([
    ["report", "", "peer:worker"],
    ["failed", "recover me", undefined],
  ]);
  expect(online).toEqual(before);
  const raw = storage.getItem(`${prefix}/detail/${online.id}`)!;
  expect(raw.length * 2).toBeLessThanOrEqual(256 * 1024);
});
test("aggregate byte budget evicts least recently accessed details across reloads", () => {
  const storage = new MemoryStorage(),
    cache = new ReadingCache(storage, prefix);
  for (let i = 0; i < 12; i++) {
    const value = detail(`peer:${i}`);
    value.messages = [message("big", "x".repeat(110_000))];
    cache.saveDetail(value);
  }
  expect(cache.readDetail("peer:0")).toBeNull();
  expect(cache.readDetail("peer:11")).not.toBeNull();
  expect(
    [...storage.records].reduce(
      (sum, [key, value]) => sum + (key.length + value.length) * 2,
      0,
    ),
  ).toBeLessThanOrEqual(2 * 1024 * 1024);
  const reloaded = new ReadingCache(storage, prefix);
  expect(reloaded.readDetail("peer:11")).not.toBeNull();
});
test("authoritative closure prevents late details from reviving cache and isolates Peers and device data", () => {
  const storage = new MemoryStorage(),
    cache = new ReadingCache(storage, prefix);
  for (const suffix of [
    "composer/peer:closed",
    "outgoing/peer%3Aclosed/op",
    "accepted/peer%3Aclosed/op",
    "peers",
  ])
    storage.setItem(`${prefix}/${suffix}`, "protected");
  cache.saveDetail(detail("peer:closed"));
  cache.saveDetail(detail("peer:open"));
  cache.saveDetail(detail("other:closed"));
  cache.prunePeer("peer", new Set(["peer:open"]));
  cache.saveDetail(detail("peer:closed"));
  expect(cache.readDetail("peer:closed")).toBeNull();
  expect(cache.readDetail("peer:open")).not.toBeNull();
  expect(cache.readDetail("other:closed")).not.toBeNull();
  expect(
    [...storage.records.values()].filter((v) => v === "protected"),
  ).toHaveLength(4);
});
test("quota recovery reclaims only reading copies; unavailable storage never throws on cache writes", () => {
  const storage = new MemoryStorage(),
    cache = new ReadingCache(storage, prefix);
  cache.saveDetail(detail());
  storage.setItem(`${prefix}/peers`, "credential");
  storage.quota = 400;
  expect(() =>
    cache.saveSnapshot({ agents: [], settings: null, revision: 1 }),
  ).not.toThrow();
  expect(cache.readSnapshot()?.revision).toBe(1);
  expect(storage.getItem(`${prefix}/peers`)).toBe("credential");
  expect(cache.readDetail("peer:orc")).toBeNull();
  storage.unavailable = true;
  expect(() => cache.saveDetail(detail())).not.toThrow();
  expect(() => cache.savePeerSnapshot("peer", [], 1)).not.toThrow();
  expect(() =>
    cache.writeDevice(`${prefix}/outgoing/op`, "must persist"),
  ).toThrow();
});
test("obsolete oversized copies are reclaimed and one oversized message is not partially saved", () => {
  const storage = new MemoryStorage();
  storage.setItem(`${prefix}/detail/obsolete`, JSON.stringify(detail()));
  const cache = new ReadingCache(storage, prefix);
  expect(storage.getItem(`${prefix}/detail/obsolete`)).toBeNull();
  const online = detail();
  online.messages[0].text = "x".repeat(200_000);
  cache.saveDetail(online);
  expect(cache.readDetail(online.id)).toBeNull();
  expect(online.messages[0].text).toHaveLength(200_000);
});
