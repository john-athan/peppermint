<script lang="ts">
  import Skeleton from "../components/Skeleton.svelte";
  import Link from "../components/Link.svelte";
  // Your history: what you viewed on Today, opened, read and clicked, with reading time. It lives in your own
  // peppermint, feeds only your palate, and you can download or clear it here.
  import { toast } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { I } from "../lib/icons";
  import { undoProposal } from "../lib/agent.svelte";
  import type { PalateChange, Proposal } from "../../shared/types";
  type H = { story_id: number; title: string; first: number; last: number; seen: boolean; opened: number; read_ms: number; clicks: number; lenses: string[]; verdict: string | null; pinned: boolean };
  let doneByAgent = $state<Proposal[]>([]), items = $state<H[] | null>(null), total = $state(0), readMs = $state(0), filter = $state<"all" | "read" | "viewed">("all"), confirm = $state(false);
  async function load() { const r = await api("/api/history"); items = r.items; doneByAgent = r.agent ?? []; total = r.total; readMs = r.read_ms; }
  $effect(() => { load(); });
  const dur = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min${ms % 60_000 >= 30_000 ? " " + Math.round((ms % 60_000) / 1000) + " s" : ""}`;
  const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const shown = $derived((items ?? []).filter(h => filter === "all" || (filter === "read" ? h.opened || h.read_ms : h.seen && !h.opened)));
  const groups = $derived.by(() => { const m = new Map<string, H[]>(); for (const h of shown) { const d = day(h.last); (m.get(d) ?? m.set(d, []).get(d)!).push(h); } return [...m]; });
  const VERDICT: Record<string, string> = { more: "more like this", less: "less like this", hide: "dismissed", unhide: "brought back", rescue: "rescued" };
  // one line per proposal: "Robotics +1.4, Never: Football"
  const line = (cs: PalateChange[]) => cs.map(c => c.type === "weight" ? `${c.name} ${c.weight > 0 ? "+" : c.weight < 0 ? "−" : ""}${Math.abs(c.weight).toFixed(1)}` : `${c.action[0].toUpperCase()}${c.action.slice(1)}: ${c.value}`).join(", ");
  const undo = async (p: Proposal) => { try { await undoProposal(p.id); await load(); } catch (e) { toast((e as Error).message); } };
  async function clearAll() { const r = await api("/api/history", { method: "DELETE" }); confirm = false; toast(`${r.deleted} entries deleted. Your palate keeps what it learned.`); load(); }
</script>

<div class="page wide">
  <header class="appbar"><Link class="back" href="/palate">{@html I.back}Palate</Link><span class="sp"></span>
    <a class="ghost sm" href="/api/history/export" download>Download</a>
  </header>
  <div class="hist-head">
    <h1>History</h1>
    <p>What you viewed, opened, read and clicked in the last 30 days. It stays in your peppermint and only tunes your palate.</p>
    {#if items}<div class="hist-stats"><span><b>{items.filter(h => h.seen).length}</b> viewed</span><span><b>{items.filter(h => h.opened).length}</b> opened</span><span><b>{dur(readMs)}</b> reading</span><span><b>{items.reduce((a, h) => a + h.clicks, 0)}</b> clicks</span></div>{/if}
    <div class="seg" role="group" aria-label="Show">
      {#each [["all", "All"], ["read", "Opened"], ["viewed", "Only viewed"]] as [k, l]}<button type="button" aria-pressed={filter === k} onclick={() => (filter = k as any)}>{l}</button>{/each}
    </div>
  </div>
  {#if doneByAgent.length}
    <div class="group-label">Done by the agent</div>
    <div class="hist-list ag-log">
      {#each doneByAgent as p (p.id)}
        <div class="hist">
          <span class="t">{p.said || p.why}</span>
          <span class="tags"><i>{line(p.changes)}</i><i class:on={p.status === "applied"}>{p.status}</i></span>
          {#if p.status === "applied"}<button class="ghost sm" type="button" onclick={() => undo(p)}>Undo</button>{/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if !items}
    <Skeleton cls="pad" />
  {:else if !shown.length}
    <div class="empty"><b>Nothing here yet</b><span>Scroll Today and open stories; they show up here.</span></div>
  {:else}
    {#each groups as [d, hs]}
      <div class="group-label">{d}</div>
      <div class="hist-list">
        {#each hs as h (h.story_id)}
          <Link class="hist" href="/story/{h.story_id}" data-item>
            <span class="t">{h.title}</span>
            <span class="tags">
              {#if h.opened}<i class="on">opened{h.opened > 1 ? ` ${h.opened}×` : ""}</i>{:else if h.seen}<i>viewed</i>{/if}
              {#if h.read_ms}<i class="on">{dur(h.read_ms)} read</i>{/if}
              {#if h.clicks}<i>{h.clicks} click{h.clicks > 1 ? "s" : ""}</i>{/if}
              {#each h.lenses as l}<i>{l}</i>{/each}
              {#if h.pinned}<i class="pin">saved</i>{/if}
              {#if h.verdict}<i class:neg={h.verdict === "less" || h.verdict === "hide"}>{VERDICT[h.verdict]}</i>{/if}
            </span>
          </Link>
        {/each}
      </div>
    {/each}
  {/if}
  <div class="hist-foot">
    {#if confirm}
      <span>Delete all {total} entries? Your palate weights stay.</span>
      <button class="ghost" type="button" onclick={() => (confirm = false)}>Keep</button>
      <button class="ghost danger" type="button" onclick={clearAll}>Delete</button>
    {:else}<button class="ghost" type="button" onclick={() => (confirm = true)}>Clear history</button>{/if}
  </div>
</div>
