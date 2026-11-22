<script lang="ts">
  import Link from "../components/Link.svelte";
  import { app, toast } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { ago } from "../lib/format";
  import { I } from "../lib/icons";
  import Fav from "../components/Fav.svelte";
  import Sheet from "../components/Sheet.svelte";

  type Src = { id: number; kind: string; name: string; config: any; filter: { any: string[]; none: string[] }; confirm: { url: string; subject: string; at: number } | null; cadence_min: number; trust: number; enabled: number; last_pull_at: number | null; last_ok_at: number | null; last_error: string | null; in24: number; through24: number; spark: number[]; icon: string | null;
    trial: { until: number; over: boolean; shown: number; opened: number; hidden: number } | null };
  let sources = $state<Src[] | null>(null);
  let sel = $state<Src | null>(null), open = $state(false), confirmRemove = $state(false);
  // the keyword filter as typed: comma or line separated, saved with the button
  let onlyWith = $state(""), neverWith = $state(""), copied = $state(false);
  async function load() { const r = await api("/api/sources"); sources = r.sources; app.sources = r.sources.filter((s: Src) => s.enabled).length; }
  // offline the list cannot load; it loads by itself once the connection is back
  $effect(() => { if (app.online) load().catch(() => {}); });

  const total = $derived(sources?.reduce((a, s) => a + s.in24, 0) ?? 0);
  const thru = $derived(sources?.reduce((a, s) => a + s.through24, 0) ?? 0);
  const CAD: [number, string][] = [[15, "15 min"], [30, "30 min"], [60, "Hourly"], [240, "4 h"], [720, "12 h"]];
  const TRUST = ["Low", "Normal", "High"];
  const daysLeft = (t: NonNullable<Src["trial"]>) => Math.max(1, Math.ceil((t.until - Date.now()) / 86400_000));
  const tried = (t: NonNullable<Src["trial"]>) => t.shown ? `opened ${t.opened} of ${t.shown}` : "none shown yet";
  // a trial is worth keeping when you opened at least one story in four and hid fewer than you opened
  const worth = (t: NonNullable<Src["trial"]>) => t.shown > 0 && t.opened / t.shown >= 0.25 && t.hidden < t.opened;
  const ended = $derived(sources?.filter(s => s.trial?.over) ?? []);
  const sub = (s: Src) => {
    if (!s.enabled) return "Paused";
    if (s.trial) return s.trial.over ? `Trial over · ${tried(s.trial)}` : `Trial, ${daysLeft(s.trial)} d left · ${tried(s.trial)}`;
    if (s.last_error) return "Last pull failed";
    if (s.kind === "mail" && s.confirm) return "Waiting for you to confirm the subscription";
    if (s.kind === "mail") return s.config.address ?? "Newsletter";
    if (s.filter?.any.length) return `Only: ${s.filter.any.join(", ")}`;
    if (s.kind === "hackernews") return `${(s.config.lists ?? []).map((l: string) => ({ top: "Top", best: "Best", show: "Show HN", ask: "Ask HN" } as any)[l]).join(", ")} · ≥${s.config.minPoints ?? 150} pts`;
    if (s.kind === "merkur") return `${(s.config.sections ?? []).length} section${(s.config.sections ?? []).length === 1 ? "" : "s"} · ${CAD.find(c => c[0] === s.cadence_min)?.[1] ?? s.cadence_min + " min"}`;
    if (s.kind === "feed") { const f: string[] = s.config.feeds ?? []; let h = ""; try { h = new URL(f[0]).hostname.replace(/^www\./, ""); } catch {} return `${h}${f.length > 1 ? ` · ${f.length} feeds` : ""} · ${CAD.find(c => c[0] === s.cadence_min)?.[1] ?? s.cadence_min + " min"}`; }
    return "";
  };
  const dot = (s: Src) => !s.enabled ? "off" : s.last_error ? "err" : "";
  const sparkPath = (v: number[]) => { const m = Math.max(1, ...v); return v.map((x, i) => `${i ? "L" : "M"}${(i / 7) * 54 + 1} ${15 - (x / m) * 13}`).join(" "); };

  function openSrc(s: Src) { sel = s; confirmRemove = false; open = true; onlyWith = s.filter.any.join(", "); neverWith = s.filter.none.join(", "); copied = false; }
  const filterChanged = $derived(!!sel && (onlyWith.trim() !== sel.filter.any.join(", ") || neverWith.trim() !== sel.filter.none.join(", ")));
  async function saveFilter() {
    await patch({ filter: { any: onlyWith, none: neverWith } });
    if (sel) { onlyWith = sel.filter.any.join(", "); neverWith = sel.filter.none.join(", "); }
    toast(sel?.filter.any.length || sel?.filter.none.length ? "Filter saved. It applies to what this source brings from now on." : "No filter: everything from this source comes in.");
  }
  async function copyAddress() { try { await navigator.clipboard.writeText(sel!.config.address); copied = true; } catch { toast("Copying did not work. Select the address by hand."); } }
  async function patch(p: Record<string, unknown>) { if (!sel) return; await api(`/api/sources/${sel.id}`, { method: "PATCH", json: p }); await load(); sel = sources!.find(s => s.id === sel!.id) ?? null; }
  async function keep(s: Src) { await api(`/api/sources/${s.id}`, { method: "PATCH", json: { trial: false } }); await load(); if (sel?.id === s.id) sel = sources!.find(x => x.id === s.id) ?? null; toast(`${s.name} stays.`); }
  async function drop(s: Src) { await api(`/api/sources/${s.id}`, { method: "DELETE" }); await load(); toast(`${s.name} removed with its items.`); }
  async function remove() { if (!sel) return; const n = sel.name; await api(`/api/sources/${sel.id}`, { method: "DELETE" }); open = false; await load(); toast(`${n} removed with its items.`); }
</script>

<div class="page">
  <header class="appbar"><h1>Sources</h1><span class="sp"></span><Link class="icon-btn" href="/sources/add" aria-label="Add source">{@html I.plus}</Link></header>
  {#if !sources && !app.online}
    <div class="empty"><b>Sources need a connection</b><span>They load by themselves when you are back online.</span></div>
  {:else if !sources}
    <div class="kpis"><div class="kpi"><b>·</b><small>loading</small></div></div>
  {:else if !sources.length}
    <div class="empty"><b>No runners yet</b><span>Every source is a runner into your bed. Plant the first one.</span><Link class="primary" href="/sources/add">Add a source</Link></div>
  {:else}
    <div class="kpis">
      <div class="kpi"><b>{sources.filter(s => s.enabled).length}</b><small>sources</small></div>
      <div class="kpi"><b>{total}</b><small>in, last 24 h</small></div>
      <div class="kpi"><b class="accent">{thru}</b><small>through</small></div>
    </div>
    {#each ended as s (s.id)}
      <div class="notice mt-s">
        <span><b>{s.name}</b>: the week is up. You {tried(s.trial!)}{s.trial!.hidden ? ` and hid ${s.trial!.hidden}` : ""}, so {worth(s.trial!) ? "it looks worth keeping" : "it did not catch on"}.</span>
        <div class="tune-row mt-xs">{#if worth(s.trial!)}<button class="ghost" type="button" onclick={() => drop(s)}>Remove</button><button class="primary" type="button" onclick={() => keep(s)}>Keep</button>
          {:else}<button class="ghost" type="button" onclick={() => keep(s)}>Keep</button><button class="primary" type="button" onclick={() => drop(s)}>Remove</button>{/if}</div>
      </div>
    {/each}
    <div class="group-label">Runners</div>
    <div class="list">
      {#each sources as s (s.id)}
        <button class="srow" class:off={!s.enabled} type="button" data-item onclick={() => openSrc(s)}>
          <Fav kind={s.kind} name={s.name} size={32} src={s.icon} />
          <span class="min0"><span class="nm">{s.name}</span><span class="sub"><span class="dot {dot(s)}"></span><span>{sub(s)}</span></span></span>
          <span class="thru">{s.in24} → {s.through24}<svg class="spark" viewBox="0 0 56 16" aria-hidden="true"><path d={sparkPath(s.spark)} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" /></svg></span>
        </button>
      {/each}
    </div>
  {/if}
</div>

<Sheet bind:open label="Source settings">
  {#if sel}
    <div class="hrow"><Fav kind={sel.kind} name={sel.name} size={38} src={sel.icon} /><div><h3>{sel.name}</h3><p class="sub">{sel.last_pull_at ? `Last pull ${ago(sel.last_pull_at)}` : "Not pulled yet"}</p></div></div>
    {#if sel.last_error}<p class="error-line mt-m">{sel.last_error}</p>{/if}
    {#if sel.kind === "mail"}
      <span class="lbl">Subscribe with this address</span>
      <div class="notice flush src-address"><code>{sel.config.address}</code><button class="ghost sm" type="button" onclick={copyAddress}>{copied ? "Copied" : "Copy"}</button></div>
      {#if sel.confirm}<p class="hint mt-s">“{sel.confirm.subject}” asks you to confirm. <a href={sel.confirm.url} target="_blank" rel="noopener noreferrer">Confirm the subscription</a>, then the issues come in here.</p>{/if}
    {/if}
    {#if sel.trial && !sel.trial.over}<p class="hint mt-m">On trial for {daysLeft(sel.trial)} more {daysLeft(sel.trial) === 1 ? "day" : "days"}: up to two of its stories per edition show as New to you. <button class="chip-btn" type="button" onclick={() => keep(sel!)}>Keep it now</button></p>{/if}
    <span class="lbl">Status</span>
    <div class="seg"><button type="button" aria-pressed={!!sel.enabled} onclick={() => patch({ enabled: true })}>Active</button><button type="button" aria-pressed={!sel.enabled} onclick={() => patch({ enabled: false })}>Paused</button></div>
    <span class="lbl">How often</span>
    <div class="seg">{#each CAD as [m, l]}<button type="button" aria-pressed={sel.cadence_min === m} onclick={() => patch({ cadence: m })}>{l}</button>{/each}</div>
    <span class="lbl">Trust</span>
    <div class="seg">{#each TRUST as t, i}<button type="button" aria-pressed={sel.trust === i} onclick={() => patch({ trust: i })}>{t}</button>{/each}</div>
    <span class="lbl">Keyword filter</span>
    <label class="field">Only items that mention<input type="text" bind:value={onlyWith} placeholder="e.g. REACH, RoHS, packaging, restrict*" /><small>Any one of these words or phrases. Empty: everything.</small></label>
    <label class="field">Never items that mention<input type="text" bind:value={neverWith} placeholder="e.g. football" /></label>
    <p class="hint">Whole words, any case; a * at the end matches the start of a word. It applies to what comes in from now on.</p>
    {#if filterChanged}<button class="primary sm mt-s" type="button" onclick={saveFilter}>Save filter</button>{/if}
    {#if !confirmRemove}
      <button class="ghost danger full mt-l" type="button" onclick={() => (confirmRemove = true)}>Remove source</button>
    {:else}
      <p class="sub mt-l">Removing {sel.name} deletes its {sel.in24 ? "items, including today’s" : "items"}. Your palate stays.</p>
      <div class="tune-row mt-s"><button class="ghost" type="button" onclick={() => (confirmRemove = false)}>Keep it</button><button class="primary danger" type="button" onclick={remove}>Remove</button></div>
    {/if}
  {/if}
</Sheet>
