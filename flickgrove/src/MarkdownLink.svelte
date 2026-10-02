<script lang="ts">
  import type { Snippet } from "svelte";
  let { href = "", title, children }: { href?: string; title?: string; children?: Snippet } = $props();
  const safe = $derived(/^(https?:|mailto:|#|\/)/i.test(href) && !href.startsWith("//"));
</script>
{#if safe}<a {href} {title} target="_blank" rel="noopener noreferrer">{@render children?.()}</a>{:else}<span>{@render children?.()}</span>{/if}
