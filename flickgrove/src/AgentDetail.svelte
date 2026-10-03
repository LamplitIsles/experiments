<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { X } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { tick } from "svelte";
  import type { Agent, Detail, Skill } from "./contracts";
  import { elapsed } from "./api";
  import TitleEditor from "./TitleEditor.svelte";
  import Weekly from "./Weekly.svelte";
  import Markdown from "./Markdown.svelte";
  import WorkerReport from "./WorkerReport.svelte";
  import Composer from "./Composer.svelte";
  import Questions from "./Questions.svelte";
  import * as m from "./paraglide/messages";
  let { detail, owner, skills, now, connected, workers, lastSeen, actionError, onrefresh, onstop, onrename, onclose, onopen, onsend, onanswer, onreconcile }: { detail: Detail; owner?: Agent; skills: Skill[]; now: number; connected: boolean; workers: Agent[]; lastSeen?: number; actionError: string; onrefresh: () => Promise<void>; onstop: () => Promise<boolean>; onrename: (title: string) => Promise<string | undefined>; onclose: () => void; onopen: (id: string) => void; onsend: (text: string, requestId: string) => Promise<boolean>; onanswer: (id: string, text: string) => Promise<boolean>; onreconcile: (id: string, accepted: boolean) => Promise<void> } = $props();
  let transcript: HTMLDivElement; let follow = $state(true);
  $effect(() => { const _count = detail.messages.length; if (follow) void tick().then(() => { if (transcript) transcript.scrollTop = transcript.scrollHeight; }); });
  const pending = $derived(detail.questions.filter(q => q.state !== "answered"));
  const reports = $derived(new Map(detail.deliveries.filter(d => d.source === "worker" && d.reportingWorkerId).map(d => [d.id, d])));
</script>
<aside class="agent-detail" aria-label={detail.title}>
  <div class="mobile-back"><Button variant="ghost" size="sm" onclick={onclose}>{m.back_sessions()}</Button><span>{detail.hostName}</span><Weekly hostId={detail.hostId} {connected} /></div><header class="detail-heading"><div class="role-project">{detail.role === "orc" ? m.orc() : m.worker()} / {detail.project.alias}</div><Button variant="ghost" size="icon-sm" aria-label={m.close_detail()} onclick={onclose}><X /></Button><TitleEditor title={detail.title} editable={detail.role === "orc" && connected} {onrename} /><div class="detail-status">{#if detail.hostName}<span class="owner-badge">{detail.hostName}</span>{/if}<span class:working={detail.state === "working"} class:failed={detail.state === "error"}><i></i>{detail.closeRequest ? m.closing_worker() : detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : detail.state === "working" ? m.working() + " " + elapsed(detail.workingSince, now) : detail.state === "error" ? m.failed() : m.idle()}</span>{#if pending.length}<Badge variant="outline" class="border-amber-500/30 text-amber-200">{m.needs_input()}</Badge>{/if}</div><div class="model-note">{detail.model} / {detail.effort}{#if detail.serviceTier === "priority"} / {m.fast_mode()}{/if}</div></header>
  <div class="conversation" bind:this={transcript} onscroll={() => follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80}>
    {#if !connected}<p class="host-outage" role="status">{m.host_offline()}{#if lastSeen}<br/>{m.last_seen({ time: new Date(lastSeen).toLocaleString() })}{/if}</p>{/if}
    {#if detail.closeRequest}<p class="model-note">{detail.closeRequest.reason}</p>{/if}
    {#if detail.error}<p class="inline-error" role="alert">{detail.error}</p>{/if}
    {#if owner}<button class="owner-link" onclick={() => onopen(owner.id)}>{m.assigned_by({ title: owner.title })}</button>{/if}
    {#if !detail.messages.length && !detail.questions.length}<div class="first-message"><h2>{m.first_heading()}</h2><p>{m.first_help({ project: detail.project.alias })}</p></div>{/if}
    {#each detail.messages as message (message.id)}
      {@const report = reports.get(message.id)}
      {#if report}<WorkerReport text={message.text} sender={workers.find(w => w.id === report.reportingWorkerId)?.title} />
      {:else}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{message.role === "assistant" ? detail.role === "orc" ? m.orc() : m.worker() : ""}</div><Markdown text={message.text} /></div>{/if}
    {/each}
    {#if detail.role === "orc" && detail.questions.length}<Questions agentId={detail.id} questions={detail.questions} deliveries={detail.deliveries} connected={connected && detail.state !== "stopping"} {onanswer} />
    {:else if detail.questions.length}<div class="delegated-questions">{#each detail.questions as q}<div><p>{q.text}</p><span>{q.state === "answered" ? m.sent() : m.delegated()}</span></div>{/each}</div>{/if}
    {#each detail.deliveries.filter(d => d.status === "failed" || d.status === "uncertain") as delivery}<details class="delivery-error"><summary>{delivery.status === "uncertain" ? m.unknown_delivery() : delivery.error}</summary><p>{delivery.text}</p>{#if delivery.status === "uncertain"}<p>{m.reconcile_help()}</p><div class="reconcile-actions"><Button variant="ghost" size="sm" disabled={!connected} onclick={() => onreconcile(delivery.id, true)}>{m.confirm_delivered()}</Button><Button variant="ghost" size="sm" disabled={!connected} onclick={() => onreconcile(delivery.id, false)}>{m.confirm_not_delivered()}</Button></div>{/if}{#if delivery.status === "failed" && delivery.source !== "question" && detail.role === "orc"}<Button variant="ghost" size="sm" disabled={!connected} onclick={() => onsend(delivery.text, delivery.id)}>{m.retry()}</Button>{/if}</details>{/each}
    {#if actionError}<div class="host-outage" role="alert"><p>{actionError}</p><Button variant="ghost" size="sm" onclick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>{m.message_orc()}</Button></div>{/if}
    {#if detail.stop?.status === "confirmed"}<p class="stop-confirmed" role="status">{m.stop_confirmed()}</p>{:else if detail.stop?.status === "unknown"}<p class="host-outage" role="status">{m.stop_unknown()} <Button variant="ghost" size="sm" onclick={onrefresh}>{m.retry_connection()}</Button></p>{:else if detail.stop?.status === "completed"}<p role="status">{m.stop_completed()}</p>{/if}
    {#if detail.role === "worker" && detail.state === "working"}<p class="work-duration">{m.working_for({ time: elapsed(detail.workingSince, now) })}</p>{/if}
  </div>
  {#if detail.role === "orc"}<details class="mobile-workers"><summary>{m.view_workers()} ({workers.length})</summary>{#each workers as worker}<Button variant="ghost" size="sm" onclick={() => onopen(worker.id)}>{worker.title} / {worker.state}</Button>{/each}</details><Composer agentId={detail.id} project={detail.project.alias} {skills} {connected} working={detail.state === "working"} stopping={detail.state === "stopping"} {onstop} {onsend} />{:else}<footer class="read-only"><p>{m.read_only()}</p>{#if owner}<button onclick={() => onopen(owner.id)}>{m.through_orc()}</button>{/if}</footer>{/if}
</aside>
