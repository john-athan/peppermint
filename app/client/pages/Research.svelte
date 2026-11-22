<script lang="ts">
  // The Research folder: like the reading list, but for topics instead of articles. Each topic is a dossier: started
  // from a story (Research in the reader) or from a question in the bar. Topics with news come first, then what is
  // still being researched, then the newest. A topic being researched says which step it is on.
  import Link from "../components/Link.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Pic from "../components/Pic.svelte";
  import AskBar from "../components/AskBar.svelte";
  import { toast } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { ago } from "../lib/format";
  import { I } from "../lib/icons";
  import { submit } from "../lib/agent.svelte";
  import type { Topic } from "../../shared/types";

  let topics = $state<Topic[] | null>(null), asking = $state(false);
  const load = () => api<{ topics: Topic[] }>("/api/research").then(r => { topics = r.topics; }).catch(() => { topics ??= []; });
  $effect(() => { load(); });
  // a topic being researched fills in while you look
  $effect(() => { if (topics?.some(t => t.status === "running")) { const t = setTimeout(load, 2500); return () => clearTimeout(t); } });

  async function remove(t: Topic) {
    topics = (topics ?? []).filter(x => x.id !== t.id);
    await api(`/api/agent/tasks/${t.id}/dismiss`, { method: "POST" }).catch(() => {});
    toast("Topic removed.", { ms: 5000, action: { label: "Undo", run: async () => { await api(`/api/agent/tasks/${t.id}/restore`, { method: "POST", json: { following: t.following } }); load(); } } });
  }
  async function ask(text: string) {
    asking = true;
    try { await submit(text, { kind: "today" }); load(); } catch (e) { toast((e as Error).message); } finally { asking = false; }
  }
  const thumb = (t: Topic) => t.from?.image ?? t.image?.src ?? null;
</script>

<div class="page research">
  <header class="appbar"><h1>Research</h1></header>
  {#if !topics}
    <Skeleton cls="pad" />
  {:else if !topics.length}
    <div class="empty"><b>No topics yet</b><span>Press Research on a story, or ask about something below. peppermint searches in rounds, reads what it finds and keeps the topic here.</span></div>
  {:else}
    <ul class="topics">
      {#each topics as t (t.id)}
        <li class:running={t.status === "running"}>
          <Link href="/dossier/{t.id}" data-item>
            <span class="thumb">{#if thumb(t)}<Pic src={thumb(t)!} sizes="56px" />{:else}<i>{t.title[0]}</i>{/if}</span>
            <span class="txt">
              <b>{t.title}</b>
              {#if t.status === "running"}<small class="step">{t.step ?? "Researching"}</small>
              {:else if t.status === "error"}<small>The research did not finish</small>
              {:else}<small>{t.sources} source{t.sources === 1 ? "" : "s"}{t.following ? " · following" : ""} · updated {ago(t.updated_at)}</small>{/if}
            </span>
            {#if t.news}<span class="chip">{t.news} new</span>{/if}
          </Link>
          <button class="act" type="button" aria-label="Remove {t.title}" title="Remove this topic" onclick={() => remove(t)}>{@html I.x}</button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="ask-dock"><AskBar placeholder="Research a topic…" chip="research" busy={asking} onsubmit={ask} /></div>
</div>
