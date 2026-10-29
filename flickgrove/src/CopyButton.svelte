<script lang="ts">
  import { onDestroy } from "svelte";
  import { Check, Copy } from "@lucide/svelte";
  import { toast } from "svelte-sonner";
  import { Button } from "$lib/components/ui/button/index.js";
  import * as m from "./paraglide/messages";

  let { text, label, class: className = "" }: { text: string; label: string; class?: string } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  onDestroy(() => { destroyed = true; clearTimeout(timer); });

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (destroyed) return;
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => copied = false, 2000);
    } catch {
      if (!destroyed) { clearTimeout(timer); copied = false; toast.error(m.copy_failed()); }
    }
  }
</script>

<Button variant="ghost" size="icon-sm" class={`copy-button ${className}`} aria-label={label} title={copied ? m.copied() : label} onclick={copy}>
  {#if copied}<Check aria-hidden="true" />{:else}<Copy aria-hidden="true" />{/if}
</Button>
