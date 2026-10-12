<script lang="ts">
  import { untrack } from "svelte";
  import { reading } from "./api";
  import Questions from "./Questions.svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Question } from "./contracts";
  let { peerOrAgent, params, connected, onpending }: { peerOrAgent: string; params: Record<string,string>; connected: boolean; onpending?: (item: string) => void } = $props();
  let questions = $state<Question[]>([]), loading = $state(true), error = $state(""), revision = $state(0);
  const key = $derived(JSON.stringify([peerOrAgent, params]));
  $effect(() => {
    const identity = key, retry = revision;
    const controller = new AbortController();
    loading = true; error = ""; questions = [];
    if (!connected) { loading = false; error = "Execution Peer is offline. Reconnect and retry."; return; }
    void untrack(() => reading<Question[]>(`/questions?${new URLSearchParams(params)}`, peerOrAgent, controller.signal)).then(value => {
      if (controller.signal.aborted) return;
      if (!value.length) throw new Error("Question record unavailable. Retry from the conversation.");
      if (onpending && value.some(q => q.state === "unanswered")) onpending(value.find(q => q.state === "unanswered")!.itemId);
      else questions = value;
    }).catch(e => { if (!controller.signal.aborted) error = (e as Error).message; }).finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });
</script>
{#if loading}<p class="question-load" role="status">Loading questions…</p>{:else if error}<div class="question-load"><p class="inline-error" role="alert">{error}</p><Button tabindex={0} variant="secondary" size="sm" disabled={!connected} onclick={() => revision++}>Retry</Button></div>{:else}<Questions agentId={peerOrAgent} {questions} readonly />{/if}
