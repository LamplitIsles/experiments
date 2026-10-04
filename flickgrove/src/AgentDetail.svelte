<script lang="ts">
  import MessageImages from "./MessageImages.svelte";
  import { restoreImages, type ImageDraft } from "./image-drafts";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { X, ArrowDown, MessageCircle, ChevronDown } from "@lucide/svelte";
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
  let { detail, owner, skills, now, connected, entryId, entryConnected, workers, lastSeen, actionError, closeError, onrefresh, onstop, onrename, onclose, onopen, onsend, onanswer, onlookup, onretry, ondismiss }: { detail: Detail; owner?: Agent; skills: Skill[]; now: number; connected: boolean; entryId?: string; entryConnected: boolean; workers: Agent[]; lastSeen?: number; actionError: string; closeError?: string; onrefresh: () => Promise<void>; onstop: () => Promise<boolean>; onrename: (title: string) => Promise<string | undefined>; onclose: () => void; onopen: (id: string) => void; onsend: (agentId: string, text: string, requestId: string, images?: ImageDraft[]) => Promise<boolean>; onanswer: (answers: Answer[], operationId: string) => Promise<void>; onlookup: (id: string) => Promise<void>; onretry: (id: string) => Promise<void>; ondismiss:(id:string)=>void } = $props();
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
  const panelVisible = $derived(panelOpen && (!narrow ? !navigation.surfaces.length : navigation.surfaces.includes("questions")));
  function toggleQuestions() {
    if (narrow) { if (navigation.surfaces.includes("questions")) void back(); else { setQuestionPanel(detail.id, true); setSurface("questions", true); } }
    else setQuestionPanel(detail.id, !panelOpen);
  }
  let reasonOpen = $state(false);
  $effect(() => { if (detail.error) reasonOpen = false; });
  const executionLabel = $derived(detail.execution?.retrying ? m.execution_retrying() : detail.execution?.kind === "capacity" ? m.execution_capacity() : m.execution_failed());
  const pending = $derived(detail.questions.filter(q => q.state !== "answered"));
  const reports = $derived(new Map(detail.deliveries.filter(d => d.source === "worker" && d.reportingWorkerId).map(d => [d.id, d])));
</script>
<aside class="agent-detail" aria-label={detail.title}>
  <div class="mobile-back"><Button variant="ghost" size="sm" onclick={onclose}>{navigation.details.length > 1 ? m.back_orc() : m.back_sessions()}</Button><Weekly surface="weekly-detail" hostId={entryId} connected={entryConnected} /></div><header class="detail-heading"><div class="detail-meta"><div class="role-project">{detail.role === "orc" ? m.orc() : m.worker()} / {detail.project.alias}</div><div class="detail-status">{#if detail.hostName}<span class="owner-badge">{detail.hostName}</span>{/if}{#if detail.error}<button class="execution-feedback" class:failed={!detail.execution?.retrying} class:working={detail.execution?.retrying} aria-expanded={reasonOpen} aria-controls="execution-reason" onclick={() => reasonOpen = !reasonOpen}><i></i>{executionLabel}{#if detail.execution?.retrying && detail.state === "working"}<span>{elapsed(detail.workingSince, now)}</span>{/if}<ChevronDown size={12} /></button>{:else}<span class:working={detail.state === "working"} class:failed={detail.state === "error"}><i></i>{detail.closeRequest ? m.closing_worker() : detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : detail.state === "working" ? m.working() + " " + elapsed(detail.workingSince, now) : detail.state === "error" ? m.failed() : m.idle()}</span>{/if}{#if pending.length}<Badge variant="outline" class="border-amber-500/30 text-amber-200">{m.needs_input()}</Badge>{/if}</div><div class="detail-model">{detail.model} / {detail.effort}{#if detail.serviceTier === "priority"} / {m.fast_mode()}{/if}</div></div><Button class="questions-toggle" variant="ghost" size="sm" aria-label={m.all_questions()} aria-expanded={panelVisible} onclick={toggleQuestions}><MessageCircle />{m.all_questions()}{#if pending.length}<span class="pending-count">{pending.length}</span>{/if}</Button>{#if detail.error && reasonOpen}<div class="execution-reason" id="execution-reason" role="status">{detail.error}</div>{/if}<TitleEditor title={detail.title} editable={detail.role === "orc" && connected} {onrename} /></header>
  {#if closeError}<p class="detail-close-error" role="alert">{closeError}</p>{/if}
  <div class="detail-body"><div class="dialogue-column"><div class="conversation-wrap"><div class="conversation" bind:this={transcript} onscroll={() => follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80}>
    {#if !connected}<p class="host-outage" role="status">{m.host_offline()}{#if lastSeen}<br/>{m.last_seen({ time: new Date(lastSeen).toLocaleString() })}{/if}</p>{/if}
    {#if detail.closeRequest}<p class="model-note">{detail.closeRequest.reason}</p>{/if}
    {#if owner}<button class="owner-link" onclick={() => onopen(owner.id)}>{m.assigned_by({ title: owner.title })}</button>{/if}
    {#if detail.historyCursor}<HistoricalMessages agentId={detail.id} {connected} {renderMessage} />{/if}
    {#if !detail.historyCursor && !detail.messages.length && !detail.questions.length}<div class="first-message"><h2>{m.first_heading()}</h2><p>{m.first_help({ project: detail.project.alias })}</p></div>{/if}
    {#snippet renderMessage(message: Message)}
      {@const report = reports.get(message.id)}
      {@const delivery = detail.deliveries.find(d=>d.id===message.id)}
      {#if report}<WorkerReport text={message.text} sender={workers.find(w => w.id === report.reportingWorkerId)?.title} />
      {:else}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{message.role === "assistant" ? detail.role === "orc" ? m.orc() : m.worker() : ""}</div><Markdown text={message.text} />
      {#if message.images?.length || message.localImageIds?.length}<MessageImages agentId={detail.id} operationId={message.id} images={message.images} localImageIds={message.localImageIds} />{/if}
      {#if delivery?.status==='failed' || delivery?.status==='uncertain'}<small class:failed={delivery.status==='failed'} role="status">{delivery.status==='failed' ? m.failed() : m.unknown_delivery()}</small>{/if}
      </div>{/if}
    {/snippet}
    {#each detail.messages.slice(detail.historyCursor ? detail.historyMessageCount ?? 0 : 0) as message (message.id)}
      {@render renderMessage(message)}
    {/each}
    {#each detail.deliveries.filter(d => (d.status === "failed" || d.status === "uncertain") && d.source !== "question") as delivery}<details class="delivery-error"><summary>{delivery.status === "uncertain" ? (delivery.receiptState === "missing" ? m.delivery_missing() : delivery.receiptState === "pending" ? m.delivery_pending() : m.unknown_delivery()) : delivery.error}</summary>{#if delivery.source !== 'user'}<p>{delivery.text}</p>{/if}{#if delivery.status === "uncertain"}<p>{m.lookup_help()}</p><Button variant="ghost" size="sm" disabled={!connected} onclick={() => onlookup(delivery.id)}>{m.check_delivery()}</Button><Button variant="ghost" size="sm" onclick={()=>ondismiss(delivery.id)}>{m.dismiss_delivery()}</Button><small>{m.dismiss_delivery_help()}</small>{/if}{#if delivery.status === "failed" && delivery.source === "user" && detail.role === "orc"}<Button variant="ghost" size="sm" onclick={() => delivery.images?.length ? restoreImages(detail.id,delivery.id,delivery.text).catch(e=>composer?.imageRecoveryError(e.message)) : composer?.recover(delivery.text)}>{m.restore_message()}</Button>{/if}{#if delivery.status === "failed" && delivery.source === "worker"}<Button variant="ghost" size="sm" disabled={!connected} onclick={() => onretry(delivery.id)}>{m.retry()}</Button>{/if}</details>{/each}
    {#if actionError}<div class="host-outage" role="alert"><p>{actionError}</p><Button variant="ghost" size="sm" onclick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>{m.message_orc()}</Button></div>{/if}
    {#if detail.stop?.status === "confirmed"}<p class="stop-confirmed" role="status">{m.stop_confirmed()}</p>{:else if detail.stop?.status === "unknown"}<p class="host-outage" role="status">{m.stop_unknown()} <Button variant="ghost" size="sm" onclick={onrefresh}>{m.retry_connection()}</Button></p>{:else if detail.stop?.status === "completed"}<p role="status">{m.stop_completed()}</p>{/if}
  </div>
  {#if !follow}<Button class="jump-bottom" variant="secondary" size="icon-sm" aria-label={m.jump_bottom()} title={m.jump_bottom()} onclick={jumpToBottom}><ArrowDown /></Button>{/if}</div>
  {#if detail.role === "orc"}<Composer bind:this={composer} agentId={detail.id} project={detail.project.alias} {skills} {connected} working={detail.state === "working"} stopping={detail.state === "stopping"} {onstop} {onsend} />{:else}<footer class="read-only"><p>{m.read_only()}</p>{#if owner}<button onclick={() => onopen(owner.id)}>{m.through_orc()}</button>{/if}</footer>{/if}
  </div>
  {#if panelVisible}<section class="question-panel" aria-label={m.all_questions()}>
    <header class="question-panel-heading"><strong>{m.all_questions()}</strong><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={toggleQuestions}><X /></Button></header>
    {#if detail.role === "orc"}<Questions agentId={detail.id} questions={detail.questions} deliveries={detail.deliveries} connected={connected && detail.state !== "stopping"} {onanswer} {onlookup} {onretry} {ondismiss} />
    {:else}<div class="delegated-questions">{#each detail.questions as q}<div><p>{q.text}</p><span>{q.state === "answered" ? q.answer : m.delegated()}</span></div>{/each}</div>{/if}
  </section>{/if}</div>
</aside>
