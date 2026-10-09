<script lang="ts">
  import { untrack } from "svelte";
  import { ChevronRight } from "@lucide/svelte";
  import MessageTime from "./MessageTime.svelte";
  import Markdown from "./Markdown.svelte";
  import * as m from "./paraglide/messages";
  let { text, at, kind, sender, agentId, initiallyExpanded = false, onexpanded }: { kind?: string; text: string; at: number; sender?: string; agentId?: string; initiallyExpanded?: boolean; onexpanded?: (value: boolean) => void } = $props();
  let expanded = $state(untrack(() => initiallyExpanded));
  const heading = $derived(sender ?? text.split("\n")[0]);
  const preview = $derived(text.split("\n\n").slice(1).join(" ").replace(/\s+/g, " ").trim());
</script>

<details class="worker-report" open={expanded} ontoggle={event => { expanded = event.currentTarget.open; onexpanded?.(expanded); }}>
  <summary tabindex="-1" aria-label={`${(kind ?? m.worker_report())} · ${heading}`}>
    <ChevronRight class="report-chevron" aria-hidden="true" />
    <span class="report-summary"><span class="report-heading"><strong>{heading}</strong><span>{(kind ?? m.worker_report())}</span><MessageTime {at} /></span><span class="report-preview">{preview}</span></span>
  </summary>
  {#if expanded}<div class="report-content"><Markdown {text} {agentId} /></div>{/if}
</details>
