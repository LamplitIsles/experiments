<script lang="ts">
  import { ArrowLeft, History } from "@lucide/svelte";
  import { Input } from "$lib/components/ui/input/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import { onMount, tick, untrack } from "svelte";
  import type { HistorySession, HistoryPage, HistoryMessages, Message, Project } from "./contracts";
  import { api } from "./api";
  import { navigation, setSurface, back } from "./navigation.svelte";
  import Markdown from "./Markdown.svelte";
  import * as m from "./paraglide/messages";
  let { hostId, hostName, project, connected, onresume }: {
    hostId: string; hostName: string; project: Project; connected: boolean;
    onresume: (session: HistorySession, project: string) => Promise<void>;
  } = $props();
  let query = $state(""); let sessions = $state<HistorySession[]>([]); let cursor = $state<string | null>(null);
  let loading = $state(false); let error = $state(""); let sequence = 0;
  let selected = $state<HistorySession | null>(null); let previewProject = $state(untrack(() => project.alias));
  let messages = $state<Message[]>([]); let messageCursor = $state<string | null>(null);
  let reading = $state(false); let resuming = $state(false); let previewSequence = 0;
  let retryOperation = $state<"search" | "read" | "owner" | "resume">("search");
  let input = $state<HTMLInputElement | null>(null);
  let results = $state<HTMLDivElement | null>(null); let listScroll = 0;
  const previewOpen = $derived(navigation.surfaces.includes("history-preview") && !!selected);
  $effect(() => { if (!previewOpen) void tick().then(() => { if (results) results.scrollTop = listScroll; }); });
  function params(alias = project.alias) { return new URLSearchParams({ host: hostId, project: alias }); }
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
    const _query = query;
    sessions = []; cursor = null; loading = true;
    const timer = setTimeout(() => { void search(); }, 200);
    // Invalidate in-flight results immediately while a new query is being typed.
    ++sequence;
    return () => clearTimeout(timer);
  });
  async function read(more = false) {
    if (!selected) return;
    const seq = ++previewSequence; reading = true; error = ""; retryOperation = "read";
    const p = params(previewProject); p.set("thread", selected.threadId);
    if (more && messageCursor) p.set("cursor", messageCursor);
    try {
      const page = await api<HistoryMessages>(`/history/messages?${p}`);
      if (seq !== previewSequence) return;
      messages = more ? [...page.messages, ...messages] : page.messages; messageCursor = page.nextCursor;
    } catch(e) { if (seq === previewSequence) error = e instanceof Error ? e.message : m.load_failure(); }
    finally { if (seq === previewSequence) reading = false; }
  }
  async function select(session: HistorySession, alias = project.alias) {
    if (!previewOpen) listScroll = results?.scrollTop ?? 0;
    ++previewSequence; selected = session; previewProject = alias; messages = []; messageCursor = null;
    setSurface("history-preview", true); await read();
  }
  async function owningOrc() {
    if (!selected?.ownerThreadId) return;
    const p = params(selected.ownerProject ?? project.alias); p.set("thread", selected.ownerThreadId);
    reading = true; error = ""; retryOperation = "owner";
    try { await select(await api<HistorySession>(`/history/session?${p}`), selected.ownerProject ?? project.alias); }
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
  function label(s: HistorySession) { return s.role === "worker" ? m.worker() : s.agentId ? m.orc() : s.source; }
  onMount(() => { void tick().then(() => input?.focus()); return () => { ++sequence; ++previewSequence; }; });
</script>

<div class="session-history">
  <div class="history-heading"><Button variant="ghost" size="icon-sm" aria-label={m.back_history()} onclick={() => back()}><ArrowLeft /></Button><strong>{previewOpen ? m.session_preview() : m.find_history()}</strong></div>
  <p class="history-context">{hostName} <span>›</span> {!previewOpen || previewProject === project.alias ? project.name : previewProject}</p>
  {#if !previewOpen}
    <Input bind:ref={input} bind:value={query} aria-label={m.search_history()} placeholder={m.search_history()} onkeydown={e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void search(); } }} />
    <p class="history-scope">{m.history_scope()}</p>
    <div class="history-results" bind:this={results}>
      {#each sessions as session (session.threadId)}
        <button class="history-result" title={session.preview} onclick={() => select(session)}>
          <strong>{session.title}</strong><span class="history-result-meta">{label(session)}{session.closed ? " · " + m.history_closed() : ""}{session.archived ? " · " + m.history_archived() : ""}<time>{new Date(session.updatedAt).toLocaleDateString()}</time></span>
        </button>
      {/each}
      {#if loading}<p class="history-empty" role="status">{m.searching_history()}</p>
      {:else if !sessions.length}<div class="history-empty"><History /><p>{cursor ? m.history_scan_more() : m.no_history()}</p></div>{/if}
      {#if cursor}<Button variant="ghost" size="sm" disabled={loading || !connected} onclick={() => search(true)}>{m.load_more_history()}</Button>{/if}
    </div>
  {:else if selected}
    <h2 class="history-title">{selected.title}</h2>
    <p class="history-scope">{label(selected)}{selected.closed ? " · " + m.history_closed() : ""}{selected.archived ? " · " + m.history_archived() : ""}</p>
    <div class="history-transcript">
      {#if reading}<p role="status">{m.loading_history()}</p>{/if}
      {#if messageCursor}<Button variant="ghost" size="sm" disabled={reading || !connected} onclick={() => read(true)}>{m.earlier_messages()}</Button>{/if}
      {#each messages as message (message.id)}<div class:user-message={message.role === "user"} class:assistant-message={message.role === "assistant"}><div class="message-role">{message.role === "user" ? m.history_you() : m.history_assistant()}</div><Markdown text={message.text} /></div>{/each}
      {#if !reading && !messages.length && !error}<p class="history-empty">{m.no_messages()}</p>{/if}
    </div>
    <div class="history-action">
      {#if selected.role === "worker"}<span>{m.history_worker_help()}</span><Button size="sm" disabled={!connected || reading || !selected.ownerThreadId} onclick={owningOrc}>{m.view_owning_orc()}</Button>
      {:else}<span>{m.history_resume_help()}</span><Button size="sm" disabled={!connected || resuming} onclick={resume}>{resuming ? m.resuming_session() : selected.agentId && !selected.closed ? m.open_existing_session() : selected.archived ? m.restore_resume() : m.resume_session()}</Button>{/if}
    </div>
  {/if}
  {#if error}<p class="inline-error" role="alert">{error}</p><Button variant="ghost" size="sm" disabled={reading || loading || resuming || !connected} onclick={() => retryOperation === "resume" ? resume() : retryOperation === "owner" ? owningOrc() : previewOpen ? read() : search()}>{m.retry()}</Button>{/if}
  {#if !connected}<p class="inline-error">{m.disconnected_host()}</p>{/if}
</div>
