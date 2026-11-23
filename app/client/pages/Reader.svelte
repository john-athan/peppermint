<script lang="ts">
  import { tick } from "svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import { app, go, toast, type Card } from "../lib/state.svelte";
  import { api, beacon, sse } from "../lib/api";
  import { ago, signed, digParts } from "../lib/format";
  import { blocks, type LensBlock } from "../lib/lens";
  import { markSentence, sentenceAt } from "../lib/dig";
  import { I } from "../lib/icons";
  import Fav from "../components/Fav.svelte";
  import TuneSheet from "../components/TuneSheet.svelte";
  import Sheet from "../components/Sheet.svelte";
  import StoryAudio from "../components/StoryAudio.svelte";
  import StoryVideo from "../components/StoryVideo.svelte";
  import Player from "../components/Player.svelte";
  import Pic, { sized } from "../components/Pic.svelte";
  import ChartView from "../components/Chart.svelte";
  import Discussion from "../components/Discussion.svelte";
  import { flyTo, haptic } from "../lib/motion";
  import AskBar from "../components/AskBar.svelte";
  import type { Ask } from "../../shared/types";

  let { id }: { id: number } = $props();
  type Story = Card & { items: { id: number; title: string; url: string; author: string; published_at: number; lang: string; source: string; kind: string; media?: { audio: string | null; video: string | null; duration: number | null; image: string | null } }[]; people: string[]; entities: { name: string; kind: "person" | "place" | "org"; img: string | null; page: string | null; description?: string | null }[]; figures?: { src: string; caption: string }[]; atoms: { kind: string; text: string }[]; share?: string | null };
  let story = $state<Story | null>(null), missing = $state("");
  // a story opens in your style: the TL;DR leads, the whole story retold follows once you scroll past it. Original is
  // the article as published, in its own language
  let mode = $state<"style" | "orig">("style"), lang = $state<"en" | "de">("en"), level = $state(2);
  let lead = $state(""), leading = $state(false), bodyWaits = $state(false), moreEl: HTMLElement | undefined = $state(), stopLead: (() => void) | null = null;
  let audio = $state(false), video = $state(false), videoFrom = $state<DOMRect | null>(null);
  let text = $state(""), streaming = $state(false), failed = $state<{ code: string; message: string } | null>(null);
  let tuneOpen = $state(false), menuOpen = $state(false);
  // following: keep collecting reports for this story; what arrived since the last visit shows first
  let following = $state(false), newReports = $state<string[]>([]), updateText = $state(""), stopUpdate: (() => void) | null = null;
  async function toggleFollow() {
    const r = await api("/api/follow", { method: "POST", json: { story_id: id, on: !following } });
    following = r.following;
    toast(following ? "Following. New reports on this story will lead Today." : "No longer following this story.");
  }
  // research: the story's headline, picture and chips fly into the Research folder and you keep reading; the topic is
  // researched in the background. A story already in Research opens its topic instead.
  let researching = $state(false);
  async function researchThis() {
    if (story.research) { go(`/dossier/${story.research}`); return; }
    researching = true; haptic("tick");
    const root = document.querySelector("main");
    const parts = [root?.querySelector("h1"), root?.querySelector("figure.read-hero:not(.hidden)"), ...(root?.querySelectorAll(".ents .ent") ?? [])].filter(Boolean).slice(0, 6) as Element[];
    const from = { title: story.title, image: story.image?.src ?? null, chips: (story.entities ?? []).slice(0, 6).map((e: any) => ({ name: e.name, img: e.img ? sized(e.img, 160) : null })) };
    const flight = flyTo(parts, "/research");
    try {
      const r = await api<{ task: { id: number; title: string } }>(`/api/stories/${id}/research`, { method: "POST", json: { from } });
      story.research = r.task.id;
      await flight;
      toast(`Researching “${r.task.title}”`, { ms: 6000, action: { label: "Open", run: () => go(`/dossier/${r.task.id}`) } });
    } catch (e) { toast((e as Error).message); } finally { researching = false; }
  }
  // sharing: a short public link to this story as you read it (language and level), with the reports behind it.
  // The system share sheet where there is one, else the link is copied. Stop sharing in the reading menu.
  let sharing = $state(false);
  async function share() {
    if (!story) return;
    sharing = true; haptic("tick");
    try {
      const { url } = await api<{ url: string }>(`/api/stories/${id}/share`, { method: "POST", json: { lang, level } });
      const fresh = !story.share; story.share = url;
      if (navigator.share) { try { await navigator.share({ title: story.title, url }); } catch {} }
      else { await navigator.clipboard.writeText(url); toast(fresh ? "Link copied. Anyone with it can read this story." : "Link copied.", { ms: 5000, action: { label: "Stop", run: unshare } }); }
    } catch (e) { toast((e as Error).message); } finally { sharing = false; }
  }
  async function unshare() {
    try { await api(`/api/stories/${id}/share`, { method: "DELETE" }); if (story) story.share = null; toast("The link no longer works."); }
    catch (e) { toast((e as Error).message); }
  }
  let stop: (() => void) | null = null;
  // Ask: earlier questions on this story, and the one being answered now (its answer streams in as it is written)
  let asks = $state<Ask[]>([]), asking = $state<{ q: string; text: string; status: string; busy: boolean; failed: string } | null>(null);
  let stopAsk: (() => void) | null = null, askEl: HTMLElement | undefined = $state();

  $effect(() => {
    const sid = id; story = null; missing = ""; asks = []; asking = null;
    api(`/api/stories/${sid}`).then(s => {
      // an answer for a story you already left (back before it loaded) must not start its lens on the next page
      if (sid !== id) return;
      story = s; following = !!s.following; newReports = s.newReports ?? [];
      // what is new for a followed story: written by Claude above the text; opening it counts as having seen it
      if (newReports.length) {
        updateText = "";
        if (app.llm) stopUpdate = sse(`/api/stories/${sid}/lens/update?lang=${app.lang}&level=2`, { delta: d => { updateText += d.t; } });
      }
      if (s.following) {
        api("/api/follow/seen", { method: "POST", json: { story_id: sid } }).catch(() => {});
        app.updates = app.updates.filter(u => u.id !== sid);
      }
      // an episode or a video plays its own media, and its text is the show notes: that opens as published
      mode = app.llm && !s.items.some((i: any) => i.media) ? "style" : "orig"; lang = app.lang;
      // a question that came with the link (shared with words, or from the agent) is asked right away
      const aq = new URLSearchParams(location.search).get("ask");
      run(); loadAsks();
      if (aq) { history.replaceState(history.state, "", location.pathname); ask(aq); }
    }).catch(e => { missing = e.message; });
    api("/api/signals", { method: "POST", json: { story_id: sid, kind: "open" } }).catch(() => {});
    const t = setTimeout(() => api("/api/signals", { method: "POST", json: { story_id: sid, kind: "read" } }).catch(() => {}), 25_000);
    // reading time: only while the tab is in front; sent when you leave the story
    let ms = 0, since: number | null = document.visibilityState === "visible" ? performance.now() : null;
    const vis = () => { if (document.visibilityState === "visible") since ??= performance.now(); else if (since != null) { ms += performance.now() - since; since = null; } };
    const flush = () => { vis(); if (since != null) { ms += performance.now() - since; since = performance.now(); } if (ms >= 2000) beacon("/api/signals", { story_id: sid, kind: "dwell", ms: Math.round(ms) }); ms = 0; };
    document.addEventListener("visibilitychange", vis); addEventListener("pagehide", flush);
    return () => { clearTimeout(t); stop?.(); stopLead?.(); stopAsk?.(); stopUpdate?.(); closeDig(); flush(); document.removeEventListener("visibilitychange", vis); removeEventListener("pagehide", flush); audio = false; video = false; };
  });
  const clicked = () => api("/api/signals", { method: "POST", json: { story_id: id, kind: "click" } }).catch(() => {});

  const thin = { code: "thin", message: "Only the headline could be read: the page showed a login, paywall or error page, and no archived copy, discussion or other report had more." };
  async function run() {
    stop?.(); stopLead?.(); closeDig(); failed = null; text = ""; lead = ""; leading = false; bodyWaits = false; streaming = false;
    if (!story) return;
    if (mode === "orig" || !app.llm) { const o = await api(`/api/stories/${id}/original`); text = o.text; return; }
    if (story.short) { steepBody(); return; }
    // the TL;DR first; the retelling waits until the reader scrolls toward it
    leading = true; bodyWaits = true;
    stopLead = sse(`/api/stories/${id}/lens/tldr?lang=${lang}&level=${level}`, {
      delta: d => { lead += d.t; },
      done: d => { leading = false; if (d.material === "none" && !lead) { bodyWaits = false; failed = thin; } },
      error: () => { leading = false; },
    });
  }
  function steepBody() {
    bodyWaits = false; streaming = true;
    stop = sse(`/api/stories/${id}/lens/digest?lang=${lang}&level=${level}`, {
      delta: d => { text += d.t; },
      // research found nothing behind the headline: say so instead of an empty page
      done: d => { streaming = false; if (d.material === "none" && !text) failed = thin; },
      error: d => { streaming = false; failed = d; },
    });
  }
  // the retelling starts once the TL;DR is written and its end comes near the screen
  $effect(() => {
    if (!moreEl || !bodyWaits || leading) return;
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); steepBody(); } }, { rootMargin: "0px 0px 300px 0px" });
    io.observe(moreEl);
    return () => io.disconnect();
  });
  const toggleOrig = () => {
    mode = mode === "orig" ? "style" : "orig"; run();
    if (mode === "orig") api("/api/signals", { method: "POST", json: { story_id: id, kind: "lens", meta: { lens: "orig" } } }).catch(() => {});
  };

  // digging into a sentence: tap one (or select words), then ask if it is true, the data behind it, who said it, to
  // have it explained, or anything else about it. The answer appears right under the paragraph.
  type DigKind = "true" | "data" | "who" | "explain" | "ask";
  const digKinds: [DigKind, string][] = [["true", "Is it true?"], ["data", "Data behind it"], ["who", "Who said it"], ["explain", "Explain"]];
  const verdicts = { holds: "Holds up", partly: "Partly true", disputed: "Disputed", unclear: "Unclear" };
  let dig = $state<{ part: "lead" | "body"; i: number; s: string; kind: DigKind | null; q: string; text: string; status: string; busy: boolean; failed: string } | null>(null);
  let digQ = $state(""), stopDig: (() => void) | null = null;
  let dug = $state(typeof localStorage !== "undefined" && !!localStorage.getItem("pm-dug"));
  function closeDig() { stopDig?.(); stopDig = null; dig = null; digQ = ""; markSentence(null); }
  function pick(e: MouseEvent) {
    const t = e.target as Element;
    if (t.closest(".dig, button, a, input, .chart")) return;
    const el = t.closest<HTMLElement>("[data-dig]");
    if (!el) return;
    const found = sentenceAt(el, e.clientX, e.clientY, lang);
    if (!found) return;
    if (dig?.s === found.text && !dig.kind) { closeDig(); return; }
    closeDig();
    dig = { part: el.closest(".tldr") ? "lead" : "body", i: Number(el.dataset.dig), s: found.text, kind: null, q: "", text: "", status: "", busy: false, failed: "" };
    markSentence(found.range); haptic("tick");
    if (!dug) { dug = true; localStorage.setItem("pm-dug", "1"); }
  }
  function digInto(kind: DigKind, q = "") {
    if (!dig || (kind === "ask" && !q.trim())) return;
    stopDig?.();
    Object.assign(dig, { kind, q, text: "", status: "", busy: true, failed: "" });
    api("/api/signals", { method: "POST", json: { story_id: id, kind: "lens", meta: { lens: "dig", dig: kind } } }).catch(() => {});
    const s = dig.s, url = `/api/stories/${id}/dig?k=${kind}&s=${encodeURIComponent(s)}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
    const mine = () => dig?.s === s && dig.kind === kind && dig.q === q;
    // a fresh answer is fetched once more when it is done: the kept copy has the quotes the sources do not hold removed
    const open = (again: boolean) => {
      let buf = "";
      stopDig = sse(url, {
        status: d => { if (mine() && !again) dig!.status = d.text ?? ""; },
        delta: d => { if (again) buf += d.t; else if (mine()) dig!.text += d.t; },
        done: d => { if (!mine()) return; if (again) dig!.text = buf; dig!.busy = false; if (!again && !d.cached) open(true); },
        error: d => { if (mine()) { dig!.busy = false; dig!.failed = d.message ?? "The answer did not arrive."; } },
      });
    };
    open(false);
  }
  async function loadAsks() { try { asks = (await api<{ asks: Ask[] }>(`/api/stories/${id}/asks`)).asks; } catch {} }
  function ask(q: string) {
    stopAsk?.();
    asking = { q, text: "", status: "", busy: true, failed: "" };
    // the answer appears under the article: bring it into view (the bar stays docked at the bottom)
    tick().then(() => askEl?.scrollIntoView({ behavior: "smooth", block: "start" }));
    api("/api/signals", { method: "POST", json: { story_id: id, kind: "lens", meta: { lens: "ask" } } }).catch(() => {});
    stopAsk = sse(`/api/stories/${id}/ask?q=${encodeURIComponent(q)}`, {
      status: d => { if (asking?.q === q) asking.status = d.text ?? ""; },
      delta: d => { if (asking?.q === q) asking.text += d.t; },
      // the saved answer replaces the streamed one, so what you see now is what you will see next time
      done: async () => { await loadAsks(); if (asking?.q === q) asking = null; },
      error: d => { if (asking?.q === q) { asking.busy = false; asking.failed = d.message ?? "The answer did not arrive."; } },
    });
  }
  // picking a language here is your reading language everywhere: briefs on Today, TL;DR, retellings
  const setLang = (l: "en" | "de") => {
    lang = l; run();
    if (l === app.lang) return;
    app.lang = l;
    api("/api/settings", { method: "PUT", json: { lang: l } })
      .then(async () => { app.edition = (await api("/api/edition")).edition; toast(app.llm ? `Reading language: ${l === "de" ? "Deutsch" : "English"}. Briefs are written again.` : "Reading language saved."); })
      .catch(() => {});
  };
  async function quick(kind: "more" | "less") {
    if (!story) return;
    const subjects = story.topics.slice(0, 2).map(t => "topic:" + t);
    const r = await api("/api/signals", { method: "POST", json: { story_id: id, kind, subjects } });
    toast(r.moved?.length ? `Palate: ${r.moved.map((m: any) => m.name).join(", ")} ${kind === "more" ? "up" : "down"}` : "Palate updated.");
  }
  const bs = $derived(blocks("digest", text)), leadBs = $derived(blocks("tldr", lead));
  // this story is the one a card is growing into (or shrinking back to)
  const morphing = $derived(app.morph === id);
  // the brief's chart, when Claude marked it as the story's core, stands at the top in place of the picture; the same
  // chart in the retelling is not drawn twice
  const heroChart = $derived(mode === "style" ? story?.chart ?? null : null);
  const kinds = $derived(story ? [...new Set(story.items.map(i => i.kind))] : []);
  const srcLang = $derived(story?.items[0]?.lang ?? "en");
  // the story's picture under the headline; a playing episode or video brings its own
  const hero = $derived(story && !story.items.some(i => i.media) ? story.image ?? null : null);
  let heroShape = $state<"wide" | "contain">("wide"), heroFailed = $state(false);
  $effect(() => { heroShape = hero && hero.shape !== "wide" ? "contain" : "wide"; heroFailed = false; });
  // what you are reading: the original, or your style with its language and level
  const reading = $derived.by(() => {
    if (!story || !app.llm) return "";
    const parts = mode === "orig" ? ["Original"] : ["Your style", lang === "de" ? "Deutsch" : "English", ...(level !== 2 ? [level === 1 ? "Simple" : "Expert"] : [])];
    return (streaming || leading ? "Writing · " : "") + parts.join(" · ");
  });
  const back = (e: MouseEvent) => { e.preventDefault(); history.length > 1 ? history.back() : go("/"); };
</script>

<div class="page wide">
  <header class="appbar">
    <a class="back" href="/" onclick={back}>{@html I.back}Today</a><span class="sp"></span>
    {#if reading}<button class="sse-badge" class:live={streaming} type="button" title="Reading settings" onclick={() => (menuOpen = true)}>{#if streaming}<i></i>{/if}<span>{reading}</span></button>{/if}
    {#if story}<button class="icon-btn" type="button" aria-label="Share a link to this story" disabled={sharing} onclick={share}>{@html I.share}</button>{/if}
    {#if story}<button class="icon-btn" type="button" aria-label="Reading settings and why you see this" aria-haspopup="dialog" onclick={() => (menuOpen = true)}>{@html I.more}</button>{/if}
  </header>
  {#if missing}
    <div class="empty"><b>{missing}</b><a href="/" onclick={back}>Back to Today</a></div>
  {:else if !story}
    <!-- before the story arrives: the card it came from, so the card can grow straight into this page -->
    {@const pk = app.peek?.id === id ? app.peek : null}
    <div class="reader" aria-busy="true" style:view-transition-name={morphing ? "pm-card" : null}>
      <div><div class="reader-head">
        {#if pk}
          <div class="src">{#each pk.sources.slice(0, 3) as s}<Fav kind={s.kind} name={s.name} src={s.icon} />{/each}<span>{pk.sources.map(s => s.name).join(", ")}</span></div>
          <h1 style:view-transition-name={morphing ? "pm-title" : null}>{pk.title}</h1>
          {#if pk.chart}<div class="read-chart" style:view-transition-name={morphing ? "pm-media" : null}><ChartView chart={pk.chart} {lang} /></div>
          {:else if pk.image && pk.image.shape === "wide"}<figure class="read-hero" style:--ar="16 / 9"><Pic src={pk.image.src} eager vt={morphing ? "pm-media" : null} sizes="(min-width: 900px) 760px, 100vw" /></figure>{/if}
          <Skeleton last="62%" cls="mt-m" />
        {:else}<div class="src ph"></div><h1 class="ph">Loading…</h1>{/if}
      </div></div>
    </div>
  {:else}
    <div class="reader" style:view-transition-name={morphing ? "pm-card" : null}>
      <div>
        <div class="reader-head">
          <div class="src">
            {#each story.sources.slice(0, 3) as s}<Fav kind={s.kind} name={s.name} src={s.icon} />{/each}
            <span>{story.items.map(i => i.source).filter((v, i, a) => a.indexOf(v) === i).join(", ")}{story.authors[0] ? ` · ${story.authors[0]}` : ""} · {ago(story.at)}</span>
            {#if story.meta?.points}<span class="chip">{story.meta.points} pts · {story.meta.comments} comments</span>{/if}
            {#if story.stand_in}
              {@const si = story.stand_in}
              <span class="chip warn" title={si.kind === "report" ? `The article showed a paywall, login or error page. What you read comes from ${si.site}'s report on the same story.` : "The article showed a paywall, login or error page. What you read comes from what commenters on Hacker News say about it."}>Article unavailable · {si.kind === "report" ? `from ${si.site}` : "from the HN discussion"}</span>
            {/if}
          </div>
          <h1 style:view-transition-name={morphing ? "pm-title" : null}>{story.title}</h1>
          {#if story.title_orig !== story.title}<span class="orig">{story.title_orig}</span>{/if}
          {#if newReports.length}
            <section class="new-since" aria-label="New since you last looked">
              <b>{@html I.follow}New since you last looked · {newReports.length} {newReports.length === 1 ? "report" : "reports"}</b>
              {#if updateText}<p>{updateText}</p>{:else if app.llm}<Skeleton sm lines={2} last="70%" label="Claude is writing what changed" />{/if}
              <ul>{#each newReports as t}<li>{t}</li>{/each}</ul>
            </section>
          {/if}
          {#if heroChart}
            <div class="read-chart" style:view-transition-name={morphing ? "pm-media" : null}><ChartView chart={heroChart} {lang} /></div>
          {:else if hero}
            <figure class="read-hero" class:hidden={heroFailed} style:--ar={heroShape === "wide" ? "16 / 9" : hero.w && hero.h ? `${hero.w} / ${hero.h}` : "4 / 3"}>
              <Pic src={hero.src} eager vt={morphing ? "pm-media" : null} fit={heroShape === "wide" ? "cover" : "contain"} sizes="(min-width: 900px) 760px, 100vw" onsize={(r) => (heroShape = r >= 1.25 ? "wide" : "contain")} onfail={() => (heroFailed = true)} />
              {#if hero.credit}<figcaption>{hero.credit}</figcaption>{/if}
            </figure>
          {/if}
          {#if story.entities?.length}
            <div class="ents" aria-label="People and places">
              {#each story.entities as e}
                {#if e.page}<a class="ent" href={e.page} target="_blank" rel="noopener noreferrer" title="{e.name} on Wikipedia">{#if e.img}<img src={sized(e.img, 160)} alt="" loading="lazy" />{:else}<i>{e.name[0]}</i>{/if}{e.name}</a>
                {:else}<span class="ent">{#if e.img}<img src={sized(e.img, 160)} alt="" loading="lazy" />{:else}<i>{e.name[0]}</i>{/if}{e.name}</span>{/if}
              {/each}
            </div>
          {/if}
          <div class="read-acts">
            <button class="ghost sm" type="button" aria-pressed={following} onclick={toggleFollow} title={following ? "Stop following this story" : "Follow: new reports on this story lead Today"}>{@html I.follow}{following ? "Following" : "Follow"}</button>
            {#if app.llm}
              <button class="ghost sm" type="button" disabled={researching} aria-pressed={!!story.research} onclick={researchThis} title={story.research ? "Open this topic in Research" : "Research: searches in rounds and keeps the topic in Research, with its sources"}>{@html I.search}{story.research ? "In Research" : researching ? "Researching…" : "Research"}</button>
              <button class="ghost sm" type="button" aria-pressed={audio} aria-label="Audio" title="Listen to this story" onclick={() => { video = false; audio = true; api("/api/signals", { method: "POST", json: { story_id: id, kind: "lens", meta: { lens: "audio" } } }).catch(() => {}); }}>{@html I.listen}</button>
              <button class="ghost sm" type="button" aria-label="Video" title="Watch this story as a video" onclick={(e) => { videoFrom = (e.currentTarget as HTMLElement).getBoundingClientRect(); audio = false; video = true; api("/api/signals", { method: "POST", json: { story_id: id, kind: "lens", meta: { lens: "video" } } }).catch(() => {}); }}>{@html I.film}</button>
              <button class="ghost sm" type="button" aria-pressed={mode === "orig"} aria-label="Original" title={mode === "orig" ? "Back to your style" : "The article as published"} onclick={toggleOrig}>{@html I.orig}</button>
            {/if}
          </div>
          {#if audio}<StoryAudio {id} lang={app.lang} onclose={() => (audio = false)} />{/if}
          {#each story.items.filter(i => i.media).slice(0, 1) as it}<Player media={it.media!} episode={it.id} title={it.title} poster={story.image ? sized(story.image.src, 800) : null} />{/each}
        </div>
        <!-- a tap on a sentence digs into it (see pick); the answer opens under its paragraph -->
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="stream" aria-live="polite" onclick={pick}>
          {#if mode === "style" && !story.short && !failed}
            <section class="tldr" aria-label="TL;DR">
              <span class="lbl">TL;DR</span>
              {#if leading && !lead}<Skeleton lines={2} last="70%" label="Writing the TL;DR" />{:else}{@render prose(leadBs, "lead", leading)}{/if}
              {#if !dug && lead && !leading}<p class="hint">Tap any sentence to check it, see the data behind it, find who said it or have it explained.</p>{/if}
            </section>
            <div bind:this={moreEl}></div>
          {/if}
          {#if failed}
            <div class="notice"><b>{failed.code === "no_llm" ? "Steeping is off" : failed.code === "thin" ? "Nothing to read here" : "Could not steep this"}</b><span>{failed.message}</span>{#if failed.code !== "no_llm" && failed.code !== "thin"}<button class="ghost" type="button" onclick={run}>Try again</button>{/if}</div>
          {:else if streaming && !text}
            <Skeleton last="62%" label="Retelling the story in your style" />
          {:else if !bodyWaits}
            {@render prose(bs, "body", streaming)}
            {#if !bs.length && (streaming || !text) && !leading}<p class="caret dim"></p>{/if}
          {/if}
        </div>
        <!-- Ask: questions about this story, answered from its text and a quick search of other reports and Wikipedia, with the passages they rest on, under the article -->
        {#if asking || asks.length}
          <div class="ask-view" aria-live="polite" bind:this={askEl}>
            {#if asking}{@render answer(asking.q, asking.text, asking.busy, asking.failed, asking.status)}{/if}
            {#each asks as a (a.id)}{#if a.q !== asking?.q}{@render answer(a.q, a.answer, false, "", "")}{/if}{/each}
          </div>
        {/if}
        <Discussion {id} />
        {#if app.llm}<div class="ask-dock"><AskBar placeholder="Ask about this story…" chip="this story" busy={asking?.busy ?? false} onsubmit={ask} /></div>{/if}
      </div>
      <aside class="aside">
        <div class="prov">
          <h3>{story.items.length === 1 ? "Source" : `${story.items.length} reports`}</h3>
          {#each story.items as it}
            <a class="it" href={it.url} target="_blank" rel="noopener noreferrer" onclick={clicked}><Fav kind={it.kind} name={it.source} src={story.sources.find(s => s.name === it.source)?.icon} /><span>{it.title}<small>{it.source}{it.author ? ` · ${it.author}` : ""} · {ago(it.published_at)}</small></span></a>
          {/each}
          {#if story.meta?.hn && story.items[0]?.kind === "hackernews"}<a href={story.meta.hn} target="_blank" rel="noopener noreferrer" class="small">Discussion on Hacker News</a>{/if}
        </div>
      </aside>
    </div>
  {/if}
</div>

{#snippet prose(list: LensBlock[], part: "lead" | "body", busy: boolean)}
  {#each list as b, i}
    {@const last = busy && i === list.length - 1}
    {#if b.t === "h"}{#if b.level === 2}<h2 class="art-h" class:caret={last} data-dig={i}>{b.s}</h2>{:else}<h3 class="art-h3" class:caret={last} data-dig={i}>{b.s}</h3>{/if}
    {:else if b.t === "ul"}<ul class="art-list" class:caret={last}>{#each b.items as item}<li data-dig={i}>{#each item as r}{#if r.b}<b>{r.s}</b>{:else}{r.s}{/if}{/each}</li>{/each}</ul>
    {:else if b.t === "quote"}<blockquote class:caret={last} data-dig={i}>{#each b.runs as r}{#if r.b}<b>{r.s}</b>{:else}{r.s}{/if}{/each}</blockquote>
    {:else if b.t === "chart"}{#if b.chart && !(heroChart && b.chart.hero)}<ChartView chart={b.chart} {lang} />{/if}
    {:else if b.t === "chart-wait"}<div class="chart-wait pm-shimmer" aria-label="Claude is drawing a chart"></div>
    {:else if b.t === "p"}<p class:caret={last} data-dig={i}>{#each b.runs as r}{#if r.b}<b>{r.s}</b>{:else}{r.s}{/if}{/each}</p>{/if}
    {#if dig && dig.part === part && dig.i === i}{@render digPanel()}{/if}
  {/each}
{/snippet}

{#snippet digPanel()}
  {#if dig}
    {@const a = digParts(dig.text)}
    <section class="dig" aria-label="Dig into this sentence">
      <div class="dig-acts">
        {#each digKinds as [k, n]}<button class="ghost sm" type="button" aria-pressed={dig.kind === k} onclick={() => digInto(k)}>{n}</button>{/each}
        <button class="icon-btn" type="button" aria-label="Close" onclick={closeDig}>{@html I.x}</button>
      </div>
      <form class="dig-ask" onsubmit={(e) => { e.preventDefault(); digInto("ask", digQ.trim()); }}>
        <input type="text" maxlength="300" placeholder="Or ask anything about this sentence…" aria-label="Ask about this sentence" bind:value={digQ} />
      </form>
      {#if dig.failed}<div class="notice flush"><span>{dig.failed}</span></div>
      {:else if dig.busy && !a.head.length}<Skeleton lines={2} sm label={dig.status || "Looking into it"} />{#if dig.status}<span class="hint">{dig.status}…</span>{/if}
      {:else if dig.kind}
        {#if a.verdict}<span class="verdict {a.verdict}">{verdicts[a.verdict]}</span>{/if}
        <p class="ask-a" class:caret={dig.busy}>{#each a.head as p}{#if "n" in p}<sup class="ask-n">{p.n}</sup>{:else}{p.t}{/if}{/each}</p>
        {#each a.quotes as k}
          {@const src = a.sources.find(x => x.site === k.source)}
          <blockquote class="ask-quote"><sup class="ask-n">{k.n}</sup>“{k.text}”{#if k.source}<small>{#if src}<a href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>{k.source}</a>{:else}{k.source}{/if}</small>{/if}</blockquote>
        {/each}
      {/if}
    </section>
  {/if}
{/snippet}

{#snippet answer(q: string, text: string, busy: boolean, failed: string, status: string)}
  {@const a = digParts(text)}
  <section class="ask-item">
    <h3>{q}</h3>
    {#if failed}<div class="notice"><span>{failed}</span></div>
    {:else if busy && !a.head.length}<Skeleton lines={2} sm label={status || "Answering"} />{#if status}<span class="hint">{status}…</span>{/if}
    {:else}
      <p class="ask-a" class:caret={busy}>{#each a.head as p}{#if "n" in p}<sup class="ask-n">{p.n}</sup>{:else}{p.t}{/if}{/each}</p>
      {#each a.quotes as k}
        {@const src = a.sources.find(x => x.site === k.source)}
        <blockquote class="ask-quote"><sup class="ask-n">{k.n}</sup>“{k.text}”{#if k.source}<small>{#if src}<a href={src.url} target="_blank" rel="noopener noreferrer" title={src.title}>{k.source}</a>{:else}{k.source}{/if}</small>{/if}</blockquote>
      {/each}
    {/if}
  </section>
{/snippet}

<Sheet bind:open={menuOpen} label="Reading settings">
  {#if story}
    <h3>Reading</h3>
    {#if app.llm}
      <span class="lbl">Language</span>
      <div class="seg" role="group" aria-label="Language">
        <button type="button" aria-pressed={lang === "en"} onclick={() => { menuOpen = false; setLang("en"); }}>English</button>
        <button type="button" aria-pressed={lang === "de"} onclick={() => { menuOpen = false; setLang("de"); }}>Deutsch</button>
      </div>
      <span class="lbl">Level</span>
      <div class="level"><span>Simple</span><input type="range" style:--pct="{(level - 1) * 50}%" min="1" max="3" step="1" bind:value={level} onchange={() => { menuOpen = false; run(); }} disabled={mode === "orig"} aria-label="Reading level" /><span>Expert</span></div>
      {#if mode === "orig"}<p class="hint">Language and level apply to your style; the original stays as published.</p>{/if}
    {:else}
      <div class="notice flush"><b>Original only for now</b><span>Your style, the TL;DR and digging into a sentence switch on when the server has a Claude key: set <code>ANTHROPIC_API_KEY</code> and restart.</span></div>
    {/if}
    {#if story.share}
      <span class="lbl">Shared</span>
      <div class="share-link"><code>{story.share}</code><button class="ghost sm" type="button" onclick={() => { menuOpen = false; unshare(); }}>Stop sharing</button></div>
      <p class="hint">Anyone with the link reads this story as peppermint wrote it for you, and the reports behind it.</p>
    {/if}
    <span class="lbl between">Why you see this <span class="mono score">{story.score.toFixed(2)}</span></span>
    {#each story.reasons as r}
      <div class="feat"><span>{r.label}</span><span class="track"><b class:neg={r.v < 0} style:width="{Math.min(50, Math.abs(r.v) * 100)}%"></b></span><span class="v">{signed(r.v)}</span></div>
    {/each}
    {#if story.topics.length || story.places.length}
      <div class="opt-grid mt-m">{#each [...story.topics, ...story.places] as t}<span class="opt">{t}</span>{/each}</div>
    {/if}
    <div class="tune-row mt-m">
      <button class="ghost" type="button" onclick={() => { menuOpen = false; quick("more"); }}>More like this</button>
      <button class="ghost" type="button" onclick={() => { menuOpen = false; quick("less"); }}>Less like this</button>
    </div>
    <button class="link-btn mt-s" type="button" onclick={() => { menuOpen = false; tuneOpen = true; }}>Tune by topic, place or source</button>
  {/if}
</Sheet>
<TuneSheet bind:open={tuneOpen} card={story} />
{#if video && story}<StoryVideo {id} lang={app.lang} title={story.title} source={story.items[0]?.source ?? ""}
  image={story.image && !heroFailed ? sized(story.image.src, 800) : null} people={(story.entities ?? []).filter(e => e.img).map(e => ({ name: e.name, img: sized(e.img!, 320), description: e.description ?? null }))}
  figures={(story.figures ?? []).map(f => ({ src: sized(f.src, 800), caption: f.caption }))}
  from={videoFrom} onclose={() => (video = false)} />{/if}
