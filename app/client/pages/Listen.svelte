<script lang="ts">
  import Link from "../components/Link.svelte";
  // The edition as an episode. The script streams in from the server (Claude, or assembled locally);
  // the natural voice reads it sentence by sentence, so seeking, speed and chapters need no audio file.
  import { app, go } from "../lib/state.svelte";
  import { sse } from "../lib/api";
  import { I } from "../lib/icons";
  import { dayLabel } from "../lib/format";
  import Mark from "../components/Mark.svelte";
  import Sheet from "../components/Sheet.svelte";
  import { store, say } from "../lib/speech";
  import { natural, canSpeak, offer } from "../lib/voice.svelte";
  import VoiceNeeded from "../components/VoiceNeeded.svelte";
  import VoiceTag from "../components/VoiceTag.svelte";

  type Part = { kind: "intro" | "story" | "outro"; id?: number; title: string; sources: string[]; text: string };
  type Sent = { part: number; text: string; start: number; dur: number };

  let lang = $state<"en" | "de">((store.get("pm-listen-lang") as any) ?? "en");
  let raw = $state(""), streaming = $state(false), model = $state(""), failed = $state(""), meta = $state<any>(null), noEdition = $state(false);
  let rate = $state(Number(store.get("pm-rate") ?? 1) || 1);
  let idx = $state(0), playing = $state(false), elapsed = $state(0), voiceOpen = $state(false);

  // ---- script ----
  let stop: (() => void) | null = null;
  function load() {
    stop?.(); halt(); raw = ""; failed = ""; model = ""; noEdition = false; idx = 0; elapsed = 0; streaming = true;
    stop = sse(`/api/listen?lang=${lang}`, {
      open: d => { meta = d; },
      delta: d => { raw += d.t; },
      done: d => { streaming = false; model = d.model; },
      error: d => { streaming = false; if (d.code === "network" && !raw) noEdition = true; else failed = d.message; },
    });
  }
  $effect(() => { load(); return () => { stop?.(); halt(); }; });

  const parts = $derived.by(() => {
    const out: Part[] = [];
    for (const chunk of raw.split(/^@/m).slice(1)) {
      const nl = chunk.indexOf("\n"); if (nl < 0) continue;
      const head = chunk.slice(0, nl).trim(), text = chunk.slice(nl + 1).trim();
      const m = /^story\s+(\d+)/.exec(head);
      if (m) { const st = meta?.stories?.find((s: any) => s.id === Number(m[1])); out.push({ kind: "story", id: Number(m[1]), title: st?.title ?? "Story", sources: st?.sources ?? [], text }); }
      else if (head === "intro" || head === "outro") out.push({ kind: head, title: head === "intro" ? (lang === "de" ? "Begrüßung" : "Intro") : (lang === "de" ? "Abschied" : "Outro"), sources: [], text });
    }
    return out;
  });
  // only finished sentences are playable while the script still streams
  const sents = $derived.by(() => {
    const out: Sent[] = []; let t = 0;
    parts.forEach((p, pi) => {
      const ss = p.text.match(/[^.!?…]+[.!?…]+["“”»«)]*|[^.!?…]+$/g) ?? [];
      ss.forEach((s, si) => {
        const text = s.trim(); if (!text) return;
        const last = pi === parts.length - 1 && si === ss.length - 1;
        if (streaming && last && !/[.!?…]["“”»«)]*$/.test(text)) return;
        const dur = Math.max(1.2, (text.match(/\S+/g)?.length ?? 1) / 2.55);
        out.push({ part: pi, text, start: t, dur }); t += dur;
      });
    });
    return out;
  });
  const total = $derived(sents.length ? sents[sents.length - 1].start + sents[sents.length - 1].dur : 0);
  const now = $derived(sents[idx] ? sents[idx].start + Math.min(elapsed, sents[idx].dur) : total);
  const curPart = $derived(sents[idx]?.part ?? -1);
  const chapters = $derived(parts.map((p, i) => ({ ...p, i, start: sents.find(s => s.part === i)?.start ?? null })));


  // ---- playback ----
  let timer: ReturnType<typeof setInterval> | undefined, began = 0, token = 0;
  let cancelSay: (() => void) | null = null;
  function speak(i: number) {
    if (!sents[i]) { if (!streaming) halt(); return; }
    const my = ++token;
    cancelSay?.();
    began = performance.now();
    cancelSay = say(sents[i].text, lang, () => {
      if (my !== token || !playing) return;
      if (idx + 1 < sents.length) { idx++; elapsed = 0; speak(idx); } else if (streaming) { idx++; elapsed = 0; waitMore(); } else { halt(); idx = 0; elapsed = 0; }
    }, sents.slice(i + 1, i + 4).map(s => s.text));
  }
  let pendingPlay = false;
  $effect(() => { if (!natural.offer && pendingPlay) { pendingPlay = false; play(); } });
  function waitMore() { const t = setInterval(() => { if (!playing) return clearInterval(t); if (sents[idx]) { clearInterval(t); speak(idx); } else if (!streaming) { clearInterval(t); halt(); } }, 300); }
  function play() {
    if (!sents.length) return;
    offer(lang);
    // the download question comes first; playing starts once it is answered
    if (natural.offer) { pendingPlay = true; return; }
    if (idx >= sents.length) idx = 0;
    playing = true; elapsed = 0; speak(idx);
    clearInterval(timer); timer = setInterval(() => { if (playing) elapsed = ((performance.now() - began) / 1000) * rate; }, 200);
    media();
  }
  function halt() { playing = false; token++; cancelSay?.(); clearInterval(timer); }
  function seek(sec: number) {
    const i = Math.max(0, sents.findLastIndex(s => s.start <= sec));
    idx = i; elapsed = 0; if (playing) speak(i);
  }
  const chapter = (d: 1 | -1) => { const target = chapters.filter(c => c.start != null && (d > 0 ? c.i > curPart : c.i < curPart)); const c = d > 0 ? target[0] : target[target.length - 1]; if (c) seek(c.start!); };
  const speeds = [0.8, 1, 1.2, 1.5, 1.8];
  function cycleSpeed() { rate = speeds[(speeds.indexOf(rate) + 1) % speeds.length] ?? 1; store.set("pm-rate", String(rate)); if (playing) speak(idx); }
  function setLang(l: "en" | "de") { if (l === lang) return; lang = l; store.set("pm-listen-lang", l); load(); }

  // lock screen and headset buttons, where the browser supports them for speech
  function media() {
    const ms = (navigator as any).mediaSession; if (!ms) return;
    try {
      ms.metadata = new (window as any).MediaMetadata({ title: `${meta?.slot === "evening" ? "Evening" : "Morning"} edition`, artist: "peppermint", album: meta?.day ?? "" });
      ms.setActionHandler("play", play); ms.setActionHandler("pause", halt);
      ms.setActionHandler("nexttrack", () => chapter(1)); ms.setActionHandler("previoustrack", () => chapter(-1));
    } catch {}
  }

  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  // the wave: one bar per slice of time, height from how much is said in it
  const BARS = 72;
  const bars = $derived.by(() => {
    if (!total) return Array.from({ length: BARS }, () => 0.15);
    return Array.from({ length: BARS }, (_, b) => {
      const t = (b + 0.5) / BARS * total; const s = sents.find(x => t >= x.start && t < x.start + x.dur);
      const h = s ? 0.35 + ((s.text.length * 7 + b * 13) % 23) / 40 : 0.12;
      return Math.min(1, h);
    });
  });
  let waveEl: HTMLDivElement | undefined = $state();
  function waveClick(e: PointerEvent) { if (!waveEl || !total) return; const r = waveEl.getBoundingClientRect(); seek(((e.clientX - r.left) / r.width) * total); }
  function waveKey(e: KeyboardEvent) { if (e.key === "ArrowRight") { seek(now + 10); e.preventDefault(); } if (e.key === "ArrowLeft") { seek(now - 10); e.preventDefault(); } }
  $effect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === " " && !(e.target as HTMLElement)?.closest("input, button, [contenteditable], [role=slider]")) { e.preventDefault(); playing ? halt() : play(); } };
    addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey);
  });
  // keep the spoken sentence in view inside the transcript
  let trEl: HTMLDivElement | undefined = $state();
  $effect(() => { idx; const el = trEl?.querySelector("p.on") as HTMLElement | null; if (el && trEl) trEl.scrollTo({ top: el.offsetTop - trEl.clientHeight / 3, behavior: "smooth" }); });
</script>

<div class="page listen">
  <header class="appbar">
    <h1>Listen</h1><span class="sp"></span>
    {#if streaming && app.online}<span class="sse-badge live"><i></i>writing</span>{:else if model}<span class="sse-badge" title="Script by {model}">{model === "local" ? "local script" : "Claude script"} · {lang.toUpperCase()}</span>{/if}
    <button class="icon-btn" type="button" aria-label="Voice and language" onclick={() => (voiceOpen = true)}>{@html I.voice}</button>
  </header>

  {#if !raw && !app.online}
    <div class="empty"><Mark cls="anim" label="" /><b>Listen needs a connection</b><span>Claude writes the script on the server. It starts when you are back online.</span></div>
  {:else if noEdition && !raw}
    <div class="empty"><Mark cls="anim" label="" /><b>Nothing to listen to yet</b><span>Listen reads the latest edition. Harvest first.</span><button class="ghost" type="button" onclick={() => go("/")}>Go to Today</button></div>
  {:else}
    <VoiceNeeded {lang} />
    <p class="mt-xs"><VoiceTag {lang} {playing} /></p>
    <div class="listen-grid">
      <div>
        <div class="cover" class:playing>
          <Mark cls={playing ? "record" : ""} label="" />
          <div class="ep"><span>{meta?.slot === "evening" ? "Evening" : "Morning"} edition</span><span>{meta?.day ? dayLabel(meta.day) : ""}</span></div>
        </div>
        <div class="wave" bind:this={waveEl} role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax={Math.round(total)} aria-valuenow={Math.round(now)} aria-valuetext={fmt(now)} onpointerdown={waveClick} onkeydown={waveKey}>
          {#each bars as h, b}<i class:p={total && (b + 0.5) / BARS * total <= now} style:height="{Math.round(h * 100)}%"></i>{/each}
        </div>
        <div class="times"><span>{fmt(now)}</span><span>{streaming ? "~" : ""}{fmt(total)}</span></div>
        <div class="controls">
          <button class="sm" type="button" onclick={cycleSpeed} aria-label="Speed {rate}×">{rate.toFixed(1)}×</button>
          <button class="sm" type="button" onclick={() => seek(now - 15)} aria-label="Back 15 seconds">−15</button>
          <button class="play" type="button" onclick={() => (playing ? halt() : play())} disabled={!sents.length || !canSpeak(lang)} aria-label={playing ? "Pause" : "Play"}>{@html playing ? I.pause : I.play}</button>
          <button class="sm" type="button" onclick={() => seek(now + 30)} aria-label="Forward 30 seconds">+30</button>
          <button class="sm" type="button" onclick={() => chapter(1)} aria-label="Next story">Next</button>
        </div>
        {#if failed}<div class="notice"><b>Could not finish the script</b><span>{failed}</span><button class="ghost" type="button" onclick={load}>Try again</button></div>{/if}
      </div>
      <div>
        <div class="group-label">Chapters</div>
        <div class="chapters">
          {#each chapters as c (c.i)}
            <button class="chap" class:on={c.i === curPart} type="button" data-item disabled={c.start == null} onclick={() => { seek(c.start!); if (!playing) play(); }}>
              <time>{c.start != null ? fmt(c.start) : "…"}</time><span>{c.title}{#if c.sources.length}<small>{c.sources.join(" · ")}</small>{/if}</span>
              {#if c.kind === "story"}<Link href="/story/{c.id}" aria-label="Read {c.title}" stop>{@html I.orig}</Link>{:else}<span></span>{/if}
            </button>
          {:else}
            {#each Array(5) as _}<div class="chap skeleton"><time></time><span></span></div>{/each}
          {/each}
        </div>
        <div class="group-label">Transcript</div>
        <div class="transcript" bind:this={trEl}>
          {#each sents as s, i}
            {#if i === 0 || sents[i - 1].part !== s.part}<b class="tr-head">{parts[s.part]?.title}</b>{/if}
            <p class:on={i === idx && (playing || now > 0)} onclick={() => seek(s.start)}>{s.text}</p>
          {/each}
          {#if streaming}<p class="cursor">&nbsp;</p>{/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<Sheet bind:open={voiceOpen} label="Voice and language">
  <h3>Voice</h3>
  <p class="sub">The natural voice (Kokoro, the voice of the podcasts) is made on this device and works offline. It speaks English.</p>
  <span class="lbl">Language</span>
  <div class="seg"><button type="button" aria-pressed={lang === "en"} onclick={() => setLang("en")}>English</button><button type="button" aria-pressed={lang === "de"} onclick={() => setLang("de")}>Deutsch</button></div>
  <span class="lbl">Speed</span>
  <div class="seg">{#each speeds as s}<button type="button" aria-pressed={rate === s} onclick={() => { rate = s; store.set("pm-rate", String(s)); if (playing) speak(idx); }}>{s.toFixed(1)}×</button>{/each}</div>
  <VoiceNeeded {lang} />
</Sheet>
