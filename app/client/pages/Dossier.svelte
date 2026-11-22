<script lang="ts">
  // A dossier: what the agent found about one thing, as a page. Timeline, people, open questions, your own stories on it,
  // and the sources. Steering it runs the research again; following keeps it up to date until it ends, and what a
  // refresh found since you last read leads the page, written by Claude like a followed story's update.
  import Link from "../components/Link.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import AskBar from "../components/AskBar.svelte";
  import Pic from "../components/Pic.svelte";
  import Pull from "../components/Pull.svelte";
  import { app, go, toast } from "../lib/state.svelte";
  import { api, sse } from "../lib/api";
  import { ago } from "../lib/format";
  import { I } from "../lib/icons";
  import { following, loadAgent } from "../lib/agent.svelte";
  import type { Dossier, Task } from "../../shared/types";

  let { id }: { id: number } = $props();
  type Src = { title: string; url: string; site: string; at: number };
  let task = $state<Task | null>(null), sources = $state<Src[]>([]), missing = $state("");
  // reports a scheduled refresh found after you last read, and Claude's "what changed"; shown once, then they count as read
  let news = $state<string[]>([]), newsText = $state(""), stopNews: (() => void) | null = null;
  // pulled down: the dossier stays on screen while it looks for news, and the pull shows what it is doing
  let pulled = $state<number | null>(null), asking = $state(false);
  const running = $derived(task?.status === "running");
  const d = $derived<Dossier | null>(task?.kind === "dossier" && (task.status === "done" || (running && pulled !== null)) ? task.result : null);
  const follows = $derived(task ? following(task) : false);

  async function load() {
    try {
      const r = await api<{ task: Task; sources: Src[]; news: string[] }>(`/api/agent/tasks/${id}`); task = r.task; sources = r.sources;
      if (r.news.length && !news.length && r.task.story_id) showNews(r.task.story_id, r.news);
    } catch (e) { missing = (e as Error).message; }
  }
  function showNews(sid: number, titles: string[]) {
    news = titles; newsText = "";
    const seen = () => { api("/api/follow/seen", { method: "POST", json: { story_id: sid } }).catch(() => {}); app.updates = app.updates.filter(u => u.id !== sid); };
    // read only once the text is written: it is made from what is unread
    if (app.llm) stopNews = sse(`/api/stories/${sid}/lens/update?lang=${app.lang}&level=2`, { delta: d => { newsText += d.t; }, done: seen });
    else seen();
  }
  $effect(() => { id; task = null; missing = ""; news = []; pulled = null; load(); return () => stopNews?.(); });
  // a running dossier fills in while you look: ask again every two seconds until it is done
  // (it reads `task`, so each answer schedules the next one; `running` alone stays true and would ask only once)
  $effect(() => { if (task && running) { const t = setTimeout(load, 2000); return () => clearTimeout(t); } });

  const fail = (e: unknown) => toast((e as Error).message);
  async function pull() {
    if (!app.online) return toast("Offline. Pull again when you are back online.");
    const before = sources.length; asking = true;
    // the server starts the search before it answers, so the task comes back running
    try { task = (await api<{ task: Task }>(`/api/agent/tasks/${id}/refresh`, { method: "POST" })).task; pulled = before; } catch (e) { fail(e); } finally { asking = false; }
  }
  // the pull is over once the research is: say what it found
  $effect(() => {
    if (pulled === null || running || !task) return;
    const n = sources.length - pulled; pulled = null;
    toast(task.status === "error" ? task.error ?? "Looking for news failed." : n > 0 ? `${n} new source${n === 1 ? "" : "s"}` : "Nothing new since the last look");
  });
  const pullMsg = $derived(running ? (task?.steps.at(-1)?.label ?? "Looking for news…").slice(0, 48) : "Looking for news…");
  const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const until = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  async function steer(text: string) { const r = await api<{ task: Task }>(`/api/agent/tasks/${id}/steer`, { method: "POST", json: { text } }); task = r.task; }
  async function toggleFollow() { try { task = (await api<{ task: Task }>(`/api/agent/tasks/${id}/follow`, { method: "POST", json: { on: !follows } })).task; toast(follows ? "Following until it ends." : "Not following any more."); } catch (e) { fail(e); } }
  async function toStudio() { try { const r = await api<{ draft: { id: number } }>(`/api/agent/tasks/${id}/draft`, { method: "POST" }); go(`/studio/${r.draft.id}`); } catch (e) { fail(e); } }
  async function dismiss() { try { await api(`/api/agent/tasks/${id}/dismiss`, { method: "POST" }); loadAgent(); go("/research"); } catch (e) { fail(e); } }
</script>

<div class="page dossier">
  {#if task && app.llm && (d || pulled !== null)}<Pull verb="look for news" busy={asking || pulled !== null} msg={pullMsg} onpull={pull} />{/if}
  <header class="appbar"><Link class="back" href="/research">{@html I.back}Research</Link></header>
  {#if missing}
    <div class="empty"><b>{missing}</b><Link href="/research">Back to Research</Link></div>
  {:else if !task}
    <div class="ds-body"><Skeleton lines={2} label="Loading" /></div>
  {:else}
    <div class="ds-body">
      <span class="ag-chip">✦ Dossier{follows ? " · following" : ""}</span>
      <h1>{task.title}</h1>
      {#if task.result?.from}
        {@const f = task.result.from}
        <!-- what flew in from the story: its picture, headline and chips -->
        <div class="ds-from">
          {#if f.image}<span class="thumb"><Pic src={f.image} sizes="40px" /></span>{/if}
          <span>Started from</span>
          {#if task.result.seed}<Link href="/story/{task.result.seed}">{f.title}</Link>{:else}<b>{f.title}</b>{/if}
          {#each f.chips as c}<span class="ent">{#if c.img}<img src={c.img} alt="" loading="lazy" />{:else}<i>{c.name[0]}</i>{/if}{c.name}</span>{/each}
        </div>
      {/if}
      {#if running && pulled === null}
        <ul class="ag-steps">{#each task.steps as s}<li class:done={s.done}><i aria-hidden="true">{s.done ? "✓" : "◦"}</i>{s.label}</li>{/each}</ul>
        <Skeleton label="Researching" />
        <Skeleton last="45%" label="Researching" />
      {:else if task.status === "error"}
        <div class="notice"><b>The research did not finish</b><span>{task.error ?? "Something went wrong."}</span></div>
        <div class="ds-acts"><button class="ghost danger" type="button" onclick={dismiss}>Dismiss</button></div>
      {:else if d}
        <p class="hint">{sources.length} source{sources.length === 1 ? "" : "s"} · updated {ago(task.updated_at)}{follows ? ` · following until ${until(d.follow_until!)}` : ""}</p>
        {#if news.length}
          <section class="new-since" aria-label="Since you last read">
            <b>{@html I.follow}Since you last read · {news.length} new {news.length === 1 ? "report" : "reports"}</b>
            {#if newsText}<p>{newsText}</p>{:else if app.llm}<Skeleton sm lines={2} last="70%" label="Claude is writing what changed" />{/if}
            <ul>{#each news as t}<li>{t}</li>{/each}</ul>
          </section>
        {/if}
        <p class="ds-sum">{d.summary}</p>

        {#if d.timeline.length}
          <span class="lbl">Timeline</span>
          <div class="tl" role="list">{#each d.timeline as t}<div class="tl-i" role="listitem" title={t.event}><i></i><b>{t.date}</b><span>{t.event}</span>{#if t.src?.length}<a class="src" href={t.src[0].url} target="_blank" rel="noopener noreferrer">{t.src[0].site}</a>{/if}</div>{/each}</div>
        {/if}
        {#if d.people.length}
          <span class="lbl">People</span>
          <div class="ds-chips">{#each d.people as p}<span class="ds-chip">{p.name}<small>{p.role}</small></span>{/each}</div>
        {/if}
        {#if d.questions.length}
          <span class="lbl">Open questions</span>
          <ol class="ds-qs">{#each d.questions as q}<li><b>{q.q}</b>{#if q.a}<span>{q.a}</span>{:else}<span class="dim">Still open</span>{/if}{#if q.a && q.src?.length}<small class="src">{#each q.src as c}<a href={c.url} target="_blank" rel="noopener noreferrer">{c.site}</a>{/each}</small>{/if}</li>{/each}</ol>
        {/if}
        {#if d.related.length}
          <span class="lbl">Your stories</span>
          <div class="ds-list">{#each d.related as r (r.id)}<Link href="/story/{r.id}" data-item>{r.title}</Link>{/each}</div>
        {/if}
        {#if sources.length}
          <span class="lbl">Sources</span>
          <div class="ds-list">{#each sources as s}<a data-item href={s.url} target="_blank" rel="noopener noreferrer">{s.title}<small>{s.site} · {ago(s.at)}</small></a>{/each}</div>
        {/if}

        <div class="ds-acts">
          {#if task.story_id}<Link class="primary" href="/story/{task.story_id}">{@html I.listen}Read and listen</Link>{/if}
          <button class="ghost" type="button" onclick={toStudio}>To Studio</button>
          <button class="ghost" type="button" aria-pressed={follows} onclick={toggleFollow}>{follows ? "Following" : "Follow"}</button>
          <button class="link-btn danger" type="button" onclick={dismiss}>Dismiss</button>
        </div>
        <p class="hint">From your question at {hhmm(task.created_at)}{d.steer.length ? ` · steered: “${d.steer.join("”, “")}”` : ""}</p>
      {/if}
    </div>
  {/if}
  {#if task && task.status !== "error"}<div class="ask-dock"><AskBar placeholder="Steer this dossier…" chip="dossier" busy={running} onsubmit={steer} /></div>{/if}
</div>
