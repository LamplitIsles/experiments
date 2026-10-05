<script lang="ts" module>
  const catalogues = new Map<string, Model[]>();
  const pending = new Set<string>();
</script>
<script lang="ts">
  import { Zap } from "@lucide/svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { api } from "./api";
  import { navigation, setSurface, back } from "./navigation.svelte";
  import { onMount, tick, untrack } from "svelte";
  import type { Detail, Model } from "./contracts";
  import * as m from "./paraglide/messages";
  let { detail, connected, onupdate }: { detail: Detail; connected: boolean; onupdate: (value: Detail) => void } = $props();
  const open = $derived(navigation.surfaces.includes("session-settings"));
  let choices = $state<Model[]>(untrack(() => catalogues.get(detail.hostId!)) ?? []);
  let model = $state(untrack(() => detail.model)); let effort = $state(untrack(() => detail.effort)); let fast = $state(untrack(() => detail.serviceTier === "priority"));
  let busy = $state(false); let error = $state(""); let catalogueError = $state("");
  let composing = false; let alive = true;
  let previous: HTMLElement | null = null;
  let selection: [number, number, "forward" | "backward" | "none"] | undefined;
  const selected = $derived(choices.find(value => value.id === model));
  const valid = $derived(!!selected?.efforts.includes(effort));
  onMount(() => () => { alive = false; });
  async function catalogue() {
    if (!connected) { catalogueError = m.session_offline(); return; }
    try {
      const result = await api<Model[]>(`/models?host=${encodeURIComponent(detail.hostId!)}`);
      catalogues.set(detail.hostId!, result);
      if (alive) { choices = result; catalogueError = ""; if (open && !result.find(v => v.id === model)?.fastTier) fast = false; }
    } catch (e) { if (alive) catalogueError = e instanceof Error ? e.message : m.load_failure(); }
  }
  $effect(() => {
    if (open) untrack(() => { model = detail.model; effort = detail.effort; fast = detail.serviceTier === "priority"; error = ""; void catalogue(); });
  });
  function capture() {
    previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selection = previous instanceof HTMLTextAreaElement ? [previous.selectionStart, previous.selectionEnd, previous.selectionDirection] : undefined;
  }
  async function restore() {
    await tick();
    if (!previous?.isConnected) return;
    previous.focus({ preventScroll: true });
    if (selection && previous instanceof HTMLTextAreaElement) previous.setSelectionRange(...selection);
  }
  function show(captured = false) {
    if (navigation.details.at(-1) !== detail.id || navigation.surfaces.length || pending.has(detail.id)) return;
    if (!captured) capture(); model = detail.model; effort = detail.effort; fast = detail.serviceTier === "priority"; error = "";
    setSurface("session-settings", true);
  }
  async function save(quick = false) {
    const id = detail.id;
    if (pending.has(id)) return;
    if (!connected) { error = m.session_offline(); return; }
    pending.add(id); busy = true; error = "";
    try {
      if (quick) await catalogue();
      if (!alive || detail.id !== id || navigation.details.at(-1) !== id) return;
      if (!connected || detail.closed || detail.closeRequest) throw new Error(m.session_offline());
      const chosen = choices.find(value => value.id === (quick ? detail.model : model));
      const chosenEffort = quick ? detail.effort : effort;
      if (!chosen?.efforts.includes(chosenEffort)) throw new Error(m.session_choose_supported());
      const enabled = quick ? detail.serviceTier !== "priority" : fast;
      if (enabled && !chosen.fastTier) throw new Error(m.session_fast_unavailable());
      const result = await api<Detail>(`/agents/${id}/settings`, quick ? { fast: enabled } : { model: chosen.id, effort: chosenEffort, serviceTier: enabled ? chosen.fastTier : "default" });
      if (!alive || detail.id !== id || navigation.details.at(-1) !== id) return;
      onupdate(result);
      if (!quick && open) await back();
    } catch (e) { if (alive && detail.id === id) error = e instanceof Error ? e.message : m.load_failure(); }
    finally { pending.delete(id); if (alive) busy = false; }
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229 || navigation.surfaces.length || navigation.details.at(-1) !== detail.id) return;
    if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || !["KeyF", "KeyM"].includes(event.code)) return;
    if (event.target instanceof HTMLElement && event.target.closest(".questions-panel, .questions-content, .question-card")) return;
    event.preventDefault();
    if (event.repeat || busy || pending.has(detail.id)) return;
    if (event.code === "KeyM") show(); else void save(true);
  }
</script>
<svelte:window onkeydown={keydown} oncompositionstart={() => composing = true} oncompositionend={() => composing = false} />
<button class="detail-model session-model" tabindex="-1" disabled={busy || !!detail.closeRequest} title={m.session_next_turn()} aria-label={m.session_settings()} onpointerdown={capture} onclick={() => show(true)}><span>{detail.model} / {detail.effort}</span>{#if detail.serviceTier === "priority"}<Zap size={14} role="img" aria-label={m.fast_mode()} />{/if}</button>
{#if error && !open}<span class="session-settings-error" role="alert">{error}</span>{/if}
<Dialog.Root {open} onOpenChange={value => { if (!value) void back(); }}>
  <Dialog.Content class="session-settings-dialog" showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); void restore(); }}>
    <Dialog.Title>{m.session_settings()}</Dialog.Title>
    <Dialog.Description>{m.session_next_turn()}</Dialog.Description>
    <label>{m.model()}<NativeSelect class="w-full min-w-0" aria-label={m.model()} value={model} disabled={busy} onchange={event => { model = event.currentTarget.value; const value = choices.find(v => v.id === model); if (!value?.efforts.includes(effort)) effort = value?.defaultEffort ?? ""; if (!value?.fastTier) fast = false; }}>
      {#if !selected}<option value={model}>{model} ({m.session_unavailable()})</option>{/if}
      {#each choices as value}<option value={value.id}>{value.name}</option>{/each}
    </NativeSelect></label>
    {#if !selected && choices.length}<p role="status">{m.session_current_unavailable()}</p>{:else if selected && !valid}<p role="status">{m.session_choose_supported()}</p>{/if}
    <label>{m.effort()}<NativeSelect class="w-full min-w-0" aria-label={m.effort()} bind:value={effort} disabled={busy || !selected}>{#if !valid}<option value={effort}>{effort}</option>{/if}{#each selected?.efforts ?? [] as value}<option value={value}>{value}</option>{/each}</NativeSelect></label>
    <label class="fast-setting"><span>{m.fast_mode()}{#if !selected?.fastTier}<small>{m.session_fast_unavailable()}</small>{/if}</span><Switch aria-label={m.fast_mode()} bind:checked={fast} disabled={busy || !selected?.fastTier} /></label>
    {#if catalogueError}<p role="alert">{catalogueError} <button onclick={catalogue} disabled={busy}>{m.retry()}</button></p>{/if}
    {#if error}<p class="session-settings-error" role="alert">{error}</p>{/if}
    <div class="modal-action"><Button variant="ghost" size="sm" onclick={() => back()}>{m.cancel()}</Button><Button size="sm" disabled={busy || !connected || !valid || !!detail.closeRequest} onclick={() => save()}>{m.save_changes()}</Button></div>
  </Dialog.Content>
</Dialog.Root>
