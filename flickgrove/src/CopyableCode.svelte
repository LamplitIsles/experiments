<script lang="ts">
  import { HighlightedCode } from "@humanspeak/svelte-markdown/extensions/tanstack-highlight";
  import CopyButton from "./CopyButton.svelte";
  import * as m from "./paraglide/messages";
  let { text, lang }: { text: string; lang: string } = $props();
  const language = $derived(lang?.trim().split(/\s+/, 1)[0]);
</script>

<div class="code-block">
  <HighlightedCode {text} {lang} />
  {#if language}<span class="code-language" title={language}>{language}</span>{/if}
  <CopyButton {text} label={m.copy_code()} class="copy-code" />
</div>
