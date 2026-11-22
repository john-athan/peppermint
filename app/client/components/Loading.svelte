<script lang="ts">
  // The page-level "on its way": the breathing mark, with an optional line under it. `inline` is just the small mark, for a bar or a button.
  import Mark from "./Mark.svelte";
  let { text = "", inline = false }: { text?: string; inline?: boolean } = $props();
</script>
{#if inline}<span class="busy-mark" role="status" aria-label={text || "Working"}><Mark cls="loading sm" label="" /></span>
{:else}<div class="empty quiet" aria-busy="true"><Mark cls="loading sm" label="" />{#if text}<span>{text}</span>{/if}</div>{/if}
