import type { Agent, Detail, Snapshot } from "./contracts";
import { detailSchema, snapshotSchema } from "./chord-contract";

const DETAIL_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 2 * 1024 * 1024;
type Stored = { at: number; value: unknown };
const bytes = (key: string, raw: string) => (key.length + raw.length) * 2;
const quota = (error: unknown) =>
  error instanceof Error && error.name === "QuotaExceededError";

// A captured reading tail is displayed directly. Native history is fetched
// separately when authoritative online detail arrives.
export type ReadingDetail = Omit<Detail, "historyCursor" | "historyBoundaryId">;
function readingCopy(detail: Detail, start: number): ReadingDetail {
  const {
    historyCursor: _cursor,
    historyBoundaryId: _boundary,
    ...value
  } = detail;
  const messages = detail.messages.slice(start);
  const ids = new Set(messages.map((m) => m.id));
  return {
    ...value,
    messages,
    deliveries: detail.deliveries.flatMap((d) => {
      if (d.status !== "sent") return [d];
      if (d.source !== "worker" || !ids.has(d.id)) return [];
      return [{ ...d, text: "", answers: undefined, images: undefined }];
    }),
  };
}

// One concrete repository for reconstructible browser data. Submission journals,
// drafts, credentials and preferences are never owned or evicted here.
export class ReadingCache {
  private active = new Map<string, Set<string>>();
  constructor(
    private storage: Storage,
    private prefix: string,
  ) {
    this.trim(0);
  }
  private owns(key: string) {
    return (
      key === `${this.prefix}/snapshot` ||
      key.startsWith(`${this.prefix}/detail/`) ||
      key.startsWith(`${this.prefix}/peer-cache/`)
    );
  }
  private keys() {
    try {
      return Array.from({ length: this.storage.length }, (_, i) =>
        this.storage.key(i),
      ).filter((key): key is string => !!key && this.owns(key));
    } catch {
      return [];
    }
  }
  private remove(key: string) {
    try {
      this.storage.removeItem(key);
    } catch {
      /* Reading storage is optional. */
    }
  }
  private records() {
    return this.keys().flatMap((key) => {
      try {
        const raw = this.storage.getItem(key)!;
        const record: Stored = JSON.parse(raw);
        if (!Number.isFinite(record.at) || !("value" in record))
          throw new Error("Invalid reading copy");
        return [{ key, raw, ...record }];
      } catch {
        this.remove(key);
        return [];
      }
    });
  }
  private trim(required: number) {
    const records = this.records().sort((a, b) => {
      const detail = (key: string) => key.startsWith(`${this.prefix}/detail/`);
      return Number(detail(b.key)) - Number(detail(a.key)) || a.at - b.at;
    });
    let total = records.reduce((sum, r) => sum + bytes(r.key, r.raw), required);
    for (const record of records) {
      if (total <= TOTAL_LIMIT) break;
      this.remove(record.key);
      total -= bytes(record.key, record.raw);
    }
  }
  reclaim() {
    for (const key of this.keys()) this.remove(key);
  }
  // Required device data may reclaim reading copies, but failure is still visible
  // to its caller. It must not be silently treated as a durable submission.
  writeDevice(key: string, value: string) {
    try {
      this.storage.setItem(key, value);
    } catch (error) {
      if (!quota(error)) throw error;
      this.reclaim();
      this.storage.setItem(key, value);
    }
  }
  private save(key: string, value: unknown, at = Date.now()) {
    const raw = JSON.stringify({ at, value });
    this.remove(key);
    if (bytes(key, raw) > TOTAL_LIMIT) return;
    this.trim(bytes(key, raw));
    try {
      this.writeDevice(key, raw);
    } catch {
      /* Do not interrupt live updates. */
    }
  }
  private read(key: string) {
    try {
      const raw = this.storage.getItem(key);
      if (!raw) return null;
      const record: Stored = JSON.parse(raw);
      if (!Number.isFinite(record.at) || !("value" in record))
        throw new Error("Invalid reading copy");
      this.save(key, record.value);
      return record.value;
    } catch {
      this.remove(key);
      return null;
    }
  }
  readDetail(id: string): ReadingDetail | null {
    const result = detailSchema.safeParse(
      this.read(`${this.prefix}/detail/${id}`),
    );
    return result.success && result.data.id === id
      ? readingCopy(result.data, 0)
      : null;
  }
  saveDetail(detail: Detail) {
    const host = detail.id.split(":")[0];
    if (this.active.has(host) && !this.active.get(host)!.has(detail.id)) return;
    const key = `${this.prefix}/detail/${detail.id}`,
      at = Date.now();
    const fits = (start: number) =>
      bytes(key, JSON.stringify({ at, value: readingCopy(detail, start) })) <=
      DETAIL_LIMIT;
    let start = 0,
      end = detail.messages.length;
    while (start < end) {
      const middle = Math.floor((start + end) / 2);
      if (fits(middle)) end = middle;
      else start = middle + 1;
    }
    if (
      !fits(start) ||
      (detail.messages.length && start === detail.messages.length)
    ) {
      this.remove(key);
      return;
    }
    this.save(key, readingCopy(detail, start), at);
  }
  readSnapshot(): Snapshot | null {
    const result = snapshotSchema.safeParse(
      this.read(`${this.prefix}/snapshot`),
    );
    return result.success ? result.data : null;
  }
  saveSnapshot(snapshot: Snapshot) {
    this.save(`${this.prefix}/snapshot`, snapshot);
  }
  readPeerSnapshot(id: string): { agents: Agent[]; lastSeen?: number } {
    const value = this.read(`${this.prefix}/peer-cache/${id}`) as {
      agents?: unknown;
      lastSeen?: number;
    } | null;
    const result = snapshotSchema.safeParse({
      agents: value?.agents,
      settings: null,
      revision: 0,
    });
    return {
      agents: result.success ? result.data.agents : [],
      lastSeen: Number.isFinite(value?.lastSeen) ? value!.lastSeen : undefined,
    };
  }
  savePeerSnapshot(id: string, agents: Agent[], lastSeen?: number) {
    this.save(`${this.prefix}/peer-cache/${id}`, { agents, lastSeen });
  }
  // Only call with a connected Peer's authoritative active identities.
  prunePeer(id: string, activeIds: Set<string>) {
    this.active.set(id, new Set(activeIds));
    const prefix = `${this.prefix}/detail/${id}:`;
    for (const key of this.keys()) {
      if (
        key.startsWith(prefix) &&
        !activeIds.has(key.slice(`${this.prefix}/detail/`.length))
      )
        this.remove(key);
    }
  }
}
