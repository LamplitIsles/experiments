<script lang="ts">
  import { ChevronRight } from "@lucide/svelte";
  import Markdown from "./Markdown.svelte";
  import * as m from "./paraglide/messages";
  let { text, sender, agentId }: { text: string; sender?: string; agentId?: string } = $props();
  let expanded = $state(false);
  const heading = $derived(sender ?? text.split("\n")[0]);
  const preview = $derived(text.split("\n\n").slice(1).join(" ").replace(/\s+/g, " ").trim());
</script>

<details class="worker-report" ontoggle={event => expanded = event.currentTarget.open}>
  <summary tabindex="-1" aria-label={`${m.worker_report()} · ${heading}`}>
    <ChevronRight class="report-chevron" aria-hidden="true" />
    <span class="report-summary"><span class="report-heading"><strong>{heading}</strong><span>{m.worker_report()}</span></span><span class="report-preview">{preview}</span></span>
  </summary>
  {#if expanded}<div class="report-content"><Markdown {text} {agentId} /></div>{/if}
</details>
