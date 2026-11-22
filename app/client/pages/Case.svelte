<script lang="ts">
  // The case file: what you saw, what peppermint found, what only you can answer, who could know, and the ways to
  // tell it. It fills in while the investigation runs; nothing here blocks it. When the piece is written, the page
  // points to Studio; when there is no story, it says so plainly and offers what is left to do.
  import { untrack } from "svelte";
  import Link from "../components/Link.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import Fav from "../components/Fav.svelte";
  import Sheet from "../components/Sheet.svelte";
  import { app, go, toast } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { ago } from "../lib/format";
  import { I } from "../lib/icons";
  import { enablePush, push, checkPush } from "../lib/push.svelte";
  import type { CaseContact, Evidence, Investigation } from "../../shared/types";

  let { id }: { id: number } = $props();
  let c = $state<Investigation | null>(null), missing = $state(""), mailbox = $state(false), tick = $state(Date.now());
  let own = $state(""), ownOpen = $state(false), mix = $state<string[]>([]);
  let editing = $state<CaseContact | null>(null), replyFor = $state<CaseContact | null>(null), replyText = $state(""), sending = $state(false);
  let editOpen = $state(false), replyOpen = $state(false);
  $effect(() => { if (!editOpen) editing = null; });
  $effect(() => { if (!replyOpen) replyFor = null; });
  let answers = $state<Record<string, string>>({});

  async function load() {
    try { const r = await api<{ case: Investigation; mailbox: boolean }>(`/api/cases/${id}`); c = r.case; mailbox = r.mailbox; } catch (e) { missing = (e as Error).message; }
  }
  $effect(() => { id; untrack(() => { c = null; missing = ""; load(); checkPush(); }); });
  // while it runs, look again every few seconds; the countdown to the angle moves every second
  $effect(() => { if (c?.status === "running") { const t = setTimeout(load, 2500); return () => clearTimeout(t); } });
  $effect(() => { if (c?.status === "running" && c.angle_deadline) { const t = setInterval(() => (tick = Date.now()), 1000); return () => clearInterval(t); } });
  $effect(() => { if (c && location.hash === "#angles") requestAnimationFrame(() => document.getElementById("angles")?.scrollIntoView({ block: "start" })); });

  const fail = (e: unknown) => toast((e as Error).message);
  const post = async (path: string, json: unknown = {}) => { try { const r = await api<{ case?: Investigation }>(`/api/cases/${id}${path}`, { method: "POST", json }); if (r.case) c = r.case; return r; } catch (e) { fail(e); return null; } };

  const stepAt = $derived(c ? c.steps.findIndex(s => !s.done) : -1);
  const left = $derived(c && c.status === "running" ? Math.max(1, Math.round((7 - Math.max(0, stepAt)) * 2.6)) : 0);
  const waiting = $derived(!!c && c.status === "running" && c.stage === "write" && !c.angle && (c.angle_deadline ?? 0) > tick);
  const countdown = $derived(c?.angle_deadline ? Math.max(0, Math.ceil((c.angle_deadline - tick) / 1000)) : 0);
  const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const reports = $derived(c?.evidence.filter(e => e.kind === "web" || e.kind === "harvest") ?? []);
  const background = $derived(c?.evidence.filter(e => e.kind === "wiki") ?? []);
  const replies = $derived(c?.evidence.filter(e => e.kind === "reply") ?? []);
  const first = $derived(!!c && (c.verdict?.first ?? (stepAt > 2 && !reports.some(r => r.same))));

  async function pick(p: string) { const r = await post("/angle", { pick: p }); if (r) { ownOpen = false; mix = []; toast(c?.status === "running" ? "Writing it this way." : "Writing it again from this angle."); } }
  function toggleMix(k: string) { mix = mix.includes(k) ? mix.filter(x => x !== k) : [...mix, k].slice(-2); }
  async function answer(qid: string, a: string) { await post("/answer", { qid, answer: a }); }
  async function saveContact(x: CaseContact) {
    try { c = (await api<{ case: Investigation }>(`/api/cases/${id}/contacts/${x.id}`, { method: "PUT", json: { to: x.to, subject: x.subject, question: x.question } })).case; } catch (e) { fail(e); }
  }
  async function send(x: CaseContact) {
    sending = true;
    try {
      const r = await api<{ case: Investigation; replies: boolean }>(`/api/cases/${id}/contacts/${x.id}/send`, { method: "POST", json: { to: x.to, subject: x.subject, question: x.question } });
      c = r.case; editOpen = false;
      toast(r.replies ? `Sent to ${x.name}. Their answer comes back here by itself.` : `Sent to ${x.name}. Paste their answer here when it comes.`, { ms: 4500 });
    } catch (e) { fail(e); } finally { sending = false; }
  }
  async function paste() {
    if (!replyFor) return;
    const r = await post("/reply", { cid: replyFor.id, text: replyText });
    if (r) { replyOpen = false; replyText = ""; toast(c?.draft_id ? "Added. peppermint proposes how the piece changes." : "Added to what peppermint knows."); }
  }
  const kindLabel: Record<Evidence["kind"], string> = { photo: "Your photo", note: "Your note", answer: "Your answer", web: "Report", wiki: "Background", harvest: "From your harvest", reply: "Answer", tip: "Reader tip" };
  const date = (t: number | null) => t ? new Date(t).toLocaleDateString(app.lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
</script>

{#if missing}
  <div class="page"><div class="empty"><b>Case not found</b><span>{missing}</span><Link class="ghost" href="/studio">Back to Studio</Link></div></div>
{:else if !c}
  <div class="page"><header class="appbar"><Link class="back" href="/studio">{@html I.back}Studio</Link></header><div class="pad"><Skeleton lines={6} /></div></div>
{:else}
  <div class="page wide case">
    <header class="appbar">
      <Link class="back" href="/studio">{@html I.back}Studio</Link><span class="sp"></span>
      {#if c.status === "running"}<span class="case-pill live"><i></i>{waiting ? "Waiting for your angle" : `Researching · about ${left} min`}</span>
      {:else if c.status === "ready"}<span class="case-pill ok">{@html I.check}{c.draft_status === "published" ? "Published" : "Ready"}</span>
      {:else if c.status === "quiet"}<span class="case-pill">{c.verdict?.kind === "note" ? "A short note at most" : "Not a story yet"}</span>
      {:else if c.status === "error"}<span class="case-pill bad">Stopped</span>{/if}
    </header>

    <div class="case-head pad">
      {#if c.place.private}<p class="case-place">{@html I.place}A private place<small>never named in the piece</small></p>
      {:else if c.place.name}<p class="case-place">{@html I.place}{c.place.name}{#if c.place.detail}<small>{c.place.detail}</small>{/if}</p>
      {:else if c.status === "running" && stepAt <= 1}<p class="case-place">{@html I.place}Looking at it…</p>{/if}
      <h1>{c.title || c.seen.summary || "New investigation"}</h1>
    </div>

    {#if c.status === "ready" && c.draft_id}
      <Link class="case-ready" href="/studio/{c.draft_id}">
        <span class="case-ready-t"><span class="case-ready-k">{c.draft_status === "published" ? "Live" : "Your piece is ready"}</span><b>Open it in Studio</b></span><span class="case-ready-go">{@html I.studio}</span>
      </Link>
    {/if}

    {#if c.status === "quiet"}
      <section class="case-quiet">
        <h2>{c.verdict?.kind === "note" ? "A short note at most" : "Not a story yet"}</h2>
        <p>{c.verdict?.why}</p>
        <div class="case-acts">
          <button class="primary" type="button" onclick={() => post("/anyway", { short: true })}>Publish as a short note</button>
          <button class="ghost" type="button" onclick={() => post("/anyway", { short: false })}>Write the full piece anyway</button>
          <button class="ghost" type="button" disabled={!!c.watch_until && c.watch_until > Date.now()} onclick={() => post("/watch").then(() => toast("Watching for news for 14 days."))}>{c.watch_until && c.watch_until > Date.now() ? "Watching for 14 days" : "Keep watching 14 days"}</button>
          <button class="link-btn danger" type="button" onclick={() => post("/drop").then(() => { toast("Dropped."); go("/studio"); })}>Drop it</button>
        </div>
      </section>
    {/if}
    {#if c.status === "error"}
      <div class="notice"><b>The investigation stopped</b><span>{c.error}</span><button class="ghost sm" type="button" onclick={() => post("/retry")}>Try again</button></div>
    {/if}

    <div class="case-grid">
      <div class="case-main">
        <section class="case-saw">
          <h2 class="case-h">You saw</h2>
          {#if c.photos.length}<div class="case-photos">{#each c.photos as p}<img src="/api/photos/{p.id}" alt={p.alt || "Your photo"} width={p.w} height={p.h} />{/each}</div>{/if}
          {#if c.note}<blockquote>{c.note}</blockquote>{/if}
          {#if c.seen.summary}<p class="case-seen"><b>peppermint sees</b> {c.seen.summary}{#if c.seen.details.length}<span>{c.seen.details.join(" · ")}</span>{/if}</p>{/if}
        </section>

        {#if c.status === "running"}
          <ol class="case-steps" aria-label="Progress">
            {#each c.steps as s, i}
              <li class:done={s.done} class:now={i === stepAt}><i>{#if s.done}{@html I.check}{/if}</i>{i === 5 && waiting ? "Waiting for your angle" : s.label}</li>
            {/each}
          </ol>
        {/if}

        {#if c.angles.length && c.status !== "quiet"}
          <section class="case-angles" id="angles">
            <h2 class="case-h">Three ways to tell it {#if waiting}<span class="case-count" aria-live="off">writes A in {mmss(countdown)}</span>{/if}</h2>
            {#each c.angles as a (a.key)}
              {@const chosen = c.angle === a.key || (!c.angle && a.key === "a")}
              <div class="angle" class:on={chosen} class:mixing={mix.includes(a.key)}>
                <span class="angle-k">{a.key.toUpperCase()}</span>
                <div class="angle-t"><b>{a.title}</b><span>{a.pitch}</span><small>{a.needs}{#if a.fit >= 0.75} · fits your voice{/if}</small></div>
                <button class="ghost sm" type="button" aria-pressed={mix.includes(a.key)} aria-label="Mix {a.key.toUpperCase()}" onclick={() => toggleMix(a.key)}>{@html I.plus}</button>
              </div>
            {/each}
            <div class="case-acts">
              {#if mix.length === 2}<button class="primary" type="button" onclick={() => pick(`mix:${mix.join(",")}`)}>Mix {mix.map(m => m.toUpperCase()).join(" + ")}</button>
              {:else if c.status === "running"}{#each c.angles as a}<button class={a.key === "a" ? "primary" : "ghost"} type="button" onclick={() => pick(a.key)}>Write {a.key.toUpperCase()}</button>{/each}
              {:else}{#each c.angles.filter(a => a.key !== (c!.angle ?? "a")) as a}<button class="ghost" type="button" onclick={() => pick(a.key)}>Rewrite as {a.key.toUpperCase()}</button>{/each}{/if}
              <button class="link-btn" type="button" onclick={() => (ownOpen = !ownOpen)}>Own idea</button>
            </div>
            {#if ownOpen}
              <div class="case-own"><textarea bind:value={own} rows="2" placeholder="How you would tell it, in a line"></textarea><button class="primary sm" type="button" disabled={own.trim().length < 4} onclick={() => pick(`own:${own}`)}>Write it so</button></div>
            {/if}
          </section>
        {/if}

        <section>
          <h2 class="case-h">Found <small>{reports.length + background.length} sources</small></h2>
          {#if stepAt >= 0 && stepAt <= 2 && c.status === "running"}<Skeleton lines={3} />{/if}
          {#if first && (stepAt > 2 || c.status !== "running")}<p class="case-first">{@html I.spark}No outlet has reported this yet. You are first.</p>{/if}
          <ul class="ev">
            {#each [...replies, ...reports, ...background] as e (e.id)}
              <li class="ev-row" class:fresh={e.fresh}>
                <Fav kind={e.kind === "wiki" ? "wikipedia" : "feed"} name={e.site} size={22} />
                <div><b>{#if e.url}<a href={e.url} target="_blank" rel="noopener">{e.title}</a>{:else}{e.title}{/if}</b>
                  <span>{e.quote}</span><small>{kindLabel[e.kind]} · {e.site}{e.at ? ` · ${date(e.at)}` : ""}{e.same ? " · reports exactly this" : ""}{e.fresh ? " · new" : ""}</small></div>
              </li>
            {/each}
          </ul>
        </section>
      </div>

      <aside class="case-side">
        {#if c.questions.length}
          <section class="case-you">
            <h2 class="case-h">Only you know</h2>
            {#each c.questions as q (q.id)}
              {@const own = answers[q.id] ?? (q.answer && !q.options.includes(q.answer) ? q.answer : "")}
              <div class="cq">
                <p>{q.q}</p>
                <div class="q-opts">
                  {#each q.options as o}<button class="ghost sm" type="button" aria-pressed={q.answer === o} onclick={() => answer(q.id, o)}>{o}</button>{/each}
                </div>
                <form class="cq-own" onsubmit={(e) => { e.preventDefault(); if (own.trim()) answer(q.id, own.trim()); }}>
                  <input type="text" placeholder="Or in your words" enterkeyhint="send" value={own} oninput={(e) => (answers[q.id] = (e.currentTarget as HTMLInputElement).value)} aria-label="Your answer: {q.q}" />
                  <button class="ask-send" type="submit" aria-label="Send answer" disabled={!own.trim() || own.trim() === q.answer}>{@html I.up}</button>
                </form>
                {#if q.answer}<p class="cq-saved">{@html I.check}{c.status === "ready" ? "Added. peppermint proposes how the piece changes." : "Added to what peppermint knows."}</p>{/if}
              </div>
            {/each}
          </section>
        {/if}

        {#if c.contacts.length}
          <section>
            <h2 class="case-h">Who could know</h2>
            {#each c.contacts as x (x.id)}
              <div class="case-who">
                <div class="who-t"><b>{x.name}</b><small>{x.why}</small></div>
                {#if x.replied_at}<span class="chip">{@html I.check} Answered {ago(x.replied_at)}</span>
                {:else if x.sent_at}<span class="chip warn">Asked {ago(x.sent_at)}</span>{/if}
                <div class="who-acts">
                  {#if !x.sent_at}<button class="primary sm" type="button" onclick={() => { editing = { ...x }; editOpen = true; }}>{@html I.mail}Review and send</button>{/if}
                  {#if !x.replied_at}<button class="ghost sm" type="button" onclick={() => { replyFor = x; replyText = ""; replyOpen = true; }}>Paste their answer</button>{/if}
                </div>
              </div>
            {/each}
            {#if c.contacts.some(x => x.sent_at && !x.replied_at)}<p class="hint mt-s">{mailbox ? "Answers by email come back here by themselves." : "Answers go to your own inbox; paste them here."}</p>{/if}
          </section>
        {/if}

        {#if c.status === "running" && !push.on && push.supported && !push.denied}
          <button class="ghost full-w" type="button" onclick={() => enablePush().then(toast)}>{@html I.bell}Notify me when it is ready</button>
        {/if}
      </aside>
    </div>
  </div>

  <Sheet bind:open={editOpen} label="Question">
    {#if editing}
      <h3>Question to {editing.name}</h3>
      <p class="sub">Sent from peppermint in your name. {mailbox ? "Their reply comes back to this case by itself." : "Their reply goes to your email; paste it here."}</p>
      <label class="field mt-m"><span>To</span><input type="email" bind:value={editing.to} placeholder="presse@…" autocomplete="email" /></label>
      <label class="field"><span>Subject</span><input type="text" bind:value={editing.subject} /></label>
      <label class="field"><span>Message</span><textarea rows="9" bind:value={editing.question}></textarea></label>
      <div class="case-acts mt-s">
        <button class="primary" type="button" disabled={sending || !/\S+@\S+\.\S+/.test(editing.to)} onclick={() => send(editing!)}>{@html I.send}{sending ? "Sending…" : "Send"}</button>
        <button class="ghost" type="button" onclick={() => { saveContact(editing!); editOpen = false; }}>Save for later</button>
      </div>
    {/if}
  </Sheet>
  <Sheet bind:open={replyOpen} label="Their answer">
    {#if replyFor}
      <h3>What {replyFor.name} answered</h3>
      <p class="sub">Paste the mail or write down what they said on the phone.</p>
      <textarea class="mt-m reply-box" rows="8" bind:value={replyText}></textarea>
      <button class="primary full mt-s" type="button" disabled={replyText.trim().length < 3} onclick={paste}>Add to the case</button>
    {/if}
  </Sheet>
{/if}
