<script lang="ts">
  // The one input of the agent, used everywhere. Where it sits sets the scope; what happens on submit is the page's business.
  // On Today it also searches your stories while you type: a result is opened, anything else goes to the agent.
  import Link from "./Link.svelte";
  import Loading from "./Loading.svelte";
  import { api } from "../lib/api";
  import { go, toast } from "../lib/state.svelte";
  import { marked } from "../lib/format";
  import { I } from "../lib/icons";
  import type { SearchHit } from "../../shared/types";

  let { placeholder, chip = "", search = false, busy = false, onsubmit, oncapture }: {
    placeholder: string; chip?: string; search?: boolean; busy?: boolean; onsubmit: (text: string) => Promise<unknown> | unknown;
    /** shows a camera button that starts an investigation */
    oncapture?: () => void;
  } = $props();
  let text = $state(""), hits = $state<SearchHit[]>([]), sel = $state(-1), working = $state(false), wrap: HTMLElement | undefined = $state();
  const listId = `ask-${Math.random().toString(36).slice(2, 7)}`;
  const shown = $derived(search && hits.length > 0);

  // search while typing: wait for a pause, and drop an answer that a newer keystroke has outdated
  let seq = 0, timer: ReturnType<typeof setTimeout> | undefined;
  function typed() {
    clearTimeout(timer); sel = -1;
    const q = text.trim(), n = ++seq;
    if (!search || q.length < 2) { hits = []; return; }
    timer = setTimeout(async () => {
      try { const r = await api<{ cards: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=8`); if (n === seq) hits = r.cards; } catch { if (n === seq) hits = []; }
    }, 120);
  }
  function clear() { clearTimeout(timer); seq++; text = ""; hits = []; sel = -1; }
  async function send() {
    const q = text.trim();
    if (!q || working || busy) return;
    working = true; hits = []; seq++;
    try { await onsubmit(q); text = ""; } catch (e) { toast((e as Error).message); } finally { working = false; }
  }
  function key(e: KeyboardEvent) {
    if (e.key === "ArrowDown" && shown) { e.preventDefault(); sel = (sel + 1) % hits.length; }
    else if (e.key === "ArrowUp" && shown) { e.preventDefault(); sel = (sel <= 0 ? hits.length : sel) - 1; }
    else if (e.key === "Escape") { if (text || hits.length) { e.preventDefault(); clear(); } }
    else if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); if (shown && sel >= 0) { go(`/story/${hits[sel].id}`); clear(); } else send(); }
  }
  const out = (e: FocusEvent) => { if (!wrap?.contains(e.relatedTarget as Node | null)) { hits = []; sel = -1; } };
</script>

<div class="ask-wrap" bind:this={wrap} onfocusout={out}>
  <div class="ask" class:long={placeholder.length > 26}>
    <span class="ask-spark">{@html I.spark}</span>
    <input type="text" bind:value={text} {placeholder} oninput={typed} onkeydown={key} enterkeyhint="send" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label={placeholder}
      role={search ? "combobox" : undefined} aria-expanded={search ? shown : undefined} aria-controls={search ? listId : undefined} aria-activedescendant={shown && sel >= 0 ? `${listId}-${sel}` : undefined} />
    {#if working || busy}<Loading inline text="The agent is working" />
    {:else if text.trim()}<button class="ask-send" type="button" aria-label="Send" onclick={send}>{@html I.up}</button>
    {:else if oncapture}<button class="ask-cam" type="button" aria-label="Investigate something you noticed" onclick={oncapture}>{@html I.camera}</button>{/if}
    {#if chip}<span class="ask-chip">{chip}</span>{/if}
  </div>
  {#if shown}
    <div class="ask-list" id={listId} role="listbox" tabindex="-1" onpointerdown={(e) => e.preventDefault()}>
      {#each hits as h, i (h.id)}
        <Link href="/story/{h.id}" class="ask-hit {i === sel ? 'on' : ''}" role="option" id="{listId}-{i}" aria-selected={i === sel}>
          <b>{h.title}</b>
          <span>{#each marked(h.snippet) as p}{#if p.m}<mark>{p.t}</mark>{:else}{p.t}{/if}{/each}</span>
        </Link>
      {/each}
    </div>
  {/if}
</div>
