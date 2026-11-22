<script lang="ts">
  // A drawn seal for a story without a picture (shared/emblem.ts). `wide` for a picture strip, otherwise square;
  // `small` for a thumbnail, without the lettering. The box takes the field colour, so any shape fills cleanly.
  // The wide seal moves slowly (SMIL in the markup); it runs only while on screen and never under reduced motion.
  import { emblemSvg, type EmblemSpec } from "../../shared/emblem";
  let { spec, seed, wide = false, small = false, cls = "" }: { spec: EmblemSpec; seed: number | string; wide?: boolean; small?: boolean; cls?: string } = $props();
  const html = $derived(emblemSvg(spec, seed, { wide, small }));
  let box: HTMLDivElement | undefined = $state();

  $effect(() => {
    void html;
    const svg = box?.querySelector("svg");
    if (!svg || !wide) return;
    svg.pauseAnimations();
    const still = matchMedia("(prefers-reduced-motion: reduce)");
    const seen = new IntersectionObserver(([e]) => { if (e.isIntersecting && !still.matches) svg.unpauseAnimations(); else svg.pauseAnimations(); });
    seen.observe(svg);
    return () => seen.disconnect();
  });
</script>
<div bind:this={box} class="emblem-box emblem {spec.mood} {cls}" aria-hidden="true">{@html html}</div>
