<script lang="ts">
  import { ServerCog } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Host } from "./contracts";
  import * as m from "./paraglide/messages";
  let { hosts, value, onselect, onmanage }: { hosts: Host[]; value: string; onselect: (id: string) => void; onmanage: () => void } = $props();
</script>
<div class="host-filter-control">
  <Button variant="ghost" size="icon-sm" aria-label={m.hosts()} title={m.hosts()} onclick={onmanage}><ServerCog aria-hidden="true" /></Button>
  <div class="host-filter-buttons" role="group" aria-label={m.host_filter()}>
    {#each hosts as host (host.id)}
      <Button variant={value === host.id ? "secondary" : "ghost"} size="sm" aria-pressed={value === host.id} title={host.name} onclick={() => onselect(host.id)}><span class="truncate">{host.name}</span></Button>
    {/each}
  </div>
</div>
