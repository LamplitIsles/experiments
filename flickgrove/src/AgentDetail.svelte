<script lang="ts">
  import { splitMessages } from "./conversation-messages";
  import { submissionResult } from "./outgoing.svelte";
  import { transcriptPositions } from "./transcript-state";
  import SessionSettings from "./SessionSettings.svelte";
  import FilePreview from "./FilePreview.svelte";
  import MessageImages from "./MessageImages.svelte";
  import { restoreImages, type ImageDraft } from "./image-drafts";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { X, ArrowDown, MessageCircle, ChevronDown } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { questionPanels, setQuestionPanel } from "./question-state.svelte";
  import { navigation, setSurface, removeQuestionDrawer, back } from "./navigation.svelte";
  import { untrack } from "svelte";
  import type { Answer, Agent, Detail, Skill, Message, Delivery } from "./contracts";
  import { elapsed } from "./api";
  import TitleEditor from "./TitleEditor.svelte";
  import Weekly from "./Weekly.svelte";
  import MessageTime from "./MessageTime.svelte";
  import Markdown from "./Markdown.svelte";
  import WorkerReport from "./WorkerReport.svelte";
  import ConversationTimeline from "./ConversationTimeline.svelte";
  import Composer from "./Composer.svelte";
  import Questions from "./Questions.svelte";
  import * as m from "./paraglide/messages";
  let { detail, ready = true, tree, owner, skills, now, connected, mediaConnected, entryId, entryConnected, workers, lastSeen, actionError, closeError, onrefresh, onstop, onupdate, onrename, onclose, onopen, onsend, onanswer, onretry, onrecovered, ondeletefailed }: { detail: Detail; ready?: boolean; tree?: Agent; owner?: Agent; skills: Skill[]; now: number; connected: boolean; mediaConnected: boolean; entryId?: string; entryConnected: boolean; workers: Agent[]; lastSeen?: number; actionError: string; closeError?: string; onupdate: (value: Detail) => void; onrefresh: () => Promise<void>; onstop: () => Promise<boolean>; onrename: (title: string) => Promise<string | undefined>; onclose: () => void; onopen: (id: string) => void; onsend: (agentId: string, text: string, requestId: string, images?: ImageDraft[]) => Promise<boolean>; onanswer: (answers: Answer[], operationId: string) => Promise<void>; onretry: (id: string) => Promise<void>; onrecovered: (agentId:string,operationId:string) => void; ondeletefailed: (agentId:string,operationId:string) => Promise<void>; } = $props();
  let composer = $state<Composer>();
  let recovering = $state(false);
  async function recoverDelivery(delivery:Delivery) {
    if(recovering || submissionResult(delivery)!=="rejected")return;
    const agentId=detail.id;
    const count=delivery.images?.length ?? detail.messages.find(m=>m.id===delivery.id)?.localImageIds?.length ?? 0;
    recovering=true;
    try {
      if(count)await restoreImages(agentId,delivery.id,delivery.text,count);
      else { if(!composer)throw new Error("Open the original conversation to restore this message."); await composer.recover(delivery.text); }
      await ondeletefailed(agentId,delivery.id);
      composer?.imageRecoveryError("");
      onrecovered(agentId,delivery.id);
    }catch(e){composer?.imageRecoveryError((e as Error).message);}
    finally{recovering=false;}
  }
  let timeline = $state<ConversationTimeline>();
  let follow = $state(true);
  let pinnedImage = $state<string>();
  const expandedReports = untrack(() => transcriptPositions.get(detail.id)?.reports ?? new Set<string>());
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
    if (!requested && drawerOpen) { removeQuestionDrawer(); return; }
    if (navigation.surfaces.includes("file-preview")) return;
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
  const panelVisible = $derived(panelOpen && (!narrow ? !navigation.surfaces.length : navigation.surfaces.at(-1) === "questions"));
  function toggleQuestions() {
    if (narrow) { if (navigation.surfaces.includes("questions")) void back(); else { setQuestionPanel(detail.id, true); setSurface("questions", true); } }
    else setQuestionPanel(detail.id, !panelOpen);
  }
  let reasonOpen = $state(false);
  let reasonIdentity: string | undefined;
  let reasonCause: string | undefined;
  $effect(() => {
    if (reasonIdentity !== detail.id || reasonCause !== detail.error) reasonOpen = false;
    reasonIdentity = detail.id;
    reasonCause = detail.error;
  });
  const executionLabel = $derived(detail.execution?.retrying ? m.execution_retrying() : detail.execution?.kind === "capacity" ? m.execution_capacity() : m.execution_failed());
  const pending = $derived(detail.questions.filter(q => q.state !== "answered"));
  let observedSent: Set<string> | undefined;
  $effect(() => {
    if (!ready) return;
    const sent = detail.deliveries.filter(d => d.source === "question" && submissionResult(d) === "accepted");
    // The initial snapshot is history, not a completion of this selected session.
    const completed = observedSent && sent.some(d => !observedSent!.has(d.id));
    observedSent ??= new Set();
    for (const delivery of sent) observedSent.add(delivery.id);
    if (!completed || !panelOpen || pending.length) return;
    setQuestionPanel(detail.id, false);
    removeQuestionDrawer();
  });
  const reports = $derived(new Map(detail.deliveries.filter(d => (d.source === "worker" && d.reportingWorkerId) || (d.source === "reviewer" && d.reportingReviewerId) || (d.source === "researcher" && d.reportingResearcherId)).map(d => [d.id, d])));
</script>
<aside class="agent-detail" aria-label={detail.title}>
  <div class="mobile-back"><Button variant="ghost" size="sm" onclick={onclose}>{navigation.details.length > 1 ? m.back_orc() : m.back_sessions()}</Button><Weekly surface="weekly-detail" hostId={entryId} connected={entryConnected} /></div><header class="detail-heading"><div class="detail-meta"><div class="role-project">{detail.role === "orc" ? m.orc() : detail.role === "reviewer" ? "Reviewer" : detail.role === "researcher" ? "Researcher" : m.worker()} / {detail.project.alias}</div><div class="detail-status">{#if detail.hostName}<span class="owner-badge">{detail.hostName}</span>{/if}{#if detail.error}<button class="execution-feedback" class:failed={!detail.execution?.retrying} class:working={detail.execution?.retrying} aria-expanded={reasonOpen} aria-controls="execution-reason" onclick={() => reasonOpen = !reasonOpen}><i></i>{executionLabel}{#if detail.execution?.retrying && detail.state === "working"}<span>{elapsed(detail.workingSince, now)}</span>{/if}<ChevronDown size={12} /></button>{:else}<span class:working={detail.state === "working"} class:failed={detail.state === "error"}><i></i>{detail.closeRequest ? m.closing_worker() : detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : detail.state === "working" ? m.working() + " " + elapsed(detail.workingSince, now) : detail.state === "error" ? m.failed() : m.idle()}</span>{/if}{#if pending.length}<Badge variant="outline" class="border-amber-500/30 text-amber-200">{m.needs_input()}</Badge>{/if}</div>{#if detail.role !== "reviewer" && detail.role !== "researcher"}<SessionSettings {detail} {tree} connected={connected && ready} {onupdate} />{:else}<span>{detail.model} · {detail.effort}</span>{/if}</div><Button class="questions-toggle" variant="ghost" size="sm" aria-label={m.all_questions()} aria-expanded={panelVisible} onclick={toggleQuestions}><MessageCircle />{m.all_questions()}{#if pending.length}<span class="pending-count">{pending.length}</span>{/if}</Button>{#if detail.error && reasonOpen}<div class="execution-reason" id="execution-reason" role="status">{detail.error}</div>{/if}<TitleEditor title={detail.title} editable={ready && detail.role === "orc" && connected} {onrename} /></header>
  {#if detail.researchQuestion}<div class="review-target">Question: {detail.researchQuestion}</div>{/if}
  {#if detail.reviewTarget}<p class="review-target">{detail.reviewTarget.profile} · {detail.reviewTarget.spec} · {detail.reviewTarget.fixedPoint} → {detail.reviewTarget.reviewedHead}</p>{/if}
  {#if closeError}<p class="detail-close-error" role="alert">{closeError}</p>{/if}
  <div class="detail-body"><div class="dialogue-column"><div class="conversation-wrap">{#key ready ? detail.historyCursor ?? "live" : "pending"}<ConversationTimeline bind:this={timeline} agentId={detail.id} boundary={ready ? detail.historyCursor : undefined} live={ready ? splitMessages(detail).live : []} {ready} {connected} reports={expandedReports} pinned={pinnedImage} onfollow={value => follow = value}>
    {#snippet header()}
    {#if !connected}<p class="host-outage" role="status">{m.host_offline()}{#if lastSeen}<br/>{m.last_seen({ time: new Date(lastSeen).toLocaleString() })}{/if}</p>{/if}
    {#if detail.closeRequest}<p class="model-note">{detail.closeRequest.reason}</p>{/if}
    {#if owner}<button class="owner-link" onclick={() => onopen(owner.id)}>{m.assigned_by({ title: owner.title })}</button>{/if}
    {#if !ready}<div class="detail-loading" role="status"><p>{actionError || m.loading_conversation()}</p>{#if actionError || !connected}<Button variant="ghost" size="sm" disabled={!connected} onclick={onrefresh}>{m.retry()}</Button>{/if}</div>{/if}
    {#if ready && !detail.historyCursor && !detail.messages.length && !detail.questions.length}<div class="first-message"><h2>{m.first_heading()}</h2><p>{m.first_help({ project: detail.project.alias })}</p></div>{/if}
    {/snippet}
    {#snippet renderMessage(message: Message)}
      {@const report = reports.get(message.id)}
      {@const delivery = detail.deliveries.find(d=>d.id===message.id)}
      {#if report}<WorkerReport at={message.at} agentId={report.reportingResearcherId ?? report.reportingReviewerId ?? report.reportingWorkerId} kind={report.source === "researcher" ? "Researcher report" : report.source === "reviewer" ? "Reviewer report" : undefined} text={message.text} sender={workers.find(w => w.id === (report.reportingResearcherId ?? report.reportingReviewerId ?? report.reportingWorkerId))?.title} initiallyExpanded={expandedReports.has(message.id)} onexpanded={value => { if (value) expandedReports.add(message.id); else expandedReports.delete(message.id); }} />
      {:else}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{#if message.role === "assistant"}<MessageTime at={message.at} />{/if}{message.role === "assistant" ? detail.role === "orc" ? m.orc() : detail.role === "reviewer" ? "Reviewer" : detail.role === "researcher" ? "Researcher" : m.worker() : ""}</div>{#if message.role === "user"}<MessageTime at={message.at} />{/if}<Markdown text={message.text} agentId={detail.id} />
      {#if message.images?.length || message.localImageIds?.length}<MessageImages connected={mediaConnected} agentId={detail.id} operationId={message.id} images={message.images} localImageIds={message.localImageIds} onviewer={open => { if (open) pinnedImage = message.id; else if (pinnedImage === message.id) pinnedImage = undefined; }} />{/if}
      {#if delivery && submissionResult(delivery) !== 'accepted'}<small class:failed={submissionResult(delivery)==='rejected'} role="status">{submissionResult(delivery)==='rejected' ? m.failed() : m.sending()}</small>{/if}
      </div>{/if}
    {/snippet}
    {#snippet footer()}
    {#each detail.deliveries.filter(d => d.source !== "question" && (submissionResult(d) === "rejected" || ((d.source === "worker" || d.source === "reviewer" || d.source === "researcher") && d.status === "uncertain"))) as delivery}<details class="delivery-error"><summary>{delivery.error}</summary>{#if delivery.source !== 'user'}<p>{delivery.text}</p>{/if}{#if delivery.source === "user" && detail.role === "orc"}<Button variant="ghost" size="sm" disabled={recovering} onclick={() => recoverDelivery(delivery)}>{m.restore_message()}</Button>{/if}{#if detail.role !== "reviewer" && detail.role !== "researcher" && (delivery.source === "worker" || delivery.source === "reviewer" || delivery.source === "researcher") && submissionResult(delivery) === "rejected"}<Button variant="ghost" size="sm" disabled={!connected} onclick={() => onretry(delivery.id)}>{m.retry()}</Button>{/if}</details>{/each}
    {#if ready && actionError}<div class="host-outage" role="alert"><p>{actionError}</p><Button variant="ghost" size="sm" onclick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>{m.message_orc()}</Button></div>{/if}
    {#if detail.stop?.status === "confirmed"}<p class="stop-confirmed" role="status">{m.stop_confirmed()}</p>{:else if detail.stop?.status === "unknown"}<p class="host-outage" role="status">{m.stop_unknown()} <Button variant="ghost" size="sm" onclick={onrefresh}>{m.retry_connection()}</Button></p>{:else if detail.stop?.status === "completed"}<p role="status">{m.stop_completed()}</p>{/if}
    {/snippet}
  </ConversationTimeline>{/key}
  {#if !follow}<Button class="jump-bottom" variant="secondary" size="icon-sm" aria-label={m.jump_bottom()} title={m.jump_bottom()} onclick={() => timeline?.jumpToBottom()}><ArrowDown /></Button>{/if}</div>
  {#if detail.role === "orc"}<Composer bind:this={composer} agentId={detail.id} project={detail.project.alias} {skills} connected={connected && ready} working={detail.state === "working"} stopping={detail.state === "stopping"} {onstop} {onsend} />{:else}<footer class="read-only"><p>{m.read_only()}</p>{#if owner}<button onclick={() => onopen(owner.id)}>{m.through_orc()}</button>{/if}</footer>{/if}
  </div>
  {#if panelOpen}<section class="question-panel" class:question-hidden={!panelVisible} aria-label={m.all_questions()}>
    <header class="question-panel-heading"><strong>{m.all_questions()}</strong><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={toggleQuestions}><X /></Button></header>
    {#if detail.role === "orc"}<Questions agentId={detail.id} questions={detail.questions} deliveries={detail.deliveries} connected={ready && connected && detail.state !== "stopping"} {onanswer} {onretry} />
    {:else}<div class="delegated-questions">{#each detail.questions as q}<div><p>{q.text}</p><span>{q.state === "answered" ? q.answer : m.delegated()}</span></div>{/each}</div>{/if}
  </section>{/if}</div>
  {#if navigation.preview}<div class:preview-hidden={navigation.surfaces.at(-1) !== "file-preview"}><FilePreview {connected} agent={navigation.preview.agent} href={navigation.preview.href} onclose={() => void back()} /></div>{/if}
</aside>
