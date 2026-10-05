<script lang="ts">
  import { getContext, type Snippet } from "svelte";
  import { localFile } from "./local-file";
  import { openFilePreview } from "./navigation.svelte";
  const agent = getContext<() => string | undefined>("file-preview-agent");
  let { href = "", title, children }: { href?: string; title?: string; children?: Snippet } = $props();
  const preview = $derived(!!agent?.() && !!localFile(href));
  const safe = $derived(/^(https?:|mailto:|#)/i.test(href) && !href.startsWith("//"));
</script>
{#if preview}<a {href} {title} onclick={event => { event.preventDefault(); openFilePreview(agent()!, href); }}>{@render children?.()}</a>{:else if safe}<a {href} {title} target="_blank" rel="noopener noreferrer">{@render children?.()}</a>{:else}<span>{@render children?.()}</span>{/if}
