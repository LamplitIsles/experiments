<script lang="ts">
  import * as ContextMenu from "$lib/components/ui/context-menu";
  import { Pin, PinOff, X } from "@lucide/svelte";
  import * as m from "./paraglide/messages";
  import { onDestroy, type Snippet } from "svelte";
  import { back, navigation, setSurface } from "./navigation.svelte";
  let { pinned, ontoggle, onclose, closeDisabled = false, children }: { pinned: boolean; ontoggle: () => void; onclose: () => void | Promise<void>; closeDisabled?: boolean; children: Snippet } = $props();
  let active = $state(false);
  const visible = $derived(navigation.surfaces.includes("session-menu"));
  $effect(() => { if (!visible) active = false; });
  const actions = $derived([
    { label: pinned ? m.unpin() : m.pin(), icon: pinned ? PinOff : Pin, run: ontoggle, disabled: false, close: false },
    { label: m.close_tree(), icon: X, run: onclose, disabled: closeDisabled, close: true },
  ]);
  onDestroy(() => { if (active && visible) setSurface("session-menu", false); });
  function change(value: boolean) {
    if (value) active = true;
    if (active) setSurface("session-menu", value);
  }
  async function select(action: typeof actions[number]) {
    // Complete foreground dismissal before the guarded close flow may show recovery.
    if (navigation.surfaces.at(-1) === "session-menu") await back();
    await action.run();
  }
</script>
<ContextMenu.Root open={active && visible} onOpenChange={change}>
  <ContextMenu.Trigger class="session-menu-row">
    {@render children()}
  </ContextMenu.Trigger>
  <ContextMenu.Content class="session-pin-menu" preventScroll={false} onEscapeKeydown={event => event.stopPropagation()}>
    {#each actions as action}
      <ContextMenu.Item disabled={action.disabled} variant={action.close ? "destructive" : "default"} onSelect={() => void select(action)}><action.icon size={14} />{action.label}</ContextMenu.Item>
    {/each}
  </ContextMenu.Content>
</ContextMenu.Root>
