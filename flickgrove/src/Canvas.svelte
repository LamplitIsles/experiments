<script lang="ts">
  import { Minus, Plus, Maximize } from "@lucide/svelte";
  import { storagePrefix } from "./api";
  import { tick } from "svelte";
  import { Background, Controls, ControlButton, SvelteFlow, useSvelteFlow, type Node, type Edge } from "@xyflow/svelte";
  import AgentNode from "./AgentNode.svelte";
  import type { Agent, Host } from "./contracts";
  import { editable } from "./api";
  import * as m from "./paraglide/messages";
  let { agents, hosts, oncreate, selectedId, now, onopen }: { agents: Agent[]; hosts: Host[]; oncreate: (id: string) => void; selectedId: string | null; now: number; onopen: (id: string) => void } = $props();
  let expanded = $state<string[]>(JSON.parse(localStorage.getItem(`${storagePrefix}/expanded`) ?? "[]"));
  const positions: Record<string, { x: number; y: number }> = JSON.parse(localStorage.getItem(`${storagePrefix}/positions`) ?? "{}");
  let nodes = $state.raw<Node[]>([]); let focusedId = $state<string | null>(null);
  const flow = useSvelteFlow();
  let viewport = $state(JSON.parse(localStorage.getItem(`${storagePrefix}/viewport`) ?? '{"x":0,"y":0,"zoom":1}') as { x: number; y: number; zoom: number });
  $effect(() => { localStorage.setItem(`${storagePrefix}/viewport`, JSON.stringify(viewport)); });
  const hostIds = $derived([...new Set(agents.map(a => a.hostId))]);
  const roots = $derived(agents.filter(a => a.role === "orc"));
  function toggle(id: string) { expanded = expanded.includes(id) ? expanded.filter(v => v !== id) : [...expanded, id]; localStorage.setItem(`${storagePrefix}/expanded`, JSON.stringify(expanded)); }
  $effect(() => {
    const visible = agents.filter(a => a.role === "orc" || expanded.includes(a.ownerId!));
    if (focusedId && !visible.some(a => a.id === focusedId)) focusedId = null;
    nodes = visible.map(a => {
      const hostIndex = hostIds.indexOf(a.hostId);
      const rootIndex = roots.filter(root => root.hostId === a.hostId).findIndex(root => root.id === (a.ownerId ?? a.id));
      const rootId = a.ownerId ?? a.id;
      let slot = rootIndex;
      let rootPosition = positions[rootId] ?? { x: 90 + hostIndex * 430, y: 136 + slot * 640 };
      if (!positions[rootId]) {
        while (roots.some(root => root.id !== rootId && positions[root.id]?.x === rootPosition.x && positions[root.id]?.y === rootPosition.y)) {
          slot++; rootPosition = { x: 90 + hostIndex * 430, y: 136 + slot * 640 };
        }
        positions[rootId] = rootPosition;
      }
      const siblings = agents.filter(w => w.ownerId === a.ownerId && w.role === "worker");
      const childIndex = siblings.findIndex(w => w.id === a.id);
      const position = positions[a.id] ?? (a.role === "orc" ? rootPosition : { x: rootPosition.x + 20, y: rootPosition.y + 220 + childIndex * 150 });
      positions[a.id] ??= position;
      const children = agents.filter(w => w.ownerId === a.id);
      return { id: a.id, type: "agent", position, width: a.role === "orc" ? 300 : 252, height: a.role === "orc" ? 166 : 128, data: { agent: a, host: hosts.find(h => h.id === a.hostId), expanded: expanded.includes(a.id), count: children.length, working: children.filter(w => w.state === "working").length, selected: selectedId === a.id, navigation: focusedId === a.id, now, open: onopen, toggle } };
    });
    localStorage.setItem(`${storagePrefix}/positions`, JSON.stringify(positions));
  });
  const edges = $derived<Edge[]>(agents.filter(a => a.ownerId && expanded.includes(a.ownerId)).map(a => ({ id: `${a.ownerId}-${a.id}`, source: a.ownerId!, target: a.id, type: "smoothstep", selectable: false, style: "stroke: #515151; stroke-width: 1.25" })));
  export function fit() { void flow.fitView({ padding: .18, duration: 0 }); }
  export function reveal(id: string, duration = 0) {
    const node = nodes.find(n => n.id === id);
    const canvas = document.querySelector(".canvas-region")?.getBoundingClientRect();
    if (!node || !canvas) return;
    const width = node.width ?? 300, height = node.height ?? 166;
    const left = canvas.left + viewport.x + node.position.x * viewport.zoom;
    const top = canvas.top + viewport.y + node.position.y * viewport.zoom;
    const headerBottom = document.querySelector(".app-header")?.getBoundingClientRect().bottom ?? canvas.top;
    if (top < Math.max(canvas.top, headerBottom) + 16 || top + height * viewport.zoom > canvas.bottom - 16 || left < canvas.left + 16 || left + width * viewport.zoom > canvas.right - 16) {
      void flow.setCenter(node.position.x + width / 2, node.position.y + height / 2, { zoom: viewport.zoom, duration });
    }
  }
  export function expandFocused() { const a = agents.find(a => a.id === focusedId || a.id === selectedId); if (a?.role === "orc") toggle(a.id); }
  export async function keydown(event: KeyboardEvent) {
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
    await tick(); reveal(focusedId, 180); document.querySelector<HTMLButtonElement>(`[data-agent-id="${focusedId}"]`)?.focus({ preventScroll: true });
  }
</script>
<!-- The spatial canvas is a keyboard navigation surface. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="canvas-region" role="region" aria-label={m.canvas()} tabindex="-1" onkeydown={keydown}>
  <SvelteFlow bind:viewport bind:nodes {edges} nodeTypes={{ agent: AgentNode }} nodesConnectable={false} elementsSelectable={false} deleteKey={null} disableKeyboardA11y nodesFocusable={false} edgesFocusable={false} minZoom={.25} maxZoom={1.5} colorMode="dark" onnodedragstop={({ nodes: moved }) => { for (const node of moved) positions[node.id] = node.position; localStorage.setItem(`${storagePrefix}/positions`, JSON.stringify(positions)); }}>
    <Background gap={28} size={.6} patternColor="#474747" bgColor="#242424" />
    <Controls showZoom={false} showLock={false} showFitView={false} orientation="horizontal" position="bottom-left"><ControlButton onclick={() => flow.setZoom(viewport.zoom / 1.2)} title={m.zoom_out()} aria-label={m.zoom_out()}><Minus /></ControlButton><span class="zoom-readout">{Math.round(viewport.zoom * 100)}%</span><ControlButton onclick={() => flow.setZoom(viewport.zoom * 1.2)} title={m.zoom_in()} aria-label={m.zoom_in()}><Plus /></ControlButton><ControlButton onclick={fit} title={m.fit_canvas()} aria-label={m.fit_canvas()}><Maximize /></ControlButton></Controls>
  </SvelteFlow>
  <div class="host-column-labels" style={`transform:translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`}>{#each hostIds as id, i}<span class:host-warning={hosts.find(h => h.id === id)?.connected === false} style={`left:${90 + i * 430}px`}>{agents.find(a => a.hostId === id)?.hostName}</span>{/each}</div>
  <div class="empty-hosts">{#each hosts.filter(h => h.connected && !agents.some(a => a.hostId === h.id)) as host}<button onclick={() => oncreate(host.id)}><strong>{host.name}</strong><span>{m.host_empty()}</span></button>{/each}</div>
  <span class="canvas-key-hint">{m.canvas_hint()}</span>
</div>
