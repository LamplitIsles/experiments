<script lang="ts">
  import { navigation, setSurface } from "./navigation.svelte";
  import { X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { weeklyCache, weeklyKey, loadWeekly, acceptWeekly, requestWeekly } from "./weekly-cache.svelte";
  import { onMount, untrack } from "svelte";
  import * as m from "./paraglide/messages";
  let { hostId, connected, surface = "weekly" }: { hostId?: string; connected: boolean; surface?: "weekly" | "weekly-detail" } = $props();
  const value = $derived(weeklyCache[weeklyKey(hostId)] ?? null); const open = $derived(navigation.surfaces.includes(surface)); let sequence = 0; let root: HTMLDivElement;
  const remaining = $derived(value?.remaining ?? null);
  let mounted = true;
  async function refresh() {
    const seq = ++sequence; const host = hostId;
    if (!connected) { acceptWeekly(host); return; }
    try { const next = await requestWeekly(host); if (mounted && seq === sequence && host === hostId && connected) acceptWeekly(host, next); }
    catch { if (mounted && seq === sequence && host === hostId) acceptWeekly(host); }
  }
  $effect(() => { const host = hostId; const online = connected; untrack(() => { loadWeekly(host); if (online) void refresh(); else { ++sequence; acceptWeekly(host); } }); });
  onMount(() => { const timer = setInterval(() => void refresh(), 60000); return () => { mounted = false; ++sequence; clearInterval(timer); }; });

</script>
<svelte:window onclick={e => { if (e.target instanceof Node && root && !root.contains(e.target)) setSurface(surface, false); }} />
<!-- Escape belongs to the focused quota control before global session/detail shortcuts. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="weekly-control" role="group" aria-label={m.weekly_remaining()} bind:this={root} onkeydown={e => { if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSurface(surface, false); } }}>
  <button class="weekly-button" aria-label={m.weekly_remaining()} aria-expanded={open} onclick={() => setSurface(surface, !open)}>
    <svg viewBox="0 0 36 36" class:low={remaining !== null && remaining <= 20} class:unknown={remaining === null} aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15"/><circle class="ring-value" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray={`${remaining ?? 0} 100`}/></svg><strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong><span>{m.weekly()}</span>
  </button>
  {#if open}<section class="weekly-popover" aria-label={m.weekly_remaining()}><header><h2>{m.weekly_remaining()}</h2><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => setSurface(surface, false)}><X /></Button></header>
    <div class="weekly-number" class:host-warning={remaining !== null && remaining <= 20}><svg viewBox="0 0 36 36" class:low={remaining !== null && remaining <= 20} class:unknown={remaining === null} aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15"/><circle class="ring-value" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray={`${remaining ?? 0} 100`}/></svg><div><strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong><span>{remaining === null ? m.weekly_unknown() : m.remaining_label()}</span></div></div>
    {#if remaining === null}<p>{m.weekly_unknown_help()}</p>{/if}
    <dl class="weekly-source">{#if typeof value?.resetsAt === "number" && Number.isFinite(value.resetsAt) && remaining !== null}<div><dt>{m.reset_label()}</dt><dd>{new Date(value.resetsAt * 1000).toLocaleString()}</dd></div>{/if}{#if value?.accountId}<div><dt>{m.account_label()}</dt><dd>{value.accountId}</dd></div>{/if}<div><dt>{m.source_label()}</dt><dd>{value?.source ?? "—"}</dd></div></dl>
    <Button class="weekly-refresh" variant="ghost" size="sm" onclick={refresh} disabled={!connected}>{m.refresh_usage()}</Button>
  </section>{/if}
</div>
