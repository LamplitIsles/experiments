<script lang="ts">
  import { createVirtualizer, defaultRangeExtractor, observeElementRect, measureElement as measureSize, type Virtualizer } from "@tanstack/svelte-virtual";
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { LoaderCircle } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { HistoryMessages, Message, MessageWindow } from "./contracts";
  import { reading, readingCache } from "./api";
  import { historyCache, type LoadedHistory } from "./history-cache";
  import { transcriptPositions, saveTranscriptPosition } from "./transcript-state";
  import * as m from "./paraglide/messages";
  let { syncRevision = 0, agentId, boundary, live, ready, connected, detailError = "", renderMessage, header, footer, onfollow, onanchor = () => {}, reports, pinned }: {
    agentId: string; boundary?: string; syncRevision?: number; live: Message[]; ready: boolean; connected: boolean; detailError?: string;
    renderMessage: Snippet<[Message]>; header: Snippet; footer: Snippet<[boolean]>; onfollow: (follow: boolean) => void; onanchor?: (operation:string) => void; reports: Set<string>; pinned?: string;
  } = $props();
  const id = untrack(() => agentId);
  const initiallyReady = untrack(() => ready);
  const saved = untrack(() => transcriptPositions.get(id));
  let history = $state.raw<LoadedHistory | null>(untrack(() => boundary ? historyCache.get(id, boundary) : null));
  let historyLoaded = $state(untrack(() => !!history?.loaded));
  let historical = $state.raw(untrack(() => history?.messages ?? []));
  let cursor = $state(untrack(() => history?.cursor ?? null)), error = $state(untrack(() => history?.error ?? "")), loading = $state(false);
  let windowState = $state<LoadedHistory["window"]>(untrack(()=>history?.window));
  let errorDirection=$state<"older"|"newer">("older");
  let locating: AbortController | undefined;
  let locationGeneration = 0;
  const request = new AbortController();
  function cancelLocation() { locationGeneration++; locating?.abort(); locating=undefined; }
  export function cancelNavigation() { cancelLocation(); }
  $effect(()=>{if(!connected) untrack(cancelLocation);});
  export async function locate(operation:string) {
    cancelLocation();
    const generation = locationGeneration;
    let target = messages.find(m=>m.clientId===operation || (m.provisional && m.id===operation))?.id;
    if (!target) {
      if (!connected) throw new Error(m.outline_offline());
      locating = new AbortController();
      const page = await reading<MessageWindow>(`/window?${new URLSearchParams({agent:id,operation})}`,id,locating.signal);
      if (!active || generation!==locationGeneration) return false;
      if (!page.target || !page.messages.some(m=>m.id===page.target)) throw new Error(m.outline_unavailable());
      target=page.target;
      if(!history) return false;
      historyCache.replaceWindow(id,history,page,syncRevision);
      windowState=history.window;
      historical=history.messages; historyLoaded=true; error="";
    }
    lastFollow=false; onfollow(false);
    await tick();
    // The virtualizer mounts by index, then measurements refine the coordinates.
    // Limit correction to a few frames; any deliberate reading cancels it.
    for(let attempt=0;attempt<6;attempt++) {
      if(!active || generation!==locationGeneration || !transcript?.isConnected) return false;
      const index=messages.findIndex(m=>m.id===target)+1;
      if(index<1) return false;
      const item=$virtualizer.getVirtualItems().find(item=>item.index===index);
      const tall=!!item && item.size>transcript.clientHeight;
      $virtualizer.scrollToIndex(index,{align:tall?"start":"center"});
      if(tall && item) $virtualizer.scrollToOffset(Math.max(0,item.start-transcript.clientHeight*0.35));
      await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
      await tick();
    }
    if(generation!==locationGeneration) return false;
    onanchor(operation); return true;
  }
  async function loadWindow(direction:"older"|"newer") {
    const position=windowState?.[direction==="older"?"olderCursor":"newerCursor"];
    if(!position || !connected || loading) return;
    const generation=locationGeneration;
    loading=true; error="";
    try {
      const page=await reading<MessageWindow>(`/window?${new URLSearchParams({agent:id,cursor:position,direction})}`,id,request.signal);
      if(!active || generation!==locationGeneration) return;
      if(!history) return;
      historyCache.extendWindow(id,history,page,direction);
      historical=history.messages; windowState=history.window;
      // Join the live tail only after a real native overlap, never by adjacency.
      if(windowState && !windowState.newerCursor && historical.some(m=>live.some(l=>l.id===m.id))) windowState.joined=true;
    } catch(e) { if(active && generation===locationGeneration) {errorDirection=direction;error=(e as Error).message;} }
    finally { if(active) loading=false; }
  }
  let active = true, attempted: LoadedHistory | null = null;
  let retained = $state.raw<Message[]>([]);
  // Server recovery metadata can refer to native items outside the recent
  // window. Check the first page before presenting those as pending rows.
  const readingSettled = $derived(!boundary || historyLoaded || !!error || !connected);
  const initialLoading = $derived(connected && !detailError && !live.length && !historical.length && !retained.length && (!ready || !readingSettled));
  $effect.pre(() => {
    const current = live, revision = syncRevision;
    untrack(() => {
      const ids = new Set(current.map(m => m.id)), clients = new Set(current.filter(m => !m.provisional).map(m => m.clientId));
      historical = historical.filter(m => !m.provisional || ids.has(m.id));
      retained = [...retained.filter(m => !ids.has(m.id) && !clients.has(m.id) && !m.provisional), ...current];
      let bytes = retained.reduce((sum, m) => sum + JSON.stringify(m).length * 2, 0);
      while (bytes > 8 * 1024 * 1024 && retained.length > 1) bytes -= JSON.stringify(retained.shift()).length * 2;
      if (!windowState && history && history.synchronized === revision) historyCache.remember(id, history, retained);
    });
  });
  const messages = $derived.by(() => {
    // A recent HTTP page may overlap only the suffix of the already-read live
    // window. Keep its known earlier prefix before that native overlap, rather
    // than appending it after the page and rotating the conversation order.
    const overlap = historical.length ? retained.findIndex(m => m.id === historical[0].id) : -1;
    const prefix = overlap > 0 ? retained.slice(0, overlap) : [];
    const rows = windowState && !windowState.joined ? historical : [...prefix, ...historical, ...retained, ...live];
    const clients = new Set(rows.filter(m => !m.provisional && m.clientId).map(m => m.clientId));
    return [...new Map(rows.filter(m => (!m.provisional || !clients.has(m.clientId)) && (readingSettled || !m.provisional || !m.delivery?.recoveryRef || m.delivery.status === "sent")).map(m => [m.id, m])).values()];
  });
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
    if (active && transcript?.isConnected && transcript.clientHeight) onfollow(windowState && !windowState.joined ? false : instance.isAtEnd());
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
      // Prepend anchoring can write against the old sizer. After commit,
      // retain a leading message by index: an absolute estimated offset would
      // be retried after short preceding rows are measured, losing the anchor.
      if (prependCommit && active && transcript?.isConnected) {
        prependCommit = false;
        const item = leadingMessageAnchor && $virtualizer.takeSnapshot().find(item => item.key === leadingMessageAnchor!.key);
        if (item) {
          $virtualizer.setOptions({ onChange: virtualChanged, scrollPaddingStart: -leadingMessageAnchor!.offset });
          $virtualizer.scrollToIndex(item.index, { align: "start" });
        } else $virtualizer.scrollToOffset($virtualizer.scrollOffset ?? 0);
        leadingMessageAnchor = undefined;
      }
    });
  });
  $effect.pre(() => {
    const b = boundary;
    if (b !== history?.boundary) untrack(() => {
      history = b ? historyCache.get(id, b) : null;
      historyLoaded = !!history?.loaded;
      historical = history?.messages ?? []; cursor = history?.cursor ?? null; error = history?.error ?? "";
    });
  });
  async function load() {
    const entry = history;
    if(windowState) { await loadWindow("older"); return; }
    if (!entry || !connected || loading) return;
    const initial = !entry.loaded;
    const revision = syncRevision, generation=locationGeneration;
    loading = true; error = "";
    const fetchPage = async (cursor?: string) => {
      const params = new URLSearchParams(); if (cursor) params.set("cursor", cursor);
      params.set("agent", id);
      return reading<HistoryMessages>(`/messages?${params}`, id, request.signal);
    };
    if (entry.loaded && entry.synchronized !== revision) await historyCache.refresh(id, entry, revision, () => fetchPage());
    else await historyCache.load(id, entry, fetchPage, revision);
    if (!active || entry !== history) return;
    historical = entry.messages; cursor = entry.cursor; error = entry.error; loading = false; historyLoaded = entry.loaded;
    // The page may arrive after the last live publication. Cache the retained
    // native prefix now as well, so its reading anchor survives a revisit.
    historyCache.remember(id, entry, retained);
    if (!entry.error) {
      const copy = readingCache.readDetail(id);
      if (copy) readingCache.saveDetail({ ...copy, messages: entry.messages.slice(-100) });
    }
    if (generation===locationGeneration && initial && (!saved || saved.follow)) { await tick(); if (active) $virtualizer.scrollToEnd(); }
  }
  $effect(() => {
    const entry = history;
    if (!windowState && ready && connected && entry && !loading && (attempted !== entry || entry.synchronized !== syncRevision) && (!entry.loaded || entry.pending || entry.synchronized !== syncRevision) && !entry.error) {
      attempted = entry; untrack(() => { void load(); });
    }
  });
  let lastScroll = initialOffset(), lastFollow = saved?.follow ?? true;
  function saveReading() {
    if (!transcript?.isConnected || !transcript.clientHeight || !ready) return;
    lastScroll = transcript.scrollTop;
    lastFollow = transcript.scrollHeight - lastScroll - transcript.clientHeight < 80;
    if(windowState && !windowState.joined) lastFollow=false;
    onfollow(lastFollow);
    const measurements=$virtualizer.getVirtualItems();
    const midpoint=lastScroll+transcript.clientHeight/2;
    const current=measurements.find(item=>item.index>0 && item.end>=midpoint);
    const index=current ? current.index-1 : messages.length-1;
    const user=messages.slice(0,index+1).reverse().find(m=>m.role==="user" && m.delivery?.source==="user");
    if(user?.clientId) onanchor(user.clientId);
  }
  function measure(node: HTMLDivElement) {
    $virtualizer.measureElement(node);
    return { destroy: () => $virtualizer.measureElement(null) };
  }
  export async function jumpToBottom() {
    cancelLocation();
    if(windowState) {
      windowState=undefined; historical=[];
      if(history) {history.window=undefined; history.messages=[];history.loaded=false;history.cursor=null;history.synchronized=undefined;}
      await load(); await tick();
    }
    $virtualizer.scrollToEnd();
  }
  onMount(() => {
    footerHeight = tail.getBoundingClientRect().height;
    const readingKey=(event:KeyboardEvent)=>{
      if(!["PageUp","PageDown","Home","End","ArrowUp","ArrowDown"," "].includes(event.key) || event.isComposing) return;
      if(event.target===document.body || (event.target instanceof Node && transcript?.contains(event.target))) cancelLocation();
    };
    window.addEventListener("keydown",readingKey,true);
    const observer = new ResizeObserver(() => {
      if (!active) return;
      footerHeight = tail.getBoundingClientRect().height;
    });
    observer.observe(tail);
    if (!saved || saved.follow) void tick().then(() => { if (active) $virtualizer.scrollToEnd(); });
    return () => {
      active = false; cancelLocation(); request.abort(); observer.disconnect(); window.removeEventListener("keydown",readingKey,true);
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
<div class="conversation-region" aria-busy={initialLoading}>
<div class="conversation" role="region" aria-label={m.conversation_region()} bind:this={transcript} onscroll={saveReading} onwheel={cancelLocation} ontouchstart={cancelLocation} onpointerdown={cancelLocation}>
  <div class="message-timeline" class:historical-messages={!!boundary} style:height={`${$virtualizer.getTotalSize()}px`}>
    <!-- Always mounted, but measured as the leading item so header changes
         use the same library anchoring as messages, rather than padding. -->
    <div class="timeline-header" data-index="0" use:measure>
      {@render header()}
      {#if boundary}<div class="history-controls">
        {#if error}<span class="inline-error" role="alert">{error}</span><Button variant="ghost" size="sm" disabled={!connected || loading} onclick={()=>windowState?loadWindow(errorDirection):load()}>{m.retry()}</Button>
        {:else}{#if windowState ? windowState.olderCursor : cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={load}>{m.earlier_messages()}</Button>{/if}
        {#if loading && readingSettled}<span role="status">{m.loading_history()}</span>{/if}{/if}
      </div>{/if}
    </div>
    {#each $virtualizer.getVirtualItems() as row (row.key)}
      {#if row.index > 0}<div class="timeline-message" data-index={row.index} data-message-id={row.key} style:transform={`translateY(${row.start}px)`} use:measure>
        {@render renderMessage(messages[row.index - 1])}
      </div>{/if}
    {/each}
    <div class="timeline-footer" bind:this={tail} style:top={`${$virtualizer.getTotalSize() - footerHeight - 24}px`}>{#if windowState}<div class="history-controls">{#if windowState.newerCursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={()=>loadWindow("newer")}>{m.later_messages()}</Button>{/if}{#if error}<span class="inline-error" role="alert">{error}</span><Button variant="ghost" size="sm" disabled={loading || !connected} onclick={()=>loadWindow(errorDirection)}>{m.retry()}</Button>{/if}</div>{/if}{@render footer(readingSettled)}</div>
  </div>
</div>
{#if initialLoading}<div class="conversation-loading" role="status" aria-label={m.loading_conversation()}><LoaderCircle size={28} aria-hidden="true" class="conversation-spinner" /></div>{/if}
</div>
<style>
  .conversation-region { position: relative; display: flex; flex: 1; min-width: 0; min-height: 0; }
  .conversation-loading { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; background: color-mix(in srgb, var(--background) 65%, transparent); color: var(--muted-foreground); }
  .conversation-loading :global(.conversation-spinner) { animation: conversation-spin 1s linear infinite; }
  @keyframes conversation-spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .conversation-loading :global(.conversation-spinner) { animation: none; } }
  .conversation { padding: 0; overflow-anchor: none; }
  .message-timeline { position: relative; width: 100%; }
  .timeline-message, .timeline-header, .timeline-footer { position: absolute; left: 24px; right: 24px; display: flow-root; }
  .timeline-message { top: 0; }
  .timeline-header { top: 24px; }
  .history-controls { min-height: 32px; display: flex; align-items: center; gap: 8px; }
  @media (max-width: 700px) { .timeline-message, .timeline-header, .timeline-footer { left: 16px; right: 16px; } }
</style>
