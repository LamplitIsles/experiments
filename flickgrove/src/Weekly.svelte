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
  const measuresId = $props.id();
  const weekSeconds = 7 * 24 * 60 * 60;
  let now = $state(Date.now());
  const reset = $derived(value?.resetsAt);
  const elapsed = $derived(typeof reset === "number" && Number.isFinite(reset) && reset > 0
    ? Math.max(0, Math.min(100, (now / 1000 - (reset - weekSeconds)) / weekSeconds * 100)) : null);
  const measures = $derived(`${m.remaining_label()}: ${remaining === null ? m.weekly_unknown() : `${Math.round(remaining)}%`}${elapsed === null ? "" : `; ${m.period_elapsed()}: ${Math.round(elapsed)}%`}`);
  let mounted = true;
  async function refresh() {
    const seq = ++sequence; const host = hostId;
    if (!connected) { acceptWeekly(host); return; }
    try { const next = await requestWeekly(host); if (mounted && seq === sequence && host === hostId && connected) acceptWeekly(host, next); }
    catch { if (mounted && seq === sequence && host === hostId) acceptWeekly(host); }
  }
  $effect(() => { const host = hostId; const online = connected; untrack(() => { loadWeekly(host); if (online) void refresh(); else { ++sequence; acceptWeekly(host); } }); });
  onMount(() => {
    const updateClock = () => { now = Date.now(); };
    const onVisible = () => { if (document.visibilityState === "visible") updateClock(); };
    updateClock();
    const clock = setInterval(updateClock, 60000);
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(() => void refresh(), 60000); return () => { mounted = false; ++sequence; clearInterval(timer); clearInterval(clock); document.removeEventListener("visibilitychange", onVisible); }; });

</script>
{#snippet rings()}
  <svg viewBox="0 0 36 36" class:low={remaining !== null && remaining <= 20} class:unknown={remaining === null} aria-hidden="true">
    {#if elapsed !== null}<circle class="elapsed-track" cx="18" cy="18" r="16.5"/><circle class="elapsed-value" cx="18" cy="18" r="16.5" pathLength="100" stroke-dasharray={`${elapsed} 100`}/>{/if}
    <circle class="ring-track" cx="18" cy="18" r="12.5"/><circle class="ring-value" cx="18" cy="18" r="12.5" pathLength="100" stroke-dasharray={`${remaining ?? 0} 100`}/>
  </svg>
{/snippet}
<svelte:window onclick={e => { if (e.target instanceof Node && root && !root.contains(e.target)) setSurface(surface, false); }} />
<!-- Escape belongs to the focused quota control before global session/detail shortcuts. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="weekly-control" role="group" aria-label={m.weekly_remaining()} bind:this={root} onkeydown={e => { if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSurface(surface, false); } }}>
  <span id={measuresId} class="sr-only">{measures}</span>
  <button class="weekly-button" aria-label={m.weekly_remaining()} aria-describedby={measuresId} aria-expanded={open} onclick={() => setSurface(surface, !open)}>
    {@render rings()}<strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong><span>{m.weekly()}</span>
  </button>
  {#if open}<section class="weekly-popover" aria-label={m.weekly_remaining()}><header><h2>{m.weekly_remaining()}</h2><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => setSurface(surface, false)}><X /></Button></header>
    <div role="group" aria-label={measures} class="weekly-number" class:host-warning={remaining !== null && remaining <= 20}>{@render rings()}<div><strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong><span>{remaining === null ? m.weekly_unknown() : m.remaining_label()}</span></div></div>
    {#if remaining === null}<p>{m.weekly_unknown_help()}</p>{/if}
    <dl class="weekly-source">{#if elapsed !== null}<div><dt>{m.period_elapsed()}</dt><dd>{Math.round(elapsed)}%</dd></div>{/if}{#if typeof reset === "number" && Number.isFinite(reset) && reset > 0 && remaining !== null}<div><dt>{m.reset_label()}</dt><dd>{new Date(reset * 1000).toLocaleString()}</dd></div>{/if}{#if value?.accountId}<div><dt>{m.account_label()}</dt><dd>{value.accountId}</dd></div>{/if}<div><dt>{m.source_label()}</dt><dd>{value?.source ?? "—"}</dd></div></dl>
    <Button class="weekly-refresh" variant="ghost" size="sm" onclick={refresh} disabled={!connected}>{m.refresh_usage()}</Button>
  </section>{/if}
</div>
