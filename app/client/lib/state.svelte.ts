// App-wide state with Svelte 5 runes: route, edition, toasts.
import { flushSync } from "svelte";
import { api, drain } from "./api";
import type { Card, Edition } from "../../shared/types";
export type { Card, Edition, StoryImage } from "../../shared/types";

export const app = $state({
  auth: false, setup: false, llm: false, sources: 0, lang: "en" as "en" | "de",
  // installing as an app: "prompt" when the browser offers it, "ios" where Safari needs the share menu, "installed" when running as one
  install: null as null | "prompt" | "ios" | "installed",
  edition: null as Edition | null,
  // offline: the app shows what this device kept; Claude and harvesting wait for the connection
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  llmServer: false,
  // followed stories with news, shown first on Today
  updates: [] as Card[],
  path: location.pathname,
  toast: null as null | { msg: string; loading?: boolean; ms?: number; action?: { label: string; run: () => void } },
  // page morph: the story whose card grows into the reader (and back); the card the reader can show before it loads
  morph: null as number | null,
  peek: null as Card | null,
  // Today's endless part outlives a trip into the reader, so going back lands on the same card
  feed: { cards: [] as Card[], done: false, fresh: [] as number[] },
});

let toastTimer: ReturnType<typeof setTimeout>;
export function toast(msg: string, opts: { loading?: boolean; ms?: number; action?: { label: string; run: () => void } } = {}) {
  clearTimeout(toastTimer);
  app.toast = { msg, loading: opts.loading, ms: opts.ms ?? 2600, action: opts.action };
  if (!opts.loading) toastTimer = setTimeout(() => { app.toast = null; }, opts.ms ?? 2600);
}

/** After a source is added: run its first harvest in the background, then show the new edition. */
export function firstHarvest(name: string) {
  drain("/api/harvest").then(async () => { app.edition = (await api<{ edition: Edition }>("/api/edition")).edition; toast(`${name}: first harvest done`); }).catch(() => {});
}

// Page changes animate by direction: a deeper page (a story) slides in from the right, going back slides it out to
// the right again, switching tabs crossfades. Each history entry keeps its scroll position, so back lands where you were.
history.scrollRestoration = "manual";
// the tabs are one level; a story, the source picker or the history sit below them
const TABS = ["/", "/list", "/listen", "/sources", "/palate", "/studio"];
const depth = (p: string) => TABS.includes(p) ? 0 : p.split("/").filter(Boolean).length;
const storyId = (p: string) => Number(/^\/story\/(\d+)$/.exec(p)?.[1]) || null;
function transition(to: string, update: () => void, y: number, animate = true) {
  // a story opened from a card (or left back to one) morphs: card, picture and headline become the reader's, and back
  const into = storyId(to), outOf = storyId(app.path);
  const morph = into && !outOf ? into : outOf && !into && (to === "/" || to === "/list" || to === "/history") ? outOf : null;
  const dir = morph ? "morph" : depth(to) > depth(app.path) ? "forward" : depth(to) < depth(app.path) ? "back" : "fade";
  // scroll once the new page is in the DOM, and again a frame later when lazy content has settled
  const run = () => { update(); flushSync(); scrollTo(0, y); requestAnimationFrame(() => { if (Math.abs(scrollY - y) > 2) scrollTo(0, y); }); };
  const vt = (document as any).startViewTransition;
  if (!animate || !vt || matchMedia("(prefers-reduced-motion: reduce)").matches) { run(); return; }
  document.documentElement.dataset.nav = dir;
  // the names go on the matching card and reader parts before the old page is captured
  app.morph = morph; flushSync();
  vt.call(document, run).finished.finally(() => { delete document.documentElement.dataset.nav; app.morph = null; });
}
export function go(path: string, replace = false) {
  // a query (a story opened with ?ask=…) lives in the URL only; routing looks at the bare path
  const bare = path.split("?")[0];
  if (path === app.path) return;
  history.replaceState({ ...(history.state ?? {}), scroll: scrollY }, "");
  transition(bare, () => { replace ? history.replaceState(null, "", path) : history.pushState(null, "", path); app.path = bare; }, 0);
}
addEventListener("popstate", (e) => {
  const to = location.pathname, y = (e.state as { scroll?: number } | null)?.scroll ?? 0;
  // Safari's swipe-back already animates the page; a second animation on top would stutter
  transition(to, () => { app.path = to; }, y, !(e as any).hasUAVisualTransition);
});
