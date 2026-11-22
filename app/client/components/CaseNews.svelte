<script lang="ts">
  // On Today, in lilac like everything the agent made: a piece of yours that is ready to publish, and news that
  // changes a piece (an answer to your question, a new report), with the change one tap away.
  import Link from "./Link.svelte";
  import { api } from "../lib/api";
  import { go, toast } from "../lib/state.svelte";
  import { I } from "../lib/icons";
  import type { CaseUpdate } from "../../shared/types";

  type Item = { id: number; title: string; headline: string; draft_id: number | null; update: CaseUpdate | null; photo: number | null };
  let items = $state<Item[]>([]);
  $effect(() => { api<{ cases: Item[] }>("/api/cases/today").then(r => (items = r.cases)).catch(() => {}); });
  async function decide(c: Item, apply: boolean) {
    try {
      await api(`/api/cases/${c.id}/update/${apply ? "apply" : "skip"}`, { method: "POST" });
      items = items.filter(x => x.id !== c.id);
      if (apply) toast("Your piece is updated.", { action: { label: "Open", run: () => go(`/studio/${c.draft_id}`) } });
    } catch (e) { toast((e as Error).message); }
  }
</script>

{#each items as c (c.id)}
  <div class="case-news">
    {#if c.photo}<img src="/api/photos/{c.photo}" alt="" />{/if}
    <div class="case-news-t">
      <small>{@html c.update ? I.spark : I.check}{c.update ? "Update for your piece" : "Ready to publish"}</small>
      <b>{c.headline}</b>
      {#if c.update}<span>{c.update.summary}</span><em>{c.update.add.length ? `+${c.update.add.length} ${c.update.add.length === 1 ? "paragraph" : "paragraphs"}` : ""}{c.update.resolves.length ? ` · ${c.update.resolves.length} claim now sourced` : ""}</em>{/if}
      <div class="case-news-acts">
        {#if c.update}
          <Link class="ghost sm" href="/studio/{c.draft_id}?update=1">See change</Link>
          <button class="primary sm" type="button" onclick={() => decide(c, true)}>Update</button>
          <button class="link-btn" type="button" onclick={() => decide(c, false)}>Skip</button>
        {:else}
          <Link class="primary sm" href="/studio/{c.draft_id}">Open and publish</Link>
        {/if}
      </div>
    </div>
  </div>
{/each}
