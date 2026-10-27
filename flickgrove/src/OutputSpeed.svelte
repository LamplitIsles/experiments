<script lang="ts">
  import { api } from "./api";
  import type { Agent, OutputSpeed } from "./contracts";
  import * as m from "./paraglide/messages";
  import { untrack } from "svelte";
  import { CircleHelp } from "@lucide/svelte";
  import * as Popover from "$lib/components/ui/popover/index.js";
  import { buttonVariants } from "$lib/components/ui/button/button.svelte";
  import { choiceLayer } from "./choice-layer.svelte";
  let { agent, hostId, connected, portalTarget }: { agent: Agent; hostId?: string; connected: boolean; portalTarget: HTMLElement } = $props();
  let activeHelp = $state<string | null>(null);
  let rowsAnchor = $state<HTMLDListElement>();
  const helpId = $props.id();
  choiceLayer(helpId, () => activeHelp !== null, () => activeHelp = null);
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
        // One preceding task and this selection each have a 90s service deadline.
        // 370 bounded polls cover both plus polling/transport slack; never queue work.
        if (next.status === "loading") {
          if (++polls < 370) timer = setTimeout(() => void read(false), 500);
          else { value = { ...value, status: "unavailable" }; speedValues.set(capturedKey, value); }
        }
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
  <dl class="weekly-source" bind:this={rowsAnchor}>
    {#each rows as [label, window]}
      {@const help = `${m.output_speed_help()} ${agent.model ?? "—"} · ${tier === "fast" ? "Fast" : tier === "standard" ? "Standard" : "—"}. ${m.output_speed_samples({ count: window?.samples ?? 0 })}${current?.status === "unavailable" ? ` ${m.output_speed_unavailable()}` : ""}`}
      <div><dt>{label}</dt><dd>
        <span>{window?.tps == null ? "—" : window.tps.toFixed(1)}</span>
        <Popover.Root open={activeHelp === label} onOpenChange={open => { if (open) activeHelp = label; else if (activeHelp === label) activeHelp = null; }}>
          <Popover.Trigger data-speed-help-trigger aria-label={m.output_speed_details({ window: label })} class={buttonVariants({ variant: "ghost", size: "icon-xs" })}><CircleHelp aria-hidden="true" /></Popover.Trigger>
          <Popover.Content data-speed-help portalProps={{ to: portalTarget }} customAnchor={rowsAnchor} align="end" sideOffset={6} collisionPadding={16} class="w-72 max-w-[calc(100vw-2rem)] break-words p-3 text-xs leading-relaxed" onEscapeKeydown={event => event.stopPropagation()} onInteractOutside={event => { if (event.target instanceof Element && event.target.closest('[data-speed-help-trigger]')) event.preventDefault(); }}>
            {help}
          </Popover.Content>
        </Popover.Root>
      </dd></div>
    {/each}
  </dl>
</div>

<script module lang="ts">
  const speedValues = new Map<string, OutputSpeed>();
</script>
