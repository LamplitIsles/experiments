<script lang="ts">
  import { ChevronDown, ChevronRight } from "@lucide/svelte";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { Handle, Position, type NodeProps, type Node } from "@xyflow/svelte";
  import type { Agent, Host } from "./contracts";
  import { elapsed } from "./api";
  import * as m from "./paraglide/messages";
  let { data }: NodeProps<Node<{ agent: Agent; host?: Host; expanded: boolean; count: number; working: number; selected: boolean; navigation: boolean; now: number; open: (id: string) => void; toggle: (id: string) => void }>> = $props();
  const agent = $derived(data.agent);
</script>
<div class="agent-node" class:worker-node={agent.role === "worker"} class:active={data.selected} class:navigation-focus={data.navigation}>
  <Handle type="target" position={Position.Top} isConnectable={false} />
  <div class="node-metadata"><span>{agent.role === "orc" ? m.orc() : m.worker()}</span><span class="truncate">{agent.project.alias}</span>{#if agent.questions.some(q => q.state !== "answered")}<Badge variant="outline" class="border-amber-500/30 text-amber-200 text-[10px]">{m.needs_input()}</Badge>{/if}</div>
  <button class="node-open nodrag" tabindex={-1} data-agent-id={agent.id} aria-label={m.open_agent({ title: agent.title, role: agent.role === "orc" ? m.orc() : m.worker() })} onclick={() => data.open(agent.id)}>
    <strong class="truncate">{agent.title}</strong>
    <div class="node-state"><span class:working={agent.state === "working"} class:failed={agent.state === "error"}><i></i>{agent.closeRequest ? m.closing_worker() : agent.stop?.status === "unknown" ? m.stop_unconfirmed() : agent.state === "stopping" ? m.stopping() : agent.state === "working" ? m.working() : agent.state === "error" ? m.failed() : m.idle()}</span>{#if agent.hostName}<span class="owner-badge" class:host-warning={data.host?.connected === false}>{agent.hostName}{#if data.host?.connected === false} · {m.disconnected_host()}{/if}</span>{:else if agent.state === "working"}<time>{elapsed(agent.workingSince, data.now)}</time>{/if}</div>
  </button>
  {#if agent.role === "orc"}<button class="worker-disclosure nodrag" aria-label={data.expanded ? m.collapse_workers() : m.expand_workers()} aria-expanded={data.expanded} disabled={!data.count} onclick={() => data.toggle(agent.id)}><span>{#if data.expanded}<ChevronDown />{:else}<ChevronRight />{/if}{m.worker_count({ count: data.count })}</span><span class:working={data.working > 0}>{m.working_count({ count: data.working })}</span></button>{/if}
  <Handle type="source" position={Position.Bottom} isConnectable={false} />
</div>
