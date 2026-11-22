// Today counts a card as viewed once it has been on screen and then scrolled more than 80 % out of view above the top.
// The time it spent at least half visible goes with it. Viewed cards stay out of Today from the next load on; your
// history page lists them. Nothing here leaves your own peppermint.
import { api } from "./api";

type Track = { id: number; was: boolean; since: number | null; ms: number; done: boolean };
const tracked = new Map<Element, Track>();
let io: IntersectionObserver | null = null;

function settle(t: Track, at = performance.now()) { if (t.since != null) { t.ms += at - t.since; t.since = null; } }
function seen(t: Track) {
  settle(t); t.done = true;
  api("/api/signals", { method: "POST", json: { story_id: t.id, kind: "seen", ms: Math.round(t.ms) } }).catch(() => {});
}
function observer() {
  if (io || typeof IntersectionObserver === "undefined") return io;
  io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const t = tracked.get(e.target); if (!t || t.done) continue;
      const r = e.boundingClientRect, top = e.rootBounds?.top ?? 0;
      if (e.intersectionRatio > 0) t.was = true;
      if (e.intersectionRatio >= 0.5 && document.visibilityState === "visible") { if (t.since == null) t.since = performance.now(); }
      else settle(t);
      // more than 80 % of the card is above the top edge
      if (t.was && r.top < top && r.bottom - top < r.height * 0.2) seen(t);
    }
  }, { threshold: [0, 0.2, 0.5, 0.8, 1] });
  document.addEventListener("visibilitychange", () => {
    for (const t of tracked.values()) if (document.visibilityState !== "visible") settle(t);
  });
  return io;
}

/** Svelte action: use:viewed={storyId} */
export function viewed(el: Element, id: number) {
  const o = observer(); if (!o || !id) return;
  tracked.set(el, { id, was: false, since: null, ms: 0, done: false }); o.observe(el);
  return { destroy() { o.unobserve(el); tracked.delete(el); } };
}
