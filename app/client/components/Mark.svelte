<script lang="ts">
  import { MARK } from "../lib/marks.gen";
  import { sky } from "../lib/sky.svelte";
  // `record` (Listen while it plays) turns the disc into a spinning record and leaves the sky out
  let { cls = "", label = "peppermint" }: { cls?: string; label?: string } = $props();
  const html = $derived.by(() => {
    let s = MARK.replace('class="pm-mark ', `class="pm-mark ${cls} `).replace('aria-label="peppermint"', `aria-label="${label}"`);
    if (/\brecord\b/.test(cls)) return s;
    const { back, front } = sky();
    return s.replace('<g class="pm-sky"></g>', `<g class="pm-sky">${back}</g>`).replace('<g class="pm-front"></g>', `<g class="pm-front">${front}</g>`);
  });
</script>
{@html html}
