<script lang="ts">
  // How you write, and where it goes. The voice is learned from what you published and from texts you add (yours or
  // ones you admire); every line of it can be edited, and a paragraph rewritten in it shows whether it is right.
  // Below: your public page with its imprint, and notifications on this device.
  import { untrack } from "svelte";
  import Link from "../components/Link.svelte";
  import Sheet from "../components/Sheet.svelte";
  import Skeleton from "../components/Skeleton.svelte";
  import { app, toast } from "../lib/state.svelte";
  import { api } from "../lib/api";
  import { I } from "../lib/icons";
  import { checkPush, disablePush, enablePush, push } from "../lib/push.svelte";
  import type { Profile, Voice } from "../../shared/types";

  let voice = $state<Voice | null>(null), prof = $state<Profile | null>(null), published = $state(0), origin = $state("");
  let profile = $state(""), learning = $state(false), addOpen = $state(false), add = $state({ title: "", text: "", mine: true });
  let test = $state(""), tried = $state(""), trying = $state(false), saving = $state(false);
  $effect(() => untrack(() => { api<{ voice: Voice; profile: Profile; published: number; origin: string }>("/api/writer").then(r => { voice = r.voice; profile = r.voice.profile; prof = r.profile; published = r.published; origin = r.origin; }); checkPush(); }));

  const put = async (json: unknown) => { try { voice = (await api<{ voice: Voice }>("/api/writer", { method: "PUT", json })).voice; profile = voice.profile; } catch (e) { toast((e as Error).message); } };
  async function learn() {
    learning = true;
    try { voice = (await api<{ voice: Voice }>("/api/writer/learn", { method: "POST" })).voice; profile = voice.profile; toast("Your voice, learned again."); }
    catch (e) { toast((e as Error).message); } finally { learning = false; }
  }
  async function addText() { await put({ add }); addOpen = false; add = { title: "", text: "", mine: true }; if (voice && !voice.profile) learn(); }
  async function tryIt() {
    trying = true; tried = "";
    try { tried = (await api<{ text: string }>("/api/writer/try", { method: "POST", json: { text: test } })).text; } catch (e) { toast((e as Error).message); } finally { trying = false; }
  }
  async function saveProf() {
    if (!prof) return; saving = true;
    try { prof = (await api<{ profile: Profile }>("/api/profile", { method: "PUT", json: prof })).profile; toast("Saved."); } catch (e) { toast((e as Error).message); } finally { saving = false; }
  }
  const lines = $derived(profile.split("\n").filter(l => l.trim()).length);
</script>

<div class="page voice-page">
  <header class="appbar"><Link class="back" href="/studio">{@html I.back}Studio</Link><span class="sp"></span></header>
  <div class="pad"><h1 class="vp-h">Your voice</h1><p class="hint">peppermint writes your investigations like you. It learned from {published + (voice?.samples.length ?? 0)} {published + (voice?.samples.length ?? 0) === 1 ? "text" : "texts"}; change anything that is not you.</p></div>

  {#if !voice || !prof}
    <div class="pad"><Skeleton lines={6} /></div>
  {:else}
    <section class="vp-card">
      <div class="vp-card-h"><b>Learned</b><button class="link-btn" type="button" disabled={learning || !app.llm} onclick={learn}>{learning ? "Learning…" : voice.learned_at ? "Learn again" : "Learn now"}</button></div>
      <textarea class="vp-profile" rows={Math.max(4, lines + 1)} bind:value={profile} onblur={() => { if (profile !== voice!.profile) put({ profile }); }} placeholder="Add a text below and peppermint describes how you write: how you open, how long your sentences are, whether you say I, how you end."></textarea>
    </section>

    <div class="group-label">Learned from</div>
    <ul class="vp-src">
      {#if published}<li>{@html I.check}<span><b>{published} published {published === 1 ? "piece" : "pieces"}</b><small>yours, from Studio</small></span></li>{/if}
      {#each voice.samples as s (s.id)}
        <li>{@html s.mine ? I.studio : I.spark}<span><b>{s.title}</b><small>{s.mine ? "yours" : "a text you admire"} · {s.text.split(/\s+/).length} words</small></span><button class="icon-btn" type="button" aria-label="Remove {s.title}" onclick={() => put({ remove: s.id })}>{@html I.x}</button></li>
      {/each}
      <li><button class="ghost sm" type="button" onclick={() => (addOpen = true)}>{@html I.plus}Add a text</button></li>
    </ul>

    <div class="group-label">How long</div>
    <div class="pad"><div class="seg">{#each [[150, "Note"], [300, "300"], [600, "600"], [1200, "1200 words"]] as [n, l]}<button type="button" aria-pressed={voice.length === n} onclick={() => put({ length: n })}>{l}</button>{/each}</div></div>

    <div class="group-label">Try it</div>
    <div class="pad vp-try">
      <textarea rows="3" bind:value={test} placeholder="Paste a paragraph you wrote, or anyone's. It comes back in your voice."></textarea>
      <button class="ghost sm" type="button" disabled={trying || test.trim().length < 40 || !app.llm} onclick={tryIt}>{trying ? "Rewriting…" : "Rewrite in my voice"}</button>
      {#if tried}<blockquote class="vp-tried">{tried}</blockquote>{/if}
    </div>

    <div class="group-label">Your page</div>
    <section class="vp-card">
      {#if prof.handle}<a class="vp-url" href="{origin}/@{prof.handle}" target="_blank" rel="noopener">{@html I.globe}{origin.replace(/^https?:\/\//, "")}/@{prof.handle}</a>{/if}
      <label class="field"><span>Name</span><input type="text" bind:value={prof.name} autocomplete="name" /></label>
      <label class="field"><span>Address</span><span class="field-pre"><em>/@</em><input type="text" bind:value={prof.handle} autocapitalize="off" placeholder="your-name" /></span></label>
      <label class="field"><span>One line about you</span><input type="text" bind:value={prof.bio} maxlength="280" placeholder="Writes about the Maxvorstadt" /></label>
      <label class="field"><span>Imprint <small>name and postal address, required in Germany</small></span><textarea rows="3" bind:value={prof.imprint}></textarea></label>
      <label class="field"><span>Contact email <small>shown in the imprint, and under questions you send</small></span><input type="email" bind:value={prof.email} autocomplete="email" /></label>
      <button class="primary sm" type="button" disabled={saving} onclick={saveProf}>Save</button>
    </section>

    <div class="group-label">Notifications</div>
    <section class="vp-card vp-push">
      <span><b class="vp-push-h">{@html I.bell}{push.on ? "On for this device" : push.denied ? "Blocked in this browser" : "Off on this device"}</b><small>{push.on ? "When a piece is ready, when someone answers, when there is news for a piece." : push.supported ? "Without them, peppermint sends an email to your briefing address." : "This browser cannot show them; on an iPhone, add peppermint to the home screen first."}</small></span>
      {#if push.on}<button class="ghost sm" type="button" onclick={() => api("/api/push/test", { method: "POST" }).then(() => toast("Sent a test."))}>Test</button><button class="link-btn" type="button" onclick={disablePush}>Turn off</button>
      {:else if push.supported && !push.denied}<button class="primary sm" type="button" onclick={() => enablePush().then(toast)}>Turn on</button>{/if}
    </section>
  {/if}
</div>

<Sheet bind:open={addOpen} label="Add a text">
  <h3>Add a text</h3>
  <p class="sub">A whole piece: one of yours, or one you wish you had written.</p>
  <div class="seg mt-m"><button type="button" aria-pressed={add.mine} onclick={() => (add.mine = true)}>I wrote it</button><button type="button" aria-pressed={!add.mine} onclick={() => (add.mine = false)}>I admire it</button></div>
  <label class="field mt-s"><span>Title</span><input type="text" bind:value={add.title} /></label>
  <label class="field"><span>Text</span><textarea rows="10" bind:value={add.text}></textarea></label>
  <button class="primary full" type="button" disabled={add.text.trim().length < 200} onclick={addText}>Add {add.text.trim() ? `· ${add.text.trim().split(/\s+/).length} words` : ""}</button>
</Sheet>
