<script lang="ts">
  import { storagePrefix } from "./api";
  import { tick, untrack } from "svelte";
  import type { Skill } from "./contracts";
  import * as m from "./paraglide/messages";
  let { agentId, project, skills, connected, working = false, stopping = false, onstop, onsend }: { agentId: string; project: string; skills: Skill[]; connected: boolean; working?: boolean; stopping?: boolean; onstop?: () => Promise<boolean>; onsend: (text: string, requestId: string) => Promise<boolean> } = $props();
  let text = $state(untrack(() => localStorage.getItem(`${storagePrefix}/composer/${agentId}`) ?? ""));
  let busy = $state(false); let dismissed = $state(false); let selection = $state(0); let input: HTMLTextAreaElement;
  const skillMatch = $derived(/(?:^|\s)\$([^\s$]*)$/.exec(text));
  const commandMatch = $derived(/^\/[^\s]*$/.test(text));
  const choices = $derived(skillMatch ? skills.filter(s => s.name.toLowerCase().includes(skillMatch[1].toLowerCase())) : commandMatch ? [{ name: "/stop", description: m.stop_help() }, { name: "/close", description: m.close_tree_help() }].filter(c => c.name.startsWith(text)) : []);
  const open = $derived(!dismissed && (skillMatch || commandMatch) && choices.length > 0);
  $effect(() => { localStorage.setItem(`${storagePrefix}/composer/${agentId}`, text); });
  async function insert() {
    const choice = choices[Math.min(selection, choices.length - 1)]; if (!choice) return;
    text = skillMatch ? text.slice(0, text.lastIndexOf("$")) + `$${choice.name} ` : choice.name;
    dismissed = true; selection = 0; await tick(); input.focus();
  }
  async function send() {
    if (!text.trim() || busy || !connected) return;
    busy = true;
    try { if (await onsend(text.trim(), crypto.randomUUID())) { text = ""; dismissed = false; } }
    finally { busy = false; await tick(); input.focus(); }
  }
  async function keydown(event: KeyboardEvent) {
    if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (open && ["ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (event.key === "Escape") dismissed = true;
      else if (event.key === "Enter") await insert();
      else { selection = Math.max(0, Math.min(choices.length - 1, selection + (event.key === "ArrowDown" ? 1 : -1))); await tick(); document.getElementById(`skill-${agentId}-${selection}`)?.scrollIntoView({ block: "nearest" }); }
    } else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); await send(); }
  }
</script>
<div class="composer-wrap">
  {#if open}
    <div class="completion">
      <div class="completion-heading">{skillMatch ? m.skills_scope({ project }) : m.commands()}</div>
      <div class="completion-list" id={`completion-${agentId}`} role="listbox" aria-label={m.skills()}>
        {#each choices as choice, i}
          <button id={`skill-${agentId}-${i}`} role="option" aria-selected={i === selection} class:selected={i === selection} onmousedown={e => e.preventDefault()} onclick={() => { selection = i; void insert(); }}><code>{skillMatch ? "$" : ""}{choice.name}</code><span class="truncate">{choice.description}</span></button>
        {/each}
      </div>
      <div class="completion-description">{choices[Math.min(selection, choices.length - 1)]?.description}</div>
    </div>
  {/if}
  <form class="composer" onsubmit={e => { e.preventDefault(); void send(); }}>
    <textarea bind:this={input} bind:value={text} aria-label={m.message_orc()} aria-controls={open ? `completion-${agentId}` : undefined} aria-activedescendant={open ? `skill-${agentId}-${selection}` : undefined} placeholder={m.message_placeholder()} disabled={!connected || busy || stopping} rows="1" oninput={() => { dismissed = false; selection = 0; }} onkeydown={keydown}></textarea>
    <div class="composer-bottom"><span>{open ? m.completion_hint() : m.commands_skills()}</span>{#if working && !text.trim()}<button class="btn btn-primary btn-sm btn-square" aria-label={m.stop_orc()} disabled={!connected || busy} type="button" onclick={onstop}>■</button>{:else}<button class="btn btn-primary btn-sm btn-square" aria-label={m.send_message()} disabled={!text.trim() || !connected || busy} type="submit">{busy ? "…" : "↑"}</button>{/if}</div>
  </form>
</div>
