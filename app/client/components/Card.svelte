<script lang="ts" module>
  // a long press reorders the list under the finger; the tap the browser sends on release must not open whatever card lands there
  let quietUntil = 0;
  // at most four briefs stream at once: a story being researched can hold its stream for a while, and the page's own
  // requests must never queue behind the cards (a browser opens only six connections per site over HTTP/1.1)
  let free = 4;
  const waiting: (() => void)[] = [];
  const take = () => new Promise<void>(r => { if (free > 0) { free--; r(); } else waiting.push(r); });
  const give = () => { const next = waiting.shift(); if (next) next(); else free++; };
</script>

<script lang="ts">
  // A story on Today: where it comes from, the headline, and a brief Claude wrote in your language and style.
  // Tap to read. − (or swipe left) dismisses, the bookmark (or a long press) saves it to the reading list, ⋯ shows why it is here.
  import { app, go, type Card } from "../lib/state.svelte";
  import { sse } from "../lib/api";
  import { ago } from "../lib/format";
  import { I } from "../lib/icons";
  import { viewed } from "../lib/viewed";
  import { animate, flyTo, haptic } from "../lib/motion";
  import Fav from "./Fav.svelte";
  import Skeleton from "./Skeleton.svelte";
  import Loading from "./Loading.svelte";
  import Pic from "./Pic.svelte";
  import ChartView from "./Chart.svelte";
  import Emblem from "./Emblem.svelte";
  import { emblemFor } from "../../shared/emblem";
  import { heroChart, withoutCharts } from "../../shared/chart";

  // `big`: the Today feed, one large card per screen with a strip of pictures; the list and history keep compact cards
  let { card, ontune, ondismiss, onpin, track = true, dismissLabel = "Dismiss", big: bigFeed = false }: { card: Card; ontune: (c: Card) => void; ondismiss: (c: Card) => void; onpin: (c: Card) => void; track?: boolean; dismissLabel?: string; big?: boolean } = $props();

  const favs = $derived(card.sources.filter((s, i) => s.kind === "feed" || card.sources.findIndex(x => x.kind === s.kind) === i).slice(0, 3));
  const label = $derived(card.sources.length > 1 ? `${card.sources[0].name} + ${card.sources.length - 1}` : card.sources[0]?.name + (card.meta?.section ? ` · ${card.meta.section}` : card.meta?.site && card.sources[0]?.kind === "hackernews" ? ` · ${card.meta.site}` : card.authors[0] ? ` · ${card.authors[0]}` : ""));
  // layout D: a wide picture runs across the top of the card, a square one sits beside the text, a tall one waits for the reader
  // research found nothing to read behind the headline: a slim card with the way to the original and no brief. It keeps
  // the article's picture only when the server already holds a wide copy (a paywalled feed such as ZEIT still sends one)
  let none = $state(false);
  const slim = $derived(!!card.unreadable || none);
  const big = $derived(bigFeed && !slim);
  const img = $derived(!slim ? card.image ?? null : card.image && !card.image.pending && card.image.shape === "wide" ? card.image : null);
  // the server may only guess the shape while its copy is still on the way; the loaded picture settles it
  let real = $state<null | "wide" | "square" | "none">(null);
  const shape = $derived(!img ? null : real ?? (img.shape === "tall" ? "none" : img.shape));
  // only a guessed shape is corrected, by the ratio; a measured one (the server knows the real size) stands
  const measured = (r: number) => { if (img?.pending) real = r < 0.8 ? "none" : r >= 1.25 ? "wide" : "square"; };
  const right = $derived(card.meta?.points ? `${card.meta.points} pts` : ago(card.at));

  // the brief: cached on the card when Claude already wrote it, otherwise written once the card comes near the screen.
  // An update card (a followed story with news) shows "what changed" instead, written the same way.
  // while the server researches a story with little to read, `step` says what it is doing (only this card waits)
  let brief = $state(""), streaming = $state(false), step = $state(""), el: HTMLElement | undefined = $state();
  const upd = $derived(card.update ?? null);
  $effect(() => {
    if ((upd ? upd.text : card.brief) || card.unreadable || (card.short && !upd) || !app.llm || !el) return;
    let stop: (() => void) | null = null, started = false, holding = false, gone = false;
    const release = () => { if (holding) { holding = false; give(); } };
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting || started) return;
      io.disconnect(); started = true; streaming = true;
      take().then(() => {
        holding = true;
        if (gone) return release();
        stop = sse(`/api/stories/${card.id}/lens/${upd ? "update" : "brief"}?lang=${app.lang}&level=2`, {
          status: d => { step = d.text ?? ""; },
          delta: d => { brief += d.t; step = ""; },
          done: d => { streaming = false; step = ""; if (d.material === "none") none = true; release(); },
          error: () => { streaming = false; step = ""; brief = ""; release(); },
        });
      });
    }, { rootMargin: "400px 0px" });
    io.observe(el);
    return () => { gone = true; io.disconnect(); stop?.(); release(); };
  });
  const text = $derived(slim ? "" : upd ? (upd.text || brief) : withoutCharts(card.brief || brief) || (streaming ? "" : card.summary));
  // a chart that is the story's core leads the card instead of the picture
  const chart = $derived(slim ? null : card.chart ?? (!streaming && brief ? heroChart(brief) : null));

  // the big card's picture strip: a chart that is the story's core, the story's photo, then the article's own figures
  // a story with no picture and no chart gets a drawn emblem instead (shared/emblem.ts): beside the text on a small
  // card, as the picture strip on a big one. A slim card (nothing to read) stays plain.
  const emblem = $derived(slim || chart || (img && shape !== "none") ? null : emblemFor(card));
  type Slide = { kind: "chart" } | { kind: "emblem" } | { kind: "image"; src: string; fit: "cover" | "contain" } | { kind: "figure"; src: string; caption: string };
  const slides = $derived.by((): Slide[] => {
    const out: Slide[] = [];
    if (chart) out.push({ kind: "chart" });
    if (img && real !== "none") out.push({ kind: "image", src: img.src, fit: shape === "wide" ? "cover" : "contain" });
    for (const f of card.figures ?? []) out.push({ kind: "figure", src: f.src, caption: f.caption });
    if (!out.length && emblem) out.push({ kind: "emblem" });
    return out;
  });
  let rail: HTMLElement | undefined = $state(), slideAt = $state(0);
  const onRail = () => { if (rail) slideAt = Math.round(rail.scrollLeft / Math.max(1, rail.clientWidth)); };
  const slideTo = (k: number) => rail?.scrollTo({ left: Math.max(0, Math.min(slides.length - 1, k)) * rail.clientWidth, behavior: "smooth" });

  // gestures: a horizontal drag dismisses past a third of the width (the card tilts with the finger, a tick at the
  // threshold); a still press of half a second saves, also on the picture strip, where a sideways drag scrolls instead
  let dx = $state(0), leaving = $state(false), pressed = $state(false), armed = $state(false), lifting = $state(false);
  let sx = 0, sy = 0, mode: "" | "swipe" | "scroll" = "", hold: ReturnType<typeof setTimeout> | undefined, held = false, pressOnRail = false;
  const interactive = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.("button, a.ext");
  function down(e: PointerEvent) {
    if (e.button !== 0 || interactive(e.target)) return;
    pressOnRail = !!(e.target as HTMLElement)?.closest?.(".rail-wrap");
    sx = e.clientX; sy = e.clientY; mode = ""; held = false; pressed = true;
    hold = setTimeout(() => { held = true; pressed = false; quietUntil = Date.now() + 800; save(); }, 520);
  }
  function move(e: PointerEvent) {
    if (!pressed && mode !== "swipe") return;
    const x = e.clientX - sx, y = e.clientY - sy;
    if (!mode && (Math.abs(x) > 8 || Math.abs(y) > 8)) {
      clearTimeout(hold); pressed = false;
      mode = !pressOnRail && Math.abs(x) > Math.abs(y) && x < 0 ? "swipe" : "scroll";
      if (mode === "swipe") (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (mode === "swipe") {
      dx = Math.min(0, x);
      const past = -dx > (el?.offsetWidth ?? 300) / 3;
      if (past !== armed) { armed = past; if (past) haptic("tick"); }
    }
  }
  function up() {
    clearTimeout(hold); pressed = false;
    if (mode === "swipe") { if (armed) dismiss(); else { dx = 0; armed = false; } }
    mode = "";
  }
  // dismiss: the card sweeps off to the left like a gust, turning a little, then the gap closes and the next card rises
  async function dismiss() {
    if (!el) { ondismiss(card); return; }
    const from = dx, w = el.offsetWidth;
    dx = 0; armed = false;
    await animate(el, [{ transform: `translateX(${from}px) rotate(${from * 0.02}deg)`, opacity: 1 }, { transform: `translateX(${-w - 80}px) rotate(-9deg)`, opacity: 0 }], { spring: "snappy", ms: 380, fill: "forwards" });
    leaving = true;
    setTimeout(() => ondismiss(card), 240);
  }
  // save: the card lifts back in 3D, a copy flies to List and turns into a leaf on the way; the gap closes behind it.
  // On the reading list itself the same press removes the card again, which simply folds away.
  async function save() {
    if (lifting) return;
    if (card.pinned) { leaving = true; setTimeout(() => onpin(card), 240); return; }
    lifting = true; haptic("tick");
    if (el) {
      await animate(el, [{ transform: "none" }, { transform: "perspective(1000px) rotateX(9deg) translateY(-6px) scale(.97)" }], { spring: "snappy", ms: 200, fill: "forwards" });
      const flight = flyTo(el, "/list");
      el.style.opacity = "0";
      leaving = true;
      await flight;
    }
    onpin(card);
  }
  function open(e: MouseEvent) {
    if (held || mode === "swipe" || dx || Date.now() < quietUntil) { e.preventDefault(); held = false; return; }
    if (interactive(e.target) || e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    // the reader shows this card's headline and picture at once, so the card can grow into it
    app.peek = card;
    go(`/story/${card.id}`);
  }
  const morph = $derived(app.morph === card.id);
  // cards that just arrived (a new page of the endless feed) rise in, one after another
  const fresh = $derived(app.feed.fresh.indexOf(card.id));
</script>

<div class="card-wrap" class:leaving class:big class:arrive={fresh >= 0} style:--k={fresh >= 0 ? fresh : null}>
  <div class="swipe-under" class:armed aria-hidden="true" style:opacity={Math.min(1, -dx / 120)}>{@html I.minus}<span>{dismissLabel}</span></div>
  <article bind:this={el} data-story={card.id} data-item tabindex="-1" use:viewed={track ? card.id : 0} class="card" class:big class:has-media={big && slides.length > 0} class:has-hero={!big && (shape === "wide" || !!chart)} class:pinned={card.pinned} class:pressed class:dragging={mode === "swipe"}
    style:translate={dx ? `${dx}px 0` : null} style:rotate={dx ? `${dx * 0.02}deg` : null} style:view-transition-name={morph ? "pm-card" : null} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up} onclick={open} oncontextmenu={(e) => { if (held || pressed) e.preventDefault(); }}>
    {#if big}
      {#if slides.length}
        <div class="rail-wrap" style:view-transition-name={morph ? "pm-media" : null}>
          <div class="rail" bind:this={rail} onscroll={onRail}>
            {#each slides as sl, k}
              <div class="slide slide-{sl.kind}" aria-hidden={k !== slideAt}>
                {#if sl.kind === "chart" && chart}{#if chart.title}<span class="ch-cap">{chart.title}</span>{/if}<ChartView {chart} lang={app.lang} compact />
                {:else if sl.kind === "emblem" && emblem}<Emblem spec={emblem} seed={card.id} wide />
                {:else if sl.kind === "image"}<Pic src={sl.src} fit={sl.fit} sizes="(min-width: 900px) 720px, 100vw" eager={k === 0} onsize={measured} onfail={() => (real = "none")} />
                {:else if sl.kind === "figure"}<Pic src={sl.src} fit="contain" alt={sl.caption} sizes="(min-width: 900px) 720px, 100vw" />{#if sl.caption}<span class="fig-cap">{sl.caption}</span>{/if}{/if}
              </div>
            {/each}
          </div>
          {#if slides.length > 1}
            <div class="dots" aria-hidden="true">{#each slides as _, k}<i class:on={k === slideAt}></i>{/each}</div>
            <button class="rail-btn prev" type="button" aria-label="Previous picture" disabled={slideAt === 0} onclick={() => slideTo(slideAt - 1)}>{@html I.back}</button>
            <button class="rail-btn next" type="button" aria-label="Next picture" disabled={slideAt === slides.length - 1} onclick={() => slideTo(slideAt + 1)}>{@html I.back}</button>
          {/if}
        </div>
      {/if}
    {:else if chart}<div class="card-chart" style:view-transition-name={morph ? "pm-media" : null}>{#if chart.title}<span class="ch-cap">{chart.title}</span>{/if}<ChartView {chart} lang={app.lang} compact /></div>
    {:else if img && shape === "wide"}<Pic cls="card-hero" vt={morph ? "pm-media" : null} src={img.src} sizes="(min-width: 900px) 820px, 100vw" onsize={measured} onfail={() => (real = "none")} />{/if}
    <div class="src">
      {#if favs.length > 1}<span class="stack">{#each favs as f}<Fav kind={f.kind} name={f.name} src={f.icon} />{/each}</span>{:else}<Fav kind={favs[0]?.kind} name={favs[0]?.name} src={favs[0]?.icon} />{/if}
      <span class="nm">{label}</span>
      {#if card.translated}<span class="lang-tag">{card.lang.toUpperCase()}→EN</span>{/if}
      {#if card.slot}<span class="lang-tag new">{card.slot === "trial" ? "New to you" : "Something different"}</span>{/if}
      <span class="t">{right}</span>
    </div>
    <div class:card-row={!big && ((shape === "square" && !chart) || !!emblem)} class:card-text={big}>
      <div>
        {#if upd}<span class="upd-tag">{@html I.follow}Following · {upd.count} new {upd.count === 1 ? "report" : "reports"}</span>{/if}
        <h2 style:view-transition-name={morph ? "pm-title" : null}><a href="/story/{card.id}">{card.title}</a></h2>
        <div class="body" aria-live="polite">
          {#if slim}<p class="hint">Only the headline could be read.{#if card.url}{" "}<a class="ext" href={card.url} target="_blank" rel="noopener noreferrer">Open the original</a>{/if}</p>
          {:else if text}<p class:caret={streaming}>{text}</p>
          {:else if streaming}<Skeleton sm lines={2} last="78%" label={step || "Claude is writing the brief"} />{#if step}<p class="hint hrow"><Loading inline text={step} />{step}…</p>{/if}{/if}
        </div>
        {#if upd}<ul class="upd-reports">{#each upd.reports as r}<li><Fav kind={r.kind} name={r.source} size={14} src={r.icon} /><span>{r.title}</span></li>{/each}</ul>{/if}
      </div>
      {#if !big && img && shape === "square" && !chart}<Pic cls="card-thumb" src={img.src} widths={[160, 320]} sizes="72px" onsize={measured} onfail={() => (real = "none")} />
      {:else if !big && emblem}<Emblem cls="card-thumb" spec={emblem} seed={card.id} small />{/if}
    </div>
    {#if big}
      <div class="card-foot">
        {#each card.topics.slice(0, 3) as t}<span class="chip">{t}</span>{/each}
        {#if card.count > 1}<span class="chip">{card.count} reports</span>{/if}
        <span class="read">Read {@html I.back}</span>
      </div>
    {/if}
    <div class="card-acts">
      <button class="act" class:on={card.pinned} type="button" aria-pressed={card.pinned} aria-label={card.pinned ? "Remove from reading list" : "Save to reading list"} title={card.pinned ? "Remove from reading list" : "Save to reading list (or long press)"} onclick={save}>{@html I.save}</button>
      <button class="act" type="button" aria-label={dismissLabel} title="{dismissLabel} (or swipe left)" onclick={dismiss}>{@html I.minus}</button>
      <button class="act" type="button" aria-label="Why this story, and tune" title="Why you see this" onclick={() => ontune(card)}>{@html I.more}</button>
    </div>
  </article>
</div>
