<script lang="ts">
  // Popular sources: a curated list of feeds, one tap each. Adding creates a normal feed source.
  // With `suggest`, the list is Sources for you: feeds Claude picked from your palate and research, each checked before
  // it is listed. One of those is added on trial for a week.
  import { app, toast, firstHarvest } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import Fav from "./Fav.svelte";
  import Loading from "./Loading.svelte";
  type E = { name: string; site: string; feed: string; lang: string; about: string; added: boolean; icon: string | null; trial?: boolean; sample?: string[]; perDay?: number };
  type G = { id: string; title: string; entries: E[] };
  let { suggest = false }: { suggest?: boolean } = $props();
  let groups = $state<G[] | null>(null), error = $state(""), adding = $state("");
  function load(fresh = false) {
    groups = null; error = "";
    api(suggest ? `/api/suggestions${fresh ? "?fresh=1" : ""}` : "/api/catalog").then((r: { groups: G[] }) => (groups = r.groups)).catch((e: Error) => { error = e.message; groups = []; });
  }
  $effect(() => load());
  async function add(e: E) {
    adding = e.feed;
    try {
      await api("/api/sources", { method: "POST", json: { kind: "feed", name: e.name, options: [e.feed], cadence: 60, trust: 1, trial: !!e.trial } });
      e.added = true; app.sources = Math.max(1, app.sources);
      toast(e.trial ? `${e.name} on trial for a week · its stories show as New to you` : `${e.name} added · first pull runs now`, { loading: true });
      firstHarvest(e.name);
    } catch (x: any) { toast(x.message); }
    adding = "";
  }
</script>

{#if !groups}
  {#if suggest}<Loading text="Claude is picking sources and checking each feed…" />{/if}
{:else}
  {#if error}<p class="error-line">{error}</p>
  {:else if suggest && !groups.length}<p class="hint">No new feed held up this time. Ask again for others.</p>{/if}
  {#each groups as g (g.id)}
    <span class="lbl">{g.title}</span>
    <div class="catalog">
      {#each g.entries as e (e.feed)}
        <div class="cat-row">
          <Fav kind="feed" name={e.name} size={34} src={e.icon} />
          <span class="who"><b>{e.name}</b><small class:wrap={suggest}>{e.lang.toUpperCase()}{e.perDay ? ` · ~${e.perDay}/day` : ""} · {e.about}</small>{#if e.sample?.length}<small class="cat-sample">Now: {e.sample[0]}</small>{/if}</span>
          <button class="ghost sm cat-add" class:done={e.added} type="button" disabled={e.added || adding === e.feed} onclick={() => add(e)}>{e.added ? (e.trial ? "Trying" : "Added") : adding === e.feed ? "Adding…" : e.trial ? "Try" : "Add"}</button>
        </div>
      {/each}
    </div>
  {/each}
  {#if suggest}<button class="ghost full mt-s" type="button" onclick={() => load(true)}>Find others</button>{/if}
{/if}
