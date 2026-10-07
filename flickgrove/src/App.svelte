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
  import { navigation, initializeNavigation, resumeFilePreview, openConversation, setSurface, back, validateNavigation } from "./navigation.svelte";
  import { storagePrefix } from "./api";
  import { Peers, preferences } from "./peers";
  import { onMount, tick, untrack } from "svelte";
  import type { Answer, Agent, Detail, HistorySession, Model, Project, Settings, Skill, Snapshot } from "./contracts";
  import { api, editable, setClient } from "./api";
  import { RequestRejected } from "./chord-client";
  import { lookupSchema, type Receipt } from "./chord-contract";
  import { addOutgoing, observeOutgoing, outgoing, withOutgoing, acceptReceipt, unknownOutgoing, submissionResult } from "./outgoing.svelte";
  import { imageSchema } from "./chord-contract";
  import { restoreImages, type ImageDraft } from "./image-drafts";
  import { receiptAlreadyAccepted, setOutgoingImages } from "./outgoing.svelte";
  import { observeQuestions, questionPanels, setQuestionPanel } from "./question-state.svelte";
  import HostFilter from "./HostFilter.svelte";
  import Hosts from "./Hosts.svelte";
  import Weekly from "./Weekly.svelte";
  import SessionList from "./SessionList.svelte";
  import { historyCache } from "./history-cache";
  import AgentDetail from "./AgentDetail.svelte";
  import SessionHistory from "./SessionHistory.svelte";
  import * as m from "./paraglide/messages";

  $effect(() => resumeFilePreview());
  $effect(() => {
    if (!navigation.surfaces.includes("file-preview")) untrack(() => observeQuestions(snapshot.agents, selectedId));
  });
  let client: Peers | undefined;
  let composing = false;
  let snapshot = $state<Snapshot>({ agents: [], settings: null, revision: 0 });
  const savedSelection = preferences.selection;
  let treeOrder = $state(preferences.treeOrder);
  $effect(() => { preferences.treeOrder = $state.snapshot(treeOrder); });
  let remembered = $state<Record<string, string>>(savedSelection.sessions);
  let selectedId = $state<string | null>(savedSelection.sessions[savedSelection.host] ?? null);
  let navigationReady = $state(false); let peersReady = $state(false); let switchingHost = $state(false);
  let detail = $state<Detail | null>(null); let skills = $state<Skill[]>([]);
  let projects = $state<Project[]>([]); let models = $state<Model[]>(preferences.models);
  let connected = $state(false); let loading = $state(true); let error = $state("");
  let now = $state(Date.now()); let sessionList: { visibleIds(): string[]; keydown(event: KeyboardEvent): Promise<void>; expandFocused(): void; reveal(id: string): Promise<void>; closeTarget(): string | null; navigate(offset: number, index?: number): Promise<string | null> };
  let projectSearch = $state<HTMLInputElement | null>(null); let modalOpen = $state(false); let modal = $state<"new" | "settings" | "keys" | "hosts" | null>(null);
  let search = $state(""); let projectId = $state(""); let saving = $state(false);
  let settings = $state<Settings | null>(null); let sequence = 0; let focusCreatedId = $state<string | null>(null);
  let install = $state<(Event & { prompt: () => Promise<void> }) | null>(null);
  let hostFilter = $state(savedSelection.host);
  let desktop = $state(matchMedia("(min-width: 701px)").matches);
  let previousVisible: string[] = [];
  let lostSelection: string | null = null;
  $effect(() => {
    const ids = visibleAgents.map(a => a.id);
    const current = navigation.details.at(-1);
    if (!navigationReady || switchingHost || navigation.surfaces.length) return;
    if (peersReady && hostFilter !== (hosts[0]?.id ?? "") && !hosts.some(h => h.id === hostFilter)) {
      void selectHost(hosts[0]?.id ?? "", !!current || desktop);
      return;
    }
    // Browser history and explicit cross-device navigation take precedence.
    if (current && hosts.some(h => current.startsWith(h.id + ":")) && !current.startsWith(hostFilter + ":")) {
      hostFilter = current.split(":")[0];
      return;
    }
    const host = hosts.find(h => h.id === hostFilter);
    if (host?.connected && remembered[hostFilter] && !ids.includes(remembered[hostFilter])) {
      const next = { ...remembered }; delete next[hostFilter]; remembered = next;
    }
    if (host?.connected && !loading && (desktop || lostSelection) && (!current || !ids.includes(current))) {
      const position = previousVisible.indexOf(current ?? lostSelection ?? "");
      const adjacent = previousVisible.slice(position + 1).find(id => ids.includes(id)) ?? previousVisible.slice(0, Math.max(0, position)).reverse().find(id => ids.includes(id));
      const next = remembered[hostFilter] ?? adjacent ?? visibleAgents.find(a => a.role === "orc")?.id ?? null;
      void openConversation(next);
    }
    previousVisible = sessionList?.visibleIds() ?? visibleAgents.filter(a => a.role === "orc").map(a => a.id);
    lostSelection = null;
  });
  async function selectHost(id: string, restore = true) {
    switchingHost = true; hostFilter = id;
    const host = hosts.find(h => h.id === id);
    const rememberedId = remembered[id];
    const next = rememberedId && (!host?.connected || snapshot.agents.some(a => a.id === rememberedId)) ? rememberedId : snapshot.agents.find(a => a.hostId === id && a.role === "orc")?.id ?? null;
    try { if (restore) await openConversation(next); }
    finally { switchingHost = false; }
  }
  let createHost = $state(preferences.host); let catalogSequence = 0;
  const target = $derived(snapshot.agents.find(a => a.id === selectedId));
  // Snapshot identity is display-only; detail remains the write authority.
  const shownDetail = $derived(detail ? withOutgoing(detail) : target ? { ...target, messages: [], deliveries: [] } : null);
  const hosts = $derived(snapshot.hosts ?? []);
  const selectedHost = $derived(hosts.find(h => h.id === shownDetail?.hostId));
  const hostConnected = $derived(!!selectedHost?.connected);
  const visibleAgents = $derived(snapshot.agents.filter(a => a.hostId === hostFilter));
  $effect(() => { if (navigationReady) preferences.selection = { host: hostFilter, sessions: $state.snapshot(remembered) }; });
  async function chooseHost(id: string) {
    createHost = id; preferences.host = id; projectId = ""; projects = []; const seq = ++catalogSequence;
    try { const registered = await api<Project[]>(`/projects?host=${encodeURIComponent(id)}`); if (seq === catalogSequence) { projects = registered; projectId = registered[0]?.alias ?? ""; } }
    catch(e) { if (seq === catalogSequence) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  const roots = $derived(snapshot.agents.filter(a => a.role === "orc"));
  const fastAvailable = $derived(!!settings && [settings.orc, settings.worker].every(role => models.find(model => model.id === role.model)?.fastTier));
  const owner = $derived(snapshot.agents.find(a => a.id === shownDetail?.ownerId));
  const filteredProjects = $derived(projects.filter(p => `${p.alias} ${p.name}`.toLowerCase().includes(search.toLowerCase())));

  $effect(() => { if (modal === "new" && !filteredProjects.some(p => p.alias === projectId)) projectId = filteredProjects[0]?.alias ?? ""; });
  function closeDetail() { if (navigation.surfaces.length || !desktop) void back(); else if (selectedId && questionPanels[selectedId]) setQuestionPanel(selectedId, false); }
  $effect(() => {
    if (!navigationReady) return;
    const id = navigation.details.at(-1) ?? null;
    if (id !== selectedId) { ++sequence; selectedId = id; detail = null; skills = []; error = ""; if (id) void restoreDetail(id); else { void client?.call("select", {ids:[]}).catch(() => {}); } }
  });
  $effect(() => {
    const kind = navigation.surfaces.find(s => s === "new" || s === "settings" || s === "keys" || s === "hosts") ?? null;
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
    error = ""; selectedId = id; observeQuestions(snapshot.agents,id);
    const host = id.split(":")[0];
    // Unwinding nested history can briefly restore the previous host's owner.
    if (!switchingHost || host === hostFilter) remembered = { ...remembered, [host]: id };
    if (!switchingHost) hostFilter = host;
    const cached = localStorage.getItem(`${storagePrefix}/detail/${id}`); detail = cached ? JSON.parse(cached) : null; skills = [];
    if (hosts.find(h=>h.id===id.split(":")[0])?.connected) {
      void client?.call('select', {ids:[id]}).catch(e => { if(selectedId === id) error = e instanceof Error ? e.message : m.load_failure(); });
      if (snapshot.agents.find(a => a.id === id)?.role === "orc" && hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected) {
        try { const list = await api<Skill[]>(`/agents/${id}/skills`); if (selectedId === id) skills = list; }
        catch (e) { if (selectedId === id) error = e instanceof Error ? e.message : m.load_failure(); }
      }
    }
  }
  function adopt(value: Snapshot, authoritative = false) {
    if (!authoritative && value.revision < snapshot.revision) return;
    // Retain read-only state until each Peer supplies an authoritative snapshot.
    const retained = snapshot.agents.filter(a => value.hosts?.some(h => h.id === a.hostId && !h.connected) && !value.agents.some(next => next.hostId === a.hostId));
    value = { ...value, agents: [...value.agents, ...retained], hosts: value.hosts?.map(h => !h.connected && !h.lastSeen ? { ...h, lastSeen: snapshot.hosts?.find(old => old.id === h.id)?.lastSeen } : h) };
    observeQuestions(value.agents, selectedId);
    if (selectedId && !value.agents.some(a => a.id === selectedId)) lostSelection = selectedId;
    if (authoritative) {
      const order = { ...treeOrder };
      for (const host of value.hosts ?? []) {
        if (!host.connected) continue;
        const ids = value.agents.filter(a => a.hostId === host.id && a.role === "orc").map(a => a.id);
        const saved = (order[host.id] ?? []).filter(id => ids.includes(id));
        order[host.id] = [...saved, ...ids.filter(id => !saved.includes(id))];
      }
      treeOrder = order;
    }
    snapshot = value; localStorage.setItem(`${storagePrefix}/snapshot`, JSON.stringify(value));
    historyCache.retain(new Set(value.agents.map(a => a.id)));
    const valid = new Set(value.agents.map(a => a.id));
    for (const id of [...navigation.details, ...Object.values(remembered)]) {
      if (!peersReady || value.hosts?.some(h => !h.connected && id.startsWith(h.id + ":"))) valid.add(id);
    }
    validateNavigation(valid);

  }
  async function load() {
    loading = true; error = "";
    if(!hosts.find(h=>h.id===snapshot.entryId)?.connected){if(selectedId)await restoreDetail(selectedId);loading=false;return;}
    try {
      const [state, registered, catalog] = await Promise.all([api<Snapshot>("/snapshot"), api<Project[]>("/projects"), api<Model[]>("/models")]);
      projects = registered; models = catalog;preferences.models=catalog; if(!preferences.settings&&catalog.length){const model=catalog.find(m=>m.isDefault)??catalog[0];preferences.settings={fast:false,orc:{model:model.id,effort:model.defaultEffort},worker:{model:model.id,effort:model.defaultEffort}};snapshot={...snapshot,settings:preferences.settings};} if(!connected) adopt(state, true);
      if (selectedId) await restoreDetail(selectedId);
    } catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { loading = false; }
  }
  function notifications(before: Snapshot, after: Snapshot) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    for (const a of after.agents) {
      if(!before.hosts?.find(h=>h.id===a.hostId)?.connected || !after.hosts?.find(h=>h.id===a.hostId)?.connected)continue;
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
  let hostsReturnFocus: HTMLElement | null = null;
  function show(kind: "new" | "settings" | "keys" | "hosts") { if (kind === "hosts") hostsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; setSurface(kind, true); }
  async function prepareModal(kind: "new" | "settings" | "keys" | "hosts") {
    error = "";
    if (kind === "new") { search = ""; void chooseHost(hostFilter || preferences.host || snapshot.entryId || ""); }
    if (kind === "settings") {
      const saved=preferences.settings;
      const fallback=models.find(m=>m.isDefault) ?? models[0];
      settings=saved ? structuredClone(saved) : fallback ? {fast:false,orc:{model:fallback.id,effort:fallback.defaultEffort},worker:{model:fallback.id,effort:fallback.defaultEffort}} : null;
      try{models = await api<Model[]>("/models");preferences.models=models;}catch(e){if(!models.length)error=e instanceof Error?e.message:m.load_failure();}
      // Catalogue refresh must not replace a foreground settings draft.
      const model = models.find(m => m.isDefault) ?? models[0];
      if(!settings && modal==='settings' && model)settings={fast:false,orc:{model:model.id,effort:model.defaultEffort},worker:{model:model.id,effort:model.defaultEffort}};
    }
    if (kind === "settings" && settings) { settings.fast = !!settings.fast; }
    await tick(); if (modal === kind && kind === "new") projectSearch?.focus();
  }
  async function closeModal() { const kind = modal; while (kind && navigation.surfaces.includes(kind)) await back(); }
  async function resumeHistory(session: HistorySession, project: string) {
    const agent = await api<Agent>(`/history/resume?host=${encodeURIComponent(createHost)}`, { project, threadId: session.threadId, archived: session.archived, settings: await creationSettings() });
    adopt(await api<Snapshot>("/snapshot"));
    focusCreatedId = agent.id;
    await openConversation(agent.id);
    await sessionList?.reveal(agent.id);
    toast.success(m.session_resumed(), { duration: 3000 });
  }
  $effect(() => { if (detail?.id === focusCreatedId && focusCreatedId) { focusCreatedId = null; void tick().then(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); } });
  async function creationSettings():Promise<Settings> {
    if(preferences.settings)return preferences.settings;
    const catalog=await api<Model[]>("/models");
    const model=catalog.find(m=>m.isDefault)??catalog[0];
    if(!model)throw new Error("No models available");
    const settings:Settings={fast:false,orc:{model:model.id,effort:model.defaultEffort},worker:{model:model.id,effort:model.defaultEffort}};
    preferences.settings=settings;return settings;
  }
  async function create() {
    if (!projectId || saving || !connected) return; saving = true;
    try { const agent = await api<Agent>(`/agents?host=${encodeURIComponent(createHost)}`, { project: projectId, settings: await creationSettings() }); await closeModal(); adopt(await api<Snapshot>("/snapshot")); focusCreatedId = agent.id; open(agent.id); await sessionList?.reveal(agent.id); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function saveSettings() {
    if (!settings || saving) return; saving = true;
    try { preferences.settings = $state.snapshot(settings); snapshot = {...snapshot,settings:preferences.settings}; closeModal(); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  const lookups=new Set<string>();
  async function lookup(agentId: string, operationId: string) {
    if(!client || !connected || hosts.find(h => h.id === agentId.split(':')[0])?.connected === false) return;
    const key=agentId+"/"+operationId;if(lookups.has(key))return;lookups.add(key);
    try {
      const receipt = lookupSchema.parse(await client.call<Receipt | null>('lookup',{id:agentId,operationId}));
      if (receipt && receipt.operationId !== operationId) throw new Error("Receipt operation identity changed");
      acceptReceipt(agentId, receipt);
    }
    catch(e) { unknownOutgoing(agentId,operationId,e instanceof Error?e.message:m.load_failure()); }
    finally{lookups.delete(key);}
  }
  async function retryDelivery(operationId: string) {
    if (!selectedId || !hostConnected || !client) return;
    const batch = outgoing.entries.find(o => o.agentId === selectedId && o.id === operationId && o.answers);
    if (batch?.answers) { await answerBatch(batch.answers, operationId); return; }
    try { await client.call("retryDelivery", {id:selectedId,deliveryId:operationId}); }
    catch(e) { error = e instanceof Error ? e.message : m.load_failure(); }
  }
  async function reconcilePending() {
    for(const pending of outgoing.entries) if(pending.status === 'pending') void lookup(pending.agentId,pending.id);
  }
  async function send(id: string, text: string, operationId: string, images: ImageDraft[] = []) {
    if (detail?.id !== id) return false;
    if (!client || !hosts.find(h=>h.id===id.split(':')[0])?.connected) {
      acceptReceipt(id,{operationId,state:"rejected",turnId:null,error:"Execution host disconnected before submission"});
      try{await restoreImages(id,operationId,text);}catch(e){if(selectedId===id)error=(e as Error).message;}
      return false;
    }
    const connection = client;
    addOutgoing(id,text,operationId,undefined,undefined,images.map(i=>i.id));
    let submitted=false;
    try {
      let refs;
      if(images.length){
        const form=new FormData();form.set('text',text);for(const image of images)form.append('images',image.file,image.file.name);
        const response=await connection.media(id,`/api/images?agent=${encodeURIComponent(id)}&operation=${encodeURIComponent(operationId)}`,{method:'POST',body:form});
        const upload=await response.json();
        if(upload.agent!==id || upload.operation!==operationId)throw new Error("Image operation identity changed");
        refs=upload.images.map((i:unknown)=>imageSchema.parse(i));setOutgoingImages(id,operationId,refs);
      }
      submitted=true;
      const result=await connection.call<Detail>('send',{id,text,operationId,...(refs ? {images:refs} : {})});
      const delivery=result.deliveries.find(d=>d.id===operationId);
      observeOutgoing(result);
      if(images.length && delivery && submissionResult(delivery)==='rejected' && !receiptAlreadyAccepted(id,operationId) && !detail?.messages.some(m=>m.id===operationId))try{await restoreImages(id,operationId,text);}catch(e){if(selectedId===id)error=(e as Error).message;}
      if(!result.deliveries.some(d=>d.id===operationId))unknownOutgoing(id,operationId,m.sending());
    }catch(e){
      if((!submitted || e instanceof RequestRejected) && !receiptAlreadyAccepted(id,operationId)){
        acceptReceipt(id,{operationId,state:"rejected",turnId:null,error:e instanceof Error?e.message:m.load_failure()});
        if(images.length)try{await restoreImages(id,operationId,text);}catch(recovery){if(selectedId===id)error=(recovery as Error).message;}
      }else unknownOutgoing(id,operationId,e instanceof Error?e.message:m.load_failure());
    }
    if(submitted)void lookup(id,operationId);
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
      observeOutgoing(result);
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
    const hostMove = event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey && ["KeyH", "KeyL"].includes(event.code);
    if (hostMove) {
      if (navigation.surfaces.length) return;
      event.preventDefault();
      if (hosts.length < 2 || switchingHost) return;
      const index = hosts.findIndex(host => host.id === hostFilter);
      const offset = event.code === "KeyH" ? -1 : 1;
      void selectHost(hosts[(index + offset + hosts.length) % hosts.length].id);
      return;
    }
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
    if (event.key.toLowerCase() === "n") { event.preventDefault(); void show("new"); }
    else if (event.key.toLowerCase() === "e") { event.preventDefault(); sessionList?.expandFocused(); }
    else if (event.key === "?") { event.preventDefault(); void show("keys"); }
  }
  onMount(() => {
    const cached = localStorage.getItem(`${storagePrefix}/snapshot`); if (cached) {const saved=JSON.parse(cached);snapshot={...saved,hosts:saved.hosts?.map((h:import("./contracts").Host)=>({...h,connected:false}))};}
    const cachedDetail = selectedId && localStorage.getItem(`${storagePrefix}/detail/${selectedId}`); if (cachedDetail) detail = JSON.parse(cachedDetail);
    const cleanupNavigation = initializeNavigation(selectedId);
    navigationReady = true;
    const initialId = navigation.details.at(-1);
    if (initialId) { hostFilter = initialId.split(":")[0]; remembered = { ...remembered, [hostFilter]: initialId }; }
    const media = matchMedia("(min-width: 701px)");
    const resize = () => desktop = media.matches;
    media.addEventListener("change", resize);
    let disposed=false;
    client=new Peers(value=>{
      if(disposed)return;
      const before=snapshot;
      const entryWasConnected=before.hosts?.find(h=>h.id===value.snapshot.entryId)?.connected;
      connected=value.snapshot.hosts?.some(h=>h.connected)??false;
      notifications(before,value.snapshot);
      adopt(value.snapshot,true);const entry=value.snapshot.hosts?.find(h=>h.id===value.snapshot.entryId);loading=!!entry&&!entry.connected&&!entry.error;
      const incoming=selectedId&&value.details[selectedId];
      if(incoming){observeOutgoing(incoming);detail=incoming;localStorage.setItem(`${storagePrefix}/detail/${incoming.id}`,JSON.stringify(incoming));}
      void reconcilePending();
      if(selectedId){const id=selectedId.split(":")[0];if(!before.hosts?.find(h=>h.id===id)?.connected&&value.snapshot.hosts?.find(h=>h.id===id)?.connected)void restoreDetail(selectedId);}
      if(!entryWasConnected&&value.snapshot.hosts?.find(h=>h.id===value.snapshot.entryId)?.connected){
        void load();
        if(modal==="new"&&!hosts.some(h=>h.id===createHost))void chooseHost(preferences.host&&hosts.some(h=>h.id===preferences.host)?preferences.host:value.snapshot.entryId!);
      }
    },id=>{
      for(const pending of outgoing.entries)if(pending.agentId.startsWith(id+":")&&pending.status==='pending')unknownOutgoing(pending.agentId,pending.id,m.sending());
    });
    setClient(client);
    void client.start().then(()=>{peersReady=true;return load();}).catch(e=>{loading=false;error=e.message;});
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
    return () => { window.removeEventListener("compositionstart", compositionStart); window.removeEventListener("compositionend", compositionEnd); media.removeEventListener("change", resize); cleanupNavigation(); window.removeEventListener("keydown", completionTab, true); disposed = true; client?.close(); setClient(undefined); clearInterval(timer);window.removeEventListener("pointerdown", permission); window.removeEventListener("keydown", permission); window.removeEventListener("keydown", keydown); window.removeEventListener("beforeinstallprompt", installer); };
  });
</script>

<Toaster theme="dark" position="bottom-center" />
<header class="app-header" class:has-selection={!!selectedId}><strong>{m.product()}</strong><span class="session-count">{m.session_count({ count: roots.length })}</span>
  <HostFilter {hosts} value={hostFilter} onselect={selectHost} onmanage={() => show("hosts")} />
  <div class="header-actions"><Weekly hostId={snapshot.entryId} connected={!!hosts.find(h=>h.id===snapshot.entryId)?.connected} /><Button variant="ghost" size="icon-sm" aria-label={m.settings()} onclick={() => show("settings")}><SettingsIcon /></Button></div>
</header>
<main class:with-detail={!!selectedId}>
  <SessionList bind:this={sessionList} agents={visibleAgents} rootOrder={treeOrder[hostFilter] ?? []} onreorder={ids => treeOrder = { ...treeOrder, [hostFilter]: ids }} {hosts} {selectedId} {loading} {connected} {closingId} closeError={selectedId === closeError?.id ? null : closeError} onclosetree={closeTree} onopen={open} onnew={() => show("new")} />
  {#if !selectedId}<div class="detail-empty"><p>{m.select_conversation()}</p></div>{:else if !shownDetail}<div class="detail-empty" role="status"><p>{m.loading()}</p><Button variant="ghost" size="sm" onclick={closeDetail}>{m.back_sessions()}</Button></div>{/if}
  {#if !connected && !loading}<div class="connection-banner" role="status"><strong>{m.reconnecting()}</strong><span>{m.offline_help()}</span><Button variant="ghost" size="sm" onclick={load}>{m.retry()}</Button></div>{/if}
  {#if error && !modal && !shownDetail}<div class="app-error" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => error = ""}><X /></Button></div>{/if}
  {#if shownDetail && selectedId}{#key selectedId}<AgentDetail detail={shownDetail!} ready={!!detail} tree={shownDetail!.role === "orc" ? target : owner} {owner} {skills} {now} connected={hostConnected} mediaConnected={connected && hostConnected} entryId={snapshot.entryId} entryConnected={!!hosts.find(h=>h.id===snapshot.entryId)?.connected} onstop={stop} onupdate={result => { if (selectedId === result.id) detail = result; snapshot = { ...snapshot, agents: snapshot.agents.map(a => a.id === result.id ? { ...a, model: result.model, effort: result.effort, serviceTier: result.serviceTier } : a) }; }} onrename={rename} onrefresh={load} actionError={error} closeError={closeError?.id === shownDetail.id ? closeError.reason : undefined} lastSeen={selectedHost?.lastSeen} workers={snapshot.agents.filter(w => w.ownerId === detail?.id)} onclose={closeDetail} onopen={id => open(id, true)} onsend={send} onanswer={answerBatch} onretry={retryDelivery} />{/key}{/if}
</main>

<Dialog.Root open={modalOpen} onOpenChange={value => { if (!value && modal) void closeModal(); }}>
  <Dialog.Content showCloseButton={false} class={`grove-dialog ${modal === "new" ? "new-modal" : modal === "settings" ? "settings-modal" : ""}`} onOpenAutoFocus={e => { e.preventDefault(); if (modal === "new") projectSearch?.focus(); }} onCloseAutoFocus={e => { e.preventDefault(); if (hostsReturnFocus?.isConnected) hostsReturnFocus.focus(); hostsReturnFocus = null; }}><Button class="modal-close" variant="ghost" size="icon-sm" aria-label={m.close()} onclick={closeModal}><X /></Button>
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
      <p class="settings-scope">{m.settings_scope()}</p><div class="modal-action">{#if install}<button class="install-link" onclick={() => install?.prompt()}>{m.install_app()}</button>{/if}<Button variant="default" size="sm" disabled={!settings || saving} onclick={saveSettings}>{saving ? m.sending() : m.save_changes()}</Button></div>
    {:else if modal === "hosts"}
      <Dialog.Title>{m.hosts()}</Dialog.Title><Hosts {hosts} sessionCount={roots.length} onadopt={value => adopt(value, true)} />
    {:else if modal === "keys"}
      <Dialog.Title>{m.shortcuts()}</Dialog.Title><p class="modal-help">{m.keyboard_help()}</p><dl class="shortcut-list">{#each [["↑ ↓ ← →", m.key_focus()], ["Option + J / K", m.key_session_loop()], ["Option/Alt + H / L", m.key_host_loop()], ["⌘ 1–9", m.key_visible_session()], ["Enter", m.key_open()], ["E", m.key_expand()], ["N", m.key_new()], ["I", m.key_input()], ["Option/Alt + S", m.search_skills()], ["Option/Alt + X", m.close_tree()], ["Esc", m.key_escape()], ["Tab", m.key_completion()], ["Enter", m.key_send()], ["Shift + Enter", m.key_newline()]] as [key, label]}<div><dt><Kbd>{key}</Kbd></dt><dd>{label}</dd></div>{/each}</dl><p class="keyboard-scope">{m.keyboard_scope()}</p>
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  </Dialog.Content>
</Dialog.Root>
