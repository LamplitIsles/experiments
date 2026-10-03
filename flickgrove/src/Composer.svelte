<script lang="ts">
  import { Button } from '$lib/components/ui/button/index.js';
  import { Textarea } from '$lib/components/ui/textarea/index.js';
  import { ArrowUp, Square, LoaderCircle } from '@lucide/svelte';
  import { storagePrefix } from './api';
  import { tick, untrack } from 'svelte';
  import type { Skill } from './contracts';
  import SkillSearch from './SkillSearch.svelte';
  import * as m from './paraglide/messages';
  let { agentId, project, skills, connected, working = false, stopping = false, onstop, onsend }: { agentId: string; project: string; skills: Skill[]; connected: boolean; working?: boolean; stopping?: boolean; onstop?: () => Promise<boolean>; onsend: (text: string, requestId: string) => Promise<boolean> } = $props();
  let text = $state(untrack(() => localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? ''));
  let busy = $state(false); let dismissed = $state(false); let selection = $state(0); let input = $state<HTMLTextAreaElement | null>(null);
  let skillOpen = $state(false); let insertion = {start:0,end:0};
  const commandMatch = $derived(/^\/[^\s]*$/.test(text));
  const choices = $derived(commandMatch ? [{name:'/stop',description:m.stop_help()},{name:'/close',description:m.close_tree_help()}].filter(c => c.name.startsWith(text)) : []);
  const open = $derived(!dismissed && !skillOpen && commandMatch && choices.length > 0);
  $effect(() => { localStorage.setItem(`${storagePrefix}/composer/${agentId}`, text); });
  async function insertCommand() {
    const choice = choices[Math.min(selection, choices.length - 1)]; if(!choice) return;
    text = choice.name; dismissed = true; selection = 0; await tick(); input?.focus();
  }
  async function restoreInput() { await tick(); input?.focus(); input?.setSelectionRange(insertion.start,insertion.end); }
  async function insertSkill(skill:Skill) {
    const before = text.slice(0,insertion.start); const after = text.slice(insertion.end);
    const value = `$${skill.name}${after.startsWith(' ') ? '' : ' '}`;
    text = before+value+after; insertion = {start:before.length+value.length,end:before.length+value.length};
    skillOpen = false; await restoreInput();
  }
  async function send() {
    if(!text.trim() || busy || !connected || stopping) return;
    busy = true;
    try { if(await onsend(text.trim(),crypto.randomUUID())) { text=''; dismissed=false; } }
    finally { busy=false; await tick(); input?.focus(); }
  }
  async function keydown(e:KeyboardEvent) {
    if(e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if(e.key === '$' && input && (input.selectionStart===0 || /\s/.test(text[input.selectionStart-1]))) {
      e.preventDefault(); e.stopPropagation(); insertion={start:input.selectionStart,end:input.selectionEnd}; skillOpen=true; return;
    }
    if(e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); if(open && !e.shiftKey) await insertCommand(); return; }
    if(open && ['ArrowUp','ArrowDown','Enter','Escape'].includes(e.key)) {
      e.preventDefault(); e.stopPropagation();
      if(e.key==='Escape') dismissed=true;
      else if(e.key==='Enter') await insertCommand();
      else { selection=Math.max(0,Math.min(choices.length-1,selection+(e.key==='ArrowDown'?1:-1))); await tick(); document.getElementById(`command-${agentId}-${selection}`)?.scrollIntoView({block:'nearest'}); }
    } else if(e.key==='Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); await send(); }
  }
</script>
<div class="composer-wrap">
  <SkillSearch bind:open={skillOpen} {skills} {project} onselect={skill => void insertSkill(skill)} onclose={() => void restoreInput()} />
  {#if open}<div class="completion"><div class="completion-heading">{m.commands()}</div><div class="completion-list" id={`completion-${agentId}`} role="listbox" aria-label={m.commands()}>
    {#each choices as choice,i}<button tabindex={-1} id={`command-${agentId}-${i}`} role="option" aria-selected={i===selection} class:selected={i===selection} onmousedown={e => e.preventDefault()} onclick={() => {selection=i;void insertCommand();}}><code>{choice.name}</code><span>{choice.description}</span></button>{/each}
  </div><div class="completion-description">{choices[selection]?.description}</div></div>{/if}
  <form class="composer" onsubmit={e => {e.preventDefault();void send();}}>
    <Textarea bind:ref={input} bind:value={text} aria-label={m.message_orc()} aria-controls={open?`completion-${agentId}`:undefined} aria-activedescendant={open?`command-${agentId}-${selection}`:undefined} placeholder={m.message_placeholder()} disabled={!connected || busy || stopping} rows={2} oninput={() => {dismissed=false;selection=0;}} onkeydown={keydown} />
    <div class="composer-bottom"><span>{open?m.completion_hint():m.commands_skills()}</span><div class="composer-actions">
      {#if working || stopping}<Button variant="secondary" size="sm" aria-label={stopping ? m.stopping() : m.stop_orc()} disabled={!connected || stopping} onclick={onstop}><Square />{stopping ? m.stopping() : m.stop_orc()}</Button>{/if}
      <Button size="icon-sm" aria-label={m.send_message()} title={m.send_message()} disabled={!text.trim() || !connected || busy || stopping} type="submit">{#if busy}<LoaderCircle class="animate-spin" />{:else}<ArrowUp />{/if}</Button>
    </div></div>
  </form>
</div>
