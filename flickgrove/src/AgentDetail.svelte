<script lang="ts">
  import { tick } from "svelte";
  import type { Agent, Detail, Skill } from "./contracts";
  import { elapsed } from "./api";
  import Weekly from "./Weekly.svelte";
  import Markdown from "./Markdown.svelte";
  import Composer from "./Composer.svelte";
  import Questions from "./Questions.svelte";
  import * as m from "./paraglide/messages";
  let { detail, owner, skills, now, connected, workers, lastSeen, actionError, onrefresh, onstop, onclose, onopen, onsend, onanswer, onreconcile }: { detail: Detail; owner?: Agent; skills: Skill[]; now: number; connected: boolean; workers: Agent[]; lastSeen?: number; actionError: string; onrefresh: () => Promise<void>; onstop: () => Promise<boolean>; onclose: () => void; onopen: (id: string) => void; onsend: (text: string, requestId: string) => Promise<boolean>; onanswer: (id: string, text: string) => Promise<boolean>; onreconcile: (id: string, accepted: boolean) => Promise<void> } = $props();
  let transcript: HTMLDivElement; let follow = $state(true);
  $effect(() => { const _count = detail.messages.length; if (follow) void tick().then(() => { if (transcript) transcript.scrollTop = transcript.scrollHeight; }); });
  const pending = $derived(detail.questions.filter(q => q.state !== "answered"));
</script>
<aside class="agent-detail" aria-label={detail.title}>
  <div class="mobile-back"><button class="btn btn-sm" onclick={onclose}>{m.back_sessions()}</button><span>{detail.hostName}</span><Weekly hostId={detail.hostId} {connected} /></div><header class="detail-heading"><div class="role-project">{detail.role === "orc" ? m.orc() : m.worker()} / {detail.project.alias}</div><button class="btn btn-sm btn-square" aria-label={m.close_detail()} onclick={onclose}>×</button><h1>{detail.title}</h1><div class="detail-status">{#if detail.hostName}<span class="owner-badge">{detail.hostName}</span>{/if}<span class:working={detail.state === "working"} class:failed={detail.state === "error"}><i></i>{detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : detail.state === "working" ? m.working() + " " + elapsed(detail.workingSince, now) : detail.state === "error" ? m.failed() : m.idle()}</span>{#if detail.role === "orc" && (detail.state === "working" || detail.state === "stopping")}<button class="btn btn-primary btn-sm stop-control" disabled={!connected || detail.state === "stopping" || !detail.turnId} onclick={onstop}>■ {detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : m.stop_orc()}</button>{/if}{#if pending.length}<span class="badge badge-warning badge-soft badge-sm">{m.needs_input()}</span>{/if}</div><div class="model-note">{detail.model} / {detail.effort}{#if detail.serviceTier === "priority"} / {m.fast_mode()}{/if}</div></header>
  <div class="conversation" bind:this={transcript} onscroll={() => follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80}>
    {#if !connected}<p class="host-outage" role="status">{m.host_offline()}{#if lastSeen}<br/>{m.last_seen({ time: new Date(lastSeen).toLocaleString() })}{/if}</p>{/if}
    {#if detail.error}<p class="inline-error" role="alert">{detail.error}</p>{/if}
    {#if owner}<button class="owner-link" onclick={() => onopen(owner.id)}>{m.assigned_by({ title: owner.title })}</button>{/if}
    {#if !detail.messages.length && !detail.questions.length}<div class="first-message"><h2>{m.first_heading()}</h2><p>{m.first_help({ project: detail.project.alias })}</p></div>{/if}
    {#each detail.messages as message (message.id)}
      <div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{message.role === "assistant" ? detail.role === "orc" ? m.orc() : m.worker() : ""}</div><Markdown text={message.text} /></div>
    {/each}
    {#if detail.role === "orc" && detail.questions.length}<Questions agentId={detail.id} questions={detail.questions} deliveries={detail.deliveries} connected={connected && detail.state !== "stopping"} {onanswer} />
    {:else if detail.questions.length}<div class="delegated-questions">{#each detail.questions as q}<div><p>{q.text}</p><span>{q.state === "answered" ? m.sent() : m.delegated()}</span></div>{/each}</div>{/if}
    {#each detail.deliveries.filter(d => d.status === "failed" || d.status === "uncertain") as delivery}<details class="delivery-error"><summary>{delivery.status === "uncertain" ? m.unknown_delivery() : delivery.error}</summary><p>{delivery.text}</p>{#if delivery.status === "uncertain"}<p>{m.reconcile_help()}</p><div class="reconcile-actions"><button class="btn btn-sm" disabled={!connected} onclick={() => onreconcile(delivery.id, true)}>{m.confirm_delivered()}</button><button class="btn btn-sm" disabled={!connected} onclick={() => onreconcile(delivery.id, false)}>{m.confirm_not_delivered()}</button></div>{/if}{#if delivery.status === "failed" && delivery.source !== "question" && detail.role === "orc"}<button class="btn btn-sm" disabled={!connected} onclick={() => onsend(delivery.text, delivery.id)}>{m.retry()}</button>{/if}</details>{/each}
    {#if actionError}<div class="host-outage" role="alert"><p>{actionError}</p><button class="btn btn-sm" onclick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>{m.message_orc()}</button></div>{/if}
    {#if detail.stop?.status === "confirmed"}<p class="stop-confirmed" role="status">{m.stop_confirmed()}</p>{:else if detail.stop?.status === "unknown"}<p class="host-outage" role="status">{m.stop_unknown()} <button class="btn btn-sm" onclick={onrefresh}>{m.retry_connection()}</button></p>{:else if detail.stop?.status === "completed"}<p role="status">{m.stop_completed()}</p>{/if}
    {#if detail.role === "worker" && detail.state === "working"}<p class="work-duration">{m.working_for({ time: elapsed(detail.workingSince, now) })}</p>{/if}
  </div>
  {#if detail.role === "orc"}<details class="mobile-workers"><summary>{m.view_workers()} ({workers.length})</summary>{#each workers as worker}<button class="btn btn-sm" onclick={() => onopen(worker.id)}>{worker.title} / {worker.state}</button>{/each}</details><Composer agentId={detail.id} project={detail.project.alias} {skills} {connected} working={detail.state === "working"} stopping={detail.state === "stopping"} {onstop} {onsend} />{:else}<footer class="read-only"><p>{m.read_only()}</p>{#if owner}<button onclick={() => onopen(owner.id)}>{m.through_orc()}</button>{/if}</footer>{/if}
</aside>
