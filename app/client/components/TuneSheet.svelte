<script lang="ts">
  import Sheet from "./Sheet.svelte";
  import { api } from "../lib/api";
  import { toast, type Card } from "../lib/state.svelte";
  import { signed } from "../lib/format";
  import { I } from "../lib/icons";
  // following from the menu: new reports on this story will lead Today
  async function followIt() {
    if (!card) return; open = false;
    await api("/api/follow", { method: "POST", json: { story_id: card.id, on: true } });
    toast("Following. New reports on this story will lead Today.");
  }
  let { open = $bindable(false), card, onhide, onpin }: { open: boolean; card: Card | null; onhide?: (id: number) => void; onpin?: (c: Card) => void } = $props();
  let dir = $state<"more" | "less">("more");
  let picked = $state<string[]>([]);
  const subjects = $derived(card ? [
    ...card.topics.map(t => ["topic:" + t, t]),
    ...card.places.slice(0, 2).map(p => ["place:" + p, p]),
    ...card.sources.map(s => ["source:" + s.name, s.name]),
  ] : []);
  $effect(() => { if (open && card) { dir = "more"; picked = subjects.slice(0, 1).map(s => s[0]); } });
  const toggle = (k: string) => { picked = picked.includes(k) ? picked.filter(x => x !== k) : [...picked, k]; };
  async function save() {
    if (!card) return;
    const r = await api("/api/signals", { method: "POST", json: { story_id: card.id, kind: dir, subjects: picked } });
    open = false;
    const m = r.moved?.[0];
    toast(m ? `Palate: ${m.name} ${m.delta > 0 ? "+" : "−"}${Math.abs(m.delta).toFixed(1)}${r.moved.length > 1 ? ` and ${r.moved.length - 1} more` : ""}. Next harvest follows.` : "Palate updated.");
  }
  async function hide() {
    if (!card) return;
    const id = card.id;
    await api("/api/signals", { method: "POST", json: { story_id: id, kind: "hide" } });
    open = false; onhide?.(id);
    toast("Hidden from this harvest.");
  }
</script>
<Sheet bind:open label="Tune this story">
  {#if card}
    <h3 class="between">Why you see this <span class="mono score">{card.score.toFixed(2)}</span></h3>
    <p class="sub">{card.title}</p>
    {#if card.slot === "trial"}<p class="hint mt-xs">From a source you are trying this week. Opening or hiding its stories decides whether it stays.</p>
    {:else if card.slot === "different"}<p class="hint mt-xs">Outside your usual subjects, so your edition does not narrow. Tune it like any story.</p>{/if}
    <div class="mt-s">
      {#each card.reasons as r}<div class="feat"><span>{r.label}</span><span class="track"><b class:neg={r.v < 0} style:width="{Math.min(50, Math.abs(r.v) * 100)}%"></b></span><span class="v">{signed(r.v)}</span></div>{/each}
    </div>
    <span class="lbl">Tune</span>
    <div class="seg" role="group" aria-label="Direction">
      <button type="button" aria-pressed={dir === "more"} onclick={() => (dir = "more")}>More like this</button>
      <button type="button" aria-pressed={dir === "less"} onclick={() => (dir = "less")}>Less like this</button>
    </div>
    <span class="lbl">Because of</span>
    <div class="opt-grid">
      {#each subjects as [k, name]}
        <button class="opt" class:neg={dir === "less"} type="button" aria-pressed={picked.includes(k)} onclick={() => toggle(k)}>{name}<span class="sr"> ({k.split(":")[0]})</span></button>
      {/each}
      {#if !subjects.length}<span class="sub">This story has no tags yet; the whole story will count.</span>{/if}
    </div>
    <button class="primary full mt-l" type="button" onclick={save}>Teach palate</button>
    <button class="ghost full mt-s" type="button" onclick={followIt}>{@html I.follow} Follow this story</button>
    {#if onpin}<button class="ghost full mt-s" type="button" onclick={() => { open = false; onpin(card!); }}>{card.pinned ? "Remove from reading list" : "Save to reading list"}</button>{/if}
    {#if onhide}<button class="ghost full mt-s" type="button" onclick={hide}>Hide from this harvest</button>{/if}
  {/if}
</Sheet>
