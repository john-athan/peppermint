<script lang="ts">
  import Skeleton from "../components/Skeleton.svelte";
  import Link from "../components/Link.svelte";
  // The reading list: stories you saved from Today (bookmark or long press), kept until you are done with them.
  import { app, toast, type Card as C } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { I } from "../lib/icons";
  import Card from "../components/Card.svelte";
  import TuneSheet from "../components/TuneSheet.svelte";
  let cards = $state<C[] | null>(null), tuneOpen = $state(false), tuneCard = $state<C | null>(null);
  // stories you follow (saved ones follow automatically), with how many reports arrived since you last looked
  let following = $state<(C & { via: string; newCount: number })[]>([]);
  $effect(() => { api("/api/list").then(r => { cards = r.cards; following = r.following ?? []; }); });
  async function unfollow(c: C) {
    following = following.filter(f => f.id !== c.id);
    await api("/api/follow", { method: "POST", json: { story_id: c.id, on: false } });
    toast("No longer following.", { ms: 5000, action: { label: "Undo", run: async () => { await api("/api/follow", { method: "POST", json: { story_id: c.id, on: true } }); following = [...following, { ...c, via: "follow", newCount: 0 }]; } } });
  }
  // done or unsaved: off the list; undo puts it back
  async function remove(c: C) {
    const at = cards?.findIndex(x => x.id === c.id) ?? -1;
    cards = (cards ?? []).filter(x => x.id !== c.id);
    await api("/api/signals", { method: "POST", json: { story_id: c.id, kind: "unpin" } });
    if (app.edition) app.edition.saved = Math.max(0, (app.edition.saved ?? 1) - 1);
    toast("Off your reading list.", { ms: 5000, action: { label: "Undo", run: async () => {
      await api("/api/signals", { method: "POST", json: { story_id: c.id, kind: "pin" } });
      dispatchEvent(new Event("pm-saved"));
      if (cards && !cards.some(x => x.id === c.id)) cards.splice(Math.max(0, at), 0, c);
    } } });
  }
</script>

<div class="page">
  <header class="appbar"><h1>Reading list</h1></header>
  {#if !cards}
    <Skeleton cls="pad" />
  {:else if !cards.length}
    <div class="empty"><b>Nothing saved yet</b><span>Save a story from Today with the bookmark, or by holding the card. It waits here until you are done with it.</span><Link href="/">Back to Today</Link></div>
  {:else}
    <div class="cards">
      {#each cards as c (c.id)}<Card card={c} track={false} dismissLabel="Done" ontune={(x) => { tuneCard = x; tuneOpen = true; }} ondismiss={remove} onpin={remove} />{/each}
    </div>
  {/if}
</div>
{#if following.length}
  <section class="page following">
    <h2 class="group-label">Following</h2>
    <ul class="follow-list">
      {#each following as f (f.id)}
        <li>
          <Link href="/story/{f.id}" data-item><b>{f.title}</b><small>{f.sources[0]?.name}{f.via === "save" ? " · saved" : ""}</small></Link>
          {#if f.newCount}<span class="chip">{f.newCount} new</span>{/if}
          <button class="act" type="button" aria-label="Stop following {f.title}" title="Stop following" onclick={() => unfollow(f)}>{@html I.x}</button>
        </li>
      {/each}
    </ul>
  </section>
{/if}
<TuneSheet bind:open={tuneOpen} card={tuneCard} />
