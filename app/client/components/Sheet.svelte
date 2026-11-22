<script lang="ts">
  import type { Snippet } from "svelte";
  let { open = $bindable(false), label, children }: { open: boolean; label: string; children: Snippet } = $props();
  let el: HTMLDivElement | undefined = $state();
  $effect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    queueMicrotask(() => (el?.querySelector("button, input, [tabindex]") as HTMLElement | null)?.focus());
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") open = false; };
    addEventListener("keydown", onKey);
    return () => { removeEventListener("keydown", onKey); prev?.focus?.(); };
  });
</script>
{#if open}
  <div class="scrim" onclick={() => (open = false)} aria-hidden="true"></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-label={label} bind:this={el}>
    <div class="grab"></div>
    {@render children()}
  </div>
{/if}
