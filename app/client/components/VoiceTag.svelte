<script lang="ts">
  // What the natural voice is doing right now, shown by every player while it speaks.
  import { natural, canSpeak } from "../lib/voice.svelte";
  let { lang, playing = false, note = "" }: { lang: string; playing?: boolean; note?: string } = $props();
  const doing = $derived(playing ? natural.phase === "loading" ? "loading…" : natural.phase === "making" ? "making…" : "" : "");
</script>

{#if canSpeak(lang)}<span class="voice-tag" class:busy={!!doing}><i class="nat"></i>Natural voice{#if note} · {note}{/if}{#if doing}<span class="doing"> · {doing}</span>{/if}</span>{/if}
