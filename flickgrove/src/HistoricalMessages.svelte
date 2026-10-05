<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { HistoryMessages, Message } from "./contracts";
  import { api } from "./api";
  import { historyCache } from "./history-cache";
  import * as m from "./paraglide/messages";
  let { agentId, boundary, connected, renderMessage, oninitialloaded, onreadingchange }: { agentId: string; boundary: string; connected: boolean; renderMessage: Snippet<[Message]>; oninitialloaded: () => void; onreadingchange: () => void } = $props();
  const id = untrack(() => agentId);
  const entry = historyCache.get(id, untrack(() => boundary));
  let messages = $state(entry.messages); let cursor = $state(entry.cursor);
  let attempted = false;
  let loading = $state(false); let error = $state(entry.error); let root: HTMLDivElement; let active = true;
  async function load() {
    if (!connected || loading) return;
    loading = true; error = "";
    const container = root?.closest(".conversation");
    // A remount joins the existing request kind, including an earlier-page read.
    const more = entry.loaded;
    if (more) { await tick(); if (!active) return; onreadingchange(); }
    await historyCache.load(id, entry, async cursor => {
      const params = new URLSearchParams(); if (cursor) params.set("cursor", cursor);
      return api<HistoryMessages>(`/agents/${encodeURIComponent(id)}/history?${params}`);
    });
    if (!active) return;
    // Capture the latest reading position, not where the request started.
    const height = container?.scrollHeight ?? 0;
    const scroll = container?.scrollTop ?? 0;
    messages = entry.messages; cursor = entry.cursor; error = entry.error; loading = false;
    await tick();
    if (!active) return;
    if (more && container) container.scrollTop = scroll + container.scrollHeight - height;
    else oninitialloaded();
  }
  $effect(() => { if (connected && !attempted && (!entry.loaded || entry.pending) && !entry.error) { attempted = true; untrack(() => { void load(); }); } });
  onMount(() => {
    if (entry.loaded || entry.error) void tick().then(() => { if (active) oninitialloaded(); });
    return () => { active = false; };
  });
</script>
<div class="historical-messages" bind:this={root}>
  {#if cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={() => load()}>{m.earlier_messages()}</Button>{/if}
  {#if loading}<p role="status">{m.loading_history()}</p>{/if}
  {#each messages as message (message.id)}{@render renderMessage(message)}{/each}
  {#if error}<p class="inline-error" role="alert">{error}</p><Button variant="ghost" size="sm" disabled={!connected || loading} onclick={() => load()}>{m.retry()}</Button>{/if}
</div>
