<script lang="ts">
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import * as DropdownMenu from "$lib/components/ui/dropdown-menu";
  import { Ellipsis, Pin, PinOff, X } from "@lucide/svelte";
  import * as m from "./paraglide/messages";
  import { onDestroy, type Snippet } from "svelte";
  import { back, navigation, setSurface } from "./navigation.svelte";
  let { title, pinned, ontoggle, onclose, closeDisabled = false, children }: { title: string; pinned: boolean; ontoggle: () => void; onclose?: () => void | Promise<void>; closeDisabled?: boolean; children: Snippet } = $props();
  let active = $state<"context" | "dropdown" | null>(null);
  const visible = $derived(navigation.surfaces.includes("session-menu"));
  $effect(() => { if (!visible) active = null; });
  const actions = $derived([
    { label: pinned ? m.unpin() : m.pin(), icon: pinned ? PinOff : Pin, run: ontoggle, disabled: false, close: false },
    ...(onclose ? [{ label: m.close_tree(), icon: X, run: onclose, disabled: closeDisabled, close: true }] : []),
  ]);
  onDestroy(() => { if (active && visible) setSurface("session-menu", false); });
  function change(mode: "context" | "dropdown", value: boolean) {
    if (value) active = mode;
    if (active === mode) setSurface("session-menu", value);
  }
  async function select(action: typeof actions[number]) {
    // Complete foreground dismissal before the guarded close flow may show recovery.
    if (navigation.surfaces.at(-1) === "session-menu") await back();
    await action.run();
  }
</script>
{#snippet items(Item: typeof ContextMenu.Item)}
  {#each actions as action}
    <Item disabled={action.disabled} variant={action.close ? "destructive" : "default"} onSelect={() => void select(action)}><action.icon size={14} />{action.label}</Item>
  {/each}
{/snippet}
<ContextMenu.Root open={active === "context" && visible} onOpenChange={value => change("context", value)}>
  <ContextMenu.Trigger class="session-menu-row" onkeydown={event => { if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) { event.preventDefault(); event.stopPropagation(); change("dropdown", true); } }}>
    {@render children()}
    <DropdownMenu.Root open={active === "dropdown" && visible} onOpenChange={value => change("dropdown", value)}>
      <DropdownMenu.Trigger class="session-menu-trigger" aria-label={m.session_menu({title})}><Ellipsis size={14} /></DropdownMenu.Trigger>
      <DropdownMenu.Content class="session-pin-menu" side="right" align="start" sideOffset={4} preventScroll={false} onEscapeKeydown={event => event.stopPropagation()}>
        {@render items(DropdownMenu.Item)}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </ContextMenu.Trigger>
  <ContextMenu.Content class="session-pin-menu" preventScroll={false} onEscapeKeydown={event => event.stopPropagation()}>
    {@render items(ContextMenu.Item)}
  </ContextMenu.Content>
</ContextMenu.Root>
