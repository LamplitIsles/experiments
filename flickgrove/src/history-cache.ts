import type { HistoryMessages, Message } from "./contracts";

export type LoadedHistory = {
  boundary: string;
  invalidated?: boolean;
  messages: Message[];
  cursor: string | null;
  loaded: boolean;
  error: string;
  pending?: Promise<void>;
};

// Native history only: no DOM, live messages, or persistent message copies.
export class HistoryCache {
  private entries = new Map<string, LoadedHistory>();
  constructor(
    private capacity = 12,
    private byteLimit = 8 * 1024 * 1024,
  ) {}
  get(id: string, boundary: string): LoadedHistory {
    let entry = this.entries.get(id);
    if (entry?.boundary !== boundary) {
      if (entry) entry.invalidated = true;
      entry = {
        boundary,
        messages: [],
        cursor: null,
        loaded: false,
        error: "",
      };
    }
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.trim();
    return entry;
  }
  has(id: string, entry: LoadedHistory) {
    return this.entries.get(id) === entry;
  }
  retain(ids: Set<string>) {
    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) {
        entry.invalidated = true;
        this.entries.delete(id);
      }
    }
  }
  load(
    id: string,
    entry: LoadedHistory,
    fetch: (cursor?: string) => Promise<HistoryMessages>,
  ): Promise<void> {
    if (entry.pending) return entry.pending;
    if (entry.invalidated || (entry.loaded && !entry.cursor))
      return Promise.resolve();
    entry.error = "";
    const request = fetch(entry.loaded ? entry.cursor! : undefined)
      .then((page) => {
        if (entry.invalidated) return;
        entry.messages = [
          ...new Map(
            [...page.messages, ...entry.messages].map((message) => [
              message.id,
              message,
            ]),
          ).values(),
        ];
        entry.cursor = page.nextCursor;
        entry.loaded = true;
        if (this.has(id, entry)) this.trim();
      })
      .catch((error) => {
        if (!entry.invalidated)
          entry.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        entry.pending = undefined;
      });
    entry.pending = request;
    return request;
  }
  private trim() {
    let bytes = [...this.entries.values()].reduce(
      (sum, entry) => sum + JSON.stringify(entry.messages).length * 2,
      0,
    );
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= this.capacity && bytes <= this.byteLimit) break;
      bytes -= JSON.stringify(entry.messages).length * 2;
      this.entries.delete(id);
    }
  }
}
export const historyCache = new HistoryCache();
