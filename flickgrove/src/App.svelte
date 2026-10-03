<script lang="ts">
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import { NativeSelect } from "$lib/components/ui/native-select/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Kbd } from "$lib/components/ui/kbd/index.js";
  import { X, Keyboard, Plus, ChevronRight, Settings as SettingsIcon, Server } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { storagePrefix } from "./api";
  import { onMount, tick } from "svelte";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import type { Agent, Detail, Model, Project, Settings, Skill, Snapshot } from "./contracts";
  import { api, editable } from "./api";
  import HostFilter from "./HostFilter.svelte";
  import Hosts from "./Hosts.svelte";
  import Weekly from "./Weekly.svelte";
  import Canvas from "./Canvas.svelte";
  import AgentDetail from "./AgentDetail.svelte";
  import * as m from "./paraglide/messages";

  let snapshot = $state<Snapshot>({ agents: [], settings: null, revision: 0 });
  let selectedId = $state<string | null>(localStorage.getItem(`${storagePrefix}/selected`));
  let detail = $state<Detail | null>(null); let skills = $state<Skill[]>([]);
  let projects = $state<Project[]>([]); let models = $state<Model[]>([]);
  let connected = $state(false); let loading = $state(true); let error = $state("");
  let now = $state(Date.now()); let canvas: { keydown(event: KeyboardEvent): Promise<void>; fit(): void; expandFocused(): void; reveal(id: string): void };
  let projectSearch = $state<HTMLInputElement | null>(null); let modalOpen = $state(false); let modal = $state<"new" | "settings" | "keys" | "hosts" | null>(null);
  let search = $state(""); let projectId = $state(""); let saving = $state(false);
  let settings = $state<Settings | null>(null); let sequence = 0;
  let install = $state<(Event & { prompt: () => Promise<void> }) | null>(null);
  let hostFilter = $state(localStorage.getItem(`${storagePrefix}/host-filter`) ?? "");
  let createHost = $state(""); let catalogSequence = 0;
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
  function closeDetail() { error = ""; selectedId = null; detail = null; localStorage.removeItem(`${storagePrefix}/selected`); }
  async function refreshDetail(id: string) {
    const seq = ++sequence;
    try {
      const result = await api<Detail>(`/agents/${id}`);
      if (selectedId === id && seq === sequence) { detail = result; localStorage.setItem(`${storagePrefix}/detail/${id}`, JSON.stringify(result)); }
    } catch (e) { if (selectedId === id && connected) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  async function open(id: string) {
    error = ""; selectedId = id; localStorage.setItem(`${storagePrefix}/selected`, id);
    const cached = localStorage.getItem(`${storagePrefix}/detail/${id}`); detail = cached ? JSON.parse(cached) : null; skills = [];
    if (connected) {
      await refreshDetail(id);
      if (snapshot.agents.find(a => a.id === id)?.role === "orc" && hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected) {
        try { const list = await api<Skill[]>(`/agents/${id}/skills`); if (selectedId === id) skills = list; }
        catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
      }
    }
  }
  function adopt(value: Snapshot, authoritative = false) {
    if (!authoritative && value.revision < snapshot.revision) return;
    // Hub restart can temporarily lack remote display caches. Retain this
    // device's read-only cache until that host supplies authoritative state.
    const retained = snapshot.agents.filter(a => value.hosts?.some(h => h.id === a.hostId && !h.connected) && !value.agents.some(next => next.hostId === a.hostId));
    value = { ...value, agents: [...value.agents, ...retained], hosts: value.hosts?.map(h => !h.connected && !h.lastSeen ? { ...h, lastSeen: snapshot.hosts?.find(old => old.id === h.id)?.lastSeen } : h) };
    snapshot = value; localStorage.setItem(`${storagePrefix}/snapshot`, JSON.stringify(value));
    if (selectedId && !value.agents.some(a => a.id === selectedId) && !value.hosts?.some(h => h.id === selectedId?.split(":")[0] && !h.connected)) closeDetail();
    else if (selectedId) void refreshDetail(selectedId);
  }
  async function load() {
    loading = true; error = "";
    try {
      const [state, registered, catalog] = await Promise.all([api<Snapshot>("/snapshot"), api<Project[]>("/projects"), api<Model[]>("/models")]);
      connected = true; projects = registered; models = catalog; adopt(state, true);
      if (selectedId) await open(selectedId);
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
  async function show(kind: "new" | "settings" | "keys" | "hosts") {
    modal = kind; error = "";
    if (kind === "new") { search = ""; void chooseHost(hostFilter || snapshot.hubId || ""); }
    if (kind === "settings") {
      models = await api<Model[]>("/models");
      const model = models.find(m => m.isDefault) ?? models[0];
      settings = snapshot.settings ? structuredClone($state.snapshot(snapshot.settings)) : model ? { fast: false, orc: { model: model.id, effort: model.defaultEffort }, worker: { model: model.id, effort: model.defaultEffort } } : null;
    }
    if (kind === "settings" && settings) { settings.fast = !!settings.fast; }
    await tick(); modalOpen = true; if (kind === "new") projectSearch?.focus();
  }
  async function createOnHost(id: string) { await show("new"); await chooseHost(id); }
  function closeModal() { modalOpen = false; modal = null; }
  async function create() {
    if (!projectId || saving || !connected) return; saving = true;
    try { const agent = await api<Agent>(`/agents?host=${encodeURIComponent(createHost)}`, { project: projectId }); closeModal(); adopt(await api<Snapshot>("/snapshot")); await open(agent.id); await tick(); canvas?.reveal(agent.id); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function saveSettings() {
    if (!settings || saving) return; saving = true;
    try { adopt(await api<Snapshot>("/settings", settings, "PUT")); closeModal(); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function send(text: string, requestId: string) {
    if (!selectedId || !hostConnected) return false; error = ""; const id = selectedId;
    try {
      if (text === "/stop") return await stop();
      const result = await api<Detail | { closed: true }>(`/agents/${id}/messages`, { text, requestId });
      if ("closed" in result && result.closed) { closeDetail(); toast.success(m.tree_closed(), { duration: 3000 }); adopt(await api<Snapshot>("/snapshot")); return true; }
      if (selectedId === id) detail = result as Detail;
      return (result as Detail).deliveries.find(d => d.id === requestId)?.status === "sent";
    } catch (e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function stop() {
    if (!detail?.turnId || !hostConnected || detail.state !== "working") { error = m.stop_not_working(); return false; }
    const id = detail.id; const turnId = detail.turnId;
    try { const result = await api<Detail>(`/agents/${id}/stop`, { turnId }); if (selectedId === id) detail = result; return true; }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function answer(questionId: string, text: string) {
    if (!selectedId || !hostConnected) return false; error = ""; const id = selectedId;
    try { const result = await api<Detail>(`/agents/${id}/answer`, { questionId, answer: text }); if (selectedId === id) detail = result; return result.questions.find(q => q.id === questionId)?.state === "answered"; }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function reconcile(deliveryId: string, accepted: boolean) {
    if (!selectedId || !hostConnected) return;
    const id = selectedId;
    try { const result = await api<Detail>(`/agents/${id}/reconcile`, { deliveryId, accepted }); if (selectedId === id) detail = result; }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") { if (modal) closeModal(); else closeDetail(); return; }
    if (editable(event.target) || modal) return;
    if (event.key.toLowerCase() === "i" && detail?.role === "orc") { event.preventDefault(); document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus(); return; }
    if (event.target instanceof HTMLElement && event.target.closest(".question-card")) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key) && !detail) { void canvas?.keydown(event); return; }
    if (event.key.toLowerCase() === "n" && connected) { event.preventDefault(); void show("new"); }
    else if (event.key.toLowerCase() === "f") { event.preventDefault(); canvas?.fit(); }
    else if (event.key.toLowerCase() === "e") { event.preventDefault(); canvas?.expandFocused(); }
    else if (event.key === "?") { event.preventDefault(); void show("keys"); }
  }
  onMount(() => {
    const cached = localStorage.getItem(`${storagePrefix}/snapshot`); if (cached) snapshot = JSON.parse(cached);
    const cachedDetail = selectedId && localStorage.getItem(`${storagePrefix}/detail/${selectedId}`); if (cachedDetail) detail = JSON.parse(cachedDetail);
    void load();
    const events = new EventSource("/api/events"); let baseline = true;
    events.onopen = () => { connected = true; baseline = true; };
    events.onmessage = event => { const next = JSON.parse(event.data) as Snapshot; if (!baseline) notifications(snapshot, next); adopt(next, baseline); baseline = false; };
    events.onerror = () => { connected = false; };
    const timer = setInterval(() => now = Date.now(), 1000);
    const permission = () => { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {}); };
    const completionTab = (e: KeyboardEvent) => { if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) e.preventDefault(); };
    window.addEventListener("keydown", completionTab, true);
    const installer = (e: Event) => { e.preventDefault(); install = e as Event & { prompt: () => Promise<void> }; };
    window.addEventListener("pointerdown", permission, { once: true }); window.addEventListener("keydown", permission, { once: true }); window.addEventListener("keydown", keydown); window.addEventListener("beforeinstallprompt", installer);
    return () => { window.removeEventListener("keydown", completionTab, true); events.close(); clearInterval(timer); window.removeEventListener("pointerdown", permission); window.removeEventListener("keydown", permission); window.removeEventListener("keydown", keydown); window.removeEventListener("beforeinstallprompt", installer); };
  });
</script>

<Toaster theme="dark" position="bottom-center" />
<header class="app-header" class:has-selection={!!selectedId}><strong>{m.product()}</strong><span class="session-count">{m.session_count({ count: roots.length })}</span>
  <HostFilter {hosts} bind:value={hostFilter} />
  <span class="host-summary">{m.connected_count({ count: hosts.filter(h => h.connected).length })}{#if hosts.some(h => !h.connected)} · <span class="host-warning">{hosts.filter(h => !h.connected).map(h => h.name).join(", ")} {m.disconnected_host().toLowerCase()}</span>{/if}</span>
  <div class="header-actions"><Weekly hostId={detail?.hostId ?? snapshot.hubId} {connected} /><Button class="desktop-new" variant="default" size="sm" disabled={!connected || loading} onclick={() => show("new")}><Plus aria-hidden="true" />{m.new_session()}</Button><Button variant="ghost" size="sm" disabled={!connected} onclick={() => show("hosts")}><Server />{m.hosts()}</Button><Button variant="ghost" size="sm" disabled={!connected || !models.length} onclick={() => show("settings")}><SettingsIcon />{m.settings()}</Button><Button class="desktop-help" variant="ghost" size="icon-sm" aria-label={m.shortcuts()} onclick={() => show("keys")}><Keyboard /></Button></div>
</header>
<main class:with-detail={!!selectedId}>
  <SvelteFlowProvider><Canvas bind:this={canvas} agents={visibleAgents} {hosts} oncreate={createOnHost} {selectedId} {now} onopen={open} /></SvelteFlowProvider>
  <section class="mobile-sessions" aria-label={m.sessions()}><h1>{m.sessions()}</h1><p class="mobile-count">{m.session_count({ count: visibleAgents.filter(a => a.role === "orc").length })} · {m.worker_count({ count: visibleAgents.filter(a => a.role === "worker").length })}</p>{#each visibleAgents.filter(a => a.role === "orc") as agent}<button class="mobile-session" onclick={() => open(agent.id)}><div><span class="mobile-card-meta"><span class="owner-badge">{agent.hostName}</span><span>{agent.project.alias}</span></span><strong>{agent.title}</strong><span class:working={agent.state === "working"}>{agent.state === "working" ? m.working() : agent.state === "stopping" ? m.stopping() : agent.state === "error" ? m.failed() : m.idle()}</span><small>{m.current_workers({ count: snapshot.agents.filter(w => w.ownerId === agent.id).length })} · {m.working_count({ count: snapshot.agents.filter(w => w.ownerId === agent.id && w.state === "working").length })}</small></div><ChevronRight aria-hidden="true" /></button>{/each}<Button class="mobile-new" variant="default" size="sm" disabled={!connected} onclick={() => show("new")}><Plus aria-hidden="true" /> {m.new_session()}</Button></section>
  {#if loading && !snapshot.agents.length}<div class="canvas-empty"><p>{m.loading()}</p></div>
  {:else if !roots.length}<div class="canvas-empty"><h1>{m.empty_heading()}</h1><p>{m.empty_help()}</p><Button variant="default" size="sm" disabled={!connected} onclick={() => show("new")}><Plus aria-hidden="true" />{m.new_session()}</Button></div>{/if}
  {#if !connected && !loading}<div class="connection-banner" role="status"><strong>{m.reconnecting()}</strong><span>{m.offline_help()}</span><Button variant="ghost" size="sm" onclick={load}>{m.retry()}</Button></div>{/if}
  {#if error && !modal && !detail}<div class="app-error" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => error = ""}><X /></Button></div>{/if}
  {#if detail && selectedId}{#key detail.id}<AgentDetail {detail} {owner} {skills} {now} connected={hostConnected} onstop={stop} onrefresh={load} actionError={error} lastSeen={selectedHost?.lastSeen} workers={snapshot.agents.filter(w => w.ownerId === detail?.id)} onclose={closeDetail} onopen={open} onsend={send} onanswer={answer} onreconcile={reconcile} />{/key}{/if}
</main>

<Dialog.Root bind:open={modalOpen} onOpenChange={value => { if (!value) modal = null; }}>
  <Dialog.Content showCloseButton={false} class={`grove-dialog ${modal === "hosts" ? "hosts-modal" : modal === "new" ? "new-modal" : modal === "settings" ? "settings-modal" : ""}`} onOpenAutoFocus={e => { e.preventDefault(); if (modal === "new") projectSearch?.focus(); }} onCloseAutoFocus={e => e.preventDefault()}><Button class="modal-close" variant="ghost" size="icon-sm" aria-label={m.close()} onclick={closeModal}><X /></Button>
    {#if modal === "new"}
      <Dialog.Title>{m.new_session()}</Dialog.Title><p class="modal-help">{m.host_project_help()}</p>
      <p class="form-section-label">{m.execution_host()}</p><div class="host-choices" aria-label={m.execution_host()}>{#each hosts as host}<button class:selected={createHost === host.id} disabled={!host.connected} onclick={() => chooseHost(host.id)}><strong>{host.name}</strong><span>{host.connected ? m.connected_host() : m.disconnected_host()}</span></button>{/each}</div>
      <p class="form-section-label">{m.project_label()}</p><Input bind:ref={projectSearch} class="project-search" aria-label={m.search_projects()} placeholder={m.search_projects()} bind:value={search} onkeydown={e => {
        if (e.isComposing) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const i = filteredProjects.findIndex(p => p.alias === projectId); projectId = filteredProjects[Math.max(0, Math.min(filteredProjects.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.alias ?? ""; }
        if (e.key === "Enter") { e.preventDefault(); void create(); }
      }} />
      <div class="project-list">{#each filteredProjects as project}<button class:selected={project.alias === projectId} onclick={() => projectId = project.alias} aria-label={project.name}><strong>{project.name}</strong>{#if project.name !== project.alias}<span>{project.path}</span>{/if}</button>{:else}<p>{m.no_projects()}</p>{/each}</div>
      {#if snapshot.settings}<p class="defaults-note">{m.new_defaults({ model: snapshot.settings.orc.model, effort: snapshot.settings.orc.effort, tier: snapshot.settings.fast ? m.fast_mode() : "Default" })}</p>{/if}
      <p class="project-keyboard">{m.project_keyboard()}</p>
      <div class="modal-action"><Button variant="ghost" size="sm" onclick={closeModal}>{m.cancel()}</Button><Button variant="default" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || !filteredProjects.some(p => p.alias === projectId)} onclick={create}>{saving ? m.sending() : m.create_host({ host: hosts.find(h => h.id === createHost)?.name ?? "" })}</Button></div>
    {:else if modal === "settings"}
      <Dialog.Title>{m.settings()}</Dialog.Title><p class="modal-help">{m.settings_help()}</p>
      {#if settings}{#each ["orc", "worker"] as role}{@const key = role as "orc" | "worker"}<section class="role-settings"><h3>{key === "orc" ? m.orc() : m.worker()}</h3><div class="model-fields"><label>{m.model()}<NativeSelect class="model-select" bind:value={settings[key].model} onchange={() => { if (settings) settings[key].effort = models.find(model => model.id === settings![key].model)?.defaultEffort ?? ""; if (settings && !models.find(model => model.id === settings![key].model)?.fastTier) settings.fast = false; }}>{#each models as model}<option value={model.id}>{model.name}</option>{/each}</NativeSelect></label><label>{m.effort()}<NativeSelect class="model-select" bind:value={settings[key].effort}>{#each models.find(model => model.id === settings![key].model)?.efforts ?? [] as effort}<option value={effort}>{effort}</option>{/each}</NativeSelect></label></div></section>{/each}<label class="fast-setting"><span><strong>{m.fast_mode()}</strong><small>{fastAvailable ? m.fast_help() : m.fast_unavailable()}</small></span><Switch aria-label={m.fast_mode()} bind:checked={settings.fast} disabled={!fastAvailable} /></label>{/if}
      <p class="settings-scope">{m.settings_scope()}</p><div class="modal-action">{#if install}<button class="install-link" onclick={() => install?.prompt()}>{m.install_app()}</button>{/if}<Button variant="default" size="sm" disabled={!settings || !connected || saving} onclick={saveSettings}>{saving ? m.sending() : m.save_changes()}</Button></div>
    {:else if modal === "hosts"}
      <Hosts {hosts} sessionCount={roots.length} onadopt={value => adopt(value, true)} />
    {:else if modal === "keys"}
      <Dialog.Title>{m.shortcuts()}</Dialog.Title><p class="modal-help">{m.keyboard_help()}</p><dl class="shortcut-list">{#each [["↑ ↓ ← →", m.key_focus()], ["Enter", m.key_open()], ["E", m.key_expand()], ["N", m.key_new()], ["I", m.key_input()], ["F", m.key_fit()], ["Esc", m.key_escape()], ["Tab", m.key_completion()], ["Enter", m.key_send()], ["Shift + Enter", m.key_newline()], ["← →", m.key_questions()]] as [key, label]}<div><dt><Kbd>{key}</Kbd></dt><dd>{label}</dd></div>{/each}</dl><p class="keyboard-scope">{m.keyboard_scope()}</p>
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  </Dialog.Content>
</Dialog.Root>
