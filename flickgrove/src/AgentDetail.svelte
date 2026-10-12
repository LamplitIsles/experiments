<script lang="ts">
  import { reading } from "./api";
  import MessageBody from "./MessageBody.svelte";
  import { submissionResult } from "./outgoing.svelte";
  import { transcriptPositions } from "./transcript-state";
  import SessionSettings from "./SessionSettings.svelte";
  import FilePreview from "./FilePreview.svelte";
  import MessageImages from "./MessageImages.svelte";
  import { restoreImages, type ImageDraft } from "./image-drafts";
  import { Badge } from "$lib/components/ui/badge/index.js";
  import { X, Square, ArrowDown, MessageCircle, ChevronDown } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { questionPanels, setQuestionPanel } from "./question-state.svelte";
  import { navigation, setSurface, removeQuestionDrawer, back } from "./navigation.svelte";
  import { untrack, onMount } from "svelte";
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
  import QuestionRecord from "./QuestionRecord.svelte";
  import * as m from "./paraglide/messages";
  let { detail, ready = true, tree, owner, skills, now, connected, mediaConnected, entryId, entryConnected, workers, lastSeen, actionError, closeError, onrefresh, onstop, onupdate, onrename, onclose, onopen, onsend, onanswer, onretry, onrecovered, ondeletefailed }: { detail: Detail; ready?: boolean; tree?: Agent; owner?: Agent; skills: Skill[]; now: number; connected: boolean; mediaConnected: boolean; entryId?: string; entryConnected: boolean; workers: Agent[]; lastSeen?: number; actionError: string; closeError?: string; onupdate: (value: Detail) => void; onrefresh: () => Promise<void>; onstop: () => Promise<boolean>; onrename: (title: string) => Promise<string | undefined>; onclose: () => void; onopen: (id: string) => void; onsend: (agentId: string, text: string, requestId: string, images?: ImageDraft[]) => Promise<boolean>; onanswer: (answers: Answer[], operationId: string, text?: string) => Promise<void>; onretry: (id: string) => Promise<void>; onrecovered: (agentId:string,operationId:string) => void; ondeletefailed: (agentId:string,operationId:string) => Promise<void>; } = $props();
  let composer = $state<Composer>();
  let recovering = $state(false);
  async function recoverDelivery(delivery:Delivery) {
    if(recovering || submissionResult(delivery)!=="rejected")return;
    const agentId=detail.id;
    recovering=true;
    try {
      if (delivery.recoveryRef) delivery = await reading<Delivery>(`/recovery?${new URLSearchParams({agent: agentId, operation: delivery.id})}`, agentId);
      const count=delivery.images?.length ?? detail.messages.find(m=>m.id===delivery.id)?.localImageIds?.length ?? 0;
      if(count)await restoreImages(agentId,delivery.id,delivery.text,count);
      else { if(!composer)throw new Error("Open the original conversation to restore this message."); await composer.recover(delivery.text); }
      await ondeletefailed(agentId,delivery.id);
      composer?.imageRecoveryError("");
      onrecovered(agentId,delivery.id);
    }catch(e){composer?.imageRecoveryError((e as Error).message);}
    finally{recovering=false;}
  }
  let recoveryRecords = $state<Delivery[]>([]), recoveryCursor = $state<string | null | undefined>(undefined), recoveryError = $state("");
  async function loadRecoveries() {
    if (recoveryCursor === null) return;
    try {
      const page = await reading<{deliveries: Delivery[]; nextCursor: string | null}>(`/deliveries?${new URLSearchParams({agent: detail.id, ...(recoveryCursor ? {cursor: recoveryCursor} : {})})}`, detail.id);
      recoveryRecords = [...new Map([...recoveryRecords, ...page.deliveries].map(d => [d.id, d])).values()];
      recoveryCursor = page.nextCursor; recoveryError = "";
    } catch(e) { recoveryError = (e as Error).message; }
  }
  const recoveries = $derived([...new Map([...recoveryRecords, ...detail.deliveries].map(d => [d.id, d])).values()]);
  let timeline = $state<ConversationTimeline>();
  let follow = $state(true);
  let pinnedImage = $state<string>();
  const expandedReports = untrack(() => transcriptPositions.get(detail.id)?.reports ?? new Set<string>());
  let record = $state<{item?: string; operation?: string} | null>(null);
  let pendingItem = $state<string>();
  let beforeRecord = false;
  const pendingOpen = $derived(!!questionPanels[detail.id]);
  const panelOpen = $derived(pendingOpen || !!record);
  function openRecord(message: Message) {
    if (!record) beforeRecord = pendingOpen;
    record = message.questionItemId ? {item: message.questionItemId} : {operation: message.clientId ?? message.id};
  }
  function closeRecord() { record = null; setQuestionPanel(detail.id, beforeRecord && pendingCount > 0); }
  function openPending(item?: string) { record = null; pendingItem = item; setQuestionPanel(detail.id, true); }

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
      if (record) closeRecord(); else setQuestionPanel(detail.id, false);
      return;
    }
    drawerWasOpen = drawerOpen;
    // A fresh question waits for the currently visible foreground to dismiss.
    if (requested && !drawerOpen && !navigation.surfaces.length) setSurface("questions", true);
  });
  const panelVisible = $derived(panelOpen && (!narrow ? !navigation.surfaces.length : navigation.surfaces.at(-1) === "questions"));
  function toggleQuestions() {
    if (record) { closeRecord(); if (!beforeRecord) removeQuestionDrawer(); return; }
    setQuestionPanel(detail.id, !pendingOpen);
    if (pendingOpen) removeQuestionDrawer();
  }
  onMount(() => {
    const dismissRecord = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || !record || !panelVisible) return;
      event.preventDefault(); event.stopImmediatePropagation();
      closeRecord(); if (!beforeRecord) removeQuestionDrawer();
    };
    window.addEventListener("keydown", dismissRecord, true);
    return () => window.removeEventListener("keydown", dismissRecord, true);
  });
  let reasonOpen = $state(false);
  let reasonIdentity: string | undefined;
  let reasonCause: string | undefined;
  $effect(() => {
    if (reasonIdentity !== detail.id || reasonCause !== detail.error) reasonOpen = false;
    reasonIdentity = detail.id;
    reasonCause = detail.error;
  });
  const executionLabel = $derived(detail.execution?.retrying ? m.execution_retrying() : detail.execution?.kind === "capacity" ? m.execution_capacity() : m.execution_failed());
  let fullQuestions = $state<import("./contracts").Question[]>([]);
  let questionError = $state("");
  let questionRevision = $state(0);
  let fullBatches = $state<Delivery[]>([]);
  let questionLoading = $state(false);
  let batchLoading = $state(false), batchError = $state("");
  const questionReadKey = $derived(JSON.stringify([detail.id, detail.questions.map(q => [q.id, q.state]), detail.unansweredCount]));
  $effect(() => {
    const identities = questionReadKey, revision = questionRevision;
    const id = untrack(() => detail.id);
    if (!pendingOpen || !connected) { questionLoading = false; return; }
    const controller = new AbortController();
    questionLoading = true;
    void untrack(() => reading<import("./contracts").Question[]>(`/questions?${new URLSearchParams({agent: id, pending: "true"})}`, id, controller.signal))
      .then(questions => { if (!controller.signal.aborted) { fullQuestions = questions; questionError = ""; } })
      .catch(e => { if (!controller.signal.aborted) questionError = (e as Error).message; })
      .finally(() => { if (!controller.signal.aborted) questionLoading = false; });
    return () => controller.abort();
  });
  // HTTP question identities also locate unresolved operations outside the
  // bounded detail delivery window, without copying another transcript.
  const batchReferences = $derived([...new Map([
    ...fullQuestions.flatMap(q => q.answerOperation && detail.questions.find(ref => ref.id === q.id)?.state !== "answered" ? [q.answerOperation] : []),
    ...detail.deliveries.filter(d => d.source === "question" && d.status !== "sent").map(d => ({id:d.id,status:d.status})),
  ].map(ref => [ref.id, ref])).values()].filter(ref => detail.deliveries.find(d => d.id === ref.id)?.status !== "sent"));
  const batchReadKey = $derived(JSON.stringify(batchReferences));
  $effect(() => {
    const key = batchReadKey, revision = questionRevision;
    if (!pendingOpen || !connected) return;
    const id = untrack(() => detail.id);
    const batches = untrack(() => batchReferences.map(ref => detail.deliveries.find(d => d.id === ref.id) ?? {...ref,source:"question" as const,recoveryRef:true,text:"",at:0,questionIds:[]}));
    const controller = new AbortController();
    batchLoading = true;
    void untrack(() => Promise.all(batches.map(d => d.recoveryRef ? reading<Delivery>(`/recovery?${new URLSearchParams({agent: id, operation: d.id})}`, id, controller.signal) : d)))
      .then(deliveries => { if (!controller.signal.aborted) { fullBatches = deliveries; batchError = ""; } })
      .catch(e => { if (!controller.signal.aborted) batchError = (e as Error).message; })
      .finally(() => { if (!controller.signal.aborted) batchLoading = false; });
    return () => controller.abort();
  });
  const shownQuestions = $derived(fullQuestions.filter(q => detail.questions.find(ref => ref.id === q.id)?.state !== "answered"));
  const shownBatches = $derived(fullBatches.filter(d => detail.deliveries.find(ref => ref.id === d.id)?.status !== "sent").map(d => ({...d,status: detail.deliveries.find(ref => ref.id === d.id)?.status ?? d.status})));
  const pending = $derived(detail.questions.filter(q => q.state !== "answered"));
  const pendingCount = $derived(detail.role === "orc" ? detail.unansweredCount ?? pending.length : pending.length);
  $effect(() => {
    if (!ready || !connected || !pendingOpen || pendingCount || questionLoading || questionError || shownQuestions.length) return;
    setQuestionPanel(detail.id, false);
    if (!record) removeQuestionDrawer();
  });

</script>
<aside class="agent-detail" aria-label={detail.title}>
  <div class="mobile-back"><Button variant="ghost" size="sm" onclick={onclose}>{navigation.details.length > 1 ? m.back_orc() : m.back_sessions()}</Button><Weekly surface="weekly-detail" hostId={entryId} connected={entryConnected} /></div><header class="detail-heading"><div class="detail-meta"><div class="role-project">{detail.role === "orc" ? m.orc() : detail.role === "reviewer" ? "Reviewer" : detail.role === "researcher" ? "Researcher" : m.worker()} / {detail.project.alias}</div><div class="detail-status">{#if detail.hostName}<span class="owner-badge">{detail.hostName}</span>{/if}{#if detail.error}<button class="execution-feedback" class:failed={!detail.execution?.retrying} class:working={detail.execution?.retrying} aria-expanded={reasonOpen} aria-controls="execution-reason" onclick={() => reasonOpen = !reasonOpen}><i></i>{executionLabel}{#if detail.execution?.retrying && detail.state === "working"}<span>{elapsed(detail.workingSince, now)}</span>{/if}<ChevronDown size={12} /></button>{:else}<span class:working={detail.state === "working"} class:failed={detail.state === "error"}><i></i>{detail.closeRequest ? m.closing_worker() : detail.stop?.status === "unknown" ? m.stop_unconfirmed() : detail.state === "stopping" ? m.stopping() : detail.state === "working" ? m.working() + " " + elapsed(detail.workingSince, now) : detail.state === "error" ? m.failed() : m.idle()}</span>{/if}{#if pendingCount}<Badge variant="outline" class="border-amber-500/30 text-amber-200">{m.needs_input()}</Badge>{/if}</div>{#if detail.role !== "reviewer" && detail.role !== "researcher"}<SessionSettings {detail} {tree} connected={connected && ready} {onupdate} />{:else}<span>{detail.model} · {detail.effort}</span>{/if}</div>{#if detail.error && reasonOpen}<div class="execution-reason" id="execution-reason" role="status">{detail.error}</div>{/if}<TitleEditor title={detail.title} editable={ready && detail.role === "orc" && connected} {onrename} /></header>
  {#if detail.researchQuestion}<div class="review-target">Question: {detail.researchQuestion}</div>{/if}
  {#if detail.reviewTarget}<p class="review-target">{detail.reviewTarget.profile} · {detail.reviewTarget.spec} · {detail.reviewTarget.fixedPoint} → {detail.reviewTarget.reviewedHead}</p>{/if}
  {#if closeError}<p class="detail-close-error" role="alert">{closeError}</p>{/if}
  <div class="detail-body"><div class="dialogue-column"><div class="conversation-wrap">{#key ready ? detail.threadId ?? "live" : "pending"}<ConversationTimeline bind:this={timeline} agentId={detail.id} boundary={ready ? detail.threadId : undefined} syncRevision={detail.readingRevision ?? 0} live={ready ? detail.messages : []} {ready} {connected} reports={expandedReports} pinned={pinnedImage} onfollow={value => follow = value}>
    {#snippet header()}
    {#if !connected}<p class="host-outage" role="status">{m.host_offline()}{#if lastSeen}<br/>{m.last_seen({ time: new Date(lastSeen).toLocaleString() })}{/if}</p>{/if}
    {#if detail.closeRequest}<p class="model-note">{detail.closeRequest.reason}</p>{/if}
    {#if owner}<button class="owner-link" onclick={() => onopen(owner.id)}>{m.assigned_by({ title: owner.title })}</button>{/if}
    {#if !ready}<div class="detail-loading" role="status"><p>{actionError || m.loading_conversation()}</p>{#if actionError || !connected}<Button variant="ghost" size="sm" disabled={!connected} onclick={onrefresh}>{m.retry()}</Button>{/if}</div>{/if}
    {#if ready && !detail.historyCursor && !detail.messages.length && !detail.questions.length}<div class="first-message"><h2>{m.first_heading()}</h2><p>{m.first_help({ project: detail.project.alias })}</p></div>{/if}
    {/snippet}
    {#snippet renderMessage(message: Message)}
      {@const report = message.delivery && ["worker", "reviewer", "researcher"].includes(message.delivery.source) ? message.delivery : undefined}
      {@const delivery = detail.deliveries.find(d=>d.id===(message.clientId ?? message.id))}
      {#if report}<WorkerReport at={message.at} agentId={report.reportingResearcherId ?? report.reportingReviewerId ?? report.reportingWorkerId} kind={report.source === "researcher" ? "Researcher report" : report.source === "reviewer" ? "Reviewer report" : undefined} text={message.text} bodyRef={message.bodyRef} owningAgentId={detail.id} readPath={message.provisional ? `/recovery?${new URLSearchParams({agent: detail.id, operation: message.id})}` : undefined} sender={workers.find(w => w.id === (report.reportingResearcherId ?? report.reportingReviewerId ?? report.reportingWorkerId))?.title} initiallyExpanded={expandedReports.has(message.clientId ?? message.id)} onexpanded={value => { if (value) expandedReports.add(message.clientId ?? message.id); else expandedReports.delete(message.clientId ?? message.id); }} />
      {:else}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{#if message.role === "assistant"}<MessageTime at={message.at} />{/if}{message.role === "assistant" ? detail.role === "orc" ? m.orc() : detail.role === "reviewer" ? "Reviewer" : detail.role === "researcher" ? "Researcher" : m.worker() : ""}</div>{#if message.role === "user"}<MessageTime at={message.at} />{/if}<MessageBody text={message.text} bodyRef={message.bodyRef} agentId={detail.id} readPath={message.provisional ? `/recovery?${new URLSearchParams({agent: detail.id, operation: message.id})}` : undefined} />
      {#if message.questionItemId || message.delivery?.source === "question"}<Button tabindex={0} class="question-record-entry" variant="secondary" size="sm" onclick={() => openRecord(message)}><MessageCircle />View questions and answers</Button>{/if}
      {#if message.images?.length || message.localImageIds?.length}<MessageImages connected={mediaConnected} agentId={detail.id} operationId={message.id} images={message.images} localImageIds={message.localImageIds} onviewer={open => { if (open) pinnedImage = message.id; else if (pinnedImage === message.id) pinnedImage = undefined; }} />{/if}
      {#if delivery && submissionResult(delivery) !== 'accepted'}<small class:failed={submissionResult(delivery)==='rejected'} role="status">{submissionResult(delivery)==='rejected' ? m.failed() : m.sending()}</small>{/if}
      </div>{/if}
    {/snippet}
    {#snippet footer(readingSettled: boolean)}
    {#each recoveries.filter(d => (readingSettled || !d.recoveryRef) && d.source !== "question" && (submissionResult(d) === "rejected" || ((d.source === "worker" || d.source === "reviewer" || d.source === "researcher") && d.status === "uncertain"))) as delivery}<details class="delivery-error"><summary>{delivery.error}</summary>{#if delivery.source !== 'user'}<MessageBody text={delivery.text} bodyRef={delivery.recoveryRef ? delivery.id : undefined} agentId={detail.id} readPath={`/recovery?${new URLSearchParams({agent: detail.id, operation: delivery.id})}`} />{/if}{#if delivery.source === "user" && detail.role === "orc"}<Button variant="ghost" size="sm" disabled={recovering} onclick={() => recoverDelivery(delivery)}>{m.restore_message()}</Button>{/if}{#if detail.role !== "reviewer" && detail.role !== "researcher" && (delivery.source === "worker" || delivery.source === "reviewer" || delivery.source === "researcher") && submissionResult(delivery) === "rejected"}<Button variant="ghost" size="sm" disabled={!connected} onclick={() => onretry(delivery.id)}>{m.retry()}</Button>{/if}</details>{/each}
    {#if readingSettled && recoveryCursor !== null && (recoveryCursor !== undefined || (detail.recoveryCount ?? 0) > recoveries.filter(d => d.status !== "sent").length)}<Button variant="ghost" size="sm" disabled={!connected} onclick={loadRecoveries}>{m.earlier_submissions()}</Button>{/if}
    {#if recoveryError}<p class="inline-error" role="alert">{recoveryError}</p>{/if}
    {#if ready && actionError}<div class="host-outage" role="alert"><p>{actionError}</p><Button variant="ghost" size="sm" onclick={() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()}>{m.message_orc()}</Button></div>{/if}
    {#if detail.stop?.status === "confirmed"}<p class="stop-confirmed" role="status">{m.stop_confirmed()}</p>{:else if detail.stop?.status === "unknown"}<p class="host-outage" role="status">{m.stop_unknown()} <Button variant="ghost" size="sm" onclick={onrefresh}>{m.retry_connection()}</Button></p>{:else if detail.stop?.status === "completed"}<p role="status">{m.stop_completed()}</p>{/if}
    {/snippet}
  </ConversationTimeline>{/key}
  {#if !follow}<Button class="jump-bottom" variant="secondary" size="icon-sm" aria-label={m.jump_bottom()} title={m.jump_bottom()} onclick={() => timeline?.jumpToBottom()}><ArrowDown /></Button>{/if}</div>
  <div class="input-seat">
    {#if pendingCount && (!pendingOpen || record)}<Button tabindex={0} class="pending-entry" variant="ghost" size="sm" onclick={() => openPending()}><MessageCircle />{pendingCount} pending {pendingCount === 1 ? "question" : "questions"}</Button>{/if}
    {#if panelOpen}<section class="question-panel" class:question-hidden={!panelVisible} aria-label={record ? "Questions and answers" : "Pending questions"}>
      <header class="question-panel-heading"><h2>{record ? "Questions and answers · Read only" : "Pending questions"}</h2><div class="question-header-actions">{#if detail.role === "orc" && detail.state === "working"}<Button tabindex={0} variant="ghost" size="icon-sm" aria-label="Stop Orc" title="Stop Orc" disabled={!ready || !connected} onclick={onstop}><Square /></Button>{/if}<Button tabindex={0} variant="ghost" size="icon-sm" aria-label={record ? "Close" : "Collapse questions"} onclick={toggleQuestions}><X /></Button></div></header>
      {#if record}<QuestionRecord peerOrAgent={detail.id} params={{agent: detail.id, ...record}} {connected} onpending={openPending} />{/if}
      <div class:question-hidden={!!record} class="pending-content">
        {#if questionError || batchError}<div class="question-load"><p class="inline-error" role="alert">{questionError || batchError}</p><Button tabindex={0} variant="secondary" size="sm" disabled={!connected} onclick={() => questionRevision++}>Retry</Button></div>{/if}
        {#if questionLoading && !shownQuestions.length}<p class="question-load" role="status">Loading questions…</p>{:else if !shownQuestions.length && !questionError}<p class="question-load" role="status">{!connected ? "Reconnect to load questions." : "No pending questions."}</p>{/if}
        {#if detail.role === "orc"}<Questions agentId={detail.id} questions={shownQuestions} deliveries={shownBatches} selectedItem={pendingItem} recovering={batchLoading || !!batchError} connected={ready && connected && detail.state !== "stopping"} {onanswer} {onretry} />
        {:else}<div class="delegated-questions">{#each shownQuestions as q}<div><p>{q.text}</p><span>{m.delegated()}</span></div>{/each}</div>{/if}
      </div>
    </section>{/if}
    <div class:question-hidden={panelVisible}>
    {#if detail.role === "orc"}<Composer bind:this={composer} suspended={panelVisible} agentId={detail.id} project={detail.project.alias} {skills} connected={connected && ready} working={detail.state === "working"} stopping={detail.state === "stopping"} {onstop} {onsend} />{:else}<footer class="read-only"><p>{m.read_only()}</p>{#if owner}<button onclick={() => onopen(owner.id)}>{m.through_orc()}</button>{/if}</footer>{/if}
    </div>
  </div></div></div>
  {#if navigation.preview}<div class:preview-hidden={navigation.surfaces.at(-1) !== "file-preview"}><FilePreview {connected} agent={navigation.preview.agent} href={navigation.preview.href} onclose={() => void back()} /></div>{/if}
</aside>
