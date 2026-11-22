<script lang="ts">
  // Publishing: the checks first (every one says what to do when it fails, and most can be fixed right here), then
  // where it goes, then when. One button. The piece goes to the writer's public page, its RSS feed and, if they
  // like, to subscribers by mail; Instagram gets five slides to share by hand.
  import { untrack } from "svelte";
  import Sheet from "./Sheet.svelte";
  import Link from "./Link.svelte";
  import { api } from "../lib/api";
  import { toast } from "../lib/state.svelte";
  import { I } from "../lib/icons";
  import { slides, type Slide } from "../lib/slides";
  import type { Draft, Profile } from "../../shared/types";

  type Check = { key: string; ok: boolean; label: string; detail: string };
  type Desk = { checks: Check[]; profile: Profile; missing: string[]; url: string | null; stats: { subscribers: number }; case: { id: number; place: { name: string } } | null };
  let { open = $bindable(false), draft, desk, photo, onchanged, onclaim }: {
    open: boolean; draft: Draft; desk: Desk; photo: string | null;
    onchanged: (d?: Draft) => Promise<void> | void; onclaim: (blockId: string, what: "cut" | "question") => Promise<void>;
  } = $props();

  let when = $state<"now" | "morning" | "pick">("now"), at = $state(""), busy = $state(false), done = $state<string | null>(null);
  let prof = $state<Profile>({ name: "", handle: "", bio: "", imprint: "", email: "" }), profOpen = $state(false), saving = $state(false);
  let deck = $state<Slide[] | null>(null), drawing = $state(false);
  // opening reads where things stand; changes while it is open (a saved imprint, a publish) are applied by the handlers
  $effect(() => { const o = open; untrack(() => { if (o) { prof = { ...desk.profile }; profOpen = desk.missing.length > 0; done = draft.status === "published" ? desk.url : null; } else { for (const s of deck ?? []) URL.revokeObjectURL(s.url); deck = null; } }); });

  const claims = $derived(draft.blocks.filter(b => b.type === "c" && b.text.trim()));
  const blocking = $derived(desk.checks.filter(c => !c.ok && c.key !== "photo"));
  const mail = $derived(draft.meta?.channels?.mail !== false);
  const slug = $derived(draft.slug ?? (draft.title || "piece").toLowerCase().replace(/[äöüß]/g, c => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" } as any)[c]).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 8).join("-"));
  const host = location.host;
  const morning = () => { const d = new Date(); d.setHours(7, 0, 0, 0); if (d.getTime() < Date.now() + 30 * 60_000) d.setDate(d.getDate() + 1); return d; };
  const fmt = (d: Date) => d.toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  async function setMail(on: boolean) { await api(`/api/drafts/${draft.id}/meta`, { method: "PATCH", json: { channels: { mail: on } } }); await onchanged(); }
  async function replyOk() { await api(`/api/drafts/${draft.id}/meta`, { method: "PATCH", json: { reply_ok: true } }); await onchanged(); }
  async function saveProfile() {
    saving = true;
    try { const r = await api<{ missing: string[] }>("/api/profile", { method: "PUT", json: prof }); await onchanged(); profOpen = r.missing.length > 0; toast(r.missing.length ? `Still missing: ${r.missing.join(", ")}.` : "Your page is set up."); }
    catch (e) { toast((e as Error).message); } finally { saving = false; }
  }
  async function go() {
    busy = true;
    try {
      const t = when === "morning" ? morning().getTime() : when === "pick" && at ? new Date(at).getTime() : null;
      const r = await api<{ draft: Draft; url: string; mailed: number | null }>(`/api/drafts/${draft.id}/publish`, { method: "POST", json: { at: t } });
      await onchanged(r.draft);
      profOpen = false;
      if (t) { toast(`Scheduled for ${fmt(new Date(t))}.`); open = false; }
      else { done = r.url; toast(r.mailed ? `Published. Sent to ${r.mailed} ${r.mailed === 1 ? "subscriber" : "subscribers"}.` : "Published."); }
    } catch (e) { toast((e as Error).message, { ms: 5000 }); await onchanged(); }
    finally { busy = false; }
  }
  async function makeSlides() {
    drawing = true;
    try {
      deck = await slides({ headline: draft.title, photo, place: desk.case?.place.name ?? "", byline: desk.profile.name || "peppermint", url: done ?? `${location.origin}/@${desk.profile.handle}/${slug}`,
        sentences: draft.blocks.filter(b => b.type === "p" && b.text.length > 40).map(b => b.text.split(/(?<=[.!?])\s+/)[0]).filter(s => s.length < 220).slice(0, 3) });
    } catch (e) { toast((e as Error).message); } finally { drawing = false; }
  }
  async function shareSlides() {
    if (!deck) return;
    const files = deck.map((s, i) => new File([s.blob], `${slug}-${i + 1}.jpg`, { type: "image/jpeg" }));
    if ((navigator as any).canShare?.({ files })) { try { await navigator.share({ files, title: draft.title }); } catch {} return; }
    for (const [i, s] of deck.entries()) { const a = document.createElement("a"); a.href = s.url; a.download = `${slug}-${i + 1}.jpg`; a.click(); }
    toast("Five slides saved to your downloads.");
  }
  async function previewLink() {
    try { const r = await api<{ url: string }>(`/api/drafts/${draft.id}/preview-link`, { method: "POST" }); await navigator.clipboard.writeText(r.url); toast("Preview link copied. Whoever has it can read the draft."); }
    catch (e) { toast((e as Error).message); }
  }
  async function copy(u: string) { try { await navigator.clipboard.writeText(u); toast("Link copied."); } catch { toast(u); } }
  async function unpublish() { await api(`/api/drafts/${draft.id}/unpublish`, { method: "POST" }); await onchanged(); done = null; toast("Taken down. The link now says it is no longer online."); }
</script>

<Sheet bind:open label="Publish">
  {#if done}
    <div class="pub-done">
      <span class="pub-done-mark">{@html I.check}</span>
      <h3>Live</h3>
      <p class="sub">{draft.title}</p>
      <div class="pub-url"><span>{done.replace(/^https?:\/\//, "")}</span><button class="ghost sm" type="button" onclick={() => copy(done!)}>{@html I.copy}Copy</button></div>
      <div class="pub-acts mt-s">
        <a class="primary" href={done} target="_blank" rel="noopener">{@html I.external}Open the page</a>
        <button class="ghost" type="button" disabled={drawing} onclick={makeSlides}>{@html I.image}{drawing ? "Drawing…" : "Instagram slides"}</button>
      </div>
      {#if deck}<div class="deck mt-s">{#each deck as s, i}<img src={s.url} alt="Slide {i + 1}" />{/each}</div><button class="primary full mt-s" type="button" onclick={shareSlides}>{@html I.share}Share 5 slides</button>{/if}
      <button class="link-btn danger mt-m" type="button" onclick={unpublish}>Take it down</button>
    </div>
  {:else}
    <h3>Publish</h3>
    <div class="pub-sec">Checks</div>
    <ul class="checks">
      {#each desk.checks as c (c.key)}
        <li class:ok={c.ok} class:bad={!c.ok && c.key !== "photo"}>
          <i>{@html c.ok ? I.check : I.alert}</i>
          <div><b>{c.label}</b>{#if c.detail}<small>{c.detail}</small>{/if}
            {#if c.key === "claims" && !c.ok}
              {#each claims as b (b.id)}<div class="claim-fix"><q>{b.text}</q><span><button class="ghost sm" type="button" onclick={() => onclaim(b.id, "cut")}>Cut</button><button class="ghost sm" type="button" onclick={() => onclaim(b.id, "question")}>As a question</button></span></div>{/each}
            {:else if c.key === "reply" && !c.ok}
              <span class="row-acts"><button class="ghost sm" type="button" onclick={replyOk}>They had a chance to reply</button>{#if desk.case}<Link class="ghost sm" href="/studio/case/{desk.case.id}">Ask them</Link>{/if}</span>
            {:else if c.key === "imprint" && !c.ok && !profOpen}
              <button class="link-btn" type="button" onclick={() => (profOpen = true)}>Set up your page</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if profOpen}
      <div class="prof">
        <p class="hint">Your page needs a name and an imprint: German law asks it of anyone who publishes regularly.</p>
        <label class="field"><span>Name</span><input type="text" bind:value={prof.name} autocomplete="name" /></label>
        <label class="field"><span>Address of your page</span><span class="field-pre"><em>{host}/@</em><input type="text" bind:value={prof.handle} placeholder="your-name" autocapitalize="off" /></span></label>
        <label class="field"><span>Imprint: name and postal address</span><textarea rows="3" bind:value={prof.imprint} placeholder="Vorname Nachname&#10;Straße 1&#10;80331 München"></textarea></label>
        <label class="field"><span>Contact email</span><input type="email" bind:value={prof.email} autocomplete="email" /></label>
        <label class="field"><span>One line about you <small>optional</small></span><input type="text" bind:value={prof.bio} maxlength="280" /></label>
        <button class="primary sm" type="button" disabled={saving} onclick={saveProfile}>Save</button>
      </div>
    {/if}

    <div class="pub-sec">Where</div>
    <ul class="pub-where">
      <li><i>{@html I.globe}</i><span><b>Your page</b><small>{host}/@{desk.profile.handle || "…"}/{slug}</small></span><em>always</em></li>
      <li><i>{@html I.mail}</i><span><b>Subscribers by mail</b><small>{desk.stats.subscribers} confirmed</small></span><label class="switch"><input type="checkbox" checked={mail} onchange={(e) => setMail((e.currentTarget as HTMLInputElement).checked)} /><span></span></label></li>
      <li><i>{@html I.link}</i><span><b>RSS</b><small>/@{desk.profile.handle || "…"}/feed.xml</small></span><em>always</em></li>
      <li><i>{@html I.image}</i><span><b>Instagram</b><small>Five slides to share yourself</small></span><button class="ghost sm" type="button" disabled={drawing} onclick={makeSlides}>{drawing ? "Drawing…" : "Make"}</button></li>
    </ul>
    {#if deck}<div class="deck">{#each deck as s, i}<img src={s.url} alt="Slide {i + 1}" />{/each}</div><button class="ghost full-w mt-s" type="button" onclick={shareSlides}>{@html I.share}Share 5 slides</button>{/if}

    <div class="pub-sec">When</div>
    <div class="seg">
      <button type="button" aria-pressed={when === "now"} onclick={() => (when = "now")}>Now</button>
      <button type="button" aria-pressed={when === "morning"} onclick={() => (when = "morning")}>{fmt(morning())}</button>
      <button type="button" aria-pressed={when === "pick"} onclick={() => (when = "pick")}>Pick</button>
    </div>
    {#if when === "pick"}<input class="mt-s when-pick" type="datetime-local" bind:value={at} aria-label="Publish at" />{/if}
    {#if when === "morning"}<p class="hint mt-xs">Mornings around seven are when local pieces are read most.</p>{/if}

    <button class="primary full mt-m" type="button" disabled={busy || blocking.length > 0 || (when === "pick" && !at)} onclick={go}>
      {@html I.send}{busy ? "Publishing…" : blocking.length ? `${blocking.length} ${blocking.length === 1 ? "thing" : "things"} to decide first` : when === "now" ? "Publish now" : "Schedule"}
    </button>
    <button class="link-btn mt-s" type="button" onclick={previewLink}>{@html I.link} Copy a preview link for someone to read first</button>
    {#if draft.publish_at}<p class="hint mt-s">Scheduled for {fmt(new Date(draft.publish_at))}. Publishing now replaces that.</p>{/if}
  {/if}
</Sheet>
