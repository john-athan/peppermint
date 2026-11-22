<script lang="ts">
  // A drawn seal for a story without a picture (shared/emblem.ts). `wide` for a picture strip, otherwise square;
  // `small` for a thumbnail, without the lettering. The box takes the field colour, so any shape fills cleanly.
  import { emblemSvg, type EmblemSpec } from "../../shared/emblem";
  let { spec, seed, wide = false, small = false, cls = "" }: { spec: EmblemSpec; seed: number | string; wide?: boolean; small?: boolean; cls?: string } = $props();
  const html = $derived(emblemSvg(spec, seed, { wide, small }));
</script>
<div class="emblem-box emblem {spec.mood} {cls}" aria-hidden="true">{@html html}</div>
