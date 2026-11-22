<script lang="ts">
  import Link from "../components/Link.svelte";
  import { I } from "../lib/icons";
  import { app, toast, type Card as C } from "../lib/state.svelte";
  import { api, sse, keepOffline } from "../lib/api";
  import { dayLabel } from "../lib/format";
  import Card from "../components/Card.svelte";
  import TuneSheet from "../components/TuneSheet.svelte";
  import Mark from "../components/Mark.svelte";
  import Pull from "../components/Pull.svelte";
  import AskBar from "../components/AskBar.svelte";
  import AgentCard from "../components/AgentCard.svelte";
  import CaseNews from "../components/CaseNews.svelte";
  import { openCapture } from "../lib/capture.svelte";
  import { agent, watchAgent, openProposals, submit } from "../lib/agent.svelte";
  import { tick } from "svelte";
  import { flyFrom, reduced } from "../lib/motion";

  let tuneOpen = $state(false), tuneCard = $state<C | null>(null);
  let busy = $state(false), ptrMsg = $state("Starting…");
  let cut = $state<{ id: number; title: string; reason: string; score: number }[] | null>(null);
  const ed = $derived(app.edition);
  const through = $derived(ed?.cards.length ?? 0);
  const considered = $derived(Math.max(through, ed?.considered ?? 0));

  async function refresh() { const r = await api("/api/edition"); app.edition = r.edition; app.updates = r.updates ?? []; app.sources = r.sources; app.llmServer = r.llm; app.llm = r.llm && app.online; cut = null; app.feed = { cards: [], done: false, fresh: [] }; }

  // ---- endless: after the edition, the next stories your palate rates as likely interesting, a page at a time,
  // fetched well before you reach the end; it stops only when nothing interesting is left ----
  let loadingMore = $state(false);
  // the endless part lives in app state (it must still be there when you come back from a story)
  const more = $derived(app.feed.cards), feedDone = $derived(app.feed.done);
  async function loadMore() {
    if (loadingMore || feedDone || !ed || !app.online) return;
    loadingMore = true;
    try {
      const r = await api("/api/feed", { method: "POST", json: { shown: [...ed.cards, ...more].map(c => c.id) } });
      const have = new Set([...ed.cards, ...more].map(c => c.id));
      const add = (r.cards as C[]).filter(c => !have.has(c.id));
      app.feed.cards = [...more, ...add]; app.feed.fresh = add.map(c => c.id);
      if (!r.more || !r.cards.length) app.feed.done = true;
    } catch { app.feed.done = true; } finally { loadingMore = false; }
  }
  function nearEnd(node: HTMLElement) {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) loadMore(); }, { rootMargin: "1600px 0px" });
    io.observe(node);
    return { destroy: () => io.disconnect() };
  }

  export function harvestNow() {
    if (busy) return;
    if (!app.online) { toast("Offline. The next harvest starts when you are back online."); return; }
    busy = true; ptrMsg = "Harvesting…";
    let added = 0;
    sse("/api/harvest", {
      source: d => { added += d.added; ptrMsg = d.error ? `${d.name}: ${d.error.slice(0, 40)}` : `${d.name}: ${d.added} new`; },
      tagging: d => { ptrMsg = `Distilling ${d.n} new item${d.n === 1 ? "" : "s"}…`; },
      edition: async d => {
        await refresh(); busy = false;
        // the fresh harvest's cards rise in one after another
        app.feed.fresh = (app.edition?.cards ?? []).slice(0, 6).map(c => c.id);
        toast(d.through ? `${d.through} new made it through · ${added - d.through > 0 ? added - d.through : 0} cut back` : added ? `${added} new items, none made it through` : "Nothing new since the last harvest");
      },
      error: d => { busy = false; toast(d.message ?? "Harvest failed."); },
    });
  }

  // first visit with sources but no edition yet: harvest right away
  $effect(() => { if (app.sources && !ed && !busy) harvestNow(); });
  // keep an open edition fresh when the tab comes back; the new edition starts at its top, so glide there as it loads
  $effect(() => {
    const v = () => {
      if (document.visibilityState !== "visible" || !ed || Date.now() - ed.updated_at <= 10 * 60_000) return;
      if (scrollY > 0) scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
      refresh();
    };
    document.addEventListener("visibilitychange", v); return () => document.removeEventListener("visibilitychange", v);
  });

  async function peek(e: Event) { if ((e.currentTarget as HTMLDetailsElement).open && !cut) cut = (await api("/api/edition/cut")).items; }
  async function rescue(id: number) {
    await api("/api/signals", { method: "POST", json: { story_id: id, kind: "rescue" } });
    await refresh(); toast("Rescued into this harvest. Palate noted it.");
  }
  const hideCard = (id: number) => { if (app.edition) app.edition.cards = app.edition.cards.filter(c => c.id !== id); app.feed.cards = more.filter(c => c.id !== id); };
  // a card lives either in the edition or further down the endless part; undo puts it back where it was
  const placeOf = (c: C) => { const i = ed?.cards.findIndex(x => x.id === c.id) ?? -1; return i >= 0 ? { list: "ed" as const, at: i } : { list: "more" as const, at: more.findIndex(x => x.id === c.id) }; };
  function putBack(c: C, p: ReturnType<typeof placeOf>) {
    if (p.list === "ed") { if (app.edition && !app.edition.cards.some(x => x.id === c.id)) app.edition.cards.splice(Math.max(0, p.at), 0, c); }
    else if (!more.some(x => x.id === c.id)) { const m = [...more]; m.splice(Math.max(0, p.at), 0, c); app.feed.cards = m; }
  }
  // dismiss: gone at once, undo brings it back where it was
  async function dismiss(c: C) {
    const at = placeOf(c);
    hideCard(c.id);
    await api("/api/signals", { method: "POST", json: { story_id: c.id, kind: "hide" } }).catch(() => {});
    toast("Dismissed. Palate noted it.", { ms: 5000, action: { label: "Undo", run: async () => {
      await api("/api/signals", { method: "POST", json: { story_id: c.id, kind: "unhide" } });
      putBack(c, at); app.feed.fresh = [c.id];
      toast("Back in your harvest.");
    } } });
  }
  // save: off Today and onto the reading list; undo puts it back where it was
  // the whole harvest on this device, for the train or the plane
  let kept = $state<"" | "busy" | "done">(""), keptPct = $state(0);
  async function keepHarvest() {
    kept = "busy"; keptPct = 0;
    try {
      const r = await keepOffline("harvest", (d, t) => { keptPct = Math.round((d / t) * 100); });
      kept = "done";
      toast(r.failed ? `${r.stories} stories kept on this device (${r.failed} pieces could not be fetched).` : `${r.stories} stories kept on this device. They open without a connection.`);
    } catch (e: any) { kept = ""; toast(e.message); }
  }
  async function pin(c: C) {
    const at = placeOf(c);
    hideCard(c.id);
    await api("/api/signals", { method: "POST", json: { story_id: c.id, kind: "pin" } }).catch(() => {});
    dispatchEvent(new Event("pm-saved"));
    if (app.edition) app.edition.saved = (app.edition.saved ?? 0) + 1;
    toast("Saved to your reading list.", { ms: 5000, action: { label: "Undo", run: async () => {
      await api("/api/signals", { method: "POST", json: { story_id: c.id, kind: "unpin" } });
      putBack({ ...c, pinned: false }, at); if (app.edition) app.edition.saved = Math.max(0, (app.edition.saved ?? 1) - 1);
      // the leaf flies back out of List and the card unfolds where it was
      await tick(); const back = document.querySelector(`[data-story="${c.id}"]`); if (back) flyFrom("/list", back);
    } } });
  }
  // the agent's cards sit above the edition and fill in while you look; dossiers live in Research, and one with news
  // comes back here as an update card
  $effect(() => watchAgent());
  // what is being worked on first, then the newest
  const mine = $derived(agent.tasks.filter(t => t.kind !== "dossier" && (t.kind !== "probe" || !t.result?.verdict) && (t.kind !== "link" || t.story_id)).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.created_at - a.created_at));
  const suggested = $derived(openProposals().length);
  const cutTotal = $derived(ed?.cut.reduce((a, c) => a + c.n, 0) ?? 0);
  const cutMax = $derived(Math.max(1, ...(ed?.cut.map(c => c.n) ?? [1])));
  // Today scrolls one card at a time: the page snaps each card to the middle of the screen
  $effect(() => { document.documentElement.classList.add("snap-feed"); return () => document.documentElement.classList.remove("snap-feed"); });
</script>

<div class="page today">
  <Pull verb="harvest" {busy} msg={ptrMsg} onpull={harvestNow} />
  <div class="snap-top">
    <header class="appbar"><h1>Today</h1><span class="sp"></span><Link class="icon-btn acct-entry" href="/account" aria-label="Account and people">{@html I.key}</Link></header>
    <div class="agent-top">
      <AskBar search placeholder="Ask, paste a link, or follow…" onsubmit={(q) => submit(q, { kind: "today" })} oncapture={() => openCapture()} />
      <CaseNews />
      {#if mine.length}<div class="ag-row">{#each mine as t (t.id)}<AgentCard task={t} />{/each}</div>{/if}
      {#if suggested}<Link class="ag-line" href="/palate">✦ {suggested} palate suggestion{suggested === 1 ? "" : "s"}</Link>{/if}
    </div>
  </div>

  {#if !app.sources}
    <div class="empty">
      <Mark cls="anim" label="" />
      <b>Nothing planted yet</b>
      <span>Add Hacker News, merkur.de, a YouTube channel or a podcast. The first harvest starts right away.</span>
      <Link class="primary" href="/sources/add">Add a source</Link>
    </div>
  {:else if !ed}
    <div class="empty">
      <Mark cls="anim loading" label="" />
      <b>First harvest</b>
      <span>{ptrMsg}</span>
    </div>
  {:else}
    <div class="ed-meta">
      <span class="ed-date">{dayLabel(ed.day)} · {ed.slot === "morning" ? "Morning" : "Evening"} harvest{ed.current ? "" : " · earlier"}</span>
      <div class="funnel" title="{considered} items arrived for this harvest. {through} cleared your palate.">
        <span><b class="strong">{through}</b> of {considered}</span>
        <span class="bar"><b style:width="{Math.max(2, (through / Math.max(1, considered)) * 100)}%"></b></span>
        {#if through}<span>{ed.minutes} min</span>{/if}
      </div>
      <div class="ed-acts">
        <Link class="chip-btn" href="/briefing">Morning briefing</Link>
        {#if app.online}<button class="chip-btn" type="button" disabled={kept === "busy"} onclick={keepHarvest} title="Keep these stories, their texts and pictures on this device to read without a connection">
          {kept === "busy" ? `Saving… ${keptPct}%` : kept === "done" ? "On this device" : "Keep offline"}
        </button>{/if}
      </div>
    </div>
    {#if !through}
      <div class="empty snap-top">{#if ed.viewed}<b>You are through this harvest</b><span>{ed.viewed} {ed.viewed === 1 ? "story" : "stories"} viewed. More from your palate below.</span>{:else}<b>Nothing new made it through</b><span>Here is what your palate still finds interesting from the last days.</span>{/if}</div>
    {/if}
    <div class="cards feed">
      <!-- followed stories with news come first -->
      {#each app.updates as c (c.id)}<Card big card={c} ontune={(x) => { tuneCard = x; tuneOpen = true; }} ondismiss={(x) => { app.updates = app.updates.filter(u => u.id !== x.id); api("/api/follow/seen", { method: "POST", json: { story_id: x.id } }).catch(() => {}); }} onpin={pin} />{/each}
      {#each ed.cards as c (c.id)}<Card big card={c} ontune={(x) => { tuneCard = x; tuneOpen = true; }} ondismiss={dismiss} onpin={pin} />{/each}
      {#if more.length}
        <div class="feed-divider"><Mark cls="sm anim" label="" /><b>More for you</b><span>From the last days, picked by your palate</span></div>
        {#each more as c (c.id)}<Card big card={c} ontune={(x) => { tuneCard = x; tuneOpen = true; }} ondismiss={dismiss} onpin={pin} />{/each}
      {/if}
      {#if !feedDone && app.online}
        <div class="card-wrap big" use:nearEnd><div class="card big feed-wait pm-shimmer leaf" aria-label="Finding more for you"></div></div>
      {/if}
    </div>
    <!-- once nothing interesting is left: everything below the cards is one snap area, scrolling freely inside -->
    {#if feedDone}
    <div class="feed-tail">
    {#if through && ed.viewed}<Link class="viewed-note" href="/history">{ed.viewed} viewed earlier · history</Link>{/if}
    {#if cutTotal}
      <details class="below" ontoggle={peek}>
        <summary>{cutTotal} cut back</summary>
        <div class="reasons">
          {#each ed.cut as c}<div class="r"><span>{c.reason}</span><b>{c.n}</b><i style:width="{(c.n / cutMax) * 100}%"></i></div>{/each}
        </div>
        {#if cut}
          <div class="peek">
            {#each cut.slice(0, 20) as x (x.id)}
              <div class="pi"><span>{x.title}<small>{x.reason} · {x.score.toFixed(2)}</small></span><button class="chip-btn" type="button" onclick={() => rescue(x.id)}>Rescue</button></div>
            {/each}
          </div>
        {/if}
      </details>
    {/if}
    <div class="end"><i class="drift" aria-hidden="true"></i><Mark cls="sm" label="" /><b>That’s everything worth reading right now.</b>New stories arrive with the next harvest at {ed.slot === "morning" ? "17:00" : "07:00"}, or pull down any time.</div>
    </div>
    {/if}
  {/if}
</div>
<TuneSheet bind:open={tuneOpen} card={tuneCard} onhide={hideCard} onpin={pin} />
