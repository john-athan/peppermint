<script lang="ts">
  // What people say about a story: where the discussion lives, Claude's summary of it, and the top comments as plain text.
  import Skeleton from "./Skeleton.svelte";
  import { app } from "../lib/state.svelte";
  import { api, sse } from "../lib/api";
  import { ago } from "../lib/format";

  type DComment = { id: string; by: string; at: number; text: string; likes: number | null; depth: 0 | 1 };
  type DThread = { source: string; url: string; count: number; comments: DComment[] };
  const NAMES: Record<string, string> = { hn: "Hacker News", lobsters: "Lobsters", bluesky: "Bluesky", mastodon: "Mastodon", youtube: "YouTube" };

  let { id }: { id: number } = $props();
  let threads = $state<DThread[]>([]), count = $state(0), loading = $state(true);
  let summary = $state(""), streaming = $state(false), failed = $state(false), open = $state(false);

  $effect(() => {
    const sid = id; threads = []; count = 0; loading = true; summary = ""; streaming = false; failed = false; open = false;
    let stop: (() => void) | null = null, gone = false;
    api(`/api/stories/${sid}/discussion`).then(d => {
      if (gone) return;
      threads = d.threads; count = d.count; loading = false;
      if (d.count && app.llm) {
        streaming = true;
        stop = sse(`/api/stories/${sid}/lens/discussion?lang=${app.lang}&level=2`, {
          delta: e => { summary += e.t; },
          done: () => { streaming = false; },
          error: () => { streaming = false; failed = true; },
        });
      }
    }).catch(() => { loading = false; });
    return () => { gone = true; stop?.(); };
  });
  const lines = $derived(summary.split("\n").map(l => l.replace(/^\s*[-*•]\s+/, "").trim()).filter(Boolean));
  const comments = $derived(threads.flatMap(t => t.comments.map(c => ({ ...c, from: NAMES[t.source] ?? t.source }))));
</script>

{#if loading}
  <section class="disc" aria-busy="true"><h2>What people say</h2><Skeleton lines={2} last="50%" label="Looking for the discussion" /></section>
{:else if count}
  <section class="disc" aria-label="What people say">
    <header>
      <h2>What people say</h2>
      <span class="chip">{count}</span>
      <span class="where">{#each threads as t}<a href={t.url} target="_blank" rel="noopener noreferrer">{NAMES[t.source] ?? t.source}</a>{/each}</span>
    </header>
    {#if app.llm && !failed}
      {#if streaming && !summary}<Skeleton lines={3} last="55%" label="Reading the comments" />
      {:else}{#each lines as l, i}<p class="sum" class:caret={streaming && i === lines.length - 1}>{l}</p>{/each}{/if}
    {/if}
    <details bind:open>
      <summary>{open ? "Hide" : "Show"} top comments ({comments.length})</summary>
      <ol class="cmts">
        {#each comments as c (c.from + c.id)}
          <li class:re={c.depth === 1}>
            <div class="by"><b>{c.by}</b><span>{c.from}{c.at ? ` · ${ago(c.at)}` : ""}{c.likes ? ` · ${c.likes} likes` : ""}</span></div>
            {#each c.text.split(/\n{2,}/) as para}<p>{para}</p>{/each}
          </li>
        {/each}
      </ol>
    </details>
  </section>
{/if}
