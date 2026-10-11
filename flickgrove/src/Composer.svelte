<script lang="ts">
  import { addOutgoing } from "./outgoing.svelte";
  import { navigation, setSurface } from "./navigation.svelte";
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { Plus, MessagesSquare, Hammer, ClipboardCheck, RotateCcw, Telescope, X, ArrowUp, Square, Sparkles } from '@lucide/svelte';
  import { storagePrefix, readingCache, peers } from './api';
  import { Mic, LoaderCircle } from '@lucide/svelte';
  import { canCaptureVoice, VoiceRecordingController, type VoiceRecordingStatus } from './voice-input';
  import { imagePreview, loadImages, saveImages, draftKey, operationKey, intakeError, IMAGE_ACCEPT, type ImageDraft } from './image-drafts';
  import { onMount, tick, untrack } from 'svelte';
  import type { Skill } from './contracts';
  import SkillSearch from './SkillSearch.svelte';
  import * as m from './paraglide/messages';
  let { agentId, project, skills, connected, working = false, stopping = false, onstop, onsend }: { agentId: string; project: string; skills: Skill[]; connected: boolean; working?: boolean; stopping?: boolean; onstop?: () => Promise<boolean>; onsend: (agentId: string, text: string, requestId: string, images?: ImageDraft[]) => Promise<boolean> } = $props();
  let text = $state(untrack(() => localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? ''));
  let input = $state<HTMLTextAreaElement | null>(null);
  let composing = false;
  let images = $state<ImageDraft[]>([]); let previews = $state<string[]>([]); let imageError=$state(""); let preparing=$state(false); let ready=$state(false); let imageStorage=$state(true); let picker: HTMLInputElement; let active=true;
  let revision=0;
  let voiceStatus = $state<VoiceRecordingStatus>("idle");
  let voiceAvailable = $state(false); let voiceReason = $state("Checking voice availability…");
  let voiceError = $state(""); let voiceSeconds = $state(0);
  const voiceBusy = $derived(voiceStatus !== "idle");
  let takeDraft: {text:string;start:number;end:number} | undefined;
  const voice = new VoiceRecordingController({
    onStatus: status => { voiceStatus=status; },
    onError: error => { voiceError = error.code === "permission-denied" ? "Allow microphone access to use voice input." : error.code === "unsupported" ? "16 kHz voice capture is unavailable in this browser." : "Voice input failed. Try again or type your message."; },
    onResult: result => {
      const saved=takeDraft; takeDraft=undefined;
      if(!active || !saved || text!==saved.text)return;
      text=saved.text.slice(0,saved.start)+result.text+saved.text.slice(saved.end);
      const caret=saved.start+result.text.length;
      void tick().then(()=>{if(active){input?.focus();input?.setSelectionRange(caret,caret);}});
    },
  });
  function cancelVoice() { takeDraft=undefined; void voice.cancel(); voiceError=""; }
  async function startVoice() {
    if(voiceBusy || !voiceAvailable || !connected || stopping || preparing || !ready || composing || navigation.surfaces.length || !input)return;
    takeDraft={text,start:input.selectionStart,end:input.selectionEnd};voiceError="";voiceSeconds=0;
    try { await voice.start(()=>peers().voiceSocket(agentId),agentId.split(":")[0]); }
    catch { /* Controller reports non-cancel failures. */ }
  }
  function stopVoice() { void voice.stopAndGet().catch(()=>{}); }
  $effect(()=>{ const value=text; untrack(()=>{if(takeDraft && value!==takeDraft.text)cancelVoice();}); });
  $effect(()=>{
    const online=connected; const id=agentId;
    const abort=new AbortController();voiceAvailable=false;voiceReason="Checking voice availability…";
    if(!online){cancelVoice();voiceReason="Execution Peer is offline";return;}
    if(!canCaptureVoice()){voiceReason="Voice requires HTTPS or localhost and a supported browser";return;}
    void peers().voiceCapability(id,abort.signal).then(value=>{
      if(abort.signal.aborted)return;voiceAvailable=value.available;
      voiceReason=value.available ? "Start voice input" : value.reason==="config_unavailable" ? "Voice configuration is unavailable on this Peer" : "Voice is not configured on this Peer";
    }).catch(()=>{if(!abort.signal.aborted)voiceReason="Voice is unavailable on this Peer";});
    return()=>abort.abort();
  });
  onMount(()=>{
    const hidden=()=>{if(document.hidden)cancelVoice();};
    const navigating=(e:Event)=>{if(!(e as CustomEvent<{foreground:boolean}>).detail.foreground)cancelVoice();};
    const escape=(e:KeyboardEvent)=>{if(e.key==="Escape" && !e.isComposing && voiceBusy && !navigation.surfaces.length && !(e.target instanceof HTMLElement && e.target.closest(".title-editor"))){e.preventDefault();e.stopImmediatePropagation();cancelVoice();}};
    const timer=setInterval(()=>{voiceSeconds=Math.floor(voice.elapsedMs/1000);},500);
    window.addEventListener("keydown",escape,true);document.addEventListener("visibilitychange",hidden);window.addEventListener("pagehide",cancelVoice);window.addEventListener("grove-navigation-pop",navigating);
    return()=>{clearInterval(timer);voice.dispose();window.removeEventListener("keydown",escape,true);document.removeEventListener("visibilitychange",hidden);window.removeEventListener("pagehide",cancelVoice);window.removeEventListener("grove-navigation-pop",navigating);};
  });
  async function refreshDraft(applyRecovery=false) {
    if(applyRecovery)cancelVoice();
    if(applyRecovery)text=localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? '';
    try { const stored=await loadImages(draftKey(agentId)); if(active) { images=stored?.images ?? []; imageStorage=true; } }
    catch(e) { if(active){imageStorage=false;imageError=`Image storage unavailable. Text messages still work. ${(e as Error).message}`;} }
    finally {if(active)ready=true;}
  }
  let restoration:Promise<void>;
  onMount(()=>{restoration=refreshDraft(); const recover=(e:Event)=>{if((e as CustomEvent).detail===agentId)void refreshDraft(true);};window.addEventListener("grove-image-recovery",recover);return()=>{active=false;window.removeEventListener("grove-image-recovery",recover);};});
  $effect(()=>{
    const snapshot=images; const urls:string[]=[];let disposed=false;
    void Promise.all(snapshot.map(i=>imagePreview(i.file))).then(blobs=>{
      if(disposed)return;for(const blob of blobs)urls.push(URL.createObjectURL(blob));previews=urls;
    }).catch(e=>{if(!disposed)imageError=(e as Error).message;});
    return()=>{disposed=true;urls.forEach(url=>URL.revokeObjectURL(url));};
  });
  let intake=Promise.resolve();
  function addFiles(files:File[]) { if(voiceBusy)return Promise.resolve(); const task=intake.catch(()=>{}).then(()=>performAdd(files));intake=task;return task; }
  async function performAdd(files: File[]) {
    if(voiceBusy || !files.length)return;
    imageError=intakeError(images,files);if(imageError)return;
    preparing=true;
    try {
      for(const file of files){ const bitmap=await createImageBitmap(file); const valid=bitmap.width*bitmap.height<=40_000_000 && bitmap.width<=16383 && bitmap.height<=16383;bitmap.close();if(!valid)throw new Error("Image exceeds 40 megapixels or 16383 pixels per side."); }
      const added=files.map(file=>({id:crypto.randomUUID(),file}));
      const next=await saveImages(draftKey(agentId),current=>[...current,...added]); if(active){images=next;revision++;}
    }catch(e){imageError=(e as Error).message;}finally{if(active)preparing=false;}
  }
  function removeImage(id:string) {
    if(voiceBusy)return;
    intake=intake.catch(()=>{}).then(async()=>{preparing=true;try{const next=await saveImages(draftKey(agentId),current=>current.filter(i=>i.id!==id));if(active){images=next;revision++;}}catch(e){imageError=(e as Error).message;}finally{preparing=false;}});
  }
  function paste(e:ClipboardEvent) { if(voiceBusy){e.preventDefault();return;} const files=Array.from(e.clipboardData?.items ?? []).filter(i=>i.kind==='file' && i.type.startsWith('image/')).map(i=>i.getAsFile()).filter((i):i is File=>!!i);if(files.length){e.preventDefault();void addFiles(files);} }

  const skillOpen = $derived(navigation.surfaces.includes("skill")); let insertion = {start:0,end:0};
  $effect(() => {
    try { readingCache.writeDevice(`${storagePrefix}/composer/${agentId}`, text); }
    catch(e) { imageError=(e as Error).message; }
  });
  export function imageRecoveryError(value:string) {imageError=value;}
  export async function recover(value: string) { cancelVoice(); const next = text.trim() ? `${text}\n\n${value}` : value; readingCache.writeDevice(`${storagePrefix}/composer/${agentId}`,next); text=next; await tick(); input?.focus(); }
  async function restoreInput() { await tick(); input?.focus(); input?.setSelectionRange(insertion.start,insertion.end); }
  async function insertSkill(skill:Skill) {
    if(voiceBusy || composing || stopping || preparing || !connected) return;
    const before = text.slice(0,insertion.start); const after = text.slice(insertion.end);
    const value = `${before && !/\s$/.test(before) ? ' ' : ''}$${skill.name}${!after || !/^\s/.test(after) ? ' ' : ''}`;
    text = before+value+after; insertion = {start:before.length+value.length,end:before.length+value.length};
    setSurface("skill", false); await restoreInput();
  }
  function workflow(name:string) {
    if(voiceBusy || !input || composing || stopping || preparing || !connected || navigation.surfaces.length) return;
    insertion={start:input.selectionStart,end:input.selectionEnd};
    void insertSkill({name, description:""});
  }
  async function send() {
    if(!ready && restoration)await restoration;
    if(voiceBusy || composing || (!text.trim() && !images.length) || !connected || stopping || preparing || !ready) return;
    if(images.length){imageError=intakeError([],images.map(i=>i.file));if(imageError)return;}
    const value=text.trim(); const frozen=$state.snapshot(images);const version=revision;const id=crypto.randomUUID();
    preparing=true;
    try {
      if(frozen.length) await saveImages(operationKey(agentId,id),frozen,value);
      addOutgoing(agentId,value,id,undefined,undefined,frozen.map(i=>i.id));
      if(frozen.length){
        await saveImages(draftKey(agentId),current=>JSON.stringify(current.map(i=>i.id))===JSON.stringify(frozen.map(i=>i.id)) ? [] : current);
      }
      try {
        if(localStorage.getItem(`${storagePrefix}/composer/${agentId}`)?.trim()===value)readingCache.writeDevice(`${storagePrefix}/composer/${agentId}`,'');
      } catch { /* The submission is already journalled; draft cleanup cannot block sending. */ }
      if(active && version===revision){ images=[];text='';revision++; }
      void onsend(agentId,value,id,frozen);
      await tick(); input?.focus();
    } catch(e){imageError=(e as Error).message;}finally{if(active)preparing=false;}
  }
  function openSkills() {
    if(voiceBusy || navigation.surfaces.length || !input || composing || stopping || preparing || !connected) return false;
    insertion={start:input.selectionStart,end:input.selectionEnd}; setSurface("skill", true); return true;
  }
  function skillShortcut(e:KeyboardEvent) {
    if(e.defaultPrevented || e.isComposing || e.keyCode === 229 || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.code !== "KeyS") return;
    if(e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable=true]") && !e.target.closest(".composer")) return;
    if(openSkills()) { e.preventDefault(); e.stopPropagation(); }
  }
  async function keydown(e:KeyboardEvent) {
    // WebKit may end composition before the confirming Enter keydown.
    if(composing || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
    if(e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return; }
    if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); await send(); }
  }
</script>
<svelte:window onkeydown={skillShortcut} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} />
<div class="composer-wrap">
  <SkillSearch bind:open={() => skillOpen, value => setSurface("skill", value)} {skills} {project} onselect={skill => void insertSkill(skill)} onclose={() => void restoreInput()} />
  <form class="composer" ondragover={e=>{if(e.dataTransfer?.types.includes("Files"))e.preventDefault();}} ondrop={e=>{e.preventDefault();void addFiles(Array.from(e.dataTransfer?.files ?? []));}} onsubmit={e => {e.preventDefault();void send();}}>
    <input class="image-picker" bind:this={picker} type="file" accept={IMAGE_ACCEPT} multiple aria-label="Choose message images" onchange={e=>{void addFiles(Array.from(e.currentTarget.files ?? []));e.currentTarget.value='';}} />
    {#if images.length}<div class="image-drafts">{#each images as image,index (image.id)}<div class="image-draft"><img src={previews[index]} alt={image.file.name} /><Button variant="secondary" size="icon-sm" disabled={voiceBusy} aria-label={`Remove image ${index+1}`} onclick={()=>removeImage(image.id)}><X /></Button></div>{/each}</div>{/if}
    {#if imageError}<p class="inline-error" role="alert">{imageError}</p>{/if}
    {#if preparing}<p role="status">Preparing images…</p>{/if}
    <Textarea onpaste={paste} bind:ref={input} bind:value={text} aria-label={m.message_orc()} placeholder={m.message_placeholder()} readonly={voiceBusy} disabled={stopping || preparing} rows={2} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} onkeydown={keydown} />
    {#if voiceBusy}<p class="voice-status" role="status" aria-live="polite">{voiceStatus === "starting" ? "Starting microphone…" : voiceStatus === "recording" ? `Recording ${Math.floor(voiceSeconds/60)}:${String(voiceSeconds%60).padStart(2,"0")}` : "Recognizing…"}</p>{:else if !voiceAvailable}<p class="voice-status" role="status">{voiceReason}</p>{/if}
    {#if voiceError}<p class="inline-error" role="alert">{voiceError}</p>{/if}
    <div class="composer-bottom">
      <div class="composer-tools">
        {#if voiceBusy}<Button variant="ghost" size="icon-sm" aria-label="Cancel voice input" title="Cancel voice input" onclick={cancelVoice}><X /></Button>
        {:else}<Button variant="ghost" size="icon-sm" aria-label="Add images" title="Add images" disabled={preparing || !ready || !imageStorage || stopping} onclick={()=>picker.click()}><Plus /></Button>{/if}
        <Button variant="ghost" size="icon-sm" aria-label={voiceBusy ? "Stop recording" : "Start voice input"} aria-describedby="composer-voice-reason" title={voiceBusy ? "Stop recording and recognize" : voiceReason} disabled={voiceBusy ? voiceStatus !== "recording" : !voiceAvailable || !connected || stopping || preparing || !ready} onclick={()=>voiceBusy ? stopVoice() : void startVoice()}>
          {#if voiceStatus === "recording"}<Square />{:else if voiceBusy}<LoaderCircle class="voice-spinner" />{:else}<Mic />{/if}
        </Button>
        <span id="composer-voice-reason" class="sr-only">{voiceBusy ? "Stop recording and recognize" : voiceReason}</span>
        <Button variant="ghost" size="icon-sm" aria-label={m.search_skills()} title={m.search_skills()} disabled={voiceBusy || preparing || stopping || !connected} onclick={openSkills}><Sparkles /></Button>
      </div>
      <div class="composer-actions">
        {#if working || stopping}<Button variant="secondary" class="round-action" size="icon-sm" title={m.stop_orc()} aria-label={m.stop_orc()} disabled={!connected || stopping} onclick={onstop}><Square /></Button>{/if}
        <Button class="round-action" size="icon-sm" aria-label={m.send_message()} title={m.send_message()} disabled={voiceBusy || (!text.trim() && !images.length) || !connected || stopping || preparing || !ready} type="submit"><ArrowUp /></Button>
      </div>
    </div>
    <div class="workflow-tools" aria-label="Built-in Skills">
      {#each [{name:"grove-grill-with-docs",label:"Discuss",icon:MessagesSquare},{name:"grove-to-orc-impl",label:"Implement",icon:Hammer},{name:"grove-code-review",label:"Review",icon:ClipboardCheck},{name:"grove-review-again",label:"Re-review",icon:RotateCcw},{name:"grove-research",label:"Research",icon:Telescope}] as action}
        <Button variant="ghost" size="sm" disabled={voiceBusy || preparing || stopping || !connected} onpointerdown={e => { if(composing)e.preventDefault(); }} onclick={() => workflow(action.name)}><action.icon />{action.label}</Button>
      {/each}
    </div>
  </form>
</div>
