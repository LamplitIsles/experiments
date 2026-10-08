<script lang="ts">
  import { ServerCog } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Host } from "./contracts";
  import * as m from "./paraglide/messages";
  let { hosts, unansweredHosts, value, onselect, onmanage }: { hosts: Host[]; unansweredHosts: Set<string>; value: string; onselect: (id: string) => void; onmanage: () => void } = $props();
</script>
<div class="host-filter-control">
  <Button variant="ghost" size="icon-sm" aria-label={m.hosts()} title={m.hosts()} onclick={onmanage}><ServerCog aria-hidden="true" /></Button>
  <div class="host-filter-buttons" role="group" aria-label={m.host_filter()}>
    {#each hosts as host (host.id)}
      <Button variant={value === host.id ? "secondary" : "ghost"} size="sm" aria-pressed={value === host.id} title={unansweredHosts.has(host.id) ? `${host.name} · ${m.unanswered()}` : host.name} onclick={() => onselect(host.id)}><span class="truncate">{host.name}</span>{#if unansweredHosts.has(host.id)}<span class="host-question-dot" aria-hidden="true"></span><span class="sr-only"> · {m.unanswered()}</span>{/if}</Button>
    {/each}
  </div>
</div>
