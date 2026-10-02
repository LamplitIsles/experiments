<script lang="ts">
  import SvelteMarkdown, { buildUnsupportedHTML, defaultRenderers } from "@humanspeak/svelte-markdown";
  import MarkdownLink from "./MarkdownLink.svelte";
  let { text }: { text: string } = $props();
  const renderers = { ...defaultRenderers, link: MarkdownLink, html: buildUnsupportedHTML() };
</script>
<div class="markdown"><SvelteMarkdown source={text} {renderers} /></div>
