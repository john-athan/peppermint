<script lang="ts">
  // Follow things by name or link, no account: podcasts and YouTube channels (public directories and feeds), Bluesky people,
  // Mastodon accounts, GitHub repositories (releases), arXiv categories, keywords (topic), single pages (watch), ECHA's
  // lists, EU consultations by keyword and newsletters (each gets its own address, shown once it is made).
  import { app, toast, firstHarvest } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import Fav from "./Fav.svelte";
  import Skeleton from "./Skeleton.svelte";
  type C = { kind: string; name: string; by: string; image: string | null; feed: string; note?: string; followed: boolean; config?: Record<string, unknown> };
  let { kind }: { kind: string } = $props();
  // live kinds search while you type; the others look up one thing when you press Enter
  const LIVE = ["podcast", "youtube", "bluesky", "arxiv", "echa"];
  // kinds whose picker lists everything without a query
  const ALL = ["arxiv", "echa"];
  const HINT: Record<string, string> = {
    podcast: "Search shows, e.g. Hard Fork", youtube: "Channel name, @handle or link", bluesky: "Name, handle or bsky.app link",
    mastodon: "@user@mastodon.social or profile link", github: "owner/repo or github.com link", arxiv: "Filter, or type a query for a custom feed",
    topic: "A keyword or phrase, e.g. Isar Hochwasser", watch: "Link of the page to watch",
    consult: "A keyword, e.g. packaging or REACH", mail: "The newsletter's name, e.g. ECHA Weekly", echa: "",
  };
  const EMPTY: Record<string, string> = {
    youtube: "Try the channel's @handle or paste its link.", podcast: "Try the show's exact name.", bluesky: "Try the exact handle, like name.bsky.social.",
  };
  let q = $state(""), lang = $state("de"), results = $state<C[]>([]), busy = $state(false), error = $state(""), adding = $state(""), asked = $state(false);
  let made = $state<{ name: string; address: string } | null>(null), copied = $state(false);
  let t: ReturnType<typeof setTimeout> | undefined, seq = 0;
  async function search() {
    const query = q.trim(), my = ++seq; error = "";
    if (query.length < 2 && !ALL.includes(kind)) { results = []; asked = false; return; }
    busy = true; asked = true;
    try { const r = await api(`/api/creators?kind=${kind}&q=${encodeURIComponent(query)}&lang=${lang}`); if (my === seq) results = r.results; }
    catch (e: any) { if (my === seq) { error = e.message; results = []; } }
    if (my === seq) busy = false;
  }
  $effect(() => {
    void q; void lang; clearTimeout(t);
    if (LIVE.includes(kind)) t = setTimeout(search, ALL.includes(kind) ? 0 : 350); else { results = []; asked = false; }
    return () => clearTimeout(t);
  });
  async function follow(c: C) {
    adding = c.feed;
    try {
      const json = c.config ? { kind, name: c.name, config: c.config, image: c.image } : { kind, name: c.name, options: [c.feed], image: c.image, cadence: kind === "podcast" ? 240 : 60, trust: 1 };
      const r = await api<{ id: number; address?: string }>("/api/sources", { method: "POST", json });
      c.followed = true; app.sources = Math.max(1, app.sources);
      // a newsletter has nothing to pull yet: what you need now is the address to subscribe with
      if (r.address) { made = { name: c.name, address: r.address }; copied = false; }
      else { toast(`Following ${c.name} · first pull runs now`, { loading: true }); firstHarvest(c.name); }
    } catch (e: any) { toast(e.message); }
    adding = "";
  }
  const round = $derived(["youtube", "bluesky", "mastodon"].includes(kind));
  async function copy() { if (!made) return; try { await navigator.clipboard.writeText(made.address); copied = true; } catch { toast("Copying did not work. Select the address by hand."); } }
</script>

<div class="creators">
  {#if !ALL.includes(kind) || kind === "arxiv"}<form onsubmit={(e) => { e.preventDefault(); if (!LIVE.includes(kind)) search(); }}>
    <input class="creator-q" type="search" bind:value={q} placeholder={HINT[kind]} aria-label={HINT[kind]} autocomplete="off" autocapitalize="off" />
    {#if kind === "topic"}<div class="seg mt-m">{#each [["de", "German"], ["en", "English"]] as [l, n]}<button type="button" aria-pressed={lang === l} onclick={() => (lang = l)}>{n}</button>{/each}</div>{/if}
    {#if !LIVE.includes(kind)}<button class="primary mt-m" type="submit" disabled={busy || q.trim().length < 2}>{busy ? "Looking…" : kind === "topic" || kind === "consult" ? "Preview" : kind === "mail" ? "Make an address" : "Look up"}</button>{/if}
  </form>{/if}
  {#if made}
    <div class="notice flush mt-m" role="status">
      <span><b>{made.name}</b> has its own address. Subscribe to the newsletter with it; every issue that arrives becomes a story here.</span>
      <div class="src-address"><code>{made.address}</code><button class="ghost sm" type="button" onclick={copy}>{copied ? "Copied" : "Copy"}</button></div>
      <span class="hint">If the newsletter asks you to confirm, the confirm link shows up on this source in Sources.</span>
    </div>
  {/if}
  {#if error}<p class="error-line">{error}</p>{/if}
  {#if busy && !results.length}<Skeleton sm lines={2} last="70%" cls="mt-m" />{/if}
  <div class="creator-list" aria-live="polite">
    {#each results as c (c.feed)}
      <div class="creator">
        {#if c.image}<img src={c.image} alt="" loading="lazy" class:round referrerpolicy="no-referrer" />{:else}<Fav {kind} size={44} />{/if}
        <span class="who"><b>{c.name}</b><small>{[c.by !== "YouTube" ? c.by : "", c.note].filter(Boolean).join(" · ")}</small></span>
        <button class={c.followed ? "ghost sm" : "primary sm"} type="button" disabled={c.followed || adding === c.feed} onclick={() => follow(c)}>{c.followed ? "Following" : adding === c.feed ? "Adding…" : "Follow"}</button>
      </div>
    {/each}
  </div>
  {#if asked && !busy && !results.length && !error && q.trim().length >= 2}<p class="sub mt-m">Nothing found. {EMPTY[kind] ?? ""}</p>{/if}
</div>
