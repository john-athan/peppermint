<script lang="ts">
  import { app } from "../lib/state.svelte";
  import Link from "./Link.svelte";
  import { I } from "../lib/icons";
  import Mark from "./Mark.svelte";
  import AccountSwitch from "./AccountSwitch.svelte";
  const tabs = [
    { path: "/", label: "Today", icon: I.today, match: (p: string) => p === "/" || p.startsWith("/story/") },
    { path: "/list", label: "List", icon: I.save },
    { path: "/research", label: "Research", icon: I.search, match: (p: string) => p === "/research" || p.startsWith("/dossier/") },
    { path: "/listen", label: "Listen", icon: I.listen },
    { path: "/sources", label: "Sources", icon: I.sources, match: (p: string) => p.startsWith("/sources") },
    { path: "/palate", label: "Palate", icon: I.palate },
    { path: "/studio", label: "Studio", icon: I.studio, match: (p: string) => p.startsWith("/studio") },
  ];
</script>
<nav class="nav" aria-label="Main">
  <Link class="brand" href="/"><Mark cls="sm" label="" /><b>peppermint</b></Link>
  {#each tabs as t}
    {@const on = t.match ? t.match(app.path) : app.path === t.path}
    <Link href={t.path} aria-current={on ? "page" : undefined}>
      <!-- the marker is one element that moves from tab to tab with the page transition -->
      {#if on}<span class="nav-pill" style:view-transition-name="nav-pill" aria-hidden="true"></span>{/if}
      {@html t.icon}<span>{t.label}</span>
    </Link>
  {/each}
  <div class="foot">Pull down on Today, or press <kbd>R</kbd>, to harvest.</div>
  <!-- the account in front, and switching to another; on a phone the bar has no room left, so Today's header carries it -->
  <AccountSwitch wide cls="nav-acct" />
</nav>
