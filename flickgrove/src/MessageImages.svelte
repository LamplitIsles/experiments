<script lang="ts">
  import { messageImagePreview, retryMessageImagePreview, hasMessageImagePreview } from "./message-image-cache";
  import { onMount } from "svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import type { MessageImage } from "./contracts";
  import { peers } from "./api";
  import { imagePreview, loadImages, operationKey } from "./image-drafts";
  let { agentId, operationId, images = [], localImageIds = [], connected, onviewer }: { agentId: string; operationId: string; images?: MessageImage[]; localImageIds?: string[]; connected: boolean; onviewer?: (open: boolean) => void } = $props();
  let urls = $state<Record<string,string>>({}); let failures = $state<Record<string,boolean>>({});
  let original = $state(""); let fullError = $state(""); let open = $state(false); let name = $state(""); let active=true;
  const items = $derived(images.length ? images : localImageIds.map(id=>({id,name:"Message image"})));
  const allocated = new Set<string>();
  function blobUrl(blob: Blob) { const url=URL.createObjectURL(blob); allocated.add(url); return url; }
  const previewKey = (id: string) => `${agentId}\0${operationId}\0${id}`;
  function retry(id: string) { retryMessageImagePreview(previewKey(id)); failures[id] = false; }
  $effect(()=>{ const snapshot=items, online=connected; void Promise.all(snapshot.map(async (image,index)=>{
    if (urls[image.id] || failures[image.id]) return;
    // Cached/local previews remain readable offline; do not retain a failed
    // remote request from cached snapshot connectivity before Peer admission.
    if ("availability" in image && image.availability === "missing") {failures[image.id]=true;return;}
    try {
      let preview: Blob;
      if (!online && !hasMessageImagePreview(previewKey(image.id))) {
        const local = await loadImages(operationKey(agentId, operationId));
        if (!local?.images[index]) return;
        preview = await messageImagePreview(previewKey(image.id), () => imagePreview(local.images[index].file));
      } else preview = await messageImagePreview(previewKey(image.id), async () => {
        const local = await loadImages(operationKey(agentId, operationId));
        if (local?.images[index]) return imagePreview(local.images[index].file);
        return (await peers().media(agentId, `/api/images/${image.id}/preview?agent=${encodeURIComponent(agentId)}`)).blob();
      });
      if (active && !urls[image.id]) urls[image.id] = blobUrl(preview);
    } catch { if(active) failures[image.id]=true; }
  })); });
  $effect(() => {
    onviewer?.(open);
    if (!open && original) { URL.revokeObjectURL(original); allocated.delete(original); original = ""; }
  });
  async function enlarge(id: string,index:number,label:string) {
    name=label; open=true; original=""; fullError="";
    try {
      const local=await loadImages(operationKey(agentId,operationId));
      const blob=local?.images[index]?.file ?? await (await peers().media(agentId,`/api/images/${id}/original?agent=${encodeURIComponent(agentId)}`)).blob();
      if(active && open) original=blobUrl(blob);
    } catch { if (active && open) fullError="Image missing or unreadable. Reconnect to its execution host and try again."; }
  }
  onMount(()=>()=>{active=false;for(const url of allocated)URL.revokeObjectURL(url);});
</script>
<div class="message-images">
  {#each items as image,index (image.id)}
    {#if urls[image.id]}<button class="message-image" aria-label={`Open image ${index+1}: ${image.name}`} onclick={()=>enlarge(image.id,index,image.name)}><img src={urls[image.id]} alt={image.name} /></button>
    {:else}<span class="image-placeholder" role="status">{failures[image.id] ? "Image missing or unreadable" : "Loading image…"}</span>{#if failures[image.id] && !("availability" in image && image.availability === "missing")}<Button variant="ghost" size="sm" onclick={() => retry(image.id)}>Retry image</Button>{/if}{/if}
  {/each}
</div>
<Dialog.Root bind:open><Dialog.Content class="image-viewer"><Dialog.Header><Dialog.Title>{name}</Dialog.Title><Dialog.Description>Full-size message image</Dialog.Description></Dialog.Header>
  {#if original}<img class="full-image" src={original} alt={name} />{:else}<p role="status">{fullError || "Loading image…"}</p>{/if}
  {#if fullError}<Button variant="secondary" onclick={()=>open=false}>Close</Button>{/if}
</Dialog.Content></Dialog.Root>
