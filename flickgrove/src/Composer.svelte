<script lang="ts">
  import { navigation, setSurface } from "./navigation.svelte";
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { ArrowUp, Square } from '@lucide/svelte';
  import { storagePrefix } from './api';
  import { tick, untrack } from 'svelte';
  import type { Skill } from './contracts';
  import SkillSearch from './SkillSearch.svelte';
  import * as m from './paraglide/messages';
  let { agentId, project, skills, connected, working = false, stopping = false, onstop, onsend }: { agentId: string; project: string; skills: Skill[]; connected: boolean; working?: boolean; stopping?: boolean; onstop?: () => Promise<boolean>; onsend: (text: string, requestId: string) => Promise<boolean> } = $props();
  let text = $state(untrack(() => localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? ''));
  let input = $state<HTMLTextAreaElement | null>(null);
  let composing = false;
  const skillOpen = $derived(navigation.surfaces.includes("skill")); let insertion = {start:0,end:0};
  $effect(() => { localStorage.setItem(`${storagePrefix}/composer/${agentId}`, text); });
  export function recover(value: string) { text = text.trim() ? `${text}\n\n${value}` : value; void tick().then(() => input?.focus()); }
  async function restoreInput() { await tick(); input?.focus(); input?.setSelectionRange(insertion.start,insertion.end); }
  async function insertSkill(skill:Skill) {
    const before = text.slice(0,insertion.start); const after = text.slice(insertion.end);
    const value = `$${skill.name}${after.startsWith(' ') ? '' : ' '}`;
    text = before+value+after; insertion = {start:before.length+value.length,end:before.length+value.length};
    setSurface("skill", false); await restoreInput();
  }
  async function send() {
    if(composing || !text.trim() || !connected || stopping) return;
    const value = text.trim();
    text = '';
    // Registration and echo happen synchronously before awaiting native admission.
    void onsend(value,crypto.randomUUID());
    await tick(); input?.focus();
  }
  function openSkills() {
    if(skillOpen || !input || (input.selectionStart !== 0 && !/\s/.test(text[input.selectionStart-1]))) return false;
    insertion={start:input.selectionStart,end:input.selectionEnd}; setSurface("skill", true); return true;
  }
  function beforeinput(e:InputEvent) {
    if(!composing && !e.isComposing && e.cancelable && e.inputType === 'insertText' && e.data === '$' && openSkills()) e.preventDefault();
  }
  async function keydown(e:KeyboardEvent) {
    // WebKit may end composition before the confirming Enter keydown.
    if(composing || e.isComposing || e.keyCode === 229 || e.ctrlKey || e.metaKey || e.altKey) return;
    if(e.key === '$' && openSkills()) { e.preventDefault(); e.stopPropagation(); return; }
    if(e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return; }
    if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); await send(); }
  }
</script>
<div class="composer-wrap">
  <SkillSearch bind:open={() => skillOpen, value => setSurface("skill", value)} {skills} {project} onselect={skill => void insertSkill(skill)} onclose={() => void restoreInput()} />
  <form class="composer" onsubmit={e => {e.preventDefault();void send();}}>
    <Textarea bind:ref={input} bind:value={text} aria-label={m.message_orc()} placeholder={m.message_placeholder()} disabled={stopping} rows={2} oncompositionstart={() => { composing = true; }} oncompositionend={() => { composing = false; }} onbeforeinput={beforeinput} onkeydown={keydown} />
    <div class="composer-bottom"><span>{m.skills_hint()}</span><div class="composer-actions">
      {#if working || stopping}<Button variant="secondary" class="round-action" size="icon-sm" title={m.stop_orc()} aria-label={m.stop_orc()} disabled={!connected || stopping} onclick={onstop}><Square /></Button>{/if}
      <Button class="round-action" size="icon-sm" aria-label={m.send_message()} title={m.send_message()} disabled={!text.trim() || !connected || stopping} type="submit"><ArrowUp /></Button>
    </div></div>
  </form>
</div>
