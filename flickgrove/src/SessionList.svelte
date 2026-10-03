<script lang="ts">
  import { ChevronDown, ChevronRight, Plus } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { onMount, tick, untrack } from "svelte";
  import { storagePrefix } from "./api";
  import type { Agent, Host } from "./contracts";
  import * as m from "./paraglide/messages";
  let { agents, hosts, selectedId, loading, connected, onopen, onnew, onclosetree, closingId, closeError }: { agents: Agent[]; hosts: Host[]; selectedId: string | null; loading: boolean; connected: boolean; onopen: (id: string) => void; onnew: () => void; onclosetree: (id: string) => Promise<void>; closingId: string | null; closeError: { id: string; reason: string } | null } = $props();
  let expanded = $state<string[]>(JSON.parse(localStorage.getItem(`${storagePrefix}/expanded`) ?? "[]"));
  let focusedId = $state<string | null>(null);
  let revealedId = $state<string | null>(null);
  let gesture: { id: string; x: number; y: number; horizontal: boolean } | null = null;
  let suppressClickUntil = 0;
  function touchStart(event: TouchEvent, agent: Agent) {
    suppressClickUntil = 0;
    const touch = event.touches[0];
    if (agent.role !== "orc" || event.touches.length !== 1 || !matchMedia("(max-width: 700px)").matches || touch.clientX < 24) return;
    if (revealedId !== agent.id) revealedId = null;
    gesture = { id: agent.id, x: touch.clientX, y: touch.clientY, horizontal: false };
  }
  function touchMove(event: TouchEvent) {
    if (!gesture) return;
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.horizontal && Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
    if (Math.abs(dx) > 20 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      gesture.horizontal = true; suppressClickUntil = Date.now() + 500;
      if (event.cancelable) event.preventDefault();
      if (dx < -40) revealedId = gesture.id;
      else if (dx > 40) revealedId = null;
    }
  }
  export function closeTarget() { return agents.find(a => a.id === focusedId && a.role === "orc")?.id ?? null; }
  let list: HTMLElement;
  const roots = $derived(agents.filter(a => a.role === "orc"));
  const visible = $derived(roots.flatMap(a => [a, ...(expanded.includes(a.id) ? agents.filter(w => w.ownerId === a.id) : [])]));
  $effect(() => { localStorage.setItem(`${storagePrefix}/expanded`, JSON.stringify(expanded)); });
  $effect(() => { const selected = agents.find(a => a.id === selectedId); if (selected?.ownerId) untrack(() => { if (!expanded.includes(selected.ownerId!)) expanded = [...expanded, selected.ownerId!]; }); });
  $effect(() => { if (focusedId && !visible.some(a => a.id === focusedId)) focusedId = agents.find(a => a.id === focusedId)?.ownerId ?? null; });
  function toggle(id: string) { expanded = expanded.includes(id) ? expanded.filter(v => v !== id) : [...expanded, id]; }
  export async function reveal(id: string) { await tick(); list?.querySelector<HTMLButtonElement>(`[data-agent-id="${id}"]`)?.scrollIntoView({ block: "nearest" }); }
  export function expandFocused() { const agent = agents.find(a => a.id === (focusedId ?? selectedId)); if (agent?.role === "orc") toggle(agent.id); }
  export async function keydown(event: KeyboardEvent) {
    event.preventDefault();
    if (event.key === "Enter") { if (focusedId) onopen(focusedId); return; }
    const current = visible.find(a => a.id === focusedId);
    if (!current) focusedId = visible[0]?.id ?? null;
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") { const i = visible.indexOf(current); focusedId = visible[Math.max(0, Math.min(visible.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)))]?.id ?? null; }
    else if (event.key === "ArrowRight" && current.role === "orc") { if (!expanded.includes(current.id)) toggle(current.id); else focusedId = agents.find(a => a.ownerId === current.id)?.id ?? current.id; }
    else if (event.key === "ArrowLeft") { if (current.ownerId) focusedId = current.ownerId; else if (expanded.includes(current.id)) toggle(current.id); }
    if (focusedId) { await reveal(focusedId); list.querySelector<HTMLButtonElement>(`[data-agent-id="${focusedId}"]`)?.focus({ preventScroll: true }); }
  }
  onMount(() => { void tick().then(() => { list.scrollTop = Number(localStorage.getItem(`${storagePrefix}/list-scroll`) ?? 0); }); });
</script>
<svelte:window onpointerdown={e => { if (revealedId && e.target instanceof Element && !e.target.closest(`[data-swipe-id="${revealedId}"]`)) revealedId = null; }} />
<section class="session-list" aria-label={m.sessions()} bind:this={list} onscroll={() => localStorage.setItem(`${storagePrefix}/list-scroll`, String(list.scrollTop))}>
  <h1>{m.sessions()}</h1>
  {#if loading && !agents.length}<p class="list-empty" role="status">{m.loading()}</p>{:else if !roots.length}<div class="list-empty"><h2>{m.empty_heading()}</h2><p>{m.empty_help()}</p><Button size="sm" disabled={!connected} onclick={onnew}><Plus />{m.new_session()}</Button></div>{/if}
  {#each visible as agent (agent.id)}
    {@const children = agents.filter(w => w.ownerId === agent.id)}{@const host = hosts.find(h => h.id === agent.hostId)}
    <div role="group" class="session-row" data-swipe-id={agent.id} class:revealed={revealedId === agent.id} ontouchstart={e => touchStart(e, agent)} ontouchmove={touchMove} ontouchend={() => gesture = null} ontouchcancel={() => { gesture = null; revealedId = null; }}>
    {#if agent.role === "orc" && revealedId === agent.id}<Button class="tree-close-action" variant="destructive" size="sm" disabled={!connected || host?.connected === false || closingId === agent.id} onclick={() => onclosetree(agent.id)}>{m.close_tree()}</Button>{/if}
    <div class="session-item" class:worker-item={agent.role === "worker"} class:active={selectedId === agent.id} class:navigation-focus={focusedId === agent.id}>
      <button class="session-open" tabindex="-1" data-agent-id={agent.id} aria-current={selectedId === agent.id ? "true" : undefined} aria-label={m.open_agent({ title: agent.title, role: agent.role === "orc" ? m.orc() : m.worker() })} onclick={e => { if(Date.now() < suppressClickUntil) { e.preventDefault(); return; } if(revealedId) { revealedId = null; return; } onopen(agent.id); }}>
        {#if agent.role === "orc"}<span class="session-meta"><span class:host-warning={host?.connected === false}>{agent.hostName}</span><span>{agent.project.alias}</span></span>{/if}<strong>{agent.title}</strong>
        <span class="session-state"><span class:working={agent.state === "working"} class:failed={agent.state === "error"}><i></i>{agent.closeRequest ? m.closing_worker() : agent.stop?.status === "unknown" ? m.stop_unconfirmed() : agent.state === "stopping" ? m.stopping() : agent.state === "working" ? m.working() : agent.state === "error" ? m.failed() : m.idle()}</span>{#if agent.questions.some(q => q.state !== "answered")}<Badge variant="outline" class="border-amber-500/30 text-amber-200 text-[10px]">{m.needs_input()}</Badge>{/if}</span>{#if host?.connected === false}<small class="host-warning">{m.disconnected_host()}</small>{/if}
      </button>
      {#if agent.role === "orc"}<button class="worker-disclosure" tabindex="-1" aria-label={expanded.includes(agent.id) ? m.collapse_workers() : m.expand_workers()} aria-expanded={expanded.includes(agent.id)} disabled={!children.length} onclick={() => { if(Date.now() >= suppressClickUntil) toggle(agent.id); }}><span>{#if expanded.includes(agent.id)}<ChevronDown />{:else}<ChevronRight />{/if}{m.current_workers({ count: children.length })}</span><span class:working={children.some(w => w.state === "working")}>{m.working_count({ count: children.filter(w => w.state === "working").length })}</span></button>{/if}
    </div>
    {#if closeError?.id === agent.id}<p class="tree-close-error" role="alert">{closeError.reason}</p>{/if}
    </div>
  {/each}
  <Button class="mobile-new" size="sm" disabled={!connected} onclick={onnew}><Plus />{m.new_session()}</Button>
</section>
