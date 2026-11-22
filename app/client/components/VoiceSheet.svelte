<script lang="ts">
  // Asks before the natural voice downloads: what it is, how big, and whether this is mobile data. Never starts alone.
  import Sheet from "./Sheet.svelte";
  import { natural, download, whenWifi, decline, onCellular } from "../lib/voice.svelte";
  const cellular = $derived(natural.offer && onCellular());
  // only some browsers say which network they are on (Android Chrome does, iPhones do not)
  const knows = typeof navigator !== "undefined" && !!(navigator as any).connection?.type;
  const mb = $derived(natural.mb);
</script>

<Sheet bind:open={natural.offer} label="Natural voice">
  <h3>{natural.update ? "A better natural voice" : "A natural voice for English"}</h3>
  <p class="sub">{natural.update ? "The copy on this device made broken sound; the new one replaces it." : "The voice from the podcasts, made on this device's graphics chip."} It downloads once, about {mb} MB, then works offline. German keeps the device voice.</p>
  {#if cellular}<p class="notice mt-s"><b>You are on mobile data.</b> The download can wait until you are on Wi-Fi.</p>{/if}
  <div class="voice-acts mt-m">
    {#if cellular}
      <button class="primary full" type="button" onclick={whenWifi}>Download when on Wi-Fi</button>
      <button class="ghost full" type="button" onclick={download}>Download now on mobile data</button>
    {:else}
      <button class="primary full" type="button" onclick={download}>Download now · {mb} MB</button>
      {#if knows}<button class="ghost full" type="button" onclick={whenWifi}>Later, on Wi-Fi</button>
      {:else}<button class="ghost full" type="button" onclick={() => (natural.offer = false)}>Not now</button>{/if}
    {/if}
    <button class="ghost full" type="button" onclick={decline}>Keep the device voice</button>
  </div>
</Sheet>
