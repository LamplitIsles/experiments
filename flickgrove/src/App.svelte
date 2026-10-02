<script lang="ts">
  import { onMount, tick } from "svelte";
  import { SvelteFlowProvider } from "@xyflow/svelte";
  import type { Agent, Detail, Model, Project, Settings, Skill, Snapshot } from "./contracts";
  import { api, editable } from "./api";
  import Canvas from "./Canvas.svelte";
  import AgentDetail from "./AgentDetail.svelte";
  import * as m from "./paraglide/messages";

  let snapshot = $state<Snapshot>({ agents: [], settings: null, revision: 0 });
  let selectedId = $state<string | null>(localStorage.getItem("flickgrove/selected"));
  let detail = $state<Detail | null>(null); let skills = $state<Skill[]>([]);
  let projects = $state<Project[]>([]); let models = $state<Model[]>([]);
  let connected = $state(false); let loading = $state(true); let error = $state("");
  let now = $state(Date.now()); let canvas: { fit(): void; expandFocused(): void };
  let dialog: HTMLDialogElement; let modal = $state<"new" | "settings" | "keys" | null>(null);
  let search = $state(""); let projectId = $state(""); let saving = $state(false);
  let settings = $state<Settings | null>(null); let sequence = 0;
  let install = $state<(Event & { prompt: () => Promise<void> }) | null>(null);
  const roots = $derived(snapshot.agents.filter(a => a.role === "orc"));
  const owner = $derived(snapshot.agents.find(a => a.id === detail?.ownerId));
  const filteredProjects = $derived(projects.filter(p => `${p.alias} ${p.name}`.toLowerCase().includes(search.toLowerCase())));

  function closeDetail() { selectedId = null; detail = null; localStorage.removeItem("flickgrove/selected"); }
  async function refreshDetail(id: string) {
    const seq = ++sequence;
    try {
      const result = await api<Detail>(`/agents/${id}`);
      if (selectedId === id && seq === sequence) { detail = result; localStorage.setItem(`flickgrove/detail/${id}`, JSON.stringify(result)); }
    } catch (e) { if (selectedId === id && connected) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  async function open(id: string) {
    selectedId = id; localStorage.setItem("flickgrove/selected", id);
    const cached = localStorage.getItem(`flickgrove/detail/${id}`); detail = cached ? JSON.parse(cached) : null; skills = [];
    if (connected) {
      await refreshDetail(id);
      if (snapshot.agents.find(a => a.id === id)?.role === "orc") {
        try { const list = await api<Skill[]>(`/agents/${id}/skills`); if (selectedId === id) skills = list; }
        catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
      }
    }
  }
  function adopt(value: Snapshot, authoritative = false) {
    if (!authoritative && value.revision < snapshot.revision) return;
    snapshot = value; localStorage.setItem("flickgrove/snapshot", JSON.stringify(value));
    if (selectedId && !value.agents.some(a => a.id === selectedId)) closeDetail();
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
  async function show(kind: "new" | "settings" | "keys") {
    modal = kind; error = "";
    if (kind === "new") { search = ""; projectId = projects[0]?.alias ?? ""; }
    if (kind === "settings") {
      const model = models.find(m => m.isDefault) ?? models[0];
      settings = snapshot.settings ? structuredClone($state.snapshot(snapshot.settings)) : model ? { orc: { model: model.id, effort: model.defaultEffort }, worker: { model: model.id, effort: model.defaultEffort } } : null;
    }
    await tick(); dialog.showModal();
  }
  function closeModal() { dialog?.close(); modal = null; }
  async function create() {
    if (!projectId || saving || !connected) return; saving = true;
    try { const agent = await api<Agent>("/agents", { project: projectId }); closeModal(); adopt(await api<Snapshot>("/snapshot")); await open(agent.id); }
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
    if (!selectedId || !connected) return false; error = ""; const id = selectedId;
    try {
      const result = await api<Detail | { closed: true }>(`/agents/${id}/messages`, { text, requestId });
      if ("closed" in result && result.closed) { closeDetail(); adopt(await api<Snapshot>("/snapshot")); return true; }
      if (selectedId === id) detail = result as Detail;
      return (result as Detail).deliveries.find(d => d.id === requestId)?.status === "sent";
    } catch (e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function answer(questionId: string, text: string) {
    if (!selectedId || !connected) return false; error = ""; const id = selectedId;
    try { const result = await api<Detail>(`/agents/${id}/answer`, { questionId, answer: text }); if (selectedId === id) detail = result; return result.questions.find(q => q.id === questionId)?.state === "answered"; }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); return false; }
  }
  async function reconcile(deliveryId: string, accepted: boolean) {
    if (!selectedId || !connected) return;
    const id = selectedId;
    try { const result = await api<Detail>(`/agents/${id}/reconcile`, { deliveryId, accepted }); if (selectedId === id) detail = result; }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
  }
  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") { if (modal) closeModal(); else closeDetail(); return; }
    if (editable(event.target) || modal || (event.target instanceof HTMLElement && event.target.closest(".question-card"))) return;
    if (event.key.toLowerCase() === "n" && connected) { event.preventDefault(); void show("new"); }
    else if (event.key.toLowerCase() === "f") { event.preventDefault(); canvas?.fit(); }
    else if (event.key.toLowerCase() === "e") { event.preventDefault(); canvas?.expandFocused(); }
    else if (event.key === "?") { event.preventDefault(); void show("keys"); }
  }
  onMount(() => {
    const cached = localStorage.getItem("flickgrove/snapshot"); if (cached) snapshot = JSON.parse(cached);
    const cachedDetail = selectedId && localStorage.getItem(`flickgrove/detail/${selectedId}`); if (cachedDetail) detail = JSON.parse(cachedDetail);
    void load();
    const events = new EventSource("/api/events"); let baseline = true;
    events.onopen = () => { connected = true; baseline = true; };
    events.onmessage = event => { const next = JSON.parse(event.data) as Snapshot; if (!baseline) notifications(snapshot, next); adopt(next, baseline); baseline = false; };
    events.onerror = () => { connected = false; };
    const timer = setInterval(() => now = Date.now(), 1000);
    const permission = () => { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {}); };
    const installer = (e: Event) => { e.preventDefault(); install = e as Event & { prompt: () => Promise<void> }; };
    window.addEventListener("pointerdown", permission, { once: true }); window.addEventListener("keydown", permission, { once: true }); window.addEventListener("keydown", keydown); window.addEventListener("beforeinstallprompt", installer);
    return () => { events.close(); clearInterval(timer); window.removeEventListener("pointerdown", permission); window.removeEventListener("keydown", permission); window.removeEventListener("keydown", keydown); window.removeEventListener("beforeinstallprompt", installer); };
  });
</script>

<header class="app-header"><strong>{m.product()}</strong><span class="session-count">{m.session_count({ count: roots.length })}</span><div class="header-actions"><button class="btn btn-primary btn-sm" disabled={!connected || loading} onclick={() => show("new")}><span aria-hidden="true">+</span>{m.new_session()}</button><button class="btn btn-sm" disabled={!connected || !models.length} onclick={() => show("settings")}>{m.settings()}</button><button class="btn btn-sm btn-square" aria-label={m.shortcuts()} onclick={() => show("keys")}>?</button></div></header>
<main class:with-detail={!!selectedId}>
  <SvelteFlowProvider><Canvas bind:this={canvas} agents={snapshot.agents} {selectedId} {now} onopen={open} /></SvelteFlowProvider>
  {#if loading && !snapshot.agents.length}<div class="canvas-empty"><p>{m.loading()}</p></div>
  {:else if !roots.length}<div class="canvas-empty"><h1>{m.empty_heading()}</h1><p>{m.empty_help()}</p><button class="btn btn-primary btn-sm" disabled={!connected} onclick={() => show("new")}><span aria-hidden="true">+</span>{m.new_session()}</button></div>{/if}
  {#if !connected && !loading}<div class="connection-banner" role="status"><strong>{m.reconnecting()}</strong><span>{m.offline_help()}</span><button class="btn btn-sm" onclick={load}>{m.retry()}</button></div>{/if}
  {#if error && !modal}<div class="app-error" role="alert"><span>{error}</span><button class="btn btn-sm btn-square" aria-label={m.close()} onclick={() => error = ""}>×</button></div>{/if}
  {#if detail && selectedId}{#key detail.id}<AgentDetail {detail} {owner} {skills} {now} {connected} onclose={closeDetail} onopen={open} onsend={send} onanswer={answer} onreconcile={reconcile} />{/key}{/if}
</main>

<dialog bind:this={dialog} class="modal" onclose={() => modal = null}>
  <div class="modal-box"><button class="btn btn-sm btn-square modal-close" aria-label={m.close()} onclick={closeModal}>×</button>
    {#if modal === "new"}
      <h2>{m.new_session()}</h2><p class="modal-help">{m.choose_project()}</p>
      <input class="input project-search" aria-label={m.search_projects()} placeholder={m.search_projects()} bind:value={search} onkeydown={e => {
        if (e.isComposing) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const i = filteredProjects.findIndex(p => p.alias === projectId); projectId = filteredProjects[Math.max(0, Math.min(filteredProjects.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.alias ?? ""; }
        if (e.key === "Enter") { e.preventDefault(); void create(); }
      }} />
      <div class="project-list">{#each filteredProjects as project}<button class:selected={project.alias === projectId} onclick={() => projectId = project.alias} aria-label={project.name}><strong>{project.name}</strong>{#if project.name !== project.alias}<span>{project.alias}</span>{/if}</button>{:else}<p>{m.no_projects()}</p>{/each}</div>
      <div class="modal-action"><button class="btn btn-primary btn-sm" disabled={!connected || saving || !filteredProjects.some(p => p.alias === projectId)} onclick={create}>{saving ? m.sending() : m.create_session()}</button></div>
    {:else if modal === "settings"}
      <h2>{m.settings()}</h2><p class="modal-help">{m.settings_help()}</p>
      {#if settings}{#each ["orc", "worker"] as role}{@const key = role as "orc" | "worker"}<section class="role-settings"><h3>{key === "orc" ? m.orc() : m.worker()}</h3><div class="model-fields"><label>{m.model()}<select class="select" bind:value={settings[key].model} onchange={() => { if (settings) settings[key].effort = models.find(model => model.id === settings![key].model)?.defaultEffort ?? ""; }}>{#each models as model}<option value={model.id}>{model.name}</option>{/each}</select></label><label>{m.effort()}<select class="select" bind:value={settings[key].effort}>{#each models.find(model => model.id === settings![key].model)?.efforts ?? [] as effort}<option value={effort}>{effort}</option>{/each}</select></label></div></section>{/each}{/if}
      <p class="settings-scope">{m.settings_scope()}</p><div class="modal-action">{#if install}<button class="install-link" onclick={() => install?.prompt()}>{m.install_app()}</button>{/if}<button class="btn btn-primary btn-sm" disabled={!settings || !connected || saving} onclick={saveSettings}>{saving ? m.sending() : m.save_changes()}</button></div>
    {:else if modal === "keys"}
      <h2>{m.shortcuts()}</h2><p class="modal-help">{m.keyboard_help()}</p><dl class="shortcut-list">{#each [["↑ ↓ ← →", m.key_focus()], ["Enter", m.key_open()], ["E", m.key_expand()], ["N", m.key_new()], ["F", m.key_fit()], ["Esc", m.key_escape()], ["/ or $", m.key_completion()], ["Enter", m.key_send()], ["Shift + Enter", m.key_newline()], ["← →", m.key_questions()]] as [key, label]}<div><dt><kbd class="kbd kbd-sm">{key}</kbd></dt><dd>{label}</dd></div>{/each}</dl><p class="keyboard-scope">{m.keyboard_scope()}</p>
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  </div>
  <form method="dialog" class="modal-backdrop"><button aria-label={m.close()}>{m.close()}</button></form>
</dialog>
