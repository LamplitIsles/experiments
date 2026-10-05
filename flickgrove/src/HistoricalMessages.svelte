<script lang="ts">
  import { onMount, tick, untrack, type Snippet } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { HistoryMessages, Message } from "./contracts";
  import { api } from "./api";
  import * as m from "./paraglide/messages";
  let { agentId, connected, renderMessage, oninitialloaded }: { agentId: string; connected: boolean; renderMessage: Snippet<[Message]>; oninitialloaded: () => void } = $props();
  let messages = $state<Message[]>([]); let cursor = $state<string | null>(null);
  let attempted = $state(false);
  let loading = $state(false); let error = $state(""); let root: HTMLDivElement; let active = true;
  async function load(more = false) {
    if (loading || !connected) return;
    loading = true; error = "";
    const container = root?.closest(".conversation");
    const height = container?.scrollHeight ?? 0;
    const scroll = container?.scrollTop ?? 0;
    try {
      const params = new URLSearchParams(); if (more && cursor) params.set("cursor", cursor);
      const page = await api<HistoryMessages>(`/agents/${encodeURIComponent(agentId)}/history?${params}`);
      if (!active) return;
      messages = [...new Map((more ? [...page.messages, ...messages] : page.messages).map(message => [message.id, message])).values()]; cursor = page.nextCursor;
      await tick();
      if (more && container) container.scrollTop = scroll + container.scrollHeight - height;
      else if (!more) { loading = false; await tick(); if (active) oninitialloaded(); }
    } catch(e) { if (active) error = e instanceof Error ? e.message : m.load_failure(); }
    finally { if (active) loading = false; }
  }
  $effect(() => { if (connected && !attempted) { attempted = true; untrack(() => { void load(); }); } });
  onMount(() => { return () => { active = false; }; });
</script>
<div class="historical-messages" bind:this={root}>
  {#if cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={() => load(true)}>{m.earlier_messages()}</Button>{/if}
  {#if loading}<p role="status">{m.loading_history()}</p>{/if}
  {#each messages as message (message.id)}{@render renderMessage(message)}{/each}
  {#if error}<p class="inline-error" role="alert">{error}</p><Button variant="ghost" size="sm" disabled={!connected || loading} onclick={() => load(!!cursor)}>{m.retry()}</Button>{/if}
</div>
