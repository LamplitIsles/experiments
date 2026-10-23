<script lang="ts">
  import { api } from "./api";
  import type { Agent, OutputSpeed } from "./contracts";
  import * as m from "./paraglide/messages";
  import { untrack } from "svelte";
  let { agent, hostId, connected }: { agent: Agent; hostId?: string; connected: boolean } = $props();
  const tier = $derived(agent.serviceTier === "priority" || agent.serviceTier === "fast" ? "fast" : agent.serviceTier === "default" ? "standard" : null);
  const key = $derived(JSON.stringify([hostId, agent.id, agent.model, tier]));
  let value = $state<OutputSpeed | null>(null);
  let valueKey = $state("");
  const current = $derived(valueKey === key ? value : null);
  let refreshVersion = $state(0);
  export function refresh() { refreshVersion++; }
  $effect(() => {
    const capturedKey = key, host = hostId, id = agent.id, model = agent.model, speed = tier, online = connected;
    const force = refreshVersion > 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    untrack(() => { valueKey = capturedKey; value = speedValues.get(capturedKey) ?? null; });
    let polls = 0;
    async function read(force: boolean) {
      if (!online || !model || !speed) return;
      try {
        const next = await api<OutputSpeed>(`/tps?id=${encodeURIComponent(id)}`, { refresh: force });
        if (cancelled || capturedKey !== key || host !== hostId || !connected || next.model !== model || next.tier !== speed) return;
        const previous = speedValues.get(capturedKey);
        value = { ...next, summary: next.summary ?? previous?.summary ?? null };
        speedValues.delete(capturedKey); speedValues.set(capturedKey, value);
        while (speedValues.size > 16) speedValues.delete(speedValues.keys().next().value!);
        if (next.status === "loading" && ++polls < 45) timer = setTimeout(() => void read(false), 500);
      } catch {
        if (!cancelled && capturedKey === key) value = { model: model!, tier: speed, summary: speedValues.get(capturedKey)?.summary ?? null, status: "unavailable" };
      }
    }
    void read(force);
    return () => { cancelled = true; clearTimeout(timer); };
  });
  const rows = $derived([
    ["1h", current?.summary?.hour], ["4h", current?.summary?.fourHours], ["1w", current?.summary?.week],
  ] as const);
</script>

<div class="output-speed">
  <h3>{m.output_speed()} · tok/s</h3>
  <dl class="weekly-source">
    {#each rows as [label, window]}
      {@const help = `${m.output_speed_help()} ${agent.model ?? "—"} · ${tier === "fast" ? "Fast" : tier === "standard" ? "Standard" : "—"}. ${m.output_speed_samples({ count: window?.samples ?? 0 })}${current?.status === "unavailable" ? ` ${m.output_speed_unavailable()}` : ""}`}
      <div title={help} aria-label={`${label}: ${window?.tps == null ? "—" : window.tps.toFixed(1)} tok/s. ${help}`}><dt>{label}</dt><dd>{window?.tps == null ? "—" : window.tps.toFixed(1)}</dd></div>
    {/each}
  </dl>
</div>

<script module lang="ts">
  const speedValues = new Map<string, OutputSpeed>();
</script>
