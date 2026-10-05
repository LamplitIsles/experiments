<script lang="ts">
  import { untrack } from "svelte";
  import { ExternalLink, X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { peers } from "./api";
  import { localFile } from "./local-file";
  import * as m from "./paraglide/messages";
  let { agent, href, connected, onclose }: { agent: string; href: string; connected: boolean; onclose: () => void } = $props();
  let url = $state(""); let error = $state(""); let loading = $state(true);
  let kind = $state<"image" | "document">("document");
  let generation = 0;
  let attempted = false;
  let previousIdentity = "";
  const file = $derived(localFile(href));
  const filename = $derived(file?.path.split("/").at(-1) ?? href);
  async function load() {
    const selected = ++generation;
    url = ""; error = ""; loading = true;
    try {
      const response = await peers().media(agent, "/api/file-preview", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, href }),
      });
      const result = await response.json();
      if (selected === generation) { url = result.url; kind = result.kind; }
    } catch (cause) {
      if (selected === generation) { error = cause instanceof Error ? cause.message : "Could not open file"; loading = false; }
    }
  }
  async function documentLoaded(target: string) {
    if (target !== url) return;
    const selected = generation;
    try {
      const response = await fetch(target, { method: "HEAD", credentials: "omit", signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Preview expired or unavailable. Retry from the conversation.");
      if (selected === generation && target === url) loading = false;
    } catch {
      if (selected === generation) { loading = false; error = "Preview expired or unavailable. Retry from the conversation."; }
    }
  }
  $effect(() => {
    const identity = `${agent}/${href}`;
    if (identity !== previousIdentity) { previousIdentity = identity; attempted = false; generation++; url = ""; error = ""; loading = true; }
    if (connected && !attempted) { attempted = true; untrack(() => { void load(); }); }
    else if (!connected && !attempted) { error = "Execution Peer is offline. Reconnect and retry."; loading = false; }
  });
  $effect(() => () => { generation++; });
</script>
<section class="file-preview" aria-label="File preview">
  <header><strong title={filename}>{filename}</strong>
    {#if url}<a class="preview-external" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" title="Open in new tab"><ExternalLink size={16} /></a>{/if}
    <Button variant="ghost" size="icon-sm" aria-label="Close preview" onclick={onclose}><X /></Button>
  </header>
  <div class="preview-content">
    {#if loading}<p class="preview-state" role="status">Loading file…</p>{/if}
    {#if error}<div class="preview-state" role="alert"><p>{error}</p><Button variant="secondary" size="sm" onclick={load}>{m.retry()}</Button><Button variant="ghost" size="sm" onclick={onclose}>{m.close()}</Button></div>
    {:else if url}
      {#key url}
        {#if kind === "image"}<img src={url} alt={filename} onload={event => { if (event.currentTarget.getAttribute("src")! === url) loading = false; }} onerror={event => { if (event.currentTarget.getAttribute("src")! !== url) return; loading = false; error = "Image unavailable. Retry from the conversation."; }} />
        {:else}<iframe title={filename} src={url} sandbox="allow-scripts" referrerpolicy="no-referrer" onload={event => void documentLoaded(event.currentTarget.getAttribute("src")!)}></iframe>{/if}
      {/key}
    {/if}
  </div>
</section>
