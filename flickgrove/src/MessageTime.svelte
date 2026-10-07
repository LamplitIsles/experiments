<script lang="ts">
  import { messageTime } from "./message-time";
  let { at }: { at: number } = $props();
  const time = $derived(messageTime(at));
</script>
{#if time}<time class="message-time" datetime={time.datetime} title={time.title}>{time.label}</time>{/if}
