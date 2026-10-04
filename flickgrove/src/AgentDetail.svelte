<script lang="ts">
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { X, ArrowDown, MessageCircle } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { questionPanels, setQuestionPanel } from "./question-state.svelte";
  import { navigation, setSurface, removeQuestionDrawer, back } from "./navigation.svelte";
  import { tick } from "svelte";
  import type { Answer, Agent, Detail, Skill, Message } from "./contracts";
  import { elapsed } from "./api";
  import TitleEditor from "./TitleEditor.svelte";
  import Weekly from "./Weekly.svelte";
  import Markdown from "./Markdown.svelte";
  import WorkerReport from "./WorkerReport.svelte";
  import HistoricalMessages from "./HistoricalMessages.svelte";
  import Composer from "./Composer.svelte";
  import Questions from "./Questions.svelte";
  import * as m from "./paraglide/messages";
  let { detail, owner, skills, now, connected, workers, lastSeen, actionError, closeError, onrefresh, onstop, onrename, onclose, onopen, onsend, onanswer, onlookup, onretry }: { detail: Detail; owner?: Agent; skills: Skill[]; now: number; connected: boolean; workers: Agent[]; lastSeen?: number; actionError: string; closeError?: string; onrefresh: () => Promise<void>; onstop: () => Promise<boolean>; onrename: (title: string) => Promise<string | undefined>; onclose: () => void; onopen: (id: string) => void; onsend: (text: string, requestId: string) => Promise<boolean>; onanswer: (answers: Answer[], operationId: string) => Promise<void>; onlookup: (id: string) => Promise<void>; onretry: (id: string) => Promise<void> } = $props();
  let composer = $state<Composer>();
  let transcript: HTMLDivElement; let follow = $state(true);
  function jumpToBottom() { follow = true; transcript.scrollTop = transcript.scrollHeight; }
  $effect(() => { const _count = detail.messages.length; if (follow) void tick().then(() => { if (transcript) transcript.scrollTop = transcript.scrollHeight; }); });
  const panelOpen = $derived(!!questionPanels[detail.id]);
  let narrow = $state(matchMedia("(max-width: 1100px)").matches);
  $effect(() => {
    const media = matchMedia("(max-width: 1100px)");
    const resize = () => narrow = media.matches;
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  });
  let drawerWasOpen = false;
  $effect(() => {
    const requested = panelOpen;
    const drawerOpen = navigation.surfaces.includes("questions");
    if (!narrow) { drawerWasOpen = false; removeQuestionDrawer(); return; }
    if (drawerWasOpen && !drawerOpen) {
      drawerWasOpen = false;
      setQuestionPanel(detail.id, false);
      return;
    }
    drawerWasOpen = drawerOpen;
    // A fresh question waits for the currently visible foreground to dismiss.
    if (requested && !drawerOpen && !navigation.surfaces.length) setSurface("questions", true);
  });
  const panelVisible = $derived(panelOpen && (!narrow || navigation.surfaces.includes("questions")));
  function toggleQuestions() {
    if (narrow) { if (navigation.surfaces.includes("questions")) void back(); else { setQuestionPanel(detail.id, true); setSurface("questions", true); } }
    else setQuestionPanel(detail.id, !panelOpen);
  }
  const pending = $derived(detail.questions.filter(q => q.state !== "answered"));
  const answerMessages = $derived(new Set(detail.deliveries.filter(d => d.source === "question").map(d => d.id)));
  const reports = $derived(new Map(detail.deliveries.filter(d => d.source === "worker" && d.reportingWorkerId).map(d => [d.id, d])));
</script>
<aside class="agent-detail" aria-label={detail.title}>
  <div class="mobile-back"><Button variant="ghost" size="sm" onclick={onclose}>{navigation.details.length > 1 ? m.back_orc() : m.back_sessions()}</Button><Weekly surface="weekly-detail" hostId={detail.hostId} {connected} /></div><header class="detail-heading"><div class="detail-meta"><div class="role-project">{detail.role === "orc" ? m.orc() : m.worker()} / {detail.project.alias}</div><div class="detail-status">{#if detail.hostName}<span class="owner-badge">{detail.hostName}</span>{/if}<span class:working={detail.state === "working"} class:failed={detail.state === "error"}><i></i>{detail.closeRequest ? m.closing_worker() : detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : detail.state === "working" ? m.working() + " " + elapsed(detail.workingSince, now) : detail.state === "error" ? m.failed() : m.idle()}</span>{#if pending.length}<Badge variant="outline" class="border-amber-500/30 text-amber-200">{m.needs_input()}</Badge>{/if}</div><div class="detail-model">{detail.model} / {detail.effort}{#if detail.serviceTier === "priority"} / {m.fast_mode()}{/if}</div></div><Button class="questions-toggle" variant="ghost" size="sm" aria-label={m.all_questions()} aria-expanded={panelVisible} onclick={toggleQuestions}><MessageCircle />{m.all_questions()}{#if pending.length}<span class="pending-count">{pending.length}</span>{/if}</Button><TitleEditor title={detail.title} editable={detail.role === "orc" && connected} {onrename} /></header>
  {#if closeError}<p class="detail-close-error" role="alert">{closeError}</p>{/if}
  <div class="detail-body"><div class="dialogue-column"><div class="conversation-wrap"><div class="conversation" bind:this={transcript} onscroll={() => follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80}>
    {#if !connected}<p class="host-outage" role="status">{m.host_offline()}{#if lastSeen}<br/>{m.last_seen({ time: new Date(lastSeen).toLocaleString() })}{/if}</p>{/if}
    {#if detail.closeRequest}<p class="model-note">{detail.closeRequest.reason}</p>{/if}
    {#if detail.error}<p class="inline-error" role="alert">{detail.error}</p>{/if}
    {#if owner}<button class="owner-link" onclick={() => onopen(owner.id)}>{m.assigned_by({ title: owner.title })}</button>{/if}
    {#if detail.historyCursor}<HistoricalMessages agentId={detail.id} {connected} {renderMessage} />{/if}
    {#if !detail.historyCursor && !detail.messages.length && !detail.questions.length}<div class="first-message"><h2>{m.first_heading()}</h2><p>{m.first_help({ project: detail.project.alias })}</p></div>{/if}
    {#snippet renderMessage(message: Message)}
      {@const report = reports.get(message.id)}
      {#if !answerMessages.has(message.id)}
      {#if report}<WorkerReport text={message.text} sender={workers.find(w => w.id === report.reportingWorkerId)?.title} />
      {:else}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{message.role === "assistant" ? detail.role === "orc" ? m.orc() : m.worker() : ""}</div><Markdown text={message.text} /></div>{/if}
      {/if}
    {/snippet}
    {#each detail.messages.slice(detail.historyCursor ? detail.historyMessageCount ?? 0 : 0) as message (message.id)}
      {@render renderMessage(message)}
    {/each}
    {#each detail.deliveries.filter(d => (d.status === "failed" || d.status === "uncertain") && d.source !== "question") as delivery}<details class="delivery-error"><summary>{delivery.status === "uncertain" ? m.unknown_delivery() : delivery.error}</summary>{#if delivery.source !== 'user'}<p>{delivery.text}</p>{/if}{#if delivery.status === "uncertain"}<p>{m.lookup_help()}</p><Button variant="ghost" size="sm" disabled={!connected} onclick={() => onlookup(delivery.id)}>{m.check_delivery()}</Button>{/if}{#if delivery.status === "failed" && delivery.source === "user" && detail.role === "orc"}<Button variant="ghost" size="sm" onclick={() => composer?.recover(delivery.text)}>{m.restore_message()}</Button>{/if}{#if delivery.status === "failed" && delivery.source === "worker"}<Button variant="ghost" size="sm" disabled={!connected} onclick={() => onretry(delivery.id)}>{m.retry()}</Button>{/if}</details>{/each}
    {#if actionError}<div class="host-outage" role="alert"><p>{actionError}</p><Button variant="ghost" size="sm" onclick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>{m.message_orc()}</Button></div>{/if}
    {#if detail.stop?.status === "confirmed"}<p class="stop-confirmed" role="status">{m.stop_confirmed()}</p>{:else if detail.stop?.status === "unknown"}<p class="host-outage" role="status">{m.stop_unknown()} <Button variant="ghost" size="sm" onclick={onrefresh}>{m.retry_connection()}</Button></p>{:else if detail.stop?.status === "completed"}<p role="status">{m.stop_completed()}</p>{/if}
    {#if detail.role === "worker" && detail.state === "working"}<p class="work-duration">{m.working_for({ time: elapsed(detail.workingSince, now) })}</p>{/if}
  </div>
  {#if !follow}<Button class="jump-bottom" variant="secondary" size="icon-sm" aria-label={m.jump_bottom()} title={m.jump_bottom()} onclick={jumpToBottom}><ArrowDown /></Button>{/if}</div>
  {#if detail.role === "orc"}<Composer bind:this={composer} agentId={detail.id} project={detail.project.alias} {skills} {connected} working={detail.state === "working"} stopping={detail.state === "stopping"} {onstop} {onsend} />{:else}<footer class="read-only"><p>{m.read_only()}</p>{#if owner}<button onclick={() => onopen(owner.id)}>{m.through_orc()}</button>{/if}</footer>{/if}
  </div>
  {#if panelVisible}<section class="question-panel" aria-label={m.all_questions()}>
    <header class="question-panel-heading"><strong>{m.all_questions()}</strong><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={toggleQuestions}><X /></Button></header>
    {#if detail.role === "orc"}<Questions agentId={detail.id} questions={detail.questions} deliveries={detail.deliveries} connected={connected && detail.state !== "stopping"} {onanswer} {onlookup} {onretry} />
    {:else}<div class="delegated-questions">{#each detail.questions as q}<div><p>{q.text}</p><span>{q.state === "answered" ? q.answer : m.delegated()}</span></div>{/each}</div>{/if}
  </section>{/if}</div>
</aside>
