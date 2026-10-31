<script lang="ts">
  import { setContext } from "svelte";
  import SvelteMarkdown, { buildUnsupportedHTML, defaultRenderers, defaultSanitizeUrl, type SanitizeUrlFn } from "@humanspeak/svelte-markdown";
  import { chatMathExtension } from "./math-extension";
  import "katex/dist/katex.css";
  import { markedMermaid } from "@humanspeak/svelte-markdown/extensions/mermaid";
  import MermaidDiagram from "./MermaidDiagram.svelte";
  import MathFormula from "./MathFormula.svelte";
  import { HIGHLIGHT_CONTEXT_KEY } from "@humanspeak/svelte-markdown/extensions/tanstack-highlight";
  import CopyableCode from "./CopyableCode.svelte";
  import { codeHighlighter } from "./code-highlighter";
  import { localFile } from "./local-file";
  import MarkdownLink from "./MarkdownLink.svelte";
  let { text, agentId, historyPreview = false }: { text: string; agentId?: string; historyPreview?: boolean } = $props();
  setContext("file-preview-agent", () => agentId);
  setContext("file-preview-history", () => historyPreview);
  setContext(HIGHLIGHT_CONTEXT_KEY, codeHighlighter);
  const sanitizeUrl: SanitizeUrlFn = (url, context) => (agentId || historyPreview) && context.type === "link" && localFile(url) ? url : defaultSanitizeUrl(url, context);
  const extensions = [chatMathExtension(), markedMermaid()];
  const renderers = { ...defaultRenderers, link: MarkdownLink, html: buildUnsupportedHTML(), inlineKatex: MathFormula, blockKatex: MathFormula, mermaid: MermaidDiagram, code: CopyableCode };
</script>
<div class="markdown"><SvelteMarkdown source={text} {extensions} {renderers} {sanitizeUrl} /></div>
