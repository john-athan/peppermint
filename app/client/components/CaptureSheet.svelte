<script lang="ts">
  // One screen to start an investigation: photos, where and when, and a few words. Everything is
  // prepared on the device (location read from the photo, then the photo shrunk and stripped of its metadata) before
  // anything is sent. "Investigate" hands it to peppermint and opens the case file while it works.
  import { untrack } from "svelte";
  import Sheet from "./Sheet.svelte";
  import { capture } from "../lib/capture.svelte";
  import { app, go, toast } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { I } from "../lib/icons";
  import { here, prepare, type Prepared } from "../lib/photo";
  import { enablePush, push, checkPush } from "../lib/push.svelte";
  import type { Investigation } from "../../shared/types";

  let shots = $state<Prepared[]>([]), note = $state(""), busy = $state(false), reading = $state(0);
  let where = $state<{ lat: number; lng: number; from: "photo" | "device" } | null>(null), placeName = $state(""), locating = $state(false);
  let notify = $state(true), listening = $state(false);
  const when = $derived(shots.find(s => s.takenAt)?.takenAt ?? null);

  // opening takes what came along (shared photos, a reader's tip); closing clears the sheet for next time
  $effect(() => {
    const open = capture.open;
    untrack(() => {
      if (open) {
        checkPush().then(p => (notify = !p.on && p.supported && !p.denied));
        const files = capture.files; capture.files = [];
        if (capture.note) { note = capture.note; capture.note = ""; }
        if (files.length) add(files);
      } else { for (const s of shots) URL.revokeObjectURL(s.url); shots = []; note = ""; where = null; placeName = ""; }
    });
  });

  async function add(files: FileList | File[]) {
    const list = [...files].filter(f => f.type.startsWith("image/") || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)).slice(0, 4 - shots.length);
    reading += list.length;
    for (const f of list) {
      try {
        const p = await prepare(f); shots = [...shots, p];
        if (!where && p.lat != null && p.lng != null) setWhere(p.lat, p.lng, "photo");
      } catch (e) { toast((e as Error).message); }
      finally { reading--; }
    }
    if (!where) locate();
  }
  async function locate() {
    if (locating) return; locating = true;
    const p = await here(); locating = false;
    if (p) setWhere(p.lat, p.lng, "device");
  }
  async function setWhere(lat: number, lng: number, from: "photo" | "device") {
    where = { lat, lng, from }; placeName = "";
    try { const r = await api<{ place: { name: string; detail: string } | null }>(`/api/place?lat=${lat}&lng=${lng}`); // the place and its street are often the same name: each part once
      placeName = [...new Set([r.place?.name, ...(r.place?.detail ?? "").split(", ")].map(x => x?.trim()).filter(Boolean))].join(", "); } catch {}
  }
  function drop(i: number) { URL.revokeObjectURL(shots[i].url); shots = shots.filter((_, k) => k !== i); }

  // dictation where the browser has it (Chrome, Safari): words land in the note as you speak
  const Rec = typeof window !== "undefined" ? (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition : null;
  let rec: any = null;
  function dictate() {
    if (listening) { rec?.stop(); return; }
    rec = new Rec(); rec.lang = /[äöüß]/i.test(note) || app.lang === "de" || navigator.language.startsWith("de") ? "de-DE" : "en-GB"; rec.interimResults = false; rec.continuous = true;
    rec.onresult = (e: any) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) note = `${note.trim()} ${e.results[i][0].transcript.trim()}`.trim(); };
    rec.onend = () => (listening = false); rec.onerror = () => (listening = false);
    rec.start(); listening = true;
  }

  async function investigate() {
    if (busy) return;
    if (!shots.length && note.trim().length < 8) return toast("Add a photo or a few words about what you noticed.");
    busy = true;
    try {
      if (notify) await enablePush().then(m => { if (!push.on) toast(m, { ms: 5000 }); }).catch(() => {});
      const f = new FormData();
      f.set("note", note.trim());
      if (where) { f.set("lat", String(where.lat)); f.set("lng", String(where.lng)); }
      for (const s of shots) { f.append("photo", s.blob, "photo.jpg"); f.append("taken_at", String(s.takenAt ?? "")); }
      const r = await api<{ case: Investigation }>("/api/cases", { method: "POST", body: f });
      capture.open = false;
      go(`/studio/case/${r.case.id}`);
      toast(push.on ? "Investigating. You get a notification when it is ready." : "Investigating. It is ready in about 20 minutes.");
    } catch (e) { toast((e as Error).message); }
    finally { busy = false; }
  }
  // the interface is English, so its dates are too (the note and the piece keep their own language)
  const hhmm = (t: number) => new Date(t).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  // a camera tile only where there is a camera to open (phones, tablets); a computer gets one tile and drag and drop
  const touch = typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches;
  let dragging = $state(false);
  function dropped(e: DragEvent) { e.preventDefault(); dragging = false; if (e.dataTransfer?.files.length) add(e.dataTransfer.files); }
</script>

<Sheet bind:open={capture.open} label="New investigation">
  <div class="cap" class:dragging role="group" aria-label="New investigation" ondragover={(e) => { e.preventDefault(); dragging = true; }} ondragleave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dragging = false; }} ondrop={dropped}>
    <h3>New investigation</h3>
    <p class="sub">A photo and a few words. peppermint finds out the rest and writes it in your voice.</p>

    <div class="cap-shots" aria-label="Photos">
      {#each shots as s, i (s.url)}
        <figure class="cap-shot"><img src={s.url} alt="Photo {i + 1}" /><button class="cap-x" type="button" aria-label="Remove photo {i + 1}" onclick={() => drop(i)}>{@html I.x}</button></figure>
      {/each}
      {#each Array(reading) as _}<div class="cap-shot cap-wait" aria-label="Reading a photo"></div>{/each}
      {#if shots.length + reading < 4}
        {#if touch}
          <label class="cap-add"><input type="file" accept="image/*" capture="environment" onchange={(e) => { add((e.currentTarget as HTMLInputElement).files!); (e.currentTarget as HTMLInputElement).value = ""; }} />{@html I.camera}<span>Camera</span></label>
          <label class="cap-add"><input type="file" accept="image/*" multiple onchange={(e) => { add((e.currentTarget as HTMLInputElement).files!); (e.currentTarget as HTMLInputElement).value = ""; }} />{@html I.image}<span>Photos</span></label>
        {:else}
          <label class="cap-add cap-drop"><input type="file" accept="image/*" multiple onchange={(e) => { add((e.currentTarget as HTMLInputElement).files!); (e.currentTarget as HTMLInputElement).value = ""; }} />{@html I.image}<span>{shots.length ? "Add more" : "Add photos"}</span><small>or drop them here · up to 4</small></label>
        {/if}
      {/if}
    </div>

    <div class="cap-facts">
      <div class="cap-fact">{@html I.place}
        {#if where}<span><b>{placeName || "Location found"}</b><small>{where.from === "photo" ? "from the photo" : "where you are now"}</small></span><button class="link-btn" type="button" onclick={() => { where = null; placeName = ""; }}>Remove</button>
        {:else if locating}<span><b>Finding where you are…</b></span>
        {:else}<span><b>No location</b><small>peppermint finds the place from the photo and your note</small></span><button class="link-btn" type="button" onclick={locate}>Use where I am</button>{/if}
      </div>
      <div class="cap-fact">{@html I.clock}<span><b>{hhmm(when ?? Date.now())}</b><small>{when ? "when the photo was taken" : "now"}</small></span></div>
    </div>

    <label class="cap-label" for="cap-note">What did you notice?</label>
    <div class="cap-note">
      <textarea id="cap-note" bind:value={note} rows="4" maxlength="4000" placeholder="The floor on the lower platform shines since two days. It was dull stone grey for as long as I live here. Only down there, not upstairs."></textarea>
      {#if Rec}<button class="ghost sm cap-mic" type="button" aria-pressed={listening} onclick={dictate}>{@html I.voice}{listening ? "Listening… tap to stop" : "Speak instead"}</button>{/if}
    </div>


    {#if notify}
      <label class="cap-notify"><input type="checkbox" bind:checked={notify} /><span>{@html I.bell}Notify me on this device when it is ready</span></label>
    {/if}

    <button class="primary full mt-m" type="button" disabled={busy || reading > 0} onclick={investigate}>{@html I.search}{busy ? "Sending…" : "Investigate"}</button>
    <p class="cap-eta">About 20 minutes. You can close the app.</p>
  </div>
</Sheet>
