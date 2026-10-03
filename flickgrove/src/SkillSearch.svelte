<script lang="ts">
  import * as Popover from '$lib/components/ui/popover/index.js';
  import * as Command from '$lib/components/ui/command/index.js';
  import { Kbd } from '$lib/components/ui/kbd/index.js';
  import { searchSkills } from './skill-search';
  import type { Skill } from './contracts';
  import * as m from './paraglide/messages';
  let { open = $bindable(false), skills, project, onselect, onclose }: {open?:boolean; skills:Skill[]; project:string; onselect:(s:Skill)=>void; onclose:()=>void} = $props();
  let query = $state(''); let selected = $state('');
  const choices = $derived(searchSkills(skills,query));
  const current = $derived(choices.find(s => s.name === selected));
  $effect(() => { if (!open) query = ''; });
  $effect(() => { selected = choices[0]?.name ?? ''; });
  function choose() { if(current) onselect(current); }
</script>
<Popover.Root bind:open>
  <Popover.Trigger class="skill-anchor" tabindex={-1} aria-label={m.skills()}><span class="sr-only">{m.skills()}</span></Popover.Trigger>
  <Popover.Content side="top" align="end" sideOffset={10} class="skill-search" onCloseAutoFocus={e => { e.preventDefault(); onclose(); }}>
    <div class="skill-search-heading"><span>{m.skills_scope({project})}</span><Kbd>Esc</Kbd></div>
    <Command.Root shouldFilter={false} bind:value={selected} label={m.search_skills()}>
      <Command.Input bind:value={query} aria-label={m.search_skills()} placeholder={m.search_skills()} onkeydown={e => { if(e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return; if(e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); choose(); } }} />
      <Command.List aria-label={m.skills()}>
        {#each choices as skill (skill.name)}
          <Command.Item value={skill.name} onSelect={() => onselect(skill)}><div class="min-w-0 flex-1"><code>${skill.name}</code><p class="skill-summary truncate">{skill.shortDescription ?? skill.description}</p></div></Command.Item>
        {:else}<div class="skill-search-empty">{m.no_skills()}</div>{/each}
      </Command.List>
    </Command.Root>
    {#if current}<div class="completion-description">{current.description}</div>{/if}
    <div class="skill-search-heading"><span>{m.skill_search_hint()}</span><Kbd>Tab</Kbd></div>
  </Popover.Content>
</Popover.Root>
