<script lang="ts">
  import { setContext } from "svelte";
  import SvelteMarkdown, { buildUnsupportedHTML, defaultRenderers, defaultSanitizeUrl, type SanitizeUrlFn } from "@humanspeak/svelte-markdown";
  import { localFile } from "./local-file";
  import MarkdownLink from "./MarkdownLink.svelte";
  let { text, agentId }: { text: string; agentId?: string } = $props();
  setContext("file-preview-agent", () => agentId);
  const sanitizeUrl: SanitizeUrlFn = (url, context) => agentId && context.type === "link" && localFile(url) ? url : defaultSanitizeUrl(url, context);
  const renderers = { ...defaultRenderers, link: MarkdownLink, html: buildUnsupportedHTML() };
</script>
<div class="markdown"><SvelteMarkdown source={text} {renderers} {sanitizeUrl} /></div>
