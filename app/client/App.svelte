<script lang="ts">
  import { app } from "./lib/state.svelte";
  import { landed } from "./lib/keys";
  import Nav from "./components/Nav.svelte";
  import Toast from "./components/Toast.svelte";
  import Mark from "./components/Mark.svelte";
  import Today from "./pages/Today.svelte";
  import Reader from "./pages/Reader.svelte";
  import Sources from "./pages/Sources.svelte";
  import AddSource from "./pages/AddSource.svelte";
  import Palate from "./pages/Palate.svelte";
  import Listen from "./pages/Listen.svelte";
  import Studio from "./pages/Studio.svelte";
  import Login from "./pages/Login.svelte";
  import Account from "./pages/Account.svelte";
  import History from "./pages/History.svelte";
  import List from "./pages/List.svelte";
  import Research from "./pages/Research.svelte";
  import Briefing from "./pages/Briefing.svelte";
  import VoiceSheet from "./components/VoiceSheet.svelte";
  import Dossier from "./pages/Dossier.svelte";
  import Share from "./pages/Share.svelte";
  import Case from "./pages/Case.svelte";
  import Voice from "./pages/Voice.svelte";
  import CaptureSheet from "./components/CaptureSheet.svelte";
  import { startSky } from "./lib/sky.svelte";

  const route = $derived.by(() => {
    const p = app.path;
    const m = /^\/story\/(\d+)$/.exec(p);
    if (m) return { name: "reader", id: Number(m[1]) };
    const ds = /^\/dossier\/(\d+)$/.exec(p);
    if (ds) return { name: "dossier", id: Number(ds[1]) };
    if (p === "/share") return { name: "share" };
    if (p === "/sources") return { name: "sources" };
    if (p === "/sources/add") return { name: "add" };
    if (p === "/palate") return { name: "palate" };
    if (p === "/history") return { name: "history" };
    if (p === "/list") return { name: "list" };
    if (p === "/research") return { name: "research" };
    if (p === "/briefing") return { name: "briefing" };
    if (p === "/account") return { name: "account" };
    if (p === "/listen") return { name: "listen" };
    if (p === "/studio") return { name: "studio" };
    if (p === "/studio/voice") return { name: "voice" };
    const cs = /^\/studio\/case\/(\d+)$/.exec(p);
    if (cs) return { name: "case", id: Number(cs[1]) };
    const d = /^\/studio\/(\d+)$/.exec(p);
    if (d) return { name: "studio", id: Number(d[1]) };
    return { name: "today" };
  });
  $effect(() => { document.title = ({ today: "Today", reader: "Reading", sources: "Sources", add: "Add source", palate: "Palate", history: "History", list: "Reading list", research: "Research", briefing: "Morning briefing", listen: "Listen", studio: "Studio", dossier: "Dossier", share: "Sharing", case: "Investigation", voice: "Your voice", account: "Account" } as any)[route.name] + " · peppermint"; });

  $effect(() => landed(app.path));
  // a link that makes a passkey (/setup#token) opens its page even where someone is signed in: an invite opened on a
  // shared computer, or a link for one more device
  const linkPage = location.pathname === "/setup" && location.hash.length > 1;
  // the mark shows the time of day and the weather at home; the weather needs a login
  $effect(() => { if (app.auth) startSky(); });

  // launch: the sprig grows once per session while the edition is already rendered underneath
  let splash = $state(false);
  try { if (!sessionStorage.getItem("pm-launched")) { splash = true; sessionStorage.setItem("pm-launched", "1"); } } catch {}
  $effect(() => { if (splash) { const t = setTimeout(() => (splash = false), matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 1500); return () => clearTimeout(t); } });
</script>

{#if !app.auth || linkPage}
  <Login setup={app.setup} />
{:else}
  <div class="shell">
    <Nav />
    <main class="main">
      {#if !app.online}<div class="offline-bar" role="status"><b>Offline</b><span>showing what this device kept</span></div>{/if}
      {#if route.name === "today"}<Today />
      {:else if route.name === "reader"}<Reader id={route.id!} />
      {:else if route.name === "dossier"}{#key route.id}<Dossier id={route.id!} />{/key}
      {:else if route.name === "share"}<Share />
      {:else if route.name === "case"}{#key route.id}<Case id={route.id!} />{/key}
      {:else if route.name === "voice"}<Voice />
      {:else if route.name === "sources"}<Sources />
      {:else if route.name === "add"}<AddSource />
      {:else if route.name === "palate"}<Palate />
      {:else if route.name === "history"}<History />
      {:else if route.name === "list"}<List />
      {:else if route.name === "research"}<Research />
      {:else if route.name === "briefing"}<Briefing />
      {:else if route.name === "account"}<Account />
      {:else if route.name === "listen"}<Listen />
      {:else if route.name === "studio"}{#key route.id ?? 0}<Studio id={route.id ?? null} />{/key}{/if}
    </main>
  </div>
  {#if splash}
    <button class="splash center-stage" type="button" onclick={() => (splash = false)} aria-label="Skip intro">
      <Mark cls="anim loading" label="" /><span class="word">peppermint</span>
    </button>
  {/if}
{/if}
{#if app.auth}<VoiceSheet /><CaptureSheet />{/if}
<Toast />
