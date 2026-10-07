<script lang="ts">
  import katex from "katex";
  import { mathOptions } from "./math-options";
  let { text, raw, displayMode = false }: { text: string; raw?: string; displayMode?: boolean } = $props();
  const html = $derived.by(() => {
    try {
      return katex.renderToString(text, { ...mathOptions, displayMode });
    } catch {
      return null;
    }
  });
</script>

<span class="math-formula" class:math-block={displayMode}>
  {#if html !== null}{@html html}{:else}{raw ?? text}{/if}
</span>
