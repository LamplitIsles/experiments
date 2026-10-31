<script lang="ts">
  import { projectReference, parseProjectReference } from "./project-identity";
  import { ArrowLeft, History } from "@lucide/svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount, tick, untrack } from "svelte";
  import type { HistorySession, HistoryPage, HistoryMessages, Message, Project } from "./contracts";
  import QuestionRecord from "./QuestionRecord.svelte";
  import FilePreview from "./FilePreview.svelte";
  import WorkerReport from "./WorkerReport.svelte";
  import MessageBody from "./MessageBody.svelte";
  import { reading as readHttp, api } from "./api";
  import { navigation, setSurface, back } from "./navigation.svelte";
  import MessageTime from "./MessageTime.svelte";
  import Markdown from "./Markdown.svelte";
  import * as m from "./paraglide/messages";
  let { hostId, project, connected, onresume }: {
    hostId: string; project: Project; connected: boolean;
    onresume: (session: HistorySession, project: string) => Promise<void>;
  } = $props();
  let query = $state(""); let sessions = $state<HistorySession[]>([]); let cursor = $state<string | null>(null);
  let onlyOrc = $state(true);
  const visibleSessions = $derived(onlyOrc ? sessions.filter(s => s.role === "orc") : sessions);
  let loading = $state(false); let error = $state(""); let sequence = 0;
  let record = $state<{item?: string; operation?: string} | null>(null);
  let selected = $state<HistorySession | null>(null); let previewProject = $state(untrack(() => projectReference(project)));
  let messages = $state<Message[]>([]); let messageCursor = $state<string | null>(null);
  let reading = $state(false); let resuming = $state(false); let previewSequence = 0;
  let retryOperation = $state<"search" | "read" | "owner" | "resume">("search");
  let input = $state<HTMLInputElement | null>(null);
  let results = $state<HTMLDivElement | null>(null); let listScroll = 0;
  const previewOpen = $derived(navigation.surfaces.includes("history-preview") && !!selected);
  $effect(() => { if (!previewOpen) record = null; });
  $effect(() => { if (!previewOpen) void tick().then(() => { if (results) results.scrollTop = listScroll; }); });
  function params(alias = projectReference(project)) { return new URLSearchParams({ project: alias }); }
  async function search(more = false) {
    const seq = ++sequence; loading = true; error = ""; retryOperation = "search";
    const p = params(); p.set("query", query.trim()); if (more && cursor) p.set("cursor", cursor);
    try {
      const page = await api<HistoryPage>(`/history?${p}`);
      if (seq !== sequence) return;
      const merged = more ? [...sessions, ...page.sessions] : page.sessions;
      sessions = [...new Map(merged.map(s => [s.threadId, s])).values()].sort((a, b) => b.updatedAt - a.updatedAt || a.threadId.localeCompare(b.threadId));
      cursor = page.nextCursor;
    } catch (e) { if (seq === sequence) error = e instanceof Error ? e.message : m.load_failure(); }
    finally { if (seq === sequence) loading = false; }
  }
  $effect(() => {
    const _query = query; const _onlyOrc = onlyOrc;
    listScroll = 0; untrack(() => { if (results) results.scrollTop = 0; });
    sessions = []; cursor = null; loading = true;
    const timer = setTimeout(() => { void search(); }, 200);
    // Invalidate in-flight results immediately when the query or filter changes.
    ++sequence;
    return () => clearTimeout(timer);
  });
  let readAbort: AbortController | undefined;
  async function read(more = false) {
    readAbort?.abort();
    const controller = readAbort = new AbortController();
    if (!selected) return;
    const seq = ++previewSequence; reading = true; error = ""; retryOperation = "read";
    const p = params(previewProject); p.set("thread", selected.threadId);
    if (more && messageCursor) p.set("cursor", messageCursor);
    try {
      const page = await readHttp<HistoryMessages>(`/messages?${p}`, hostId, controller.signal);
      if (seq !== previewSequence) return;
      messages = more ? [...page.messages, ...messages] : page.messages; messageCursor = page.nextCursor;
    } catch(e) { if (seq === previewSequence) error = e instanceof Error ? e.message : m.load_failure(); }
    finally { if (seq === previewSequence) reading = false; }
  }
  async function select(session: HistorySession, alias = projectReference(project)) {
    if (!previewOpen) listScroll = results?.scrollTop ?? 0;
    ++previewSequence; record = null; selected = session; previewProject = alias; messages = []; messageCursor = null;
    setSurface("history-preview", true); await read();
  }
  async function owningOrc() {
    if (!selected?.ownerThreadId) return;
    const p = params(selected.ownerProject ?? projectReference(project)); p.set("thread", selected.ownerThreadId);
    reading = true; error = ""; retryOperation = "owner";
    try { await select(await api<HistorySession>(`/history/session?${p}`), selected.ownerProject ?? projectReference(project)); }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { reading = false; }
  }
  async function resume() {
    if (!selected || resuming || !connected) return;
    resuming = true; error = ""; retryOperation = "resume";
    try { await onresume(selected, previewProject); }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { resuming = false; }
  }
  function label(s: HistorySession) { const role = s.role === "reviewer" ? "Reviewer" : s.role === "researcher" ? "Researcher" : s.role === "worker" ? m.worker() : s.agentId ? m.orc() : s.source; return `${s.backend === "pi" ? "Pi" : "Codex"} · ${role}`; }
  onMount(() => { void tick().then(() => input?.focus()); return () => { ++sequence; ++previewSequence; readAbort?.abort(); }; });
</script>

<div class="session-history">
  <div class="history-heading"><Button variant="ghost" size="icon-sm" aria-label={m.back_history()} onclick={() => back()}><ArrowLeft /></Button><strong>{previewOpen ? m.session_preview() : m.find_history()}</strong></div>
  <p class="history-context">{#if project.environment && project.environment.id!=="local"}{project.environment.name} · {/if}{!previewOpen || previewProject === projectReference(project) ? project.name : previewProject.startsWith("@saved:") ? selected?.cwd : parseProjectReference(previewProject).alias}</p>
  {#if !previewOpen}
    <div class="history-controls">
    <Input bind:ref={input} bind:value={query} aria-label={m.search_history()} placeholder={m.search_history()} onkeydown={e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void search(); } }} />
    <label class="history-filter"><Switch bind:checked={onlyOrc} aria-label={m.only_orc()} /><span>{m.only_orc()}</span></label>
    </div>
    <p class="history-scope">{m.history_scope()}</p>
    <div class="history-results" bind:this={results}>
      {#each visibleSessions as session (session.threadId)}
        <button class="history-result" title={session.preview} onclick={() => select(session)}>
          <strong>{session.title}</strong><span class="history-result-meta">{label(session)}{session.closed ? " · " + m.history_closed() : ""}{session.archived ? " · " + m.history_archived() : ""}<time>{new Date(session.updatedAt).toLocaleDateString()}</time></span>
        </button>
      {/each}
      {#if loading}<p class="history-empty" role="status">{m.searching_history()}</p>
      {:else if !visibleSessions.length}<div class="history-empty"><History /><p>{cursor ? m.history_scan_more() : m.no_history()}</p></div>{/if}
      {#if cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={() => search(true)}>{m.load_more_history()}</Button>{/if}
    </div>
  {:else if selected}
    <h2 class="history-title">{selected.title}</h2>
    <p class="history-scope">{label(selected)}{selected.closed ? " · " + m.history_closed() : ""}{selected.archived ? " · " + m.history_archived() : ""}</p>
    <div class="history-transcript">
      {#if reading}<p role="status">{m.loading_history()}</p>{/if}
      {#if messageCursor}<Button variant="ghost" size="sm" disabled={reading || !connected} onclick={() => read(true)}>{m.earlier_messages()}</Button>{/if}
      {#each messages as message (message.id)}{#if message.delivery && ["worker", "reviewer", "researcher"].includes(message.delivery.source)}<WorkerReport at={message.at} text={message.text} bodyRef={message.bodyRef} owningAgentId={hostId} agentId={message.delivery.reportingResearcherId ?? message.delivery.reportingReviewerId ?? message.delivery.reportingWorkerId} kind={message.delivery.source === "researcher" ? "Researcher report" : message.delivery.source === "reviewer" ? "Reviewer report" : undefined} readPath={`/body?${new URLSearchParams({project: previewProject, thread: selected.threadId, item: message.id})}`} />{:else}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{#if message.role === "assistant"}<MessageTime at={message.at} />{/if}{message.role === "user" ? m.history_you() : m.history_assistant()}</div>{#if message.role === "user"}<MessageTime at={message.at} />{/if}<MessageBody text={message.text} bodyRef={message.bodyRef} agentId={hostId} copyMessage={message.role === "assistant"} readPath={`/body?${new URLSearchParams({project: previewProject, thread: selected.threadId, item: message.id})}`} />{#if message.questionItemId || message.delivery?.source === "question"}<Button tabindex={0} class="question-record-entry" variant="secondary" size="sm" onclick={() => record = message.questionItemId ? {item:message.questionItemId} : {operation:message.clientId ?? message.id}}>View questions and answers</Button>{/if}</div>{/if}{/each}
      {#if !reading && !messages.length && !error}<p class="history-empty">{m.no_messages()}</p>{/if}
    </div>
    {#if record}<section class="question-panel" aria-label="Questions and answers"><header class="question-panel-heading"><h2>Questions and answers · Read only</h2><Button tabindex={0} variant="ghost" size="sm" onclick={() => record = null}>Close</Button></header><QuestionRecord peerOrAgent={hostId} previewAgentId={selected.agentId?.startsWith(hostId + ":") ? selected.agentId : null} historyPreview params={{project:previewProject,thread:selected.threadId,...record}} {connected} onpending={selected.agentId && !selected.closed && selected.role === "orc" ? () => void resume() : undefined} /></section>{/if}
    {#if navigation.preview && navigation.surfaces.includes("history-preview")}<div class:preview-hidden={navigation.surfaces.at(-1) !== "file-preview"}><FilePreview {connected} agent={navigation.preview.agent} href={navigation.preview.href} onclose={() => void back()} /></div>{/if}
    <div class="history-action">
      {#if selected.role === "worker" || selected.role === "reviewer" || selected.role === "researcher"}<span>{selected.role === "researcher" ? "Continue this Researcher through its original Orc." : selected.role === "reviewer" ? m.history_reviewer_help() : m.history_worker_help()}</span><Button size="sm" disabled={!connected || reading || !selected.ownerThreadId} onclick={owningOrc}>{m.view_owning_orc()}</Button>
      {:else}<span>{m.history_resume_help()}</span><Button size="sm" disabled={!connected || resuming} onclick={resume}>{resuming ? m.resuming_session() : selected.agentId && !selected.closed ? m.open_existing_session() : selected.archived ? m.restore_resume() : m.resume_session()}</Button>{/if}
    </div>
  {/if}
  {#if error}<p class="inline-error" role="alert">{error}</p><Button variant="ghost" size="sm" disabled={reading || loading || resuming || !connected} onclick={() => retryOperation === "resume" ? resume() : retryOperation === "owner" ? owningOrc() : previewOpen ? read() : search()}>{m.retry()}</Button>{/if}
  {#if !connected}<p class="inline-error">{m.disconnected_host()}</p>{/if}
</div>
