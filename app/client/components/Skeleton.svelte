<script lang="ts">
  // Text that is still steeping: shimmering lines, the last one shorter.
  let { lines = 3, last = "60%", sm = false, label = "Loading", cls = "" }: { lines?: number; last?: string; sm?: boolean; label?: string; cls?: string } = $props();
</script>
<div class="steeping {cls}" class:sm aria-label={label}>{#each { length: lines } as _, k}<i style:width={k === lines - 1 ? last : null}></i>{/each}</div>
