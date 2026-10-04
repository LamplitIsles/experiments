<script lang="ts">
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Kbd } from "$lib/components/ui/kbd/index.js";
  import { X, Plus, History, Settings as SettingsIcon } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { navigation, initializeNavigation, openConversation, setSurface, back, validateNavigation } from "./navigation.svelte";
  import { storagePrefix } from "./api";
  import { onMount, tick } from "svelte";
  import type { Answer, Agent, Detail, HistorySession, Model, Project, Settings, Skill, Snapshot } from "./contracts";
  import { api, editable, setClient } from "./api";
  import { RequestRejected, openGrove, type GroveClient } from "./chord-client";
  import { receiptSchema, type Receipt } from "./chord-contract";
  import { addOutgoing, observeOutgoing, outgoing, withOutgoing, acceptReceipt, unknownOutgoing } from "./outgoing.svelte";
  import { observeQuestions, questionPanels, setQuestionPanel } from "./question-state.svelte";
  import HostFilter from "./HostFilter.svelte";
  import Hosts from "./Hosts.svelte";
  import Weekly from "./Weekly.svelte";
  import SessionList from "./SessionList.svelte";
  import AgentDetail from "./AgentDetail.svelte";
  import SessionHistory from "./SessionHistory.svelte";
  import * as m from "./paraglide/messages";

  let client: GroveClient | undefined;
  let composing = false;
  let snapshot = $state<Snapshot>({ agents: [], settings: null, revision: 0 });
  let selectedId = $state<string | null>(localStorage.getItem(`${storagePrefix}/selected`));
  let detail = $state<Detail | null>(null); let skills = $state<Skill[]>([]);
  let projects = $state<Project[]>([]); let models = $state<Model[]>([]);
  let connected = $state(false); let loading = $state(true); let error = $state("");
  let now = $state(Date.now()); let sessionList: { visibleIds(): string[]; keydown(event: KeyboardEvent): Promise<void>; expandFocused(): void; reveal(id: string): Promise<void>; closeTarget(): string | null; navigate(offset: number, index?: number): Promise<string | null> };
  let projectSearch = $state<HTMLInputElement | null>(null); let modalOpen = $state(false); let modal = $state<"new" | "settings" | "keys" | null>(null);
  let search = $state(""); let projectId = $state(""); let saving = $state(false);
  let settings = $state<Settings | null>(null); let sequence = 0; let focusCreatedId = $state<string | null>(null);
  let install = $state<(Event & { prompt: () => Promise<void> }) | null>(null);
  let hostFilter = $state(localStorage.getItem(`${storagePrefix}/host-filter`) ?? "");
  let desktop = $state(matchMedia("(min-width: 701px)").matches);
  let previousVisible: string[] = [];
  let lostSelection: string | null = null;
  $effect(() => {
    const ids = visibleAgents.map(a => a.id);
    const current = navigation.details.at(-1);
    if (desktop && !loading && (!current || !ids.includes(current))) {
      const position = previousVisible.indexOf(current ?? lostSelection ?? "");
      const adjacent = previousVisible.slice(position + 1).find(id => ids.includes(id)) ?? previousVisible.slice(0, Math.max(0, position)).reverse().find(id => ids.includes(id));
      const next = adjacent ?? visibleAgents.find(a => a.role === "orc")?.id;
      if (next) void openConversation(next);
      else validateNavigation(new Set(ids));
    }
    previousVisible = sessionList?.visibleIds() ?? visibleAgents.filter(a => a.role === "orc").map(a => a.id);
    lostSelection = null;
  });
  let createHost = $state(""); let catalogSequence = 0;
  const shownDetail = $derived(detail ? withOutgoing(detail) : null);
  const hosts = $derived(snapshot.hosts ?? []);
  const selectedHost = $derived(hosts.find(h => h.id === detail?.hostId));
  const hostConnected = $derived(connected && (!selectedHost || selectedHost.connected));
  const visibleAgents = $derived(snapshot.agents.filter(a => !hostFilter || a.hostId === hostFilter));
  $effect(() => { localStorage.setItem(`${storagePrefix}/host-filter`, hostFilter); });
  async function chooseHost(id: string) {
    createHost = id; projectId = ""; projects = []; const seq = ++catalogSequence;
    try { const [registered, catalog] = await Promise.all([api<Project[]>(`/projects?host=${encodeURIComponent(id)}`), api<Model[]>(`/models?host=${encodeURIComponent(id)}`)]); if (seq === catalogSequence) { projects = registered; models = catalog; projectId = registered[0]?.alias ?? ""; } }
    catch(e) { if (seq === catalogSequence) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  const roots = $derived(snapshot.agents.filter(a => a.role === "orc"));
  const fastAvailable = $derived(!!settings && [settings.orc, settings.worker].every(role => models.find(model => model.id === role.model)?.fastTier));
  const owner = $derived(snapshot.agents.find(a => a.id === detail?.ownerId));
  const filteredProjects = $derived(projects.filter(p => `${p.alias} ${p.name}`.toLowerCase().includes(search.toLowerCase())));

  $effect(() => { if (modal === "new" && !filteredProjects.some(p => p.alias === projectId)) projectId = filteredProjects[0]?.alias ?? ""; });
  function closeDetail() { if (navigation.surfaces.length || !desktop) void back(); else if (selectedId && questionPanels[selectedId]) setQuestionPanel(selectedId, false); }
  $effect(() => {
    const id = navigation.details.at(-1) ?? null;
    if (id !== selectedId) { ++sequence; selectedId = id; detail = null; skills = []; error = ""; if (id) void restoreDetail(id); else { localStorage.removeItem(`${storagePrefix}/selected`); void client?.call("select", {ids:[]}).catch(() => {}); } }
  });
  $effect(() => {
    const kind = navigation.surfaces.find(s => s === "new" || s === "settings" || s === "keys") ?? null;
    if (kind !== modal) { modal = kind; modalOpen = !!kind; if (kind) void prepareModal(kind); }
  });
  async function refreshDetail(id: string) {
    const seq = ++sequence;
    try {
      const result = await api<Detail>(`/agents/${id}`);
      if (selectedId === id && seq === sequence) { observeOutgoing(result); detail = result; localStorage.setItem(`${storagePrefix}/detail/${id}`, JSON.stringify(result)); }
    } catch (e) { if (selectedId === id && seq === sequence && connected) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  function open(id: string, fromDetail = false) { openConversation(id, fromDetail, snapshot.agents.find(a => a.id === id)?.ownerId); }
  async function restoreDetail(id: string) {
    error = ""; selectedId = id; localStorage.setItem(`${storagePrefix}/selected`, id);
    const cached = localStorage.getItem(`${storagePrefix}/detail/${id}`); detail = cached ? JSON.parse(cached) : null; skills = [];
    if (connected) {
      void client?.call('select', {ids:[id]}).catch(e => { if(selectedId === id) error = e instanceof Error ? e.message : m.load_failure(); });
      if (snapshot.agents.find(a => a.id === id)?.role === "orc" && hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected) {
        try { const list = await api<Skill[]>(`/agents/${id}/skills`); if (selectedId === id) skills = list; }
        catch (e) { if (selectedId === id) error = e instanceof Error ? e.message : m.load_failure(); }
      }
    }
  }
  function adopt(value: Snapshot, authoritative = false) {
    if (!authoritative && value.revision < snapshot.revision) return;
    // Hub restart can temporarily lack remote display caches. Retain this
    // device's read-only cache until that host supplies authoritative state.
    const retained = snapshot.agents.filter(a => value.hosts?.some(h => h.id === a.hostId && !h.connected) && !value.agents.some(next => next.hostId === a.hostId));
    value = { ...value, agents: [...value.agents, ...retained], hosts: value.hosts?.map(h => !h.connected && !h.lastSeen ? { ...h, lastSeen: snapshot.hosts?.find(old => old.id === h.id)?.lastSeen } : h) };
    observeQuestions(value.agents, selectedId);
    if (selectedId && !value.agents.some(a => a.id === selectedId)) lostSelection = selectedId;
    snapshot = value; localStorage.setItem(`${storagePrefix}/snapshot`, JSON.stringify(value));
    validateNavigation(new Set(value.agents.map(a => a.id)));

  }
  async function load() {
    loading = true; error = "";
    try {
      const [state, registered, catalog] = await Promise.all([api<Snapshot>("/snapshot"), api<Project[]>("/projects"), api<Model[]>("/models")]);
      projects = registered; models = catalog; if(!connected) adopt(state, true);
      if (selectedId) await restoreDetail(selectedId);
    } catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { loading = false; }
  }
  function notifications(before: Snapshot, after: Snapshot) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    for (const a of after.agents) {
      const previous = before.agents.find(p => p.id === a.id); if (!previous) continue;
      const newQuestion = a.role === "orc" && a.questions.some(q => q.state === "unanswered" && !previous.questions.some(p => p.id === q.id));
      const idle = previous.state === "working" && a.state === "idle";
      const failed = a.state === "error" && (previous.state !== "error" || previous.error !== a.error);
      if (!newQuestion && !idle && !failed) continue;
      if (document.hasFocus() && document.visibilityState === "visible" && selectedId === a.id) continue;
      const title = newQuestion ? m.notification_input({ title: a.title }) : failed ? m.notification_error({ title: a.title }) : m.notification_idle({ title: a.title });
      const notification = new Notification(title, { body: newQuestion ? a.questions.find(q => q.state === "unanswered")?.text : failed ? a.error : m.notification_idle_body(), tag: `${a.id}:${newQuestion ? "input" : a.state}` });
      notification.onclick = () => { window.focus(); void open(a.ownerId ?? a.id); notification.close(); };
    }
  }
  function show(kind: "new" | "settings" | "keys") { setSurface(kind, true); }
  async function prepareModal(kind: "new" | "settings" | "keys") {
    error = "";
    if (kind === "new") { search = ""; void chooseHost(hostFilter || snapshot.hubId || ""); }
    if (kind === "settings") {
      models = await api<Model[]>("/models");
      const model = models.find(m => m.isDefault) ?? models[0];
      settings = snapshot.settings ? structuredClone($state.snapshot(snapshot.settings)) : model ? { fast: false, orc: { model: model.id, effort: model.defaultEffort }, worker: { model: model.id, effort: model.defaultEffort } } : null;
    }
    if (kind === "settings" && settings) { settings.fast = !!settings.fast; }
    await tick(); if (modal === kind && kind === "new") projectSearch?.focus();
  }
  async function closeModal() { const kind = modal; do { await back(); } while (kind && navigation.surfaces.includes(kind)); }
  async function resumeHistory(session: HistorySession, project: string) {
    const agent = await api<Agent>(`/history/resume?host=${encodeURIComponent(createHost)}`, { project, threadId: session.threadId, archived: session.archived });
    adopt(await api<Snapshot>("/snapshot"));
    focusCreatedId = agent.id;
    await openConversation(agent.id);
    await sessionList?.reveal(agent.id);
    toast.success(m.session_resumed(), { duration: 3000 });
  }
  $effect(() => { if (detail?.id === focusCreatedId && focusCreatedId) { focusCreatedId = null; void tick().then(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); } });
  async function create() {
    if (!projectId || saving || !connected) return; saving = true;
    try { const agent = await api<Agent>(`/agents?host=${encodeURIComponent(createHost)}`, { project: projectId }); await closeModal(); adopt(await api<Snapshot>("/snapshot")); focusCreatedId = agent.id; open(agent.id); await sessionList?.reveal(agent.id); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function saveSettings() {
    if (!settings || saving) return; saving = true;
    try { adopt(await api<Snapshot>("/settings", settings, "PUT")); closeModal(); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function lookup(agentId: string, operationId: string) {
    if(!client || !connected || hosts.find(h => h.id === agentId.split(':')[0])?.connected === false) return;
    try { acceptReceipt(agentId, receiptSchema.parse(await client.call<Receipt>('lookup',{id:agentId,operationId}))); }
    catch(e) { unknownOutgoing(agentId,operationId,e instanceof Error?e.message:m.load_failure()); }
  }
  async function retryDelivery(operationId: string) {
    if (!selectedId || !hostConnected || !client) return;
    const batch = outgoing.entries.find(o => o.agentId === selectedId && o.id === operationId && o.answers);
    if (batch?.answers) { await answerBatch(batch.answers, operationId); return; }
    try { await client.call("retryDelivery", {id:selectedId,deliveryId:operationId}); }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); }
  }
  async function reconcilePending() {
    for(const pending of outgoing.entries) if(pending.status === 'uncertain') void lookup(pending.agentId,pending.id);
  }
  async function send(text: string, operationId: string) {
    if (!selectedId || !hostConnected || !client) return false;
    const id = selectedId; const connection = client;
    addOutgoing(id,text,operationId);
    try {
      const result = await connection.call<Detail>('send',{id,text,operationId});
      observeOutgoing(result);
      // Only replicated detail updates may replace visible state; RPC replies may be older.
      const delivery = result.deliveries.find(d => d.id === operationId);
      if(!delivery) unknownOutgoing(id,operationId,m.unknown_delivery());
    } catch(e) {
      unknownOutgoing(id,operationId,e instanceof Error?e.message:m.load_failure());
    }
    void lookup(id,operationId);
    return true;
  }
  let closingId = $state<string | null>(null);
  let closeError = $state<{ id: string; reason: string } | null>(null);
  async function closeTree(id: string) {
    if (closingId) return;
    closeError = null;
    if (!connected || hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected === false) { closeError = { id, reason: m.host_offline() }; return; }
    closingId = id;
    try {
      await api(`/agents/${id}/close`, {});
      toast.success(m.tree_closed(), { duration: 3000 });
      adopt(await api<Snapshot>("/snapshot"));
    } catch(e) { closeError = { id, reason: e instanceof Error ? e.message : m.load_failure() }; }
    finally { closingId = null; }
  }
  async function rename(title: string) {
    if (!selectedId || !hostConnected) return m.host_offline();
    const id = selectedId;
    try {
      const result = await api<Detail>(`/agents/${id}/title`, { title });
      if (selectedId === id) detail = result;
      snapshot = { ...snapshot, agents: snapshot.agents.map(a => a.id === id ? { ...a, title: result.title } : a) };
      return undefined;
    } catch (e) { return e instanceof Error ? e.message : m.load_failure(); }
  }
  async function stop() {
    if (!detail?.turnId || !hostConnected || detail.state !== "working") { error = m.stop_not_working(); return false; }
    const id = detail.id; const turnId = detail.turnId;
    try { const result = await api<Detail>(`/agents/${id}/stop`, { turnId }); if (selectedId === id) detail = result; return true; }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function answerBatch(answers: Answer[], operationId: string) {
    if (!selectedId || !hostConnected || !client || !detail) return;
    const id = selectedId;
    const text = answers.map(answer => `Question: ${detail!.questions.find(q => q.id === answer.questionId)?.text}\nAnswer: ${answer.answer}`).join("\n\n");
    addOutgoing(id, text, operationId, answers);
    try {
      const result = await client.call<Detail>("answerBatch", { id, answers, operationId });
      const delivery = result.deliveries.find(d => d.id === operationId);
      if (delivery) acceptReceipt(id, { operationId, state: delivery.status === "sent" ? "accepted" : delivery.status === "failed" ? "rejected" : delivery.status === "uncertain" ? "uncertain" : "pending", turnId: delivery.turnId ?? null, error: delivery.error ?? null });
    } catch (e) {
      if (e instanceof RequestRejected) { acceptReceipt(id, { operationId, state: "rejected", turnId: null, error: e.message }); return; }
      else unknownOutgoing(id, operationId, e instanceof Error ? e.message : m.load_failure());
    }
    void lookup(id, operationId);
  }
  async function navigate(offset: number, index?: number) {
    const id = await sessionList?.navigate(offset, index);
    if (!id) return;
    if (snapshot.agents.find(a => a.id === id)?.role === "orc") focusCreatedId = id;
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
    const optionMove = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && ["KeyJ", "KeyK"].includes(event.code);
    const numberMove = event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code);
    if (optionMove || numberMove) {
      if (navigation.surfaces.length) return;
      event.preventDefault();
      void navigate(optionMove ? (event.code === "KeyJ" ? 1 : -1) : 0, numberMove ? Number(event.code.slice(-1)) - 1 : undefined);
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.code === "KeyX") {
      event.preventDefault();
      if (navigation.surfaces.length) return;
      const id = navigation.details.length ? (detail?.role === "orc" ? detail.id : null) : sessionList?.closeTarget();
      if (id && !event.repeat) void closeTree(id);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault(); closeDetail();
      return;
    }
    if (editable(event.target) || navigation.surfaces.length) return;
    if (event.key.toLowerCase() === "i" && detail?.role === "orc") { event.preventDefault(); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); return; }
    if (event.target instanceof HTMLElement && event.target.closest(".question-card")) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) { void sessionList?.keydown(event); return; }
    if (event.key.toLowerCase() === "n" && connected) { event.preventDefault(); void show("new"); }
    else if (event.key.toLowerCase() === "e") { event.preventDefault(); sessionList?.expandFocused(); }
    else if (event.key === "?") { event.preventDefault(); void show("keys"); }
  }
  onMount(() => {
    const cached = localStorage.getItem(`${storagePrefix}/snapshot`); if (cached) snapshot = JSON.parse(cached);
    const cachedDetail = selectedId && localStorage.getItem(`${storagePrefix}/detail/${selectedId}`); if (cachedDetail) detail = JSON.parse(cachedDetail);
    const cleanupNavigation = initializeNavigation(selectedId);
    const media = matchMedia("(min-width: 701px)");
    const resize = () => desktop = media.matches;
    media.addEventListener("change", resize);
    void load();
    let disposed = false; let generation = 0; let reconnect: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      const gen = ++generation; let baseline = true;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/socket`);
      const offline = () => {
        if(disposed || gen !== generation) return;
        connected = false; client = undefined; setClient(undefined);
        for(const pending of outgoing.entries) if(pending.status === 'sending') unknownOutgoing(pending.agentId,pending.id,m.unknown_delivery());
        clearTimeout(reconnect); reconnect = setTimeout(() => { void connect(); },1000);
      };
      try {
        const next = await openGrove(socket, value => {
          if(disposed || gen !== generation) return;
          connected = true;
          if(!baseline) notifications(snapshot,value.snapshot);
          const wasAvailable = selectedId && snapshot.hosts?.find(h => h.id === snapshot.agents.find(a => a.id === selectedId)?.hostId)?.connected;
          adopt(value.snapshot,baseline); baseline = false;
          const nowAvailable = selectedId && value.snapshot.hosts?.find(h => h.id === value.snapshot.agents.find(a => a.id === selectedId)?.hostId)?.connected;
          if(selectedId && !wasAvailable && nowAvailable && client) void client.call("select",{ids:[selectedId]}).catch(() => {});
          const incoming = selectedId && value.details[selectedId];
          if(incoming) { observeOutgoing(incoming);detail = incoming;localStorage.setItem(`${storagePrefix}/detail/${incoming.id}`,JSON.stringify(incoming)); }
          void reconcilePending();
        },offline);
        if(disposed || gen !== generation) {next.close();return;}
        client = next; setClient(next); connected = true;
        if(selectedId) await restoreDetail(selectedId);
        void reconcilePending();
      } catch { offline(); }
    };
    void connect();
    const compositionStart = () => composing = true;
    const compositionEnd = () => composing = false;
    window.addEventListener("compositionstart", compositionStart);
    window.addEventListener("compositionend", compositionEnd);
    const timer = setInterval(() => now = Date.now(), 1000);
    const permission = () => { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {}); };
    const completionTab = (e: KeyboardEvent) => { if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault(); };
    window.addEventListener("keydown", completionTab, true);
    const installer = (e: Event) => { e.preventDefault(); install = e as Event & { prompt: () => Promise<void> }; };
    window.addEventListener("pointerdown", permission, { once: true }); window.addEventListener("keydown", permission, { once: true }); window.addEventListener("keydown", keydown); window.addEventListener("beforeinstallprompt", installer);
    return () => { window.removeEventListener("compositionstart", compositionStart); window.removeEventListener("compositionend", compositionEnd); media.removeEventListener("change", resize); cleanupNavigation(); window.removeEventListener("keydown", completionTab, true); disposed = true; ++generation; clearTimeout(reconnect); client?.close(); setClient(undefined); clearInterval(timer); window.removeEventListener("pointerdown", permission); window.removeEventListener("keydown", permission); window.removeEventListener("keydown", keydown); window.removeEventListener("beforeinstallprompt", installer); };
  });
</script>

<Toaster theme="dark" position="bottom-center" />
<header class="app-header" class:has-selection={!!selectedId}><strong>{m.product()}</strong><span class="session-count">{m.session_count({ count: roots.length })}</span>
  <HostFilter {hosts} bind:value={hostFilter} />
  <div class="header-actions"><Weekly hostId={detail?.hostId ?? snapshot.hubId} connected={connected && (selectedHost?.connected ?? true)} /><Button variant="ghost" size="icon-sm" aria-label={m.settings()} disabled={!connected} onclick={() => show("settings")}><SettingsIcon /></Button></div>
</header>
<main class:with-detail={!!selectedId}>
  <SessionList bind:this={sessionList} agents={visibleAgents} {hosts} {selectedId} {loading} {connected} {closingId} closeError={selectedId === closeError?.id ? null : closeError} onclosetree={closeTree} onopen={open} onnew={() => show("new")} />
  {#if !selectedId}<div class="detail-empty"><p>{m.select_conversation()}</p></div>{:else if !detail}<div class="detail-empty" role="status"><p>{m.loading()}</p><Button variant="ghost" size="sm" onclick={closeDetail}>{m.back_sessions()}</Button></div>{/if}
  {#if !connected && !loading}<div class="connection-banner" role="status"><strong>{m.reconnecting()}</strong><span>{m.offline_help()}</span><Button variant="ghost" size="sm" onclick={load}>{m.retry()}</Button></div>{/if}
  {#if error && !modal && !detail}<div class="app-error" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => error = ""}><X /></Button></div>{/if}
  {#if detail && selectedId}{#key detail.id}<AgentDetail detail={shownDetail!} {owner} {skills} {now} connected={hostConnected} onstop={stop} onrename={rename} onrefresh={load} actionError={error} closeError={closeError?.id === detail.id ? closeError.reason : undefined} lastSeen={selectedHost?.lastSeen} workers={snapshot.agents.filter(w => w.ownerId === detail?.id)} onclose={closeDetail} onopen={id => open(id, true)} onsend={send} onanswer={answerBatch} onretry={retryDelivery} onlookup={operationId => selectedId ? lookup(selectedId,operationId) : Promise.resolve()} />{/key}{/if}
</main>

<Dialog.Root open={modalOpen} onOpenChange={value => { if (!value && modal) void closeModal(); }}>
  <Dialog.Content showCloseButton={false} class={`grove-dialog ${modal === "new" ? "new-modal" : modal === "settings" ? "settings-modal" : ""}`} onOpenAutoFocus={e => { e.preventDefault(); if (modal === "new") projectSearch?.focus(); }} onCloseAutoFocus={e => e.preventDefault()}><Button class="modal-close" variant="ghost" size="icon-sm" aria-label={m.close()} onclick={closeModal}><X /></Button>
    {#if modal === "new"}
      <Dialog.Title>{navigation.surfaces.includes("history") ? m.open_session() : m.new_session()}</Dialog.Title>
      {#if navigation.surfaces.includes("history") && projects.find(p => p.alias === projectId)}
        {#key createHost + ":" + projectId}<SessionHistory hostId={createHost} hostName={hosts.find(h => h.id === createHost)?.name ?? ""} project={projects.find(p => p.alias === projectId)!} connected={connected && !!hosts.find(h => h.id === createHost)?.connected} onresume={resumeHistory} />{/key}
      {:else}
      <p class="modal-help">{m.host_project_help()}</p>
      <p class="form-section-label">{m.execution_host()}</p><div class="host-choices" aria-label={m.execution_host()}>{#each hosts as host}<button class:selected={createHost === host.id} disabled={!host.connected} onclick={() => chooseHost(host.id)}><strong>{host.name}</strong><span>{host.connected ? m.connected_host() : m.disconnected_host()}</span></button>{/each}</div>
      <p class="form-section-label">{m.project_label()}</p><Input bind:ref={projectSearch} class="project-search" aria-label={m.search_projects()} placeholder={m.search_projects()} bind:value={search} onkeydown={e => {
        if (e.isComposing) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const i = filteredProjects.findIndex(p => p.alias === projectId); projectId = filteredProjects[Math.max(0, Math.min(filteredProjects.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.alias ?? ""; }
        if (e.key === "Enter") { e.preventDefault(); void create(); }
      }} />
      <div class="project-list">{#each filteredProjects as project}<button class:selected={project.alias === projectId} onclick={() => projectId = project.alias} aria-label={project.name}><strong>{project.name}</strong>{#if project.name !== project.alias}<span>{project.path}</span>{/if}</button>{:else}<p>{m.no_projects()}</p>{/each}</div>
      {#if snapshot.settings}<p class="defaults-note">{m.new_defaults({ model: snapshot.settings.orc.model, effort: snapshot.settings.orc.effort, tier: snapshot.settings.fast ? m.fast_mode() : "Default" })}</p>{/if}
      <p class="project-keyboard">{m.project_keyboard()}</p>
      <div class="modal-action"><Button variant="ghost" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || !projectId} onclick={() => setSurface("history", true)}><History />{m.find_history()}</Button><Button variant="default" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || !filteredProjects.some(p => p.alias === projectId)} onclick={create}>{saving ? m.sending() : m.create_host({ host: hosts.find(h => h.id === createHost)?.name ?? "" })}</Button></div>
      {/if}
    {:else if modal === "settings"}
      <Dialog.Title>{m.settings()}</Dialog.Title><p class="modal-help">{m.settings_help()}</p>
      {#if settings}{#each ["orc", "worker"] as role}{@const key = role as "orc" | "worker"}<section class="role-settings"><h3>{key === "orc" ? m.orc() : m.worker()}</h3><div class="model-fields"><label>{m.model()}<NativeSelect class="model-select" bind:value={settings[key].model} onchange={() => { if (settings) settings[key].effort = models.find(model => model.id === settings![key].model)?.defaultEffort ?? ""; if (settings && !models.find(model => model.id === settings![key].model)?.fastTier) settings.fast = false; }}>{#each models as model}<option value={model.id}>{model.name}</option>{/each}</NativeSelect></label><label>{m.effort()}<NativeSelect class="model-select" bind:value={settings[key].effort}>{#each models.find(model => model.id === settings![key].model)?.efforts ?? [] as effort}<option value={effort}>{effort}</option>{/each}</NativeSelect></label></div></section>{/each}<label class="fast-setting"><span><strong>{m.fast_mode()}</strong><small>{fastAvailable ? m.fast_help() : m.fast_unavailable()}</small></span><Switch aria-label={m.fast_mode()} bind:checked={settings.fast} disabled={!fastAvailable} /></label>{/if}
      <p class="settings-scope">{m.settings_scope()}</p><div class="modal-action">{#if install}<button class="install-link" onclick={() => install?.prompt()}>{m.install_app()}</button>{/if}<Button variant="default" size="sm" disabled={!settings || !connected || saving} onclick={saveSettings}>{saving ? m.sending() : m.save_changes()}</Button></div>
      <details class="settings-hosts"><summary>{m.hosts()}</summary><Hosts {hosts} sessionCount={roots.length} onadopt={value => adopt(value, true)} /></details>
    {:else if modal === "keys"}
      <Dialog.Title>{m.shortcuts()}</Dialog.Title><p class="modal-help">{m.keyboard_help()}</p><dl class="shortcut-list">{#each [["↑ ↓ ← →", m.key_focus()], ["Option + J / K", m.key_session_loop()], ["⌘ 1–9", m.key_visible_session()], ["Enter", m.key_open()], ["E", m.key_expand()], ["N", m.key_new()], ["I", m.key_input()], ["Option/Alt + X", m.close_tree()], ["Esc", m.key_escape()], ["Tab", m.key_completion()], ["Enter", m.key_send()], ["Shift + Enter", m.key_newline()]] as [key, label]}<div><dt><Kbd>{key}</Kbd></dt><dd>{label}</dd></div>{/each}</dl><p class="keyboard-scope">{m.keyboard_scope()}</p>
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  </Dialog.Content>
</Dialog.Root>
