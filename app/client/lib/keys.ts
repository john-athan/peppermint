// The keyboard, in one place. Arrows move through what a page lists, Enter opens it, Escape goes back up a level.
// A page opts its rows in with `data-item` (a story card, a topic, a source); everything else keeps the browser's own keys.
//
//   ↑ ↓      the previous or next row on the page (at the ends the page scrolls as usual)
//   ← →      in a story: the previous or next story of the list you opened it from;
//            in the tab bar or a row of buttons (.seg, role=group): the neighbouring button
//   Enter    opens the row in focus (links and buttons do this themselves)
//   Escape   closes a sheet, else leaves a text field, else goes back from a story, topic or draft to its list
//
// Components that use a key for themselves (AskBar's suggestions, Studio's slash menu, the chart, the video) call
// preventDefault, and this handler leaves that key alone.
import { app, go } from "./state.svelte";

// false on phones and tablets (no hover, so most likely no keyboard): shortcut hints are left out there
export const hasKeys = typeof matchMedia === "undefined" || !matchMedia("(hover: none)").matches;

const ITEM = "main [data-item]";
const typing = (t: Element | null) => !!t?.closest("input, textarea, select, [contenteditable]");
// a modal on top (sheet, story video) owns the keys
const modal = () => !!document.querySelector("[aria-modal='true']");
const visible = (el: HTMLElement) => el.offsetParent !== null || getComputedStyle(el).position === "fixed";
const items = () => [...document.querySelectorAll<HTMLElement>(ITEM)].filter(visible);
const smooth = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;

function show(el: HTMLElement) {
  el.focus({ preventScroll: true });
  // a tall card (one per screen on Today) is shown from its top, a short row only scrolled into view
  el.scrollIntoView({ block: el.offsetHeight > innerHeight * 0.6 ? "start" : "nearest", behavior: smooth() ? "smooth" : "auto" });
}

function step(dir: 1 | -1): boolean {
  const list = items();
  if (!list.length) return false;
  const at = list.findIndex(el => el.contains(document.activeElement));
  // nothing chosen yet: start with the first row that is on screen
  const next = at < 0 ? list.find(el => el.getBoundingClientRect().bottom > 60) ?? list[0] : list[at + dir];
  if (!next) return false;
  show(next);
  return true;
}

// the stories of the list a story was opened from, so ← → in the reader walk through that list
let trail: number[] = [];
const storyOf = (el: Element) => Number((el as HTMLElement).dataset.story ?? /^\/story\/(\d+)/.exec(el.getAttribute("href") ?? "")?.[1]) || 0;
function remember(target: Element | null) {
  if (!target?.closest("main [data-story], main a[href^='/story/']") || app.path.startsWith("/story/")) return;
  trail = [...new Set([...document.querySelectorAll("main [data-story], main a[href^='/story/']")].map(storyOf).filter(Boolean))];
}
function sibling(dir: 1 | -1) {
  const id = Number(/^\/story\/(\d+)$/.exec(app.path)?.[1]);
  const i = trail.indexOf(id);
  const next = i >= 0 ? trail[i + dir] : undefined;
  if (!next) return false;
  const cards = [...(app.edition?.cards ?? []), ...app.feed.cards];
  app.peek = cards.find(c => c.id === next) ?? null;
  go(`/story/${next}`, true);
  return true;
}

// a row of buttons or the tab bar: arrows move along it, Enter or Space presses as usual
function along(t: Element, key: string): boolean {
  const row = t.closest(".seg, [role='group'], .nav");
  if (!row || row.closest(".pm-chart")) return false;
  const vertical = row.matches(".nav") && getComputedStyle(row).flexDirection === "column";
  const dir = key === (vertical ? "ArrowDown" : "ArrowRight") ? 1 : key === (vertical ? "ArrowUp" : "ArrowLeft") ? -1 : 0;
  if (!dir) return false;
  const all = [...row.querySelectorAll<HTMLElement>("a[href], button:not(:disabled)")].filter(visible);
  const i = all.indexOf(t as HTMLElement);
  if (i < 0) return false;
  all[(i + dir + all.length) % all.length].focus();
  return true;
}

function up(): boolean {
  if (!/^\/(story|dossier|studio\/|sources\/|history|briefing|share)/.test(app.path)) return false;
  if (history.length > 1) history.back();
  else go(app.path.startsWith("/dossier") ? "/research" : app.path.startsWith("/studio") ? "/studio" : app.path.startsWith("/sources") ? "/sources" : "/");
  return true;
}

// back on a list after reading: the row of the story you just read is in focus again, so ↓ goes on from there
let read = 0, keyboard = false;
export function landed(path: string) {
  const id = Number(/^\/story\/(\d+)$/.exec(path)?.[1]);
  if (id) { read = id; return; }
  if (!read || !keyboard) return;
  const row = items().find(el => storyOf(el) === read || el.querySelector(`[data-story="${read}"], a[href="/story/${read}"]`));
  read = 0;
  row?.focus({ preventScroll: true });
}

export function installKeys() {
  addEventListener("pointerdown", () => { keyboard = false; }, true);
  addEventListener("click", e => remember(e.target as Element), true);
  addEventListener("keydown", (e) => {
    keyboard = true;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = document.activeElement ?? document.body;
    if (e.key === "Escape") {
      if (modal()) return;
      if (typing(t) || t.closest(ITEM)) { (t as HTMLElement).blur(); return; }
      if (up()) e.preventDefault();
      return;
    }
    if (typing(t) || e.shiftKey) return;
    if (along(t, e.key)) { e.preventDefault(); return; }
    if (modal()) return;
    // widgets with their own arrows: sliders, the chart, the listen waveform
    if (t.closest("[role='slider'], input[type='range'], .pm-chart, [role='listbox']")) return;
    if (e.key === "Enter" && t.matches(ITEM) && !t.matches("a, button")) {
      const open = t.querySelector<HTMLElement>("h2 a, a[href], button");
      if (open) { e.preventDefault(); remember(open); open.click(); }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { if (step(e.key === "ArrowDown" ? 1 : -1)) e.preventDefault(); return; }
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && app.path.startsWith("/story/")) { if (sibling(e.key === "ArrowRight" ? 1 : -1)) e.preventDefault(); }
  });
}
