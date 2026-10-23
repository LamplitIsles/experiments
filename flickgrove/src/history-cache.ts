import type { HistoryMessages, Message, MessageWindow } from "./contracts";

export type LoadedHistory = {
  boundary: string;
  invalidated?: boolean;
  messages: Message[];
  cursor: string | null;
  loaded: boolean;
  error: string;
  pending?: Promise<void>;
  synchronized?: number;
  generation?: number;
  window?: {
    olderCursor: string | null;
    newerCursor: string | null;
    joined?: boolean;
    pages: {
      ids: string[];
      olderCursor: string | null;
      newerCursor: string | null;
    }[];
  };
  gap?: { until: string; olderCursor: string | null; before: string };
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
  reconnect(peer: string) {
    for (const [id, entry] of this.entries)
      if (id.startsWith(peer + ":")) {
        entry.generation = (entry.generation ?? 0) + 1;
        entry.synchronized = undefined;
      }
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
  remember(id: string, entry: LoadedHistory, messages: Message[]) {
    if (!this.has(id, entry) || entry.invalidated) return;
    const ids = new Set(messages.map((m) => m.id));
    const clients = new Set(
      messages.filter((m) => !m.provisional).map((m) => m.clientId),
    );
    entry.messages = [
      ...entry.messages.filter(
        (m) => !ids.has(m.id) && !clients.has(m.id) && !m.provisional,
      ),
      ...messages,
    ];
    this.trim();
  }
  replaceWindow(
    id: string,
    entry: LoadedHistory,
    page: MessageWindow,
    revision: number,
  ) {
    entry.generation = (entry.generation ?? 0) + 1;
    entry.loaded = true;
    entry.error = "";
    entry.synchronized = revision;
    entry.gap = undefined;
    entry.messages = page.messages;
    entry.window = {
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
      pages: [
        {
          ids: page.messages.map((m) => m.id),
          olderCursor: page.olderCursor,
          newerCursor: page.newerCursor,
        },
      ],
    };
    if (this.has(id, entry)) this.trim();
  }
  extendWindow(
    id: string,
    entry: LoadedHistory,
    page: MessageWindow,
    direction: "older" | "newer",
  ) {
    if (!entry.window) return;
    const segment = {
      ids: page.messages.map((m) => m.id),
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
    };
    const pages =
      direction === "older"
        ? [segment, ...entry.window.pages]
        : [...entry.window.pages, segment];
    const rows =
      direction === "older"
        ? [...page.messages, ...entry.messages]
        : [...entry.messages, ...page.messages];
    entry.messages = [...new Map(rows.map((m) => [m.id, m])).values()];
    // Drop whole pages at the opposite boundary. Their exact native continuation
    // is retained on the remaining boundary; no fabricated offset or gap join.
    while (
      pages.length > 1 &&
      JSON.stringify(entry.messages).length * 2 > this.byteLimit
    ) {
      if (direction === "older") pages.pop();
      else pages.shift();
      const keep = new Set(pages.flatMap((p) => p.ids));
      entry.messages = entry.messages.filter((m) => keep.has(m.id));
    }
    entry.window = {
      pages,
      olderCursor: pages[0].olderCursor,
      newerCursor: pages[pages.length - 1].newerCursor,
    };
    if (this.has(id, entry)) this.trim();
  }
  load(
    id: string,
    entry: LoadedHistory,
    fetch: (cursor?: string) => Promise<HistoryMessages>,
    revision?: number,
  ): Promise<void> {
    if (entry.pending) return entry.pending;
    if (entry.invalidated || (entry.loaded && !entry.cursor))
      return Promise.resolve();
    entry.error = "";
    const generation = entry.generation ?? 0;
    const request = fetch(entry.loaded ? entry.cursor! : undefined)
      .then((page) => {
        if (entry.invalidated || (entry.generation ?? 0) !== generation) return;
        if (entry.gap) {
          const gap = entry.gap;
          const returned = new Set(page.messages.map((m) => m.id));
          const prefix = entry.messages
            .slice(
              0,
              Math.max(
                0,
                entry.messages.findIndex((m) => m.id === gap.before),
              ),
            )
            .filter((m) => !returned.has(m.id));
          const suffix = entry.messages.filter(
            (m) => !returned.has(m.id) && !prefix.some((p) => p.id === m.id),
          );
          entry.messages = [...prefix, ...page.messages, ...suffix];
          if (returned.has(gap.until) || !page.nextCursor) {
            entry.gap = undefined;
            entry.cursor = gap.olderCursor;
          } else {
            gap.before = page.messages[0]?.id ?? gap.before;
            entry.cursor = page.nextCursor;
          }
        } else {
          entry.messages = [
            ...new Map(
              [...page.messages, ...entry.messages].map((message) => [
                message.id,
                message,
              ]),
            ).values(),
          ];
          entry.cursor = page.nextCursor;
        }
        entry.loaded = true;
        if (revision !== undefined) entry.synchronized = revision;
        if (this.has(id, entry)) this.trim();
      })
      .catch((error) => {
        if (
          !entry.invalidated &&
          (entry.generation ?? 0) === generation &&
          !(error instanceof Error && error.name === "AbortError")
        )
          entry.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (entry.pending === request) entry.pending = undefined;
      });
    entry.pending = request;
    return request;
  }
  refresh(
    id: string,
    entry: LoadedHistory,
    revision: number,
    fetch: () => Promise<HistoryMessages>,
  ): Promise<void> {
    if (entry.pending) return entry.pending;
    const generation = entry.generation ?? 0;
    const known = new Set(entry.messages.map((m) => m.id));
    const until = entry.messages.at(-1)?.id;
    const request = fetch()
      .then((page) => {
        if (entry.invalidated || (entry.generation ?? 0) !== generation) return;
        const overlap = page.messages.some((m) => known.has(m.id));
        const returned = new Set(page.messages.map((m) => m.id));
        entry.messages = [
          ...entry.messages.filter((m) => !returned.has(m.id)),
          ...page.messages,
        ];
        if (!overlap && until && page.messages.length && page.nextCursor) {
          entry.gap = {
            until,
            olderCursor: entry.cursor,
            before: page.messages[0].id,
          };
          entry.cursor = page.nextCursor;
        }
        entry.synchronized = revision;
        entry.error = "";
        if (this.has(id, entry)) this.trim();
      })
      .catch((error) => {
        if (
          !entry.invalidated &&
          (entry.generation ?? 0) === generation &&
          !(error instanceof Error && error.name === "AbortError")
        )
          entry.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        if (entry.pending === request) entry.pending = undefined;
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
