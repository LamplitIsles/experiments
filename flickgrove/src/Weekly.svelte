<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "./api";
  import type { WeeklyUsage } from "./contracts";
  import * as m from "./paraglide/messages";
  let { hostId, connected }: { hostId?: string; connected: boolean } = $props();
  let value = $state<WeeklyUsage | null>(null); let open = $state(false); let sequence = 0; let root: HTMLDivElement;
  const remaining = $derived(value && value.hostId === hostId ? value.remaining : null);
  async function refresh() {
    const seq = ++sequence; const host = hostId;
    if (!connected) { value = null; return; }
    try { const next = await api<WeeklyUsage>(`/weekly${host ? `?host=${encodeURIComponent(host)}` : ""}`); if (seq === sequence && host === hostId) value = next; }
    catch { if (seq === sequence) value = null; }
  }
  $effect(() => { const _host = hostId; const _connected = connected; value = null; void refresh(); });
  onMount(() => { const timer = setInterval(() => void refresh(), 60000); return () => clearInterval(timer); });
</script>
<svelte:window onclick={e => { if (e.target instanceof Node && root && !root.contains(e.target)) open = false; }} />
<!-- Escape belongs to the focused quota control before global canvas/detail shortcuts. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="weekly-control" role="group" aria-label={m.weekly_remaining()} bind:this={root} onkeydown={e => { if (open && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); open = false; } }}>
  <button class="weekly-button" aria-label={m.weekly_remaining()} aria-expanded={open} onclick={() => open = !open}>
    <svg viewBox="0 0 36 36" class:low={remaining !== null && remaining <= 20} class:unknown={remaining === null} aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15"/><circle class="ring-value" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray={`${remaining ?? 0} 100`}/></svg><strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong><span>{m.weekly()}</span>
  </button>
  {#if open}<section class="weekly-popover" aria-label={m.weekly_remaining()}><header><h2>{m.weekly_remaining()}</h2><button class="btn btn-sm btn-square" aria-label={m.close()} onclick={() => open = false}>×</button></header>
    <div class="weekly-number" class:host-warning={remaining !== null && remaining <= 20}><svg viewBox="0 0 36 36" class:low={remaining !== null && remaining <= 20} class:unknown={remaining === null} aria-hidden="true"><circle class="ring-track" cx="18" cy="18" r="15"/><circle class="ring-value" cx="18" cy="18" r="15" pathLength="100" stroke-dasharray={`${remaining ?? 0} 100`}/></svg><div><strong>{remaining === null ? "—" : `${Math.round(remaining)}%`}</strong><span>{remaining === null ? m.weekly_unknown() : m.remaining_label()}</span></div></div>
    {#if remaining === null}<p>{m.weekly_unknown_help()}</p>{/if}
    <dl class="weekly-source">{#if value?.resetsAt && remaining !== null}<div><dt>{m.reset_label()}</dt><dd>{new Date(value.resetsAt * 1000).toLocaleString()}</dd></div>{/if}{#if value?.accountId}<div><dt>{m.account_label()}</dt><dd>{value.accountId}</dd></div>{/if}<div><dt>{m.source_label()}</dt><dd>{value?.source ?? "—"}</dd></div></dl>
    {#if value}<p class="weekly-freshness">{m.usage_freshness({ time: new Date(value.fetchedAt).toLocaleTimeString() })}</p>{/if}<button class="btn btn-sm weekly-refresh" onclick={refresh} disabled={!connected}>{m.refresh_usage()}</button>
  </section>{/if}
</div>
