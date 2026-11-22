<script lang="ts">
  import Link from "../components/Link.svelte";
  import { app, toast } from "../lib/state.svelte";
  import { installApp } from "../lib/install";
  import { natural, remove } from "../lib/voice.svelte";
  import { api } from "../lib/api";
  import { ago } from "../lib/format";
  import { I } from "../lib/icons";
  import Sheet from "../components/Sheet.svelte";
  import AskBar from "../components/AskBar.svelte";
  import AgentCard from "../components/AgentCard.svelte";
  import ProposalCard from "../components/ProposalCard.svelte";
  import { agent, watchAgent, openProposals, submit } from "../lib/agent.svelte";

  type P = { topics: { name: string; n: number; weight: number }[]; others: { kind: string; name: string; weight: number }[]; rules: { id: number; action: string; kind: string; value: string }[]; count: number; signals: { kind: string; value: number; at: number; title: string | null }[]; settings: { budget: number; threshold: number; lang: "en" | "de"; style: string; images: boolean; briefing: boolean; briefing_email: string }; briefing: { day: string; error: string | null } | null };
  let p = $state<P | null>(null), sel = $state(0), ruleOpen = $state(false);
  let ra = $state("never"), rk = $state("topic"), rv = $state(""), vals = $state<string[]>([]);
  let duel = $state<{ id: number; title: string; topic: string; source: string }[] | null>(null), won = $state<number | null>(null), duels = $state(0);
  // offline the palate cannot load; it loads by itself once the connection is back
  async function load() { try { p = await api("/api/palate"); } catch {} }
  async function nextDuel() { won = null; try { duel = (await api("/api/duel")).pair; } catch {} }
  $effect(() => { if (app.online) { load(); nextDuel(); } });
  $effect(() => watchAgent());
  const proposals = $derived(openProposals());
  const why = $derived(agent.tasks.find(t => t.kind === "explain"));
  // topics an open proposal would move wear a lilac ring on the map
  const ringed = $derived(new Set(proposals.flatMap(p => p.changes).flatMap(c => c.type === "weight" && c.kind === "topic" ? [c.name.toLowerCase()] : [])));
  // the agent can change weights and rules, so the map and the rules are read again after it answers
  const ask = (q: string) => submit(q, { kind: "palate" }).then(load);

  // bubble layout: start on a golden-angle spiral (strongest first, near the centre), then push apart until nothing overlaps
  let W = $state(360), H = $state(290);
  const bubbles = $derived.by(() => {
    if (!p) return [];
    const n = p.topics.length, area = W * H;
    const raw = p.topics.map(t => 34 + Math.abs(t.weight) * 9 + Math.min(10, t.n * 0.8));
    const fill = raw.reduce((a, r) => a + Math.PI * r * r, 0);
    const k = Math.min(1, Math.sqrt((area * 0.55) / Math.max(1, fill)));
    const B = p.topics.map((t, i) => {
      const a = i * 2.39996, rr = Math.sqrt(i + 0.5) * 22;
      return { ...t, i, r: raw[i] * k, x: W / 2 + Math.cos(a) * rr, y: H / 2 + Math.sin(a) * rr * 0.8 };
    });
    for (let it = 0; it < 220; it++) {
      for (let a = 0; a < n; a++) for (let c = a + 1; c < n; c++) {
        const A = B[a], C = B[c]; let dx = C.x - A.x, dy = C.y - A.y; const d = Math.hypot(dx, dy) || 0.01, min = A.r + C.r + 4;
        if (d < min) { const push = (min - d) / 2; dx /= d; dy /= d; A.x -= dx * push; A.y -= dy * push; C.x += dx * push; C.y += dy * push; }
      }
      for (const b of B) { b.x += (W / 2 - b.x) * 0.01; b.y += (H / 2 - b.y) * 0.01; b.x = Math.max(b.r + 4, Math.min(W - b.r - 4, b.x)); b.y = Math.max(b.r + 4, Math.min(H - b.r - 4, b.y)); }
    }
    return B;
  });
  const cur = $derived(p?.topics[sel]);
  async function setWeight(w: number) {
    if (!p || !cur) return;
    await api("/api/affinities", { method: "PUT", json: { kind: "topic", name: cur.name, weight: w } });
    p.topics[sel].weight = w;
    const r = await api("/api/edition/rebuild", { method: "POST" });
    const e = await api("/api/edition"); app.edition = e.edition;
    toast(`${cur.name} set to ${w > 0 ? "+" : ""}${w}. ${r.added ? `${r.added} more made it into this harvest.` : "This harvest is updated."}`);
  }
  async function openRule() { ra = "never"; rk = "topic"; await loadVals(); ruleOpen = true; }
  async function loadVals() { vals = (await api(`/api/rule-values?kind=${rk}`)).values; rv = vals[0] ?? ""; }
  async function addRule() {
    if (!rv) return;
    const r = await api("/api/rules", { method: "POST", json: { action: ra, kind: rk, value: rv } });
    p!.rules = r.rules; ruleOpen = false;
    await api("/api/edition/rebuild", { method: "POST" }); app.edition = (await api("/api/edition")).edition;
    toast(`Rule added: ${ra} ${rv}`);
  }
  async function delRule(id: number) { const r = await api(`/api/rules/${id}`, { method: "DELETE" }); p!.rules = r.rules; await api("/api/edition/rebuild", { method: "POST" }); app.edition = (await api("/api/edition")).edition; toast("Rule removed."); }
  async function pickDuel(i: number) {
    if (!duel || won !== null) return;
    won = i; duels++;
    await Promise.all([api("/api/signals", { method: "POST", json: { story_id: duel[i].id, kind: "duel_win" } }), api("/api/signals", { method: "POST", json: { story_id: duel[1 - i].id, kind: "duel_lose" } })]);
    setTimeout(() => { nextDuel(); load(); }, 650);
  }
  let knobT: any;
  function knob(key: "budget" | "threshold", v: number) {
    if (!p) return; p.settings[key] = v; clearTimeout(knobT);
    knobT = setTimeout(async () => { await api("/api/settings", { method: "PUT", json: { [key]: v } }); await api("/api/edition/rebuild", { method: "POST" }); app.edition = (await api("/api/edition")).edition; toast("This harvest is rebuilt with the new setting."); }, 400);
  }
  // briefs on Today: language and how you like to read; changing either has Claude write them again
  let styleT: any;
  async function pictures(on: boolean) {
    p!.settings.images = on;
    await api("/api/settings", { method: "PUT", json: { images: on } });
    app.edition = (await api("/api/edition")).edition;
    toast(on ? "Pictures are back." : "Pictures are off: a calmer Today.");
  }
  async function reading(key: "lang" | "style", v: string) {
    if (!p) return; (p.settings as any)[key] = v;
    if (key === "lang") app.lang = v as "en" | "de";
    clearTimeout(styleT);
    styleT = setTimeout(async () => { await api("/api/settings", { method: "PUT", json: { [key]: v } }); app.edition = (await api("/api/edition")).edition; toast(app.llm ? "Briefs are being written again in the new style." : "Saved. Briefs need Claude on the server."); }, key === "style" ? 900 : 0);
  }
  // the morning briefing: written each morning, and mailed when an address is saved
  let mail = $state(""), mailSaved = $state(""), sending = $state(false);
  $effect(() => { if (p) mail = mailSaved = p.settings.briefing_email; });
  async function briefingOn(on: boolean) {
    p!.settings.briefing = on;
    await api("/api/settings", { method: "PUT", json: { briefing: on } });
    toast(on ? "Claude writes a briefing each morning." : "No more morning briefings.");
  }
  async function saveMail() {
    const e = mail.trim();
    if (e === mailSaved) return;
    try { await api("/api/settings", { method: "PUT", json: { briefing_email: e } }); mailSaved = e; toast(e ? `The briefing goes to ${e} each morning.` : "No email: the briefing stays in the app."); }
    catch (err: any) { toast(err.message); }
  }
  async function sendNow() {
    sending = true;
    try { await api("/api/briefing/send", { method: "POST" }); toast(`Sent to ${mailSaved}.`); } catch (e: any) { toast(e.message); } finally { sending = false; }
  }
  const ACTIONS = ["always", "boost", "mute", "never"];
  const SIG: Record<string, string> = { open: "opened", read: "read", lens: "lens", more: "more", less: "less", rescue: "rescued", skip: "skipped", duel_win: "chose", duel_lose: "passed", hide: "hid", seen: "viewed", dwell: "read time", click: "clicked", pin: "pinned", unpin: "unpinned", unhide: "undid hide" };
</script>

<div class="page wide feed">
  <header class="appbar"><h1>Palate</h1><span class="sp"></span>{#if p}<span class="sse-badge">{p.count.toLocaleString("en")} signals</span>{/if}</header>
  <div class="ask-top"><AskBar chip="your taste" placeholder="Tune, ask why, or find new things…" onsubmit={ask} /></div>
  {#if why || proposals.length}
    <div class="ag-stack">
      {#if why}<AgentCard task={why} />{/if}
      {#each proposals as pr (pr.id)}<ProposalCard proposal={pr} onchange={load} />{/each}
    </div>
  {/if}
  {#if !p && !app.online}
    <div class="empty"><b>Palate needs a connection</b><span>It loads by itself when you are back online.</span></div>
  {/if}
  {#if p}
    <div class="palate-feed">
      <section class="pal-sec">
        <div class="group-label">Topics</div>
        {#if p.topics.length}
          <div class="taste" role="group" aria-label="Topics on your palate" bind:clientWidth={W} bind:clientHeight={H}>
            {#each bubbles as b (b.name)}
              <button class="bub" class:pos={b.weight > 0} class:neg={b.weight < 0} class:sel={b.i === sel} class:ring={ringed.has(b.name.toLowerCase())} type="button" style:left="{b.x}px" style:top="{b.y}px" style:width="{b.r * 2}px" style:height="{b.r * 2}px" style:font-size="{Math.max(9.5, Math.min(13, b.r / 3.6))}px" onclick={() => (sel = b.i)} aria-pressed={b.i === sel}>{b.name}</button>
            {/each}
          </div>
          {#if cur}
            <div class="weight-pick">
              <span><b>{cur.name}</b> · {cur.n} stor{cur.n === 1 ? "y" : "ies"} this week. Set how much you want it.</span>
              <div class="scale" role="group" aria-label="Weight">
                {#each [-3, -2, -1, 0, 1, 2, 3] as w}<button type="button" aria-pressed={Math.round(cur.weight) === w} onclick={() => setWeight(w)}>{w > 0 ? "+" : w < 0 ? "−" : ""}{Math.abs(w)}</button>{/each}
              </div>
            </div>
          {/if}
        {:else}
          <div class="empty"><b>No topics yet</b><span>Your map fills in after the first harvest.</span></div>
        {/if}
      </section>
      <section class="pal-sec">
        <div class="group-label">Rules</div>
        <div class="rules">
          {#each ACTIONS as a}
            {@const rs = p.rules.filter(r => r.action === a)}
            {#if rs.length}
              <div class="rule-line"><span class="k {a}">{a}</span>{#each rs as r (r.id)}<span class="rchip">{r.value}<i>{r.kind}</i><button type="button" aria-label="Remove rule {a} {r.value}" onclick={() => delRule(r.id)}>×</button></span>{/each}</div>
            {/if}
          {/each}
          <div class="rule-line"><button class="rchip add" type="button" onclick={openRule}>+ Add rule</button></div>
        </div>
      </section>
      <section class="pal-sec">
        <div class="group-label">Which would you rather get? {#if duels}<span class="accent">+{duels}</span>{/if}</div>
        {#if duel}
          <div class="duel">
            {#each duel as d, i (d.id)}
              <button type="button" class:win={won === i} class:lose={won !== null && won !== i} onclick={() => pickDuel(i)}><small>{d.source} · {d.topic}</small>{d.title}</button>
            {/each}
          </div>
        {:else}
          <p class="pad hint">No pair to compare right now. More arrive with the next harvest.</p>
        {/if}
      </section>
      <section class="pal-sec">
        <div class="group-label">Edition</div>
        <div class="knobs">
          <label>Stories per harvest <b>{p.settings.budget}</b><input type="range" min="3" max="30" step="1" value={p.settings.budget} oninput={(e) => knob("budget", +e.currentTarget.value)} /></label>
          <label>Threshold <b>{p.settings.threshold.toFixed(2)}</b><input type="range" min="0.3" max="0.85" step="0.01" value={p.settings.threshold} oninput={(e) => knob("threshold", +e.currentTarget.value)} /></label>
        </div>
      </section>
      <section class="pal-sec">
        {#if app.install}
          <div class="group-label">App</div>
          <div class="knobs install">
            {#if app.install === "installed"}<span>peppermint runs as an app on this device.</span>
            {:else if app.install === "prompt"}<span>Open peppermint from your home screen or dock, in its own window, without the browser around it.</span>
              <button class="primary" type="button" onclick={async () => { if (await installApp()) toast("Installed. Find peppermint with your apps."); }}>Install peppermint</button>
            {:else}<span>To add peppermint to your home screen: tap <b>Share</b> in Safari, then <b>Add to Home Screen</b>.</span>{/if}
          </div>
        {/if}
      </section>
      <section class="pal-sec">
        {#if natural.status !== "unknown"}
          <div class="group-label">Natural voice</div>
          <div class="knobs install">
            {#if natural.status === "unsupported"}<span>This browser has no WebGPU, so it cannot make the voice. Chrome on a Mac or a recent Android phone can.</span>
            {:else if natural.status === "ready"}<span>English stories are read by the natural voice, made on this device and working offline.</span>
              <button class="ghost" type="button" onclick={async () => { await remove(); toast("The natural voice is removed from this device."); }}>Remove (frees about {natural.mb} MB)</button>
            {:else if natural.status === "downloading"}<span>Downloading: {Math.round(natural.done / 1e6)} of {Math.round(natural.total / 1e6)} MB. It resumes if the connection drops.</span>
              <div class="bar"><b style:width="{(natural.done / Math.max(1, natural.total)) * 100}%"></b></div>
            {:else}<span>{natural.status === "error" ? `The last attempt stopped: ${natural.error}` : natural.wifiWait ? `Waiting for Wi-Fi to download (about ${natural.mb} MB).` : `Read English stories in the podcast voice, made on this device. One download of about ${natural.mb} MB, then it works offline.`}</span>
              <button class="primary" type="button" onclick={() => (natural.offer = true)}>{natural.status === "error" ? "Try again" : "Get the natural voice"}</button>{/if}
          </div>
        {/if}
      </section>
      <section class="pal-sec">
        <div class="group-label">Briefs</div>
        <div class="knobs">
          <div class="seg" role="group" aria-label="Brief language">
            <button type="button" aria-pressed={p.settings.lang === "en"} onclick={() => reading("lang", "en")}>English</button>
            <button type="button" aria-pressed={p.settings.lang === "de"} onclick={() => reading("lang", "de")}>Deutsch</button>
          </div>
          <label>How you like to read<textarea rows="2" maxlength="300" value={p.settings.style} oninput={(e) => reading("style", e.currentTarget.value)}></textarea></label>
          <label class="switch-row">Pictures on cards and in the reader<input type="checkbox" role="switch" checked={p.settings.images} onchange={(e) => pictures(e.currentTarget.checked)} /></label>
        </div>
      </section>
      <section class="pal-sec">
        <div class="group-label between">Morning briefing <Link href="/briefing">Read today's</Link></div>
        <div class="knobs">
          <label class="switch-row">Write a briefing each morning<input type="checkbox" role="switch" checked={p.settings.briefing} onchange={(e) => briefingOn(e.currentTarget.checked)} /></label>
          <label>Also send it by email<input type="email" placeholder="you@example.org" autocomplete="email" bind:value={mail} onchange={saveMail} onkeydown={(e) => e.key === "Enter" && e.currentTarget.blur()} /></label>
          <span class="sub">With its pictures and charts, from the mail server next to peppermint. Leave empty to keep it in the app.</span>
          {#if p.briefing?.error}<p class="notice flush">Last email: {p.briefing.error}</p>{/if}
          {#if p.briefing}<a class="hint" href="/api/briefing/email" target="_blank" rel="noopener">Preview the email</a>{/if}
            {#if p.briefing && mailSaved}<button class="ghost" type="button" disabled={sending} onclick={sendNow}>{sending ? "Sending…" : "Send today's now"}</button>{/if}
        </div>
      </section>
      <section class="pal-sec">
        <div class="group-label between">Recent signals <Link href="/history">Your history</Link></div>
        {#if p.signals.length}
          <div class="siglog">
            {#each p.signals as s}<div><span class="k" class:neg={s.value < 0}>{SIG[s.kind] ?? s.kind}</span><span>{s.title ?? "Setting"}</span><time>{ago(s.at)}</time></div>{/each}
          </div>
        {:else}
          <p class="pad hint">Open, tune and rescue stories; every action shows up here.</p>
        {/if}
      </section>
    </div>
  {/if}
</div>

<Sheet bind:open={ruleOpen} label="New rule">
  <h3>New rule</h3>
  <p class="sub">Never and always act before any score. Boost and mute shift it.</p>
  <span class="lbl">Action</span>
  <div class="seg">{#each ACTIONS as a}<button type="button" aria-pressed={ra === a} onclick={() => (ra = a)}>{a[0].toUpperCase() + a.slice(1)}</button>{/each}</div>
  <span class="lbl">Kind</span>
  <div class="seg">{#each [["topic", "Topic"], ["person", "Person"], ["place", "Place"], ["source", "Source"]] as [k, l]}<button type="button" aria-pressed={rk === k} onclick={() => { rk = k; loadVals(); }}>{l}</button>{/each}</div>
  <span class="lbl">{rk === "topic" ? "Topics" : rk === "source" ? "Your sources" : "From the last 7 days"}</span>
  <div class="opt-grid">
    {#each vals as v}<button class="opt" class:neg={ra === "never" || ra === "mute"} type="button" aria-pressed={rv === v} onclick={() => (rv = v)}>{v}</button>{/each}
    {#if !vals.length}<span class="sub">Nothing seen yet for this kind.</span>{/if}
  </div>
  <button class="primary full mt-l" type="button" disabled={!rv} onclick={addRule}>Add {ra} rule{rv ? `: ${rv}` : ""}</button>
</Sheet>
