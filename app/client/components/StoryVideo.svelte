<script lang="ts">
  // The story as a short vertical video. Claude writes 5 to 7 scenes (shared/storyboard.ts): a caption, a spoken line and
  // a visual chosen from what peppermint has for the story: a number that counts up, a chart that builds, the article's
  // own figure with its caption, a quote, the portrait of a person or place, values side by side, or the story's photo.
  // Like stories elsewhere: the bar on top fills while a scene plays; tap the right half for the next scene, the left
  // half for the previous one; hold anywhere to pause, let go to go on. Keys: arrows, Space, Escape.
  import { sse } from "../lib/api";
  import { I } from "../lib/icons";
  import { say, rate, pauseSpeech, resumeSpeech } from "../lib/speech";
  import { natural, offer } from "../lib/voice.svelte";
  import VoiceNeeded from "./VoiceNeeded.svelte";
  import VoiceTag from "./VoiceTag.svelte";
  import { scenesOf, countable, type Visual } from "../../shared/storyboard";
  import Mark from "./Mark.svelte";
  import ChartView from "./Chart.svelte";
  import { animate } from "../lib/motion";
  type Person = { name: string; img: string; description?: string | null };
  type Figure = { src: string; caption: string };
  let { id, lang, title, source, image = null, people = [], figures = [], from = null, onclose }: {
    id: number; lang: "en" | "de"; title: string; source: string; image?: string | null; people?: Person[]; figures?: Figure[];
    /** where the Video button was: the frame grows out of it */
    from?: DOMRect | null; onclose: () => void;
  } = $props();
  let frameEl: HTMLElement | undefined = $state(), backdrop: HTMLElement | undefined = $state();
  $effect(() => {
    if (!frameEl) return;
    animate(backdrop!, [{ opacity: 0 }, { opacity: 1 }], { ms: 260, easing: "ease-out" });
    if (!from) { animate(frameEl, [{ transform: "scale(.92)", opacity: 0 }, { transform: "none", opacity: 1 }]); return; }
    const r = frameEl.getBoundingClientRect();
    const dx = from.left + from.width / 2 - (r.left + r.width / 2), dy = from.top + from.height / 2 - (r.top + r.height / 2);
    animate(frameEl, [{ transform: `translate(${dx}px, ${dy}px) scale(${Math.max(.08, from.width / r.width)})`, borderRadius: "99px", opacity: .4 }, { transform: "none", borderRadius: "22px", opacity: 1 }]);
  });

  let raw = $state(""), streaming = $state(true), failed = $state(""), i = $state(0), playing = $state(true), held = $state(false);
  let cancel: (() => void) | null = null, speaking = false;
  const scenes = $derived(scenesOf(raw, streaming));
  $effect(() => {
    const stop = sse(`/api/stories/${id}/lens/video?lang=${lang}&level=2`, {
      delta: d => { raw += d.t; }, done: () => { streaming = false; }, error: d => { streaming = false; failed = d.message ?? "Could not write the video."; },
    });
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); if (e.key === "ArrowRight") step(1); if (e.key === "ArrowLeft") step(-1); if (e.key === " ") { e.preventDefault(); toggle(); } };
    addEventListener("keydown", key);
    return () => { stop(); cancel?.(); cancelAnimationFrame(raf); removeEventListener("keydown", key); };
  });

  // ---- progress of the current scene: estimated from its words and the voice rate, frozen while paused, full when the
  // voice actually finishes (the estimate never reaches the end on its own) ----
  let prog = $state(0), t0 = 0, acc = 0, est = 3, raf = 0;
  const tickProg = () => {
    if (playing && !held && speaking) prog = Math.min(0.97, (acc + (performance.now() - t0) / 1000) / est);
    raf = requestAnimationFrame(tickProg);
  };
  $effect(() => { raf = requestAnimationFrame(tickProg); return () => cancelAnimationFrame(raf); });

  function next() {
    if (!playing || speaking || held || natural.offer) return;
    if (i >= scenes.length) { if (!streaming) playing = false; return; }
    speaking = true; prog = 0; acc = 0; t0 = performance.now();
    est = Math.max(1.6, ((scenes[i].line.match(/\S+/g)?.length ?? 1) / 2.55) / rate());
    cancel = say(scenes[i].line, lang, () => {
      speaking = false; prog = 1;
      if (i < scenes.length - 1 || streaming) { i++; next(); } else playing = false;
    }, scenes.slice(i + 1, i + 4).map(s => s.line), { silent: true }); // without the voice the captions carry the scene
  }
  $effect(() => { scenes.length; natural.offer; if (playing) next(); });
  function step(d: number) { cancel?.(); speaking = false; held = false; i = Math.max(0, Math.min(scenes.length - 1, i + d)); playing = true; next(); }

  // pause keeps the place: the voice pauses mid-sentence and the bar stops where it is
  function pause() {
    if (!playing) return;
    playing = false; acc += (performance.now() - t0) / 1000;
    if (!pauseSpeech()) { cancel?.(); speaking = false; }
  }
  offer(lang);
  function resume() {
    if (playing) return;
    if (i >= scenes.length - 1 && !streaming && !speaking) { i = 0; playing = true; next(); return; }
    playing = true; t0 = performance.now();
    if (!(speaking && resumeSpeech())) { speaking = false; next(); }
  }
  const toggle = () => (playing ? pause() : resume());
  function close() { cancel?.(); onclose(); }

  // a press longer than a quarter second is a hold (pause until release); a shorter one is a tap (left back, right on)
  let pressT: ReturnType<typeof setTimeout> | undefined, pressX = 0, wasPlaying = false;
  function down(e: PointerEvent) {
    if (e.button !== 0) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); pressX = (e.clientX - r.left) / r.width;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    wasPlaying = playing;
    pressT = setTimeout(() => { held = true; if (wasPlaying) pause(); }, 250);
  }
  function up() {
    clearTimeout(pressT);
    if (held) { held = false; if (wasPlaying) resume(); return; }
    step(pressX < 0.5 ? -1 : 1);
  }
  const cancelPress = () => { clearTimeout(pressT); if (held) { held = false; if (wasPlaying) resume(); } };

  // ---- what a scene shows; anything that points at material we do not have falls back to the photo ----
  const scene = $derived(scenes[Math.min(i, scenes.length - 1)]);
  const findPerson = (name: string | null) => {
    if (!name) return null;
    const n = name.toLowerCase(), last = (s: string) => s.split(" ").at(-1)!.toLowerCase();
    return people.find(p => p.name.toLowerCase() === n || n.includes(p.name.toLowerCase()) || (last(p.name).length >= 4 && last(p.name) === last(name))) ?? null;
  };
  type Shown = { kind: "picture" | "plain" } | Exclude<Visual, { kind: "picture" | "figure" | "person" }> | { kind: "figure"; fig: Figure; n: number } | { kind: "person"; p: Person };
  const shown = $derived.by((): Shown => {
    const v = scene?.visual;
    const photo: Shown = image ? { kind: "picture" } : { kind: "plain" };
    if (!v || v.kind === "picture") return photo;
    if (v.kind === "figure") { const fig = figures[v.n - 1]; return fig ? { kind: "figure", fig, n: v.n } : photo; }
    if (v.kind === "person") { const p = findPerson(v.name); return p ? { kind: "person", p } : photo; }
    return v;
  });
  // on a photo scene, the person or place it names appears as a small portrait
  const who = $derived(scene && shown.kind === "picture" ? people.find(p => `${scene.caption} ${scene.line}`.toLowerCase().includes(p.name.toLowerCase())) ?? null : null);
  const quoteBy = $derived(shown.kind === "quote" ? findPerson(shown.by) : null);
  const bars = $derived.by(() => {
    if (shown.kind !== "compare") return null;
    const ns = shown.items.map(x => countable(x.value)?.n ?? NaN);
    const max = Math.max(...ns.map(Math.abs));
    return ns.every(Number.isFinite) && max > 0 ? ns.map(n => Math.abs(n) / max) : null;
  });

  // numbers count up from zero once per scene, in the notation Claude used, ending on its exact digits; a unit that is
  // a word ("steps", "Mrd. €") sits smaller under the number instead of wrapping it
  const unitIsWord = (post: string) => /\p{L}{2,}/u.test(post);
  function countUp(node: HTMLElement, value: string) {
    const c = countable(value);
    if (!c || matchMedia("(prefers-reduced-motion: reduce)").matches) { if (c) node.textContent = c.num; return; }
    const nf = new Intl.NumberFormat(c.comma ? "de-DE" : "en-US", { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals });
    let r = 0; const start = performance.now(), dur = 1100;
    const frame = (t: number) => {
      const k = Math.min(1, (t - start) / dur), e = 1 - (1 - k) ** 3;
      node.textContent = k < 1 ? nf.format(c.n * e) : c.num;
      if (k < 1) r = requestAnimationFrame(frame);
    };
    r = requestAnimationFrame(frame);
    return { destroy: () => cancelAnimationFrame(r) };
  }
</script>

{#snippet amount(value: string)}
  {@const c = countable(value)}
  {#if c}{c.pre}<span use:countUp={value}>{c.num}</span>{#if c.post}{#if unitIsWord(c.post)}<small class="unit">{c.post.trim()}</small>{:else}{c.post}{/if}{/if}{:else}{value}{/if}
{/snippet}

<div class="story-video" role="dialog" aria-modal="true" aria-label="Story as video" bind:this={backdrop}>
  <div bind:this={frameEl} class="frame hue{i % 4} kind-{shown.kind}" class:has-image={shown.kind === "picture"} class:held>
    {#if shown.kind === "picture" && image}
      <img class="bg-blur" src={image} alt="" draggable="false" />
      <span class="pic-frame">{#key i}<img class="bg kb{i % 4}" src={image} alt="" draggable="false" style:animation-play-state={playing ? "running" : "paused"} />{/key}</span>
    {:else if shown.kind === "person"}
      <img class="bg-blur" src={shown.p.img} alt="" draggable="false" />
    {/if}
    <span class="shade" aria-hidden="true"></span>
    <div class="segs" class:waiting={!scenes.length && !failed}>
      {#each Array(Math.max(scenes.length, 5)) as _, k}<i><b style:width="{k < i ? 100 : k === i && scenes.length ? prog * 100 : 0}%"></b></i>{/each}
    </div>

    <div class="visual" aria-hidden={shown.kind === "picture" || shown.kind === "plain"}>
      {#if scene}{#key i}
        {#if shown.kind === "stat"}
          <div class="v-stat"><b>{@render amount(shown.value)}</b>{#if shown.label}<span>{shown.label}</span>{/if}</div>
        {:else if shown.kind === "chart"}
          <div class="v-chart on-dark"><ChartView chart={shown.chart} {lang} compact />{#if shown.chart.title}<small>{shown.chart.title}</small>{/if}</div>
        {:else if shown.kind === "figure"}
          <figure class="v-figure"><img src={shown.fig.src} alt={shown.fig.caption} draggable="false" style:animation-play-state={playing ? "running" : "paused"} />{#if shown.fig.caption}<figcaption>{shown.fig.caption}</figcaption>{/if}</figure>
        {:else if shown.kind === "quote"}
          <blockquote class="v-quote"><span class="mark" aria-hidden="true">“</span><p>{shown.text}</p>
            {#if shown.by}<footer>{#if quoteBy}<img src={quoteBy.img} alt="" />{/if}<span>{shown.by}</span></footer>{/if}</blockquote>
        {:else if shown.kind === "person"}
          <div class="v-person"><img src={shown.p.img} alt="" draggable="false" /><b>{shown.p.name}</b>{#if shown.p.description}<span>{shown.p.description}</span>{/if}</div>
        {:else if shown.kind === "compare"}
          <div class="v-compare" style:--n={shown.items.length}>
            {#each shown.items as it, k}
              <div class="cmp" style:--d="{k * 0.18}s"><b>{@render amount(it.value)}</b>{#if bars}<i style:--h={bars[k]}></i>{/if}<span>{it.label}</span></div>
            {/each}
          </div>
        {/if}
      {/key}{/if}
    </div>

    <div class="stage" aria-live="polite">
      {#if failed}<b class="cap">{failed}</b>
      {:else if !scene}<Mark cls="anim loading" label="" /><small class="wait">Claude is writing the scenes…</small>
      {:else}{#key i}
        {#if who}<span class="who"><img src={who.img} alt="" draggable="false" /><small>{who.name}</small></span>{/if}
        <b class="cap">{scene.caption}</b><span class="line">{scene.line}</span>
      {/key}{/if}
    </div>
    <div class="foot"><span class="src">{source}</span><span class="ttl">{title}</span></div>
    <div class="sv-silent"><VoiceNeeded {lang} /></div>
    <div class="sv-voice"><VoiceTag {lang} {playing} /></div>
    <button class="tapper" type="button" aria-label="Tap right for the next scene, left for the previous one; hold to pause"
      onpointerdown={down} onpointerup={up} onpointercancel={cancelPress} oncontextmenu={(e) => e.preventDefault()}
      onclick={(e) => { if (e.detail === 0) toggle(); }}></button>
    {#if !playing && scene && !held}<span class="paused" aria-hidden="true">{@html I.play}</span>{/if}
  </div>
  <button class="icon-btn close" type="button" aria-label="Close video" onclick={close}>{@html I.x}</button>
</div>
