<script lang="ts">
  // What a player needs before it can speak: peppermint speaks only with the natural voice (English, on this device's
  // graphics chip). Shown instead of playing, with the one step that helps here.
  import { natural, canSpeak } from "../lib/voice.svelte";
  let { lang }: { lang: string } = $props();
</script>

{#if !canSpeak(lang) && natural.status !== "unknown"}
  <div class="notice mt-s" role="status">
    {#if lang !== "en"}
      <b>Listening is English only for now</b><span>The natural voice has no German yet. Switch the language to English to listen.</span>
    {:else if natural.status === "unsupported"}
      <b>This browser cannot make the voice</b><span>The natural voice runs on the graphics chip through WebGPU, which this browser does not offer. Chrome on a Mac or a recent Android phone has it.</span>
    {:else if natural.status === "downloading"}
      <b>Getting the natural voice</b><span>{Math.round(natural.done / 1e6)} of {Math.round(natural.total / 1e6)} MB. Listening starts once it is here.</span>
    {:else if natural.status === "error"}
      <b>The natural voice stopped</b><span>{natural.error}</span>
      <button class="primary mt-xs" type="button" onclick={() => (natural.offer = true)}>Try again</button>
    {:else}
      <b>Listening needs the natural voice</b><span>{natural.wifiWait ? `It downloads on the next Wi-Fi connection (about ${natural.mb} MB).` : `It is made on this device and works offline: one download of about ${natural.mb} MB.`}</span>
      <button class="primary mt-xs" type="button" onclick={() => (natural.offer = true)}>Get the natural voice</button>
    {/if}
  </div>
{/if}
