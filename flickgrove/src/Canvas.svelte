<script lang="ts">
  import { tick } from "svelte";
  import { Background, Controls, ControlButton, SvelteFlow, useSvelteFlow, type Node, type Edge } from "@xyflow/svelte";
  import AgentNode from "./AgentNode.svelte";
  import type { Agent } from "./contracts";
  import { editable } from "./api";
  import * as m from "./paraglide/messages";
  let { agents, selectedId, now, onopen }: { agents: Agent[]; selectedId: string | null; now: number; onopen: (id: string) => void } = $props();
  let expanded = $state<string[]>(JSON.parse(localStorage.getItem("flickgrove/expanded") ?? "[]"));
  const positions: Record<string, { x: number; y: number }> = JSON.parse(localStorage.getItem("flickgrove/positions") ?? "{}");
  let nodes = $state.raw<Node[]>([]); let focusedId = $state<string | null>(null);
  const flow = useSvelteFlow();
  let viewport = $state({ x: 0, y: 0, zoom: 1 });
  const roots = $derived(agents.filter(a => a.role === "orc"));
  function toggle(id: string) { expanded = expanded.includes(id) ? expanded.filter(v => v !== id) : [...expanded, id]; localStorage.setItem("flickgrove/expanded", JSON.stringify(expanded)); }
  $effect(() => {
    const visible = agents.filter(a => a.role === "orc" || expanded.includes(a.ownerId!));
    nodes = visible.map(a => {
      const rootIndex = roots.findIndex(root => root.id === (a.ownerId ?? a.id));
      const rootId = a.ownerId ?? a.id;
      let slot = rootIndex;
      let rootPosition = positions[rootId] ?? { x: 180 + (slot % 3) * 400, y: 140 + Math.floor(slot / 3) * 360 };
      if (!positions[rootId]) {
        while (roots.some(root => root.id !== rootId && positions[root.id]?.x === rootPosition.x && positions[root.id]?.y === rootPosition.y)) {
          slot++; rootPosition = { x: 180 + (slot % 3) * 400, y: 140 + Math.floor(slot / 3) * 360 };
        }
        positions[rootId] = rootPosition;
      }
      const siblings = agents.filter(w => w.ownerId === a.ownerId && w.role === "worker");
      const childIndex = siblings.findIndex(w => w.id === a.id);
      const position = positions[a.id] ?? (a.role === "orc" ? rootPosition : { x: rootPosition.x + childIndex * 288 - 144 * (siblings.length - 1), y: rootPosition.y + 240 });
      positions[a.id] ??= position;
      const children = agents.filter(w => w.ownerId === a.id);
      return { id: a.id, type: "agent", position, width: a.role === "orc" ? 296 : 248, height: a.role === "orc" ? 148 : 108, data: { agent: a, expanded: expanded.includes(a.id), count: children.length, working: children.filter(w => w.state === "working").length, selected: selectedId === a.id, now, open: onopen, toggle } };
    });
    localStorage.setItem("flickgrove/positions", JSON.stringify(positions));
  });
  const edges = $derived<Edge[]>(agents.filter(a => a.ownerId && expanded.includes(a.ownerId)).map(a => ({ id: `${a.ownerId}-${a.id}`, source: a.ownerId!, target: a.id, type: "smoothstep", selectable: false, style: "stroke: #515151; stroke-width: 1.25" })));
  export function fit() { void flow.fitView({ padding: .18, duration: 0 }); }
  export function expandFocused() { const a = agents.find(a => a.id === focusedId || a.id === selectedId); if (a?.role === "orc") toggle(a.id); }
  async function keydown(event: KeyboardEvent) {
    if (editable(event.target) || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === "Enter") { if (focusedId) onopen(focusedId); return; }
    const current = nodes.find(n => n.id === focusedId) ?? nodes[0]; if (!current) return;
    const candidates = nodes.filter(n => {
      if (n.id === current.id) return false;
      const dx = n.position.x - current.position.x, dy = n.position.y - current.position.y;
      return event.key === "ArrowLeft" ? dx < -1 : event.key === "ArrowRight" ? dx > 1 : event.key === "ArrowUp" ? dy < -1 : dy > 1;
    }).sort((a, b) => Math.hypot(a.position.x - current.position.x, a.position.y - current.position.y) - Math.hypot(b.position.x - current.position.x, b.position.y - current.position.y));
    focusedId = (candidates[0] ?? current).id;
    await tick(); document.querySelector<HTMLButtonElement>(`[data-agent-id="${focusedId}"]`)?.focus();
  }
</script>
<!-- The spatial canvas is a keyboard navigation surface. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="canvas-region" role="region" aria-label={m.canvas()} tabindex="0" onkeydown={keydown} onfocusin={e => { if (e.target instanceof HTMLElement && e.target.dataset.agentId) focusedId = e.target.dataset.agentId; }}>
  <SvelteFlow bind:viewport bind:nodes {edges} nodeTypes={{ agent: AgentNode }} nodesConnectable={false} elementsSelectable={false} deleteKey={null} disableKeyboardA11y nodesFocusable={false} edgesFocusable={false} minZoom={.25} maxZoom={1.5} colorMode="dark" onnodedragstop={({ nodes: moved }) => { for (const node of moved) positions[node.id] = node.position; localStorage.setItem("flickgrove/positions", JSON.stringify(positions)); }}>
    <Background gap={28} size={.6} patternColor="#474747" bgColor="#242424" />
    <Controls showZoom={false} showLock={false} showFitView={false} orientation="horizontal" position="bottom-left"><ControlButton onclick={() => flow.setZoom(viewport.zoom / 1.2)} title={m.zoom_out()} aria-label={m.zoom_out()}>−</ControlButton><span class="zoom-readout">{Math.round(viewport.zoom * 100)}%</span><ControlButton onclick={() => flow.setZoom(viewport.zoom * 1.2)} title={m.zoom_in()} aria-label={m.zoom_in()}>+</ControlButton><ControlButton onclick={fit} title={m.fit_canvas()} aria-label={m.fit_canvas()}>{m.fit_canvas()}</ControlButton></Controls>
  </SvelteFlow>
  <span class="canvas-key-hint">{m.canvas_hint()}</span>
</div>
