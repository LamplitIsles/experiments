<script lang="ts">
  import { HighlightedCode } from "@humanspeak/svelte-markdown/extensions/tanstack-highlight";
  import CopyButton from "./CopyButton.svelte";
  import * as m from "./paraglide/messages";
  let { text, lang }: { text: string; lang: string } = $props();
</script>

<div class="code-block">
  <HighlightedCode {text} {lang} />
  <CopyButton {text} label={m.copy_code()} class="copy-code" />
</div>
