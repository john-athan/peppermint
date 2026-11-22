<script lang="ts">
  // The morning briefing: Claude's short read of the harvest in your style, each section with its story's picture and
  // a link into the story. Whether it is written and where it is emailed is set in Palate.
  import { api } from "../lib/api";
  import { app, toast, type Card } from "../lib/state.svelte";
  import { blocks, kpis } from "../lib/lens";
  import { dayLabel } from "../lib/format";
  import Link from "../components/Link.svelte";
  import Pic from "../components/Pic.svelte";
  import ChartView from "../components/Chart.svelte";
  import Loading from "../components/Loading.svelte";

  type B = { day: string; text: string; stories: { n: number; id: number }[]; sent_at: number | null; error: string | null };
  let b = $state<B | null>(null), cards = $state<{ n: number; card: Card }[]>([]), loaded = $state(false);
  let writing = $state(false);
  const load = () => api("/api/briefing").then(r => { b = r.briefing; cards = r.cards; loaded = true; }).catch(e => { loaded = true; toast(e.message); });
  $effect(() => { load(); });

  // the key figures Claude put after the lead, and the rest of the text
  const figs = $derived(kpis(b?.text ?? ""));
  const bs = $derived(blocks("briefing", figs.text));
  const byN = $derived(new Map(cards.map(c => [c.n, c.card])));
  /** "## Headline {3}": the heading and the story it points to */
  function head(s: string) {
    const m = /\s*\{(\d+)\}\s*$/.exec(s);
    return { title: m ? s.slice(0, m.index).trim() : s, card: m ? byN.get(Number(m[1])) ?? null : null };
  }

  async function writeNow() {
    writing = true;
    try { await api("/api/briefing", { method: "POST" }); await load(); } catch (e: any) { toast(e.message); } finally { writing = false; }
  }
</script>

<div class="page">
  <header class="appbar"><Link class="back" href="/">Today</Link><h1>Morning briefing</h1></header>
  {#if !loaded}
    <Loading />
  {:else if writing}
    <Loading text="Claude is writing your briefing…" />
  {:else if !b}
    <div class="empty"><b>No briefing yet</b><span>Each morning from 6:30 Claude writes the harvest as one short read in your style.</span>
      {#if app.llm}<button class="primary" type="button" onclick={writeNow}>Write today's now</button>{/if}</div>
  {:else}
    <article class="brief-doc">
      <p class="brief-day">{dayLabel(b.day)}{b.sent_at ? " · emailed" : ""}</p>
      {#each bs as x, i}
        {#if x.t === "h"}
          {@const h = head(x.s)}
          <section class="brief-sec">
            {#if h.card?.image && !h.card.image.pending}<Link href="/story/{h.card.id}"><Pic cls="brief-pic" src={h.card.image.src} sizes="(min-width: 900px) 640px, 100vw" /></Link>{/if}
            <h2>{#if h.card}<Link href="/story/{h.card.id}">{h.title}</Link>{:else}{h.title}{/if}</h2>
          </section>
        {:else if x.t === "p"}<p class:brief-lead={i === 0}>{#each x.runs as r}{#if r.b}<b>{r.s}</b>{:else}{r.s}{/if}{/each}</p>
          {#if i === 0 && figs.kpis.length}
            <div class="brief-kpis">
              {#each figs.kpis as k}
                {@const card = k.n ? byN.get(k.n) : null}
                {#if card}<Link class="brief-kpi" href="/story/{card.id}"><b>{k.value}{#if k.unit}<small> {k.unit}</small>{/if}</b><span>{k.label}</span></Link>
                {:else}<div class="brief-kpi"><b>{k.value}{#if k.unit}<small> {k.unit}</small>{/if}</b><span>{k.label}</span></div>{/if}
              {/each}
            </div>
          {/if}
        {:else if x.t === "ul"}<ul>{#each x.items as item}<li>{#each item as r}{#if r.b}<b>{r.s}</b>{:else}{r.s}{/if}{/each}</li>{/each}</ul>
        {:else if x.t === "quote"}<blockquote>{#each x.runs as r}{#if r.b}<b>{r.s}</b>{:else}{r.s}{/if}{/each}</blockquote>
        {:else if x.t === "chart" && x.chart}<ChartView chart={x.chart} lang={app.lang} />{/if}
      {/each}
    </article>
    {#if app.llm}<button class="ghost full mt-m" type="button" onclick={writeNow}>Write it again</button>{/if}
  {/if}

  {#if loaded}<p class="pad hint mt-m">Email and the daily schedule are in <Link href="/palate">Palate</Link>.</p>{/if}
</div>
