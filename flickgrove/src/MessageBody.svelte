<script lang="ts">
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { reading } from "./api";
  import * as m from "./paraglide/messages";
  import Markdown from "./Markdown.svelte";
  let { text, bodyRef, agentId, readPath, expand = false, fileAgentId = agentId }: { text: string; bodyRef?: string; agentId: string; readPath?: string; expand?: boolean; fileAgentId?: string } = $props();
  let body = $state<string>();
  let loading = $state(false), error = $state("");
  const abort = new AbortController();
  async function load() {
    if (!bodyRef || loading || body !== undefined) return;
    loading = true; error = "";
    try {
      const p = new URLSearchParams({ agent: agentId, item: bodyRef });
      const result = await reading<{text: string}>(readPath ?? `/body?${p}`, agentId, abort.signal);
      if (!abort.signal.aborted) body = result.text;
    } catch(e) { if (!abort.signal.aborted) error = (e as Error).message; }
    finally { if (!abort.signal.aborted) loading = false; }
  }
  $effect(() => { if (expand && bodyRef) void load(); });
  onMount(() => () => abort.abort());
</script>
{#if !bodyRef || body !== undefined}<Markdown text={body ?? text} agentId={fileAgentId} />
{:else}<div class="message-body">{#if error}<p class="inline-error" role="alert">{error}</p>{/if}<Button variant="ghost" size="sm" disabled={loading} onclick={load}>{loading ? m.loading_message() : error ? m.retry() : m.read_full_message()}</Button></div>{/if}
