<script lang="ts">
  // The story as audio: Claude writes a script for the ear, the natural voice reads it sentence by sentence while it streams in.
  import { sse } from "../lib/api";
  import { I } from "../lib/icons";
  import { say, sentences } from "../lib/speech";
  import { natural, offer, canSpeak } from "../lib/voice.svelte";
  import VoiceNeeded from "./VoiceNeeded.svelte";
  import VoiceTag from "./VoiceTag.svelte";
  let { id, lang: reading, onclose }: { id: number; lang: "en" | "de"; onclose: () => void } = $props();
  // the natural voice speaks English only, so Claude writes the script in English whatever the reading language
  const lang = "en";

  let raw = $state(""), streaming = $state(true), failed = $state(""), i = $state(0), playing = $state(true);
  // held: the browser would not start sound on its own (no tap yet), so the player waits for one
  let held = $state(false);
  let cancel: (() => void) | null = null;
  const lines = $derived(sentences(raw, streaming));
  $effect(() => {
    const stop = sse(`/api/stories/${id}/lens/audio?lang=${lang}&level=2`, {
      delta: d => { raw += d.t; }, done: () => { streaming = false; }, error: d => { streaming = false; failed = d.message ?? "Could not write the audio."; },
    });
    return () => { stop(); cancel?.(); };
  });
  // the next sentence starts when the last one ends and the stream has delivered it
  let speaking = false;
  function next() {
    // nothing speaks without the natural voice; while it is being offered or fetched, playing waits
    if (!playing || speaking || natural.offer || !canSpeak(lang)) return;
    if (i >= lines.length) { if (!streaming) { playing = false; i = 0; } return; }
    speaking = true;
    cancel = say(lines[i], lang, () => { speaking = false; i++; next(); }, lines.slice(i + 1, i + 4), { onfail: () => { speaking = false; playing = false; held = true; } });
  }
  $effect(() => { lines.length; natural.offer; natural.status; if (playing) next(); });
  // opening Audio is the moment to offer the natural voice (it starts playing by itself, so not only on the button)
  offer(lang);
  function toggle() { if (playing) { playing = false; speaking = false; cancel?.(); } else { held = false; offer(lang); playing = true; next(); } }
  const pct = $derived(lines.length ? Math.min(100, (i / Math.max(lines.length, 1)) * 100) : 0);
</script>

<div class="story-audio" role="region" aria-label="Story as audio">
  <button class="play" type="button" onclick={toggle} disabled={(!lines.length && !streaming) || !canSpeak(lang)} aria-label={playing && canSpeak(lang) ? "Pause" : "Play"}>{@html playing && canSpeak(lang) ? I.pause : I.play}</button>
  <div class="mid">
    <b>{failed ? "Audio failed" : !canSpeak(lang) ? "Needs the natural voice" : held ? "Tap play to listen" : streaming && !lines.length ? "Claude is writing the script…" : playing && natural.phase ? "Making the voice…" : playing ? "Playing" : i ? "Paused" : "Ready"}</b>
    <span class="bar"><i style:width="{pct}%"></i></span>
    <small>{failed || (lines[i] ?? (streaming ? "" : "Done"))}</small>
    <VoiceTag {lang} {playing} note={reading !== "en" ? "in English" : ""} />
  </div>
  <button class="icon-btn" type="button" aria-label="Close audio" onclick={() => { cancel?.(); onclose(); }}>{@html I.x}</button>
</div>
<VoiceNeeded {lang} />
