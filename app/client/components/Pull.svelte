<script lang="ts">
  // Pull to refresh at the top of a page: touch or mouse drag down, trackpad overscroll, or R. While `busy` it stays
  // open and shows `msg` (what the work is doing right now).
  import Mark from "./Mark.svelte";

  let { verb, busy, msg = "", onpull }: { verb: string; busy: boolean; msg?: string; onpull: () => void } = $props();
  const READY = 64;
  let h = $state(0), start = $state<number | null>(null), dragging = false;
  const shown = $derived(busy ? READY : h);
  const label = $derived(busy ? msg : h >= READY ? `Release to ${verb}` : `Pull to ${verb}`);

  const atTop = () => window.scrollY <= 0;
  function down(y: number, target: EventTarget | null, touch = false) { if (atTop() && !busy && !(target as HTMLElement)?.closest?.(touch ? "input, textarea, .sheet" : "a, button, input, textarea, summary, [contenteditable], .card, .sheet")) { start = y; dragging = false; } }
  function move(y: number, e?: Event) {
    if (start === null) return;
    const d = y - start;
    if (d > 6) { if (!dragging) { document.documentElement.classList.add("pulling"); getSelection()?.removeAllRanges(); } dragging = true; }
    if (dragging) { h = Math.min(96, Math.max(0, d * 0.5)); if (e?.cancelable && d > 0) e.preventDefault(); }
  }
  function up() { document.documentElement.classList.remove("pulling"); if (start === null) return; start = null; if (h >= READY && dragging) onpull(); h = 0; dragging = false; }
  let wheelAcc = 0, wheelT: ReturnType<typeof setTimeout>;
  function wheel(e: WheelEvent) {
    if (busy || !atTop() || e.deltaY >= 0) { wheelAcc = 0; return; }
    wheelAcc += -e.deltaY; h = Math.min(96, wheelAcc * 0.35);
    clearTimeout(wheelT); wheelT = setTimeout(() => { if (h >= READY) onpull(); h = 0; wheelAcc = 0; }, 180);
  }
  $effect(() => {
    const ts = (e: TouchEvent) => down(e.touches[0].clientY, e.target, true), tm = (e: TouchEvent) => move(e.touches[0].clientY, e), te = () => up();
    const md = (e: PointerEvent) => { if (e.pointerType === "mouse" && e.button === 0) down(e.clientY, e.target); }, mm = (e: PointerEvent) => { if (e.pointerType === "mouse") move(e.clientY); };
    const key = (e: KeyboardEvent) => { if (e.key === "r" && !e.metaKey && !e.ctrlKey && !e.altKey && !busy && !(e.target as HTMLElement).closest?.("input, textarea, [contenteditable]")) onpull(); };
    addEventListener("touchstart", ts, { passive: true }); addEventListener("touchmove", tm, { passive: false }); addEventListener("touchend", te);
    addEventListener("pointerdown", md); addEventListener("pointermove", mm); addEventListener("pointerup", up);
    addEventListener("wheel", wheel, { passive: true }); addEventListener("keydown", key);
    return () => { removeEventListener("touchstart", ts); removeEventListener("touchmove", tm); removeEventListener("touchend", te); removeEventListener("pointerdown", md); removeEventListener("pointermove", mm); removeEventListener("pointerup", up); removeEventListener("wheel", wheel); removeEventListener("keydown", key); clearTimeout(wheelT); document.documentElement.classList.remove("pulling"); };
  });
</script>

<div class="ptr" class:ready={shown >= READY} class:busy class:settle={start === null} style:height="{shown}px" style:--grow={Math.min(1, shown / READY)} aria-live="polite">
  <Mark cls="sm {busy ? 'loading' : ''}" label="" /><span>{label}</span>
</div>
