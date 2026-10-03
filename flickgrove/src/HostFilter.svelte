<script lang="ts">
  import { navigation, setSurface } from "./navigation.svelte";
  import { ChevronDown } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import type { Host } from "./contracts";
  import * as m from "./paraglide/messages";
  let { hosts, value = $bindable("") }: { hosts: Host[]; value?: string } = $props();
  const open = $derived(navigation.surfaces.includes("host-filter")); let current = $state(0); let root: HTMLDivElement;
  const choices = $derived([{ id: "", name: m.all_hosts(), connected: true }, ...hosts]);
  function select(id: string) { value = id; setSurface("host-filter", false); root.querySelector<HTMLButtonElement>("[role=combobox]")?.focus(); }
  function keydown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (["ArrowDown", "ArrowUp", "Escape"].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if (e.key === "Escape") setSurface("host-filter", false);
      else { setSurface("host-filter", true); current = Math.max(0, Math.min(choices.length - 1, current + (e.key === "ArrowDown" ? 1 : -1))); }
    } else if (open && e.key === "Enter") { e.preventDefault(); select(choices[current].id); }
  }
</script>
<svelte:window onclick={e => { if (e.target instanceof Node && root && !root.contains(e.target)) setSurface("host-filter", false); }} />
<div class="host-filter-control" bind:this={root}>
  <Button class="host-filter" variant="ghost" size="sm" role="combobox" aria-label={m.host_filter()} aria-expanded={open} aria-haspopup="listbox" aria-controls="host-options" aria-activedescendant={open ? `host-option-${current}` : undefined} onclick={() => { setSurface("host-filter", !open); current = choices.findIndex(h => h.id === value); }} onkeydown={keydown}>{choices.find(h => h.id === value)?.name ?? m.all_hosts()} <ChevronDown aria-hidden="true" /></Button>
  {#if open}<div class="host-filter-menu" role="listbox" id="host-options" aria-label={m.host_filter()}>{#each choices as host, i}<button id={`host-option-${i}`} role="option" aria-selected={host.id === value} class:selected={i === current} onclick={() => select(host.id)}><span>{host.name}</span>{#if host.id}<small class:host-warning={!host.connected}>{host.connected ? m.connected_host() : m.disconnected_host()}</small>{/if}</button>{/each}</div>{/if}
</div>
