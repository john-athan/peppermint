<script lang="ts">
  import { favChar } from "../lib/format";
  let { kind, size = 18, name = "", src = null }: { kind: string; size?: number; name?: string; src?: string | null } = $props();
  // a feed stands for any site, so it shows the site's initial when the name is known
  const ch = $derived(kind === "feed" && name ? ([...name.replace(/^the\s+/i, "")][0] ?? "·").toUpperCase() : favChar[kind] ?? "·");
  // the source's own logo when peppermint has a sharp copy; the letter badge when it has none or it fails to load
  let broken = $state(false);
  const round = $derived(kind === "youtube");
</script>
{#if src && !broken}<img class="fav img" class:round src={src} alt="" width={size} height={size} style:border-radius={round ? "50%" : `${Math.round(size / 3.4)}px`} loading="lazy" onerror={() => (broken = true)} />
{:else}<span class="fav {kind}" style:width="{size}px" style:height="{size}px" style:border-radius="{Math.round(size / 3.4)}px" style:font-size="{Math.round(size * 0.42)}px" aria-hidden="true">{ch}</span>{/if}
