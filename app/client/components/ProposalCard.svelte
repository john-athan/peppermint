<script lang="ts">
  // A palate change the agent suggests, with what this morning would look like. Nothing happens until Apply, and Apply can be undone.
  import { applyProposal, dismissProposal } from "../lib/agent.svelte";
  import { toast } from "../lib/state.svelte";
  import type { PalateChange, Proposal } from "../../shared/types";

  let { proposal, onchange }: { proposal: Proposal; onchange?: () => void } = $props();
  let working = $state(false);
  const w = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}`;
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
  const row = (c: PalateChange): [string, string] => c.type === "weight"
    ? [c.name, c.from != null ? `${c.from.toFixed(1)} → ${c.weight.toFixed(1)}` : `new ${w(c.weight)}`]
    : [`${cap(c.action)}: ${c.value}`, ""];
  async function apply() { working = true; try { await applyProposal(proposal, onchange); } catch (e) { toast((e as Error).message); working = false; } }
  const later = () => dismissProposal(proposal).catch((e) => toast(e.message));
  const p = $derived(proposal.preview);
</script>

<article class="ag prop">
  <span class="ag-chip">✦ Proposal</span>
  <p class="ag-sum all">{proposal.why}</p>
  <div class="prop-rows">{#each proposal.changes as c}{@const [a, b] = row(c)}<div><span>{a}</span><span class="mono">{b}</span></div>{/each}</div>
  {#if p.in.length || p.out.length}
    <div class="prop-diff">
      <span>This morning would change:</span>
      {#each p.in as s (s.id)}<div class="in"><i>+</i>{s.title}</div>{/each}
      {#each p.out as s (s.id)}<div class="out"><i>−</i>{s.title}</div>{/each}
    </div>
  {/if}
  <div class="ag-acts"><button class="primary" type="button" disabled={working} onclick={apply}>Apply</button><button class="ghost" type="button" disabled={working} onclick={later}>Not now</button></div>
</article>
