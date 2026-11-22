<script lang="ts" module>
  /** Our image copies come in widths; the browser picks the one that fits the slot and the screen. */
  export const WIDTHS = [160, 320, 480, 800, 1200];
  export const sized = (src: string, w: number) => src.startsWith("/api/media/") ? `${src}?w=${w}` : src;
</script>

<script lang="ts">
  // A picture that arrives behind the peppermint shimmer and fades in. Tells the parent its real shape once loaded
  // (a card that guessed the shape can still change its mind) and when it fails (the card then drops it).
  let { src, alt = "", sizes = "100vw", widths = WIDTHS, cls = "", fit = "cover", eager = false, vt = null, onsize, onfail }: {
    src: string; alt?: string; sizes?: string; widths?: number[]; cls?: string; fit?: "cover" | "contain"; eager?: boolean;
    /** a view-transition name, for a picture that morphs between pages */
    vt?: string | null;
    onsize?: (ratio: number) => void; onfail?: () => void;
  } = $props();
  let loaded = $state(false), img: HTMLImageElement | undefined = $state();
  const srcset = $derived(src.startsWith("/api/media/") ? widths.map(w => `${sized(src, w)} ${w}w`).join(", ") : undefined);
  // only the ratio is reported: with srcset, browsers scale naturalWidth to the slot, so pixel sizes would lie
  const done = () => { if (!img) return; loaded = true; if (img.naturalHeight) onsize?.(img.naturalWidth / img.naturalHeight); };
  // a cached picture can be complete before the load handler is attached
  $effect(() => { if (img?.complete && img.naturalWidth) done(); });
</script>

<span class="pic pm-shimmer leaf {cls}" class:loaded class:contain={fit === "contain"} style:view-transition-name={vt}>
  <img bind:this={img} src={sized(src, widths[Math.min(2, widths.length - 1)])} {srcset} {sizes} {alt} loading={eager ? "eager" : "lazy"} decoding="async" draggable="false" onload={done} onerror={() => onfail?.()} />
</span>
