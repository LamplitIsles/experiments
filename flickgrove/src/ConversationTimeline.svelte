<script lang="ts">
  import { createVirtualizer, defaultRangeExtractor, observeElementRect, measureElement as measureSize, type Virtualizer } from "@tanstack/svelte-virtual";
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { HistoryMessages, Message } from "./contracts";
  import { api } from "./api";
  import { historyCache, type LoadedHistory } from "./history-cache";
  import { transcriptPositions, saveTranscriptPosition } from "./transcript-state";
  import * as m from "./paraglide/messages";
  let { agentId, boundary, live, ready, connected, renderMessage, header, footer, onfollow, reports, pinned }: {
    agentId: string; boundary?: string; live: Message[]; ready: boolean; connected: boolean;
    renderMessage: Snippet<[Message]>; header: Snippet; footer: Snippet; onfollow: (follow: boolean) => void; reports: Set<string>; pinned?: string;
  } = $props();
  const id = untrack(() => agentId);
  const initiallyReady = untrack(() => ready);
  const saved = untrack(() => transcriptPositions.get(id));
  let history = $state.raw<LoadedHistory | null>(untrack(() => boundary ? historyCache.get(id, boundary) : null));
  let historical = $state.raw(untrack(() => history?.messages ?? []));
  let cursor = $state(untrack(() => history?.cursor ?? null)), error = $state(untrack(() => history?.error ?? "")), loading = $state(false);
  let active = true, attempted: LoadedHistory | null = null;
  const messages = $derived([...new Map([...historical, ...live].map(message => [message.id, message])).values()]);
  let transcript = $state<HTMLDivElement>();
  let tail: HTMLDivElement;
  const headerKey = "timeline-header";
  let footerHeight = $state(0);
  let lastWidth = saved?.width ?? 800, lastHeight = saved?.height ?? 600;
  const estimate = 320;
  const initialMessages = untrack(() => messages);
  // Map a retained message anchor into newly prepended data while away. The
  // virtualizer's measured sizes seed the coordinates; ongoing compensation is
  // exclusively TanStack's end anchoring / dynamic measurement.
  function initialOffset() {
    if (!saved || saved.follow) return initialMessages.length * estimate;
    const index = initialMessages.findIndex(message => message.id === saved.anchor?.id);
    if (index < 0) return saved.scroll;
    const sizes = new Map(saved.measurements.map(item => [item.key, item.size]));
    return (sizes.get(headerKey) ?? saved.headerHeight) + 24 + initialMessages.slice(0, index).reduce((sum, message) => sum + (sizes.get(message.id) ?? estimate), 0) + saved.anchor!.offset;
  }
  // Published core 3.17.11 takeSnapshot contains only actually measured items.
  const measuredKeys = new Set(saved?.measurements.map(item => item.key));
  let firstMeasurement: string | number | bigint | undefined;
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: initialMessages.length + 1, getScrollElement: () => transcript ?? null,
    getItemKey: index => index === 0 ? headerKey : initialMessages[index - 1].id,
    estimateSize: index => index === 0 ? (saved?.headerHeight ?? 0) : estimate,
    measureElement: (node, entry, instance) => {
      const key = instance.options.getItemKey(Number(node.dataset.index));
      firstMeasurement = measuredKeys.has(key) ? undefined : key;
      measuredKeys.add(key); // The independent flag is consumed by resizeItem's predicate.
      return measureSize(node, entry, instance);
    },
    overscan: 4, anchorTo: "end", followOnAppend: true, scrollEndThreshold: 80,
    initialOffset, initialRect: { width: saved?.width ?? 800, height: saved?.height ?? 600 },
    initialMeasurementsCache: saved?.measurements ?? [],
    // Rect callbacks may not publish when the virtual range is unchanged.
    // Wrap the documented observer, retaining its one subscription/cleanup.
    observeElementRect: (instance, changed) => observeElementRect(instance, rect => {
      const resizePinned = rect.width > 0 && rect.height > 0 && (rect.width !== lastWidth || rect.height !== lastHeight) && lastFollow;
      if (rect.width && rect.height) { lastWidth = rect.width; lastHeight = rect.height; }
      changed(rect);
      if (resizePinned) void tick().then(() => { if (active && ready && transcript?.isConnected) $virtualizer.scrollToEnd(); });
    }),
    paddingStart: 24, paddingEnd: 24,
  });
  // Preserve the reading point when an item entirely above it changes size,
  // including while scrolling backward. Growth spanning the fold stays below
  // the reading point; TanStack separately handles following at the end.
  const instance = $virtualizer;
  instance.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const first = firstMeasurement === item.key;
    firstMeasurement = undefined;
    return active && (first ? item.start < (instance.scrollOffset ?? 0) : item.end <= (instance.scrollOffset ?? 0));
  };
  let prependCommit = false;
  let leadingMessageAnchor: { key: string | number | bigint; offset: number } | undefined;
  $effect.pre(() => {
    const current = messages, element = transcript, pin = pinned, end = footerHeight + 24;
    untrack(() => {
      const previous = $virtualizer.options;
      const prepending = previous.count > 1 && current.length + 1 > previous.count && current[0]?.id !== previous.getItemKey(1);
      if (prepending) {
        // At the top the library would retain the persistent header. Retain
        // the first message identity/relative offset, as on route restoration.
        // Capture at data commit, after any reading during the fetch.
        const snapshot = $virtualizer.takeSnapshot(), first = snapshot.find(item => item.index === 1), header = snapshot.find(item => item.key === headerKey);
        const scroll = $virtualizer.scrollOffset ?? 0;
        if (first && header && scroll < header.end) leadingMessageAnchor = { key: first.key, offset: scroll - first.start };
      }
      prependCommit ||= prepending;
      $virtualizer.setOptions({
        count: current.length + 1, getItemKey: index => index === 0 ? headerKey : current[index - 1].id,
        getScrollElement: () => element ?? null, paddingEnd: end,
        rangeExtractor: range => {
          const indexes = defaultRangeExtractor(range), messageIndex = current.findIndex(message => message.id === pin);
          const index = messageIndex < 0 ? -1 : messageIndex + 1;
          return index < 0 || indexes.includes(index) ? indexes : [...indexes, index].sort((a, b) => a - b);
        },
        onChange: virtualChanged,
      });
    });
  });
  function virtualChanged(instance: Virtualizer<HTMLDivElement, HTMLDivElement>) {
    if (active && transcript?.isConnected && transcript.clientHeight) onfollow(instance.isAtEnd());
  }
  // The published Svelte adapter applies options before Svelte commits the
  // sizer. A public options refresh after a size commit lets the adapter retry
  // a scroll clamped against the previous DOM height. Guard the store update
  // and retain the same user callback (not its adapter wrapper). See published
  // @tanstack/svelte-virtual 3.13.39 src/index.ts; no lifecycle hook/subscription.
  let committedSize = -1;
  $effect(() => {
    const size = $virtualizer.getTotalSize();
    if (size === committedSize) return;
    committedSize = size;
    untrack(() => {
      $virtualizer.setOptions({ onChange: virtualChanged });
      // Prepend anchoring eagerly computes the library offset, but the adapter
      // can write it against the old sizer. Sync that same offset after commit.
      if (prependCommit && active && transcript?.isConnected) {
        prependCommit = false;
        const item = leadingMessageAnchor && $virtualizer.takeSnapshot().find(item => item.key === leadingMessageAnchor!.key);
        $virtualizer.scrollToOffset(item ? item.start + leadingMessageAnchor!.offset : ($virtualizer.scrollOffset ?? 0));
        leadingMessageAnchor = undefined;
      }
    });
  });
  $effect.pre(() => {
    const b = boundary;
    if (b !== history?.boundary) untrack(() => {
      history = b ? historyCache.get(id, b) : null;
      historical = history?.messages ?? []; cursor = history?.cursor ?? null; error = history?.error ?? "";
    });
  });
  async function load() {
    const entry = history;
    if (!entry || !connected || loading) return;
    const initial = !entry.loaded;
    loading = true; error = "";
    await historyCache.load(id, entry, async cursor => {
      const params = new URLSearchParams(); if (cursor) params.set("cursor", cursor);
      return api<HistoryMessages>(`/agents/${encodeURIComponent(id)}/history?${params}`);
    });
    if (!active || entry !== history) return;
    historical = entry.messages; cursor = entry.cursor; error = entry.error; loading = false;
    if (initial && (!saved || saved.follow)) { await tick(); if (active) $virtualizer.scrollToEnd(); }
  }
  $effect(() => {
    const entry = history;
    if (ready && connected && entry && attempted !== entry && (!entry.loaded || entry.pending) && !entry.error) {
      attempted = entry; untrack(() => { void load(); });
    }
  });
  let lastScroll = initialOffset(), lastFollow = saved?.follow ?? true;
  function saveReading() {
    if (!transcript?.isConnected || !transcript.clientHeight || !ready) return;
    lastScroll = transcript.scrollTop;
    lastFollow = transcript.scrollHeight - lastScroll - transcript.clientHeight < 80;
    onfollow(lastFollow);
  }
  function measure(node: HTMLDivElement) {
    $virtualizer.measureElement(node);
    return { destroy: () => $virtualizer.measureElement(null) };
  }
  export function jumpToBottom() { $virtualizer.scrollToEnd(); }
  onMount(() => {
    footerHeight = tail.getBoundingClientRect().height;
    const observer = new ResizeObserver(() => {
      if (!active) return;
      footerHeight = tail.getBoundingClientRect().height;
    });
    observer.observe(tail);
    if (!saved || saved.follow) void tick().then(() => { if (active) $virtualizer.scrollToEnd(); });
    return () => {
      active = false; observer.disconnect();
      if (!transcript || !initiallyReady) return;
      const scroll = lastScroll;
      const measurements = $virtualizer.takeSnapshot();
      const item = measurements.find(item => item.key !== headerKey && item.end > scroll);
      saveTranscriptPosition(id, {
        scroll, follow: lastFollow,
        anchor: item ? { id: String(item.key), offset: scroll - item.start } : undefined,
        measurements, headerHeight: measurements.find(item => item.key === headerKey)?.size ?? 0,
        width: lastWidth, height: lastHeight,
        reports,
      });
    };
  });
</script>
<div class="conversation" bind:this={transcript} onscroll={saveReading}>
  <div class="message-timeline" class:historical-messages={!!boundary} style:height={`${$virtualizer.getTotalSize()}px`}>
    <!-- Always mounted, but measured as the leading item so header changes
         use the same library anchoring as messages, rather than padding. -->
    <div class="timeline-header" data-index="0" use:measure>
      {@render header()}
      {#if boundary}<div class="history-controls">
        {#if error}<span class="inline-error" role="alert">{error}</span><Button variant="ghost" size="sm" disabled={!connected || loading} onclick={load}>{m.retry()}</Button>
        {:else}{#if cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={load}>{m.earlier_messages()}</Button>{/if}
        {#if loading}<span role="status">{m.loading_history()}</span>{/if}{/if}
      </div>{/if}
    </div>
    {#each $virtualizer.getVirtualItems() as row (row.key)}
      {#if row.index > 0}<div class="timeline-message" data-index={row.index} data-message-id={row.key} style:transform={`translateY(${row.start}px)`} use:measure>
        {@render renderMessage(messages[row.index - 1])}
      </div>{/if}
    {/each}
    <div class="timeline-footer" bind:this={tail} style:top={`${$virtualizer.getTotalSize() - footerHeight - 24}px`}>{@render footer()}</div>
  </div>
</div>
<style>
  .conversation { padding: 0; overflow-anchor: none; }
  .message-timeline { position: relative; width: 100%; }
  .timeline-message, .timeline-header, .timeline-footer { position: absolute; left: 24px; right: 24px; display: flow-root; }
  .timeline-message { top: 0; }
  .timeline-header { top: 24px; }
  .history-controls { min-height: 32px; display: flex; align-items: center; gap: 8px; }
  @media (max-width: 700px) { .timeline-message, .timeline-header, .timeline-footer { left: 16px; right: 16px; } }
</style>
