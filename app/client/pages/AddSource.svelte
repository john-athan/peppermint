<script lang="ts">
  import Loading from "../components/Loading.svelte";
  import { app, go, toast, firstHarvest } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { I } from "../lib/icons";
  import { hasKeys } from "../lib/keys";
  import Fav from "../components/Fav.svelte";
  import CreatorPicker from "../components/CreatorPicker.svelte";
  import Catalog from "../components/Catalog.svelte";

  type Disc = { image?: string | null; icon?: string | null; config?: Record<string, unknown>; kind: string; name: string; subtitle: string; options: { key: string; label: string; perDay: number; on: boolean }[]; cadence: number; sample: { title: string; lang: string }[] };
  const KINDS = [
    { kind: "hackernews", name: "Hacker News", sub: "Lists and a points floor" },
    { kind: "merkur", name: "merkur.de", sub: "Münchner Merkur sections" },
    { kind: "feed", name: "Any site", sub: "RSS, Atom, JSON Feed" },
    { kind: "catalog", name: "Popular sources", sub: "Curated, one tap each" },
    { kind: "watch", name: "Watch a page", sub: "Alerts when its text changes" },
    { kind: "mail", name: "Newsletter", sub: "Its own address to subscribe with" },
    { kind: "youtube", name: "YouTube", sub: "Channels by name" },
    { kind: "podcast", name: "Podcasts", sub: "Shows by name" },
    { kind: "bluesky", name: "Bluesky", sub: "People by name or handle" },
    { kind: "mastodon", name: "Mastodon", sub: "@user@instance" },
    { kind: "topic", name: "Topic", sub: "News about a keyword" },
    { kind: "github", name: "GitHub", sub: "Releases of a repo" },
    { kind: "arxiv", name: "arXiv", sub: "New papers by field" },
    { kind: "echa", name: "ECHA lists", sub: "SVHC, restrictions, authorisation" },
    { kind: "consult", name: "EU consultations", sub: "Have your say, by keyword" },
  ];
  const PICKERS: Record<string, { title: string; sub: string }> = {
    youtube: { title: "YouTube channels", sub: "New videos with their descriptions, played right here" },
    podcast: { title: "Podcasts", sub: "New episodes with show notes, played right here" },
    bluesky: { title: "Bluesky", sub: "Posts from people you pick, with link cards and pictures" },
    mastodon: { title: "Mastodon", sub: "Posts from one account on any server" },
    topic: { title: "Topic", sub: "Everything new about a keyword, read in full" },
    github: { title: "GitHub releases", sub: "A note for every new release of a repository" },
    arxiv: { title: "arXiv", sub: "Newest papers in a field, with abstract and PDF" },
    watch: { title: "Watch a page", sub: "One item when the page's text changes" },
    echa: { title: "ECHA lists", sub: "Read from ECHA CHEM; new and changed entries become stories" },
    consult: { title: "EU consultations", sub: "Have your say: a story whenever feedback opens on a matching initiative" },
    mail: { title: "Newsletter", sub: "Name it, then subscribe with the address peppermint gives it" },
  };
  let picked = $state(""), loading = $state(false), disc = $state<Disc | null>(null), error = $state("");
  let on = $state<string[]>([]), cadence = $state(60), trust = $state(1), minPoints = $state(150);

  async function discover(q: { kind?: string; url?: string }) {
    error = ""; disc = null; loading = true;
    try {
      const d: Disc = await api(`/api/discover?${new URLSearchParams(q as any)}`);
      disc = d; picked = d.kind; on = d.options.filter(o => o.on).map(o => o.key); cadence = d.cadence || 60;
    } catch (e: any) { error = e.message; }
    loading = false;
  }
  async function fromClipboard() {
    try { const t = await navigator.clipboard.readText(); if (t.trim()) return discover({ url: t.trim() }); error = "The clipboard is empty. Copy the link of any site or feed first."; }
    catch { error = hasKeys ? "Clipboard access was blocked. Copy the site's link, then press ⌘V (or Ctrl V) on this page." : "Clipboard access was blocked. Allow it for this site in the browser settings, then tap Paste a link again."; }
  }
  $effect(() => {
    // a link pasted anywhere on the page finds its feeds, except into a field: there it is what you are typing (the Watch
    // a page field, a topic, a newsletter's name)
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as Element | null)?.closest?.("input, textarea, [contenteditable]")) return;
      const t = e.clipboardData?.getData("text")?.trim(); if (t && /^https?:\/\//.test(t)) { e.preventDefault(); discover({ url: t }); }
    };
    addEventListener("paste", onPaste); return () => removeEventListener("paste", onPaste);
  });
  const perDay = $derived(disc ? disc.options.filter(o => on.includes(o.key)).reduce((a, o) => a + o.perDay, 0) : 0);
  const ratio = 0.08; // share of items that clear a typical palate; replaced by your own once there is history
  const toggle = (k: string) => { on = on.includes(k) ? on.filter(x => x !== k) : [...on, k]; };
  async function add() {
    if (!disc) return;
    await api("/api/sources", { method: "POST", json: { kind: disc.kind, name: disc.name, options: on, cadence, trust, minPoints, config: disc.config, image: disc.image } });
    app.sources = Math.max(1, app.sources);
    toast(`${disc.name} added · first pull runs now`, { loading: true });
    go("/sources");
    firstHarvest(disc!.name);
  }
  const back = (e: MouseEvent) => { e.preventDefault(); go("/sources"); };
</script>

<div class="page">
  <header class="appbar"><a class="back" href="/sources" onclick={back}>{@html I.back}Sources</a></header>
  <header class="appbar tight"><h1>Add source</h1></header>
  <button class="paste" type="button" onclick={fromClipboard}>{@html I.paste}<span>Paste a link<small>{hasKeys ? "or press ⌘V anywhere here. " : ""}peppermint finds the feeds.</small></span></button>
  <button class="paste find" type="button" aria-pressed={picked === "suggest"} onclick={() => ((picked = "suggest"), (disc = null), (error = ""))}>{@html I.spark}<span>Find sources for me<small>Claude picks feeds from your palate and research. You try each one for a week.</small></span></button>

  {#if loading}
    <Loading text="Looking for feeds…" />
  {:else if error}
    <p class="error-line pad mt-xs">{error}</p>
  {/if}

  {#if !disc && PICKERS[picked]}
    <div class="detected">
      <div class="hd"><Fav kind={picked} size={38} /><div><b>{PICKERS[picked].title}</b><small>{PICKERS[picked].sub} · no account needed</small></div></div>
      {#key picked}<CreatorPicker kind={picked} />{/key}
    </div>
  {/if}

  {#if !disc && picked === "suggest"}
    <div class="detected">
      <div class="hd"><Fav kind="catalog" size={38} /><div><b>Sources for you</b><small>Every feed was opened and read before it is listed · on trial for a week</small></div></div>
      <Catalog suggest />
    </div>
  {/if}

  {#if !disc && picked === "catalog"}
    <div class="detected">
      <div class="hd"><Fav kind="catalog" size={38} /><div><b>Popular sources</b><small>Munich, Germany, tech, AI and business · added as normal feeds</small></div></div>
      <Catalog />
    </div>
  {/if}

  {#if disc}
    <div class="detected">
      <div class="hd"><Fav kind={disc.kind} name={disc.name} size={38} src={disc.icon} /><div><b>{disc.name}</b><small>{disc.subtitle}</small></div></div>
        <span class="lbl">{disc.kind === "merkur" ? "Sections" : disc.kind === "hackernews" ? "Lists" : disc.kind === "feed" ? "Feeds" : "Follow"}</span>
        <div>
          {#each disc.options as o}
            <label class="feedopt"><input type="checkbox" checked={on.includes(o.key)} onchange={() => toggle(o.key)} /><span>{o.label}</span><small>~{o.perDay}/day</small></label>
          {/each}
        </div>
        {#if disc.kind === "hackernews"}
          <span class="lbl">Points floor</span>
          <div class="seg">{#each [50, 100, 150, 300] as p}<button type="button" aria-pressed={minPoints === p} onclick={() => (minPoints = p)}>≥ {p}</button>{/each}</div>
        {/if}
        <span class="lbl">How often</span>
        <div class="seg">{#each [[15, "15 min"], [30, "30 min"], [60, "Hourly"], [240, "4 h"]] as [m, l]}<button type="button" aria-pressed={cadence === m} onclick={() => (cadence = m as number)}>{l}</button>{/each}</div>
        <span class="lbl">Trust</span>
        <div class="seg">{#each ["Low", "Normal", "High"] as t, i}<button type="button" aria-pressed={trust === i} onclick={() => (trust = i)}>{t}</button>{/each}</div>
        {#if disc.sample.length}
          <span class="lbl">On it right now</span>
          <div class="sample">{#each disc.sample as s}<div>{s.title}</div>{/each}</div>
        {/if}
        <div class="estimate"><b>~{perDay}</b> in <span aria-hidden="true">→</span> <b class="out">~{Math.max(on.length ? 1 : 0, Math.round(perDay * ratio))}</b> through a day</div>
        <button class="primary full mt-s" type="button" disabled={!on.length} onclick={add}>Add {disc.name}</button>
    </div>
  {/if}

  <div class="group-label">Or pick a kind</div>
  <div class="kinds">
    {#each KINDS as k}
      <button class="kind" type="button" disabled={k.soon} aria-pressed={picked === k.kind} onclick={() => !k.soon && (k.kind === "feed" ? fromClipboard() : k.kind === "catalog" || PICKERS[k.kind] ? ((picked = k.kind), (disc = null), (error = "")) : discover({ kind: k.kind }))}>
        {#if k.soon || k.kind === "catalog"}{#if k.soon}<span class="soon">soon</span>{/if}<Fav kind={k.kind} size={34} />{:else}<Fav kind={k.kind} size={34} />{/if}
        {k.name}<small>{k.sub}</small>
      </button>
    {/each}
  </div>
  <div class="spacer"></div>
</div>
