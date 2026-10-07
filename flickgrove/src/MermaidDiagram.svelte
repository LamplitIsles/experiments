<script lang="ts">
  import { getMermaid } from "./mermaid";
  import * as m from "./paraglide/messages";
  let { text }: { text: string } = $props();
  let staging: HTMLDivElement;
  let svg = $state("");
  let failed = $state(false);
  let loading = $state(true);
  $effect(() => {
    const source = text;
    const container = document.createElement("div");
    staging.append(container);
    let active = true;
    svg = "";
    failed = false;
    loading = true;
    void (async () => {
      try {
        const mermaid = await getMermaid();
        await document.fonts.ready;
        if (!active) return;
        const result = await mermaid.render(`grove-diagram-${crypto.randomUUID()}`, source, container);
        if (active) {
          // Mermaid strict sanitizes SVG, but can retain inert anchor wrappers.
          // This read-only surface grants no diagram navigation.
          const output = document.createElement("template");
          output.innerHTML = result.svg;
          for (const link of output.content.querySelectorAll("a")) link.replaceWith(...link.childNodes);
          svg = output.innerHTML;
        }
        // Strict diagrams are read-only; never call result.bindFunctions.
      } catch {
        if (active) failed = true;
      } finally {
        container.remove();
        if (active) loading = false;
      }
    })();
    return () => { active = false; container.remove(); };
  });
</script>

<div class="mermaid-renderer">
  <div class="mermaid-staging" aria-hidden="true" bind:this={staging}></div>
  {#if loading}<p class="mermaid-status">{m.diagram_loading()}</p>{:else if failed}<p class="mermaid-status">{m.diagram_invalid()}</p>{/if}
  {#if svg}<div class="mermaid-svg">{@html svg}</div>{:else}<pre><code>{text}</code></pre>{/if}
</div>
