<script lang="ts">
  import { Toaster } from "$lib/components/ui/sonner/index.js";
  import { toast } from "svelte-sonner";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import * as Command from "$lib/components/ui/command/index.js";
  import { Switch } from "$lib/components/ui/switch/index.js";
  import { Kbd } from "$lib/components/ui/kbd/index.js";
  import { X, Plus, History, Settings as SettingsIcon } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { navigation, initializeNavigation, resumeFilePreview, openConversation, setSurface, back, validateNavigation } from "./navigation.svelte";
  import { readingCache, reading } from "./api";
  import { retainReading } from "./reading-cache";
  import { retainTranscriptPositions } from "./transcript-state";
  import { LocalConnection, preferences } from "./connection";
  import { onMount, tick, untrack } from "svelte";
  import * as Select from "$lib/components/ui/select/index.js";
  import { projectReference } from "./project-identity";
  import type { ProjectEnvironment } from "./contracts";
  import type { Answer, Agent, Detail, HistorySession, Model, Project, Settings, Skill, Snapshot } from "./contracts";
  import { api, editable, setClient } from "./api";
  import { RequestRejected } from "./chord-client";
  import { lookupSchema, abandonCloseSchema, type Receipt } from "./chord-contract";
  import { addOutgoing, observeOutgoing, outgoing, withOutgoing, acceptReceipt, unknownOutgoing, submissionResult, beginRetry, observeSendResult } from "./outgoing.svelte";
  import { imageSchema } from "./chord-contract";
  import { loadImages, operationKey, type ImageDraft } from "./image-drafts";
  import { receiptAlreadyAccepted, setOutgoingImages, clearClosedPending, closeRecovery, rememberCloseRecovery, forgetCloseRecovery } from "./outgoing.svelte";
  import { observeQuestions, questionPanels, setQuestionPanel } from "./question-state.svelte";
  import ModelFields from "./ModelFields.svelte";
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
  let client: LocalConnection | undefined;
  let composing = false;
  let snapshot = $state<Snapshot>({ agents: [], settings: null, revision: 0 });
  const savedSelection = preferences.selection;
  let treeOrder = $state(preferences.treeOrder);
  $effect(() => { preferences.treeOrder = $state.snapshot(treeOrder); });
  let remembered = $state<Record<string, string>>(savedSelection.sessions);
  let selectedId = $state<string | null>(savedSelection.sessions[savedSelection.host] ?? null);
  let navigationReady = $state(false); let connectionReady = $state(false);
  let detail = $state<Detail | null>(null); let skills = $state<Skill[]>([]);
  let projects = $state<Project[]>([]); let projectsLoading = $state(true); let models = $state<Model[]>(preferences.models);
  let connected = $state(false); let loading = $state(true); let error = $state("");
  let now = $state(Date.now()); let sessionList: { visibleIds(): string[]; keydown(event: KeyboardEvent): Promise<void>; expandFocused(): void; reveal(id: string): Promise<void>; closeTarget(): string | null; navigate(offset: number, index?: number): Promise<string | null> };
  let projectSearch = $state<HTMLInputElement | null>(null); let modalOpen = $state(false); let modal = $state<"new" | "settings" | "keys" | "abandon-close" | null>(null);
  let search = $state(""); let projectId = $state(""); let projectHighlight=$state(""); let projectError=$state(""); let saving = $state(false);
  const projectListId=$props.id();
  let modelRefreshBusy = $state(false); let modalModelsLoading=$state(false); let modalModelSequence=0;
  let settings = $state<Settings | null>(null); let sequence = 0; let focusCreatedId = $state<string | null>(null);
  let install = $state<(Event & { prompt: () => Promise<void> }) | null>(null);
  let instanceId = $state(savedSelection.host);
  let desktop = $state(matchMedia("(min-width: 701px)").matches);
  let previousVisible: string[] = [];
  let lostSelection: string | null = null;
  $effect(() => {
    const ids = visibleAgents.map(a => a.id);
    const current = navigation.details.at(-1);
    if (!navigationReady || navigation.surfaces.length) return;
    if (connectionReady && instanceId !== (snapshot.entryId ?? "")) {
      instanceId = snapshot.entryId ?? "";
      return;
    }
    const host = hosts.find(h => h.id === instanceId);
    if (host?.connected && remembered[instanceId] && !ids.includes(remembered[instanceId])) {
      const next = { ...remembered }; delete next[instanceId]; remembered = next;
    }
    if (host?.connected && !loading && (desktop || lostSelection) && (!current || !ids.includes(current))) {
      const position = previousVisible.indexOf(current ?? lostSelection ?? "");
      const adjacent = previousVisible.slice(position + 1).find(id => ids.includes(id)) ?? previousVisible.slice(0, Math.max(0, position)).reverse().find(id => ids.includes(id));
      const next = remembered[instanceId] ?? adjacent ?? visibleAgents.find(a => a.role === "orc")?.id ?? null;
      void openConversation(next);
    }
    previousVisible = sessionList?.visibleIds() ?? visibleAgents.filter(a => a.role === "orc").map(a => a.id);
    lostSelection = null;
  });
  const createHost = $derived(snapshot.entryId ?? ""); let catalogSequence = 0;
  const target = $derived(snapshot.agents.find(a => a.id === selectedId));
  // Snapshot identity is display-only; detail remains the write authority.
  const shownDetail = $derived(detail ? withOutgoing(detail) : target ? { ...target, messages: [], deliveries: [] } : null);
  const hosts = $derived(snapshot.hosts ?? []);
  const selectedHost = $derived(hosts.find(h => h.id === shownDetail?.hostId));
  const hostConnected = $derived(!!selectedHost?.connected);
  const visibleAgents = $derived(snapshot.agents.map(a => optimistic(a.id) && a.state !== "working" && a.state !== "stopping" ? {...a,state:"working" as const} : a));
  $effect(() => { if (navigationReady) preferences.selection = { host: instanceId, sessions: $state.snapshot(remembered) }; });
  let environments = $state<ProjectEnvironment[]>([]);
  let selectedEnvironment = $state("local");
  async function loadEnvironments() { try { environments = await api<ProjectEnvironment[]>("/environments"); } catch(e) { error = e instanceof Error ? e.message : m.load_failure(); } }
  const remotePi = $derived(selectedEnvironment !== "local" && !!settings && [settings.orc,settings.worker].some(s=>s.backend === "pi"));
  async function loadProjects() {
    projectId = ""; projectError=""; projectsLoading=true; const seq = ++catalogSequence;
    const [live,saved] = await Promise.allSettled([api<Project[]>(`/projects?environment=${encodeURIComponent(selectedEnvironment)}`),api<Project[]>("/history/projects")]);
    if(seq !== catalogSequence) return;
    projects = [...(live.status==="fulfilled" ? live.value : []),...(saved.status==="fulfilled" ? saved.value.filter(p=>(p.environment?.id ?? "local")===selectedEnvironment) : [])];
    projectError = [live,saved].flatMap(result=>result.status==="rejected" ? [result.reason instanceof Error ? result.reason.message : m.load_failure()] : []).join(" ");
    projectId = projects[0] ? projectReference(projects[0]) : ""; projectsLoading=false;
  }
  const roots = $derived(snapshot.agents.filter(a => a.role === "orc"));
  const settingsValid = $derived(!!settings && [settings.orc, settings.worker].every(role => models.some(model => model.id === role.model && (model.backend ?? "codex") === (role.backend ?? "codex") && model.provider === role.provider && model.efforts.includes(role.effort))));
  const fastAvailable = $derived(!!settings && [settings.orc, settings.worker].some(role => models.find(model => model.id === role.model && (model.backend ?? "codex") === (role.backend ?? "codex") && model.provider === role.provider)?.fastTier));
  const owner = $derived(snapshot.agents.find(a => a.id === shownDetail?.ownerId));
  const filteredProjects = $derived(projectsLoading ? [] : projects.filter(p => `${p.alias} ${p.name}`.toLowerCase().includes(search.toLowerCase())));

  $effect(() => { if (modal === "new" && !filteredProjects.some(p => projectReference(p) === projectId)) projectId = filteredProjects[0] ? projectReference(filteredProjects[0]) : ""; });
  $effect(()=>{projectHighlight=projectId;});
  $effect(()=>{const input=projectSearch;if(input)untrack(()=>{if(modal==="new"&&!navigation.surfaces.includes("history"))input.focus({preventScroll:true});});});
  function closeDetail() { if (navigation.surfaces.length || !desktop) void back(); else if (selectedId && questionPanels[selectedId]) setQuestionPanel(selectedId, false); }
  $effect(() => {
    if (!navigationReady) return;
    const id = navigation.details.at(-1) ?? null;
    if (id !== selectedId) { ++sequence; selectedId = id; detail = null; skills = []; error = ""; if (id) void restoreDetail(id); else { void client?.call("select", {ids:[]}).catch(() => {}); } }
  });
  $effect(() => {
    const kind = navigation.surfaces.find(s => s === "new" || s === "settings" || s === "keys" || s === "abandon-close") ?? null;
    if (kind !== modal) { modal = kind; modalOpen = !!kind; if (kind) void prepareModal(kind); }
  });
  async function refreshDetail(id: string) {
    const seq = ++sequence;
    try {
      const result = await api<Detail>(`/agents/${id}`);
      if (selectedId === id && seq === sequence) { observeOutgoing(result); detail = retainReading(detail, result); readingCache.saveDetail(detail); }
    } catch (e) { if (selectedId === id && seq === sequence && connected) error = e instanceof Error ? e.message : m.load_failure(); }
  }
  function open(id: string, fromDetail = false) { openConversation(id, fromDetail, snapshot.agents.find(a => a.id === id)?.ownerId); }
  async function restoreDetail(id: string) {
    error = ""; selectedId = id;
    const host = id.split(":")[0];
    if (host !== (snapshot.entryId ?? instanceId)) { detail = null; return; }
    observeQuestions(snapshot.agents,id,true);
    remembered = { ...remembered, [host]: id };
    if (detail?.id !== id) detail = readingCache.readDetail(id); skills = [];
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
    // Retain local read-only state until the instance supplies an authoritative snapshot.
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
    snapshot = value;
    if (authoritative) for (const host of value.hosts ?? []) {
      if (!host.connected) continue;
      const active = new Set(value.agents.filter(a => a.hostId === host.id).map(a => a.id));
      readingCache.prunePeer(host.id, active);
      retainTranscriptPositions(host.id, active);
    }
    readingCache.saveSnapshot(value);
    historyCache.retain(new Set(value.agents.map(a => a.id)));
    const valid = new Set(value.agents.map(a => a.id));
    for (const id of [...navigation.details, ...Object.values(remembered)]) {
      if (id.startsWith(value.entryId + ":") && (!connectionReady || value.hosts?.some(h => !h.connected))) valid.add(id);
    }
    validateNavigation(valid);

  }
  async function load() {
    loading = true; error = "";
    if(!hosts.find(h=>h.id===snapshot.entryId)?.connected){if(selectedId)await restoreDetail(selectedId);loading=false;projectsLoading=false;return;}
    try {
      const [state, , catalog] = await Promise.all([api<Snapshot>("/snapshot"), Promise.all([loadEnvironments(),loadProjects()]), api<Model[]>("/models")]);
      models = catalog;preferences.models=catalog; if(!preferences.settings&&catalog.length){const model=catalog.find(m=>m.isDefault)??catalog[0];preferences.settings={fast:false,orc:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort},worker:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort}};snapshot={...snapshot,settings:preferences.settings};} if(!connected) adopt(state, true);
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
  function show(kind: "new" | "settings" | "keys") { setSurface(kind, true); }
  async function prepareModal(kind: "new" | "settings" | "keys" | "abandon-close") {
    error = "";
    if (kind === "abandon-close" && !abandon) {
      const intent = closeRecovery.entries.find(i => i.agentId === selectedId);
      if (!intent) { await closeModal(); return; }
      abandon = { id: intent.agentId, title: snapshot.agents.find(a => a.id === intent.agentId)?.title ?? "Orc", unknownOperationIds: intent.unknownOperationIds };
      closeUnknown = true;
    }
    if (kind === "new") { search = ""; void loadProjects(); }
    if (kind === "settings" || kind === "new") {
      const saved=preferences.settings;
      const fallback=models.find(m=>m.isDefault) ?? models[0];
      settings=saved ? structuredClone(saved) : fallback ? {fast:false,orc:{backend:fallback.backend ?? "codex",provider:fallback.provider,model:fallback.id,effort:fallback.defaultEffort},worker:{backend:fallback.backend ?? "codex",provider:fallback.provider,model:fallback.id,effort:fallback.defaultEffort}} : null;
      const request=++modalModelSequence; modalModelsLoading=true;
      try{const result=await api<Model[]>("/models");if(request!==modalModelSequence)return;models=result;preferences.models=models;}catch(e){if(request!==modalModelSequence)return;if(!models.length)error=e instanceof Error?e.message:m.load_failure();}finally{if(request===modalModelSequence)modalModelsLoading=false;}
      // Catalogue refresh must not replace a foreground settings draft.
      const model = models.find(m => m.isDefault) ?? models[0];
      if(!settings && (modal==='settings' || modal==='new') && model)settings={fast:false,orc:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort},worker:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort}};
    }
    if (kind === "settings" && settings) { settings.fast = !!settings.fast; }

  }
  async function closeModal() { const kind = modal; while (kind && navigation.surfaces.includes(kind)) await back(); }
  async function resumeHistory(session: HistorySession, project: string) {
    const agent = await api<Agent>("/history/resume", { project, threadId: session.threadId, archived: session.archived, settings: await creationSettings() });
    adopt(await api<Snapshot>("/snapshot"));
    focusCreatedId = agent.id;
    await openConversation(agent.id);
    await sessionList?.reveal(agent.id);
    toast.success(m.session_resumed(), { duration: 3000 });
  }
  $effect(() => { if (detail?.id === focusCreatedId && focusCreatedId) { focusCreatedId = null; void tick().then(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus()); } });
  async function creationSettings():Promise<Settings> {
    if (modal === "new" && settings) { preferences.settings = $state.snapshot(settings); return preferences.settings!; }
    if(preferences.settings)return preferences.settings;
    const catalog=await api<Model[]>("/models");
    const model=catalog.find(m=>m.isDefault)??catalog[0];
    if(!model)throw new Error("No models available");
    const initial:Settings={fast:false,orc:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort},worker:{backend:model.backend ?? "codex",provider:model.provider,model:model.id,effort:model.defaultEffort}};
    preferences.settings=initial;return initial;
  }
  async function create() {
    if (!projectId || saving || !connected) return; saving = true;
    try { const agent = await api<Agent>("/agents", { project: projectReference(projects.find(p=>projectReference(p)===projectId)!), settings: await creationSettings() }); await closeModal(); adopt(await api<Snapshot>("/snapshot")); focusCreatedId = agent.id; open(agent.id); await sessionList?.reveal(agent.id); }
    catch (e) { error = e instanceof Error ? e.message : m.load_failure(); }
    finally { saving = false; }
  }
  async function refreshModels() {
    if (modelRefreshBusy) return;
    const request=++modalModelSequence; modelRefreshBusy = true; error = "";
    try { const result=await api<Model[]>("/models"); if(request===modalModelSequence){models=result;preferences.models=models;} }
    catch (e) { if(request===modalModelSequence)error = e instanceof Error ? e.message : m.load_failure(); }
    finally { modelRefreshBusy = false; if(request===modalModelSequence)modalModelsLoading=false; }
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
    const attempt=outgoing.entries.find(o=>o.agentId===agentId && o.id===operationId)?.attemptId;
    try {
      const receipt = lookupSchema.parse(await client.call<Receipt | null>('lookup',{id:agentId,operationId}));
      if (receipt && receipt.operationId !== operationId) throw new Error("Receipt operation identity changed");
      acceptReceipt(agentId, receipt);
    }
    catch(e) { if(outgoing.entries.find(o=>o.agentId===agentId && o.id===operationId)?.attemptId===attempt) unknownOutgoing(agentId,operationId,e instanceof Error?e.message:m.load_failure()); }
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
  let dispatches = $state<{key:string; token:string; admitting:boolean}[]>([]);
  let retryErrors = $state<Record<string,string>>({});
  const dispatchKey = (id:string, operation:string) => id + "/" + operation;
  const dispatchActive = (dispatch: typeof dispatches[number]) => {
    const local = outgoing.entries.find(o => dispatchKey(o.agentId,o.id) === dispatch.key);
    return !dispatch.admitting || local?.status === "pending";
  };
  const optimistic = (id:string) => dispatches.some(d => d.key.startsWith(id + "/") && dispatchActive(d)) && !!hosts.find(h => h.id === id.split(":")[0])?.connected;
  async function retryUser(id:string, operationId:string, older?:import("./contracts").Delivery) {
    const key = dispatchKey(id,operationId);
    if (!client || dispatches.some(d=>d.key===key && dispatchActive(d)) || receiptAlreadyAccepted(id,operationId)) return;
    const d = (detail?.id === id ? withOutgoing(detail).deliveries.find(d => d.id === operationId) : undefined) ?? older;
    if (!d || d.source !== "user" || submissionResult(d) !== "rejected") return;
    const token=crypto.randomUUID();
    dispatches = [...dispatches,{key,token,admitting:false}];
    retryErrors = {...retryErrors,[key]:""};
    try {
      let original = outgoing.entries.find(o => o.agentId === id && o.id === operationId);
      if (!original) {
        const envelope = d.recoveryRef ? await reading<import("./contracts").Delivery>(`/recovery?${new URLSearchParams({agent:id,operation:operationId})}`, id) : d;
        if (receiptAlreadyAccepted(id,operationId)) return;
        addOutgoing(id,envelope.text,operationId,undefined,envelope.images);
        original = outgoing.entries.find(o => o.agentId === id && o.id === operationId)!;
        original.attemptId = envelope.attemptId;
        acceptReceipt(id,{operationId, attemptId:envelope.attemptId, state:"rejected", turnId:null, error:envelope.error ?? null});
      }
      let images:ImageDraft[] = [];
      if (original.localImageIds?.length && !original.images?.length) {
        const stored = await loadImages(operationKey(id,operationId));
        images = stored?.images ?? [];
        if (images.length !== original.localImageIds.length || images.some((image,i) => image.id !== original!.localImageIds![i])) throw new Error("Original images are unavailable on this device. Reconnect to the original device and retry.");
      }
      await dispatch(id,original.text,operationId,images,{after:original.attemptId ?? operationId,attempt:token});
    } catch(e) {
      retryErrors = {...retryErrors,[key]:(e as Error).message};
      const original = outgoing.entries.find(o => o.agentId === id && o.id === operationId);
      acceptReceipt(id,{operationId,attemptId:original?.attemptId,state:"rejected",turnId:null,error:(e as Error).message});
    } finally { dispatches = dispatches.filter(d => d.token !== token); }
  }
  async function send(id: string, text: string, operationId: string, images: ImageDraft[] = []) {
    if (detail?.id !== id) return false;
    addOutgoing(id,text,operationId,undefined,undefined,images.map(i=>i.id));
    const key=dispatchKey(id,operationId);
    dispatches=[...dispatches,{key,token:operationId,admitting:false}];
    try { await dispatch(id,text,operationId,images); }
    finally { dispatches=dispatches.filter(d=>d.token!==operationId); }
    return true;
  }
  async function dispatch(id:string,text:string,operationId:string,images:ImageDraft[],retry?:import("./chord-contract").RetrySend) {
    const connection = client;
    let submitted=false, attemptId=outgoing.entries.find(o=>o.agentId===id && o.id===operationId)?.attemptId;
    const previousAttempt=attemptId;
    try {
      if (!connection || !hosts.find(h=>h.id===id.split(":")[0])?.connected) throw new RequestRejected("Execution host disconnected before submission");
      let refs=outgoing.entries.find(o=>o.agentId===id && o.id===operationId)?.images;
      if(images.length && !refs?.length){
        const form=new FormData();form.set('text',JSON.stringify(text));for(const image of images)form.append('images',image.file,image.file.name);
        const response=await connection.media(id,`/api/images?agent=${encodeURIComponent(id)}&operation=${encodeURIComponent(operationId)}`,{method:'POST',body:form});
        const upload=await response.json();
        if(upload.agent!==id || upload.operation!==operationId)throw new Error(upload.error ?? "Image operation identity changed");
        refs=upload.images.map((i:unknown)=>imageSchema.parse(i));setOutgoingImages(id,operationId,refs!);
      }
      if (receiptAlreadyAccepted(id,operationId)) return;
      if(retry){beginRetry(id,operationId,retry.attempt);attemptId=retry.attempt;}
      submitted=true;
      const active=dispatches.find(d=>d.token===(retry?.attempt ?? operationId));if(active)active.admitting=true;
      const result=await connection.call<import("./chord-contract").SendResult>('send',{id,text,operationId,...(refs ? {images:refs} : {}),...(retry ? {retry} : {})});
      observeSendResult(result,operationId,retry?.attempt);
      if(outgoing.entries.find(o=>o.agentId===id && o.id===operationId)?.attemptId===attemptId && !result.deliveries.some(d=>d.id===operationId))unknownOutgoing(id,operationId,"");
    }catch(e){
      const current=outgoing.entries.find(o=>o.agentId===id && o.id===operationId);
      if(current?.attemptId!==attemptId)return;
      if((!submitted || e instanceof RequestRejected) && !receiptAlreadyAccepted(id,operationId)){
        // An RPC rejection did not enter the owning queue. Keep the predecessor
        // token so the next explicit retry can still replace that rejection.
        const o=outgoing.entries.find(o=>o.agentId===id && o.id===operationId);
        if(o && retry && e instanceof RequestRejected){o.attemptId=previousAttempt;attemptId=previousAttempt;}
        acceptReceipt(id,{operationId,attemptId,state:"rejected",turnId:null,error:e instanceof Error?e.message:m.load_failure()});
      }else unknownOutgoing(id,operationId,e instanceof Error?e.message:m.load_failure());
    }
    if(submitted)void lookup(id,operationId);
  }
  let closingId = $state<string | null>(null);
  let closeError = $state<{ id: string; reason: string } | null>(null);
  let abandon = $state<{ id: string; title: string; unknownOperationIds: string[] } | null>(null);
  let closeUnknown = $state(false);
  let abandonError = $state("");
  let closeRecoveryErrors = $state<Record<string, string>>({});
  let checkingCloses = $state<string[]>([]);
  async function checkPendingClose(id: string, showConfirmation = false) {
    if (closingId === id || checkingCloses.includes(id) || !hosts.some(h => id.startsWith(h.id + ":") && h.connected)) return;
    checkingCloses = [...checkingCloses, id];
    const visit = selectedId; const device = instanceId; const generation = sequence;
    try {
      const state = await readAbandon(id);
      if (state.closed) await finishAbandon(id);
      else if (showConfirmation && selectedId === visit && instanceId === device && sequence === generation && !navigation.surfaces.length) {
        abandon = { id, title: snapshot.agents.find(a => a.id === id)?.title ?? "Orc", unknownOperationIds: state.unknownOperationIds };
        closeUnknown = false; abandonError = ""; setSurface("abandon-close", true);
      }
    } catch(e) { closeRecoveryErrors = { ...closeRecoveryErrors, [id]: e instanceof Error ? e.message : m.load_failure() }; }
    finally { checkingCloses = checkingCloses.filter(target => target !== id); }
  }
  async function readAbandon(id: string) {
    return abandonCloseSchema.parse(await api(`/agents/${id}/abandon-close-candidate`, {}));
  }
  async function finishAbandon(id: string) {
    clearClosedPending(id);
    forgetCloseRecovery(id);
    const errors = { ...closeRecoveryErrors }; delete errors[id]; closeRecoveryErrors = errors;
    if (modal === "abandon-close" && abandon?.id === id) await closeModal();
    if (abandon?.id === id) { abandon = null; closeUnknown = false; abandonError = ""; }
    if (closeError?.id === id) closeError = null;
    toast.success(m.tree_closed(), { duration: 3000 });
    adopt(await api<Snapshot>("/snapshot"), true);
  }
  async function confirmAbandon() {
    if (!abandon || closingId) return;
    const target = $state.snapshot(abandon);
    closingId = target.id; abandonError = "";
    try {
      if (closeUnknown) {
        const state = await readAbandon(target.id);
        if (state.closed) await finishAbandon(target.id);
        else { abandon = { ...target, unknownOperationIds: state.unknownOperationIds }; closeUnknown = false; }
        return;
      }
      // Remember an unknown close until a read confirms its result; never blindly replay.
      rememberCloseRecovery(target.id, target.unknownOperationIds);
      closeUnknown = true;
      await api(`/agents/${target.id}/close`, { abandonUnknownOperationIds: target.unknownOperationIds });
      await finishAbandon(target.id);
    } catch(e) {
      abandonError = e instanceof Error ? e.message : m.load_failure();
      try {
        const state = await readAbandon(target.id);
        if (state.closed) await finishAbandon(target.id);
        else if (e instanceof RequestRejected) {
          abandon = { ...target, unknownOperationIds: state.unknownOperationIds }; closeUnknown = false;
        }
      } catch(readError) {
        closeRecoveryErrors = { ...closeRecoveryErrors, [target.id]: readError instanceof Error ? readError.message : abandonError };
      }
    } finally { closingId = null; }
  }
  async function closeTree(id: string) {
    if (closingId) return;
    closeError = null;
    if (!connected || hosts.find(h => h.id === snapshot.agents.find(a => a.id === id)?.hostId)?.connected === false) { closeError = { id, reason: m.host_offline() }; return; }
    closingId = id;
    const visit = selectedId; const device = instanceId; const generation = sequence;
    try {
      await api(`/agents/${id}/close`, {});
      toast.success(m.tree_closed(), { duration: 3000 });
      adopt(await api<Snapshot>("/snapshot"));
    } catch(e) {
      closeError = { id, reason: e instanceof Error ? e.message : m.load_failure() };
      try {
        const state = await readAbandon(id);
        if (!state.closed && selectedId === visit && instanceId === device && sequence === generation && !navigation.surfaces.length) {
          abandon = { id, title: snapshot.agents.find(a => a.id === id)?.title ?? "Orc", unknownOperationIds: state.unknownOperationIds };
          closeUnknown = false; abandonError = ""; setSurface("abandon-close", true);
        }
      } catch { /* Ordinary close errors retain their existing inline feedback. */ }
    }
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
  async function answerBatch(answers: Answer[], operationId: string, preparedText?: string) {
    if (!selectedId || !hostConnected || !client || !detail) return;
    const id = selectedId;
    const text = preparedText ?? outgoing.entries.find(o => o.agentId === id && o.id === operationId)?.text ?? answers.map(answer => `Question: ${detail!.questions.find(q => q.id === answer.questionId)?.text}\nAnswer: ${answer.answer}`).join("\n\n");
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
    if (event.target instanceof HTMLElement && event.target.closest(".question-panel, .pending-entry, .question-record-entry")) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(event.key)) { void sessionList?.keydown(event); return; }
    if (event.key.toLowerCase() === "n") { event.preventDefault(); void show("new"); }
    else if (event.key.toLowerCase() === "e") { event.preventDefault(); sessionList?.expandFocused(); }
    else if (event.key === "?") { event.preventDefault(); void show("keys"); }
  }
  onMount(() => {
    const cached = readingCache.readSnapshot(); if (cached) snapshot={...cached,agents:cached.agents.filter(a=>a.hostId===cached.entryId),hosts:cached.hosts?.filter(h=>h.id===cached.entryId).map(h=>({...h,connected:false}))};
    if (selectedId && selectedId.startsWith((snapshot.entryId ?? "") + ":")) detail = readingCache.readDetail(selectedId);
    const cleanupNavigation = initializeNavigation(selectedId);
    navigationReady = true;
    const initialId = navigation.details.at(-1);
    if (initialId) { instanceId = initialId.split(":")[0]; remembered = { ...remembered, [instanceId]: initialId }; }
    const media = matchMedia("(min-width: 701px)");
    const resize = () => desktop = media.matches;
    media.addEventListener("change", resize);
    let disposed=false;
    client=new LocalConnection(value=>{
      if(disposed)return;
      const before=snapshot;
      const entryWasConnected=before.hosts?.find(h=>h.id===value.snapshot.entryId)?.connected;
      connected=value.snapshot.hosts?.some(h=>h.connected)??false;
      notifications(before,value.snapshot);
      adopt(value.snapshot,true);const entry=value.snapshot.hosts?.find(h=>h.id===value.snapshot.entryId);loading=!!entry&&!entry.connected&&!entry.error;
      const incoming=selectedId&&value.details[selectedId];
      if(incoming && value.snapshot.agents.some(a=>a.id===incoming.id)){observeOutgoing(incoming);detail=retainReading(detail?.messages.length ? detail : readingCache.readDetail(incoming.id),incoming);readingCache.saveDetail(detail);}
      void reconcilePending();
      for (const intent of closeRecovery.entries) {
        const peer = intent.agentId.split(":")[0];
        if (!before.hosts?.some(h => h.id === peer && h.connected) && value.snapshot.hosts?.some(h => h.id === peer && h.connected)) void checkPendingClose(intent.agentId);
      }
      if(selectedId){const id=selectedId.split(":")[0];if(!before.hosts?.find(h=>h.id===id)?.connected&&value.snapshot.hosts?.find(h=>h.id===id)?.connected)void restoreDetail(selectedId);}
      if(!entryWasConnected&&value.snapshot.hosts?.find(h=>h.id===value.snapshot.entryId)?.connected){
        void load();
        if(modal==="new")void loadProjects();
      }
    },id=>{
      for(const pending of outgoing.entries)if(pending.agentId.startsWith(id+":")&&pending.status==='pending')unknownOutgoing(pending.agentId,pending.id,m.sending());
    });
    setClient(client);
    void client.start().then(()=>{connectionReady=true;return load();}).catch(e=>{loading=false;projectsLoading=false;error=e.message;});
    const compositionStart = () => composing = true;
    const compositionEnd = () => composing = false;
    window.addEventListener("compositionstart", compositionStart);
    window.addEventListener("compositionend", compositionEnd);
    const timer = setInterval(() => now = Date.now(), 1000);
    const permission = () => { if ("Notification" in window && Notification.permission === "default") void Notification.requestPermission().catch(() => {}); };
    const completionTab = (e: KeyboardEvent) => { if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLElement && e.target.closest(".question-panel, .history-controls, [data-choice-layer], [data-slot=select-content], [data-slot=select-trigger], [data-choice-trigger]"))) e.preventDefault(); };
    window.addEventListener("keydown", completionTab, true);
    const installer = (e: Event) => { e.preventDefault(); install = e as Event & { prompt: () => Promise<void> }; };
    window.addEventListener("pointerdown", permission, { once: true }); window.addEventListener("keydown", permission, { once: true }); window.addEventListener("keydown", keydown); window.addEventListener("beforeinstallprompt", installer);
    return () => { window.removeEventListener("compositionstart", compositionStart); window.removeEventListener("compositionend", compositionEnd); media.removeEventListener("change", resize); cleanupNavigation(); window.removeEventListener("keydown", completionTab, true); disposed = true; client?.close(); setClient(undefined); clearInterval(timer);window.removeEventListener("pointerdown", permission); window.removeEventListener("keydown", permission); window.removeEventListener("keydown", keydown); window.removeEventListener("beforeinstallprompt", installer); };
  });
</script>

<Toaster theme="dark" position="bottom-center" />
<header class="app-header" class:has-selection={!!selectedId}><strong>{m.product()}</strong><span class="session-count">{m.session_count({ count: roots.length })}</span>

  <div class="header-actions">{#if !loading && detail?.backend !== "pi" && (!snapshot.agents.length || snapshot.agents.some(agent => agent.backend !== "pi"))}<Weekly hostId={snapshot.entryId} connected={!!hosts.find(h=>h.id===snapshot.entryId)?.connected} />{/if}<Button variant="ghost" size="icon-sm" aria-label={m.settings()} onclick={() => show("settings")}><SettingsIcon /></Button></div>
</header>
<div class:close-recovery-layout={closeRecovery.entries.some(i => modal !== "abandon-close" || abandon?.id !== i.agentId)}>
<main class:with-detail={!!selectedId}>
  <SessionList bind:this={sessionList} agents={visibleAgents} {projects} {projectsLoading} {instanceId} rootOrder={treeOrder[instanceId] ?? []} onreorder={ids => treeOrder = { ...treeOrder, [instanceId]: ids }} {hosts} {selectedId} {loading} {connected} {closingId} closeError={selectedId === closeError?.id ? null : closeError} onclosetree={closeTree} onopen={open} onnew={() => show("new")}>
    {#if !connected && !loading}<div class="connection-banner" role="status"><strong>{m.reconnecting()}</strong><span>{m.offline_help()}</span><Button variant="ghost" size="sm" onclick={load}>{m.retry()}</Button></div>{/if}
  </SessionList>
  {#if !selectedId}<div class="detail-empty"><p>{m.select_conversation()}</p></div>{:else if !shownDetail}<div class="detail-empty" role="status"><p>{m.loading()}</p><Button variant="ghost" size="sm" onclick={closeDetail}>{m.back_sessions()}</Button></div>{/if}
  {#if error && !modal && !shownDetail}<div class="app-error" role="alert"><span>{error}</span><Button variant="ghost" size="icon-sm" aria-label={m.close()} onclick={() => error = ""}><X /></Button></div>{/if}
  {#if shownDetail && selectedId}{#key selectedId}<AgentDetail detail={shownDetail!} ready={!!detail} tree={shownDetail!.role === "orc" ? target : owner} {owner} {skills} {now} connected={hostConnected} mediaConnected={connected && hostConnected} entryId={snapshot.entryId} entryConnected={!!hosts.find(h=>h.id===snapshot.entryId)?.connected} onstop={stop} onupdate={result => { if (selectedId === result.id) detail = result; snapshot = { ...snapshot, agents: snapshot.agents.map(a => a.id === result.id ? { ...a, model: result.model, effort: result.effort, serviceTier: result.serviceTier } : a) }; }} onrename={rename} onrefresh={load} onretryuser={retryUser} {retryErrors} dispatching={dispatches.filter(d=>d.key.startsWith(selectedId + "/") && dispatchActive(d)).map(d=>d.key.slice(selectedId!.length+1))} optimisticWorking={optimistic(selectedId)} actionError={error} closeError={closeError?.id === shownDetail.id ? closeError.reason : undefined} lastSeen={selectedHost?.lastSeen} workers={snapshot.agents.filter(w => w.ownerId === detail?.id)} onclose={closeDetail} onopen={id => open(id, true)} onsend={send} onanswer={answerBatch} onretry={retryDelivery} />{/key}{/if}
</main>

{#if closeRecovery.entries.some(i => modal !== "abandon-close" || abandon?.id !== i.agentId)}
  <div class="close-recovery flex-col items-start" role="status" aria-label={m.abandon_close_recovery()}>
    {#each closeRecovery.entries.filter(i => i.agentId.startsWith(snapshot.entryId + ":") && (modal !== "abandon-close" || abandon?.id !== i.agentId)) as intent (intent.agentId)}<div class="flex flex-wrap items-center gap-2 min-w-0"><div class="min-w-0"><strong>{m.abandon_close_recovery()}</strong><p class="break-all text-xs">{intent.agentId}</p>{#if closeRecoveryErrors[intent.agentId]}<p role="alert" class="break-words">{closeRecoveryErrors[intent.agentId]}</p>{/if}</div><Button variant="ghost" size="sm" disabled={closingId === intent.agentId || checkingCloses.includes(intent.agentId) || !hosts.some(h => intent.agentId.startsWith(h.id + ":") && h.connected)} onclick={() => checkPendingClose(intent.agentId, true)}>{m.abandon_close_check()}</Button></div>{/each}
  </div>
{/if}
</div>
<Dialog.Root open={modalOpen} onOpenChange={value => { if (!value && modal) void closeModal(); }}>
  <Dialog.Content onEscapeKeydown={event=>{event.preventDefault();event.stopPropagation();void back();}} showCloseButton={false} class={`grove-dialog ${modal === "new" ? "new-modal" : modal === "settings" ? "settings-modal" : ""}`} onOpenAutoFocus={e => { e.preventDefault(); if (modal === "new") projectSearch?.focus(); }}><Button class="modal-close" variant="ghost" size="icon-sm" aria-label={m.close()} onclick={closeModal}><X /></Button>
    {#if modal === "abandon-close" && abandon}
      <Dialog.Title>{m.abandon_close_title()}</Dialog.Title>
      <Dialog.Description>{m.abandon_close_help()}</Dialog.Description>
      <p class="break-words font-medium">{abandon.title}</p>
      <details open><summary>{m.abandon_close_submissions({ count: abandon.unknownOperationIds.length })}</summary><ul class="max-h-32 overflow-y-auto text-xs break-all">{#each abandon.unknownOperationIds as id}<li>{id}</li>{/each}</ul></details>
      {#if abandonError}<p class="inline-error" role="alert">{abandonError}</p>{/if}
      <div class="flex flex-wrap justify-end gap-2"><Button variant="ghost" size="sm" disabled={!!closingId} onclick={closeModal}>{m.cancel()}</Button><Button variant="destructive" size="sm" disabled={!!closingId || !hosts.find(h => abandon?.id.startsWith(h.id + ":"))?.connected} onclick={confirmAbandon}>{closingId ? m.sending() : closeUnknown ? m.abandon_close_check() : m.abandon_close_title()}</Button></div>
    {:else if modal === "new"}
      <Dialog.Title>{navigation.surfaces.includes("history") ? m.open_session() : m.new_session()}</Dialog.Title>
      {#if navigation.surfaces.includes("history") && projects.find(p => projectReference(p) === projectId)}
        {#key createHost + ":" + selectedEnvironment + ":" + projectId}<SessionHistory hostId={createHost} project={projects.find(p => projectReference(p) === projectId)!} connected={connected && !!hosts.find(h => h.id === createHost)?.connected} onresume={resumeHistory} />{/key}
      {:else}
      {#if environments.length > 1 || selectedEnvironment !== "local"}
      <label class="form-section-label" for="execution-environment">Execution environment</label>
      <Select.Root type="single" value={selectedEnvironment} onValueChange={value=>{selectedEnvironment=value;search="";void loadProjects();}} disabled={saving}>
        <Select.Trigger id="execution-environment" class="w-full min-w-0"><span class="truncate">{environments.find(e=>e.id===selectedEnvironment)?.name ?? "Unavailable environment"}</span></Select.Trigger>
        <Select.Content>{#each environments as environment}<Select.Item value={environment.id}>{environment.name}</Select.Item>{/each}</Select.Content>
      </Select.Root>
      {/if}
      <p class="form-section-label">{m.project_label()}</p>
      <Command.Root class="project-choice h-auto border border-input" shouldFilter={false} bind:value={projectHighlight} label={m.search_projects()}>
        <Command.Input aria-controls={projectListId} bind:ref={projectSearch} aria-label={m.search_projects()} placeholder={m.search_projects()} bind:value={search} disabled={saving} onkeydown={event=>{if(event.key==="Tab"&&!event.isComposing&&!event.shiftKey){event.preventDefault();if(filteredProjects.some(project=>projectReference(project)===projectHighlight))projectId=projectHighlight;}}} />
        <Command.List id={projectListId} class="max-h-44" aria-label={m.project_label()} aria-busy={projectsLoading}>
          {#each filteredProjects as project (projectReference(project))}
            <Command.Item value={projectReference(project)} aria-label={project.historyRef ? project.name+" · Saved history" : project.name} data-checked={projectReference(project)===projectId} disabled={saving||!connected||!hosts.find(host=>host.id===createHost)?.connected} onSelect={()=>projectId=projectReference(project)}>
              <div class="min-w-0 flex-1"><strong class="block break-words font-medium">{project.name}</strong><span class="block break-all text-xs text-muted-foreground">{project.name!==project.alias ? project.alias+" · " : ""}{project.path}{#if project.historyRef} · Saved history{/if}</span></div>
            </Command.Item>
          {:else}<p class="px-2 py-3 text-sm text-muted-foreground" role="status">{projectsLoading ? m.loading() : !connected ? m.offline_help() : projectError ? m.load_failure() : m.no_projects()}</p>{/each}
        </Command.List>
      </Command.Root>
      {#if projectError}<p role="alert">{projectError} <Button variant="ghost" size="sm" disabled={!connected||projectsLoading} onclick={loadProjects}>{m.retry()}</Button></p>{/if}
      {#if !settings&&modalModelsLoading}<p role="status">{m.loading()}</p>{/if}
      {#if settings}{#each ["orc", "worker"] as role}{@const key = role as "orc" | "worker"}<section class="role-settings"><h3>{key === "orc" ? m.orc() : m.worker()}</h3><ModelFields bind:value={settings[key]} {models} loading={modelRefreshBusy||modalModelsLoading} disabled={saving||!connected} label={key === "orc" ? m.orc() : m.worker()} /></section>{/each}{/if}
      <Button variant="ghost" size="sm" disabled={modelRefreshBusy || !connected} onclick={refreshModels}>Refresh models</Button>
      {#if remotePi}<p role="alert" class="inline-error">Pi supports this machine only. Choose Codex for Orc and Worker.</p>{/if}
      <p class="project-keyboard">{m.project_keyboard()}</p>
      <div class="modal-action"><Button variant="ghost" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || !projectId} onclick={() => setSurface("history", true)}><History />{m.find_history()}</Button><Button variant="default" size="sm" disabled={!connected || !hosts.find(h => h.id === createHost)?.connected || saving || remotePi || !!projects.find(p=>projectReference(p)===projectId)?.historyRef || !settingsValid || !filteredProjects.some(p => projectReference(p) === projectId)} onclick={create}>{saving ? m.sending() : m.new_session()}</Button></div>
      {/if}
    {:else if modal === "settings"}
      <Dialog.Title>{m.settings()}</Dialog.Title><p class="modal-help">{m.settings_help()}</p>
      {#if !settings&&modalModelsLoading}<p role="status">{m.loading()}</p>{/if}
      {#if settings}{#each ["orc", "worker"] as role}{@const key = role as "orc" | "worker"}<section class="role-settings"><h3>{key === "orc" ? m.orc() : m.worker()}</h3><ModelFields bind:value={settings[key]} {models} loading={modelRefreshBusy||modalModelsLoading} disabled={saving||!connected} label={key === "orc" ? m.orc() : m.worker()} /></section>{/each}<label class="fast-setting"><span><strong>{m.fast_mode()}</strong><small>{fastAvailable ? m.fast_help() : m.fast_unavailable()}</small></span><Switch aria-label={m.fast_mode()} bind:checked={settings.fast} disabled={!fastAvailable && !settings.fast} /></label>{/if}
      <Button variant="ghost" size="sm" disabled={modelRefreshBusy || !connected} onclick={refreshModels}>Refresh models</Button>
      <p class="settings-scope">{m.settings_scope()}</p><div class="modal-action">{#if install}<button class="install-link" onclick={() => install?.prompt()}>{m.install_app()}</button>{/if}<Button variant="default" size="sm" disabled={!settings || !settingsValid || saving} onclick={saveSettings}>{saving ? m.sending() : m.save_changes()}</Button></div>
    {:else if modal === "keys"}
      <Dialog.Title>{m.shortcuts()}</Dialog.Title><p class="modal-help">{m.keyboard_help()}</p><dl class="shortcut-list">{#each [["↑ ↓ ← →", m.key_focus()], ["Option + J / K", m.key_session_loop()], ["⌘ 1–9", m.key_visible_session()], ["Enter", m.key_open()], ["E", m.key_expand()], ["N", m.key_new()], ["I", m.key_input()], ["Option/Alt + S", m.search_skills()], ["Option/Alt + X", m.close_tree()], ["Esc", m.key_escape()], ["Tab", m.key_completion()], ["Enter", m.key_send()], ["Shift + Enter", m.key_newline()]] as [key, label]}<div><dt><Kbd>{key}</Kbd></dt><dd>{label}</dd></div>{/each}</dl><p class="keyboard-scope">{m.keyboard_scope()}</p>
    {/if}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
  </Dialog.Content>
</Dialog.Root>
