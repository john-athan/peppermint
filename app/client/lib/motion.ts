// peppermint's motion language, in one place.
//  - Springs, not durations: a soft one for large things (cards, sheets, page morphs) and a snappy one for small things.
//    They are sampled into CSS linear() easings, so CSS, View Transitions and the Web Animations API all share them.
//  - Only transform and opacity move. Nothing that makes the browser lay out the page again mid-animation.
//  - Motion says where things go: saved flies to List, dismissed leaves to the side.
//  - The peppermint motifs (a leaf, the aroma wisps, text that steeps in) appear at arrivals, never in loops.
//  - Reduced motion: everything becomes an instant change or a short fade.

export type Spring = { stiffness: number; damping: number; mass?: number };
export const SOFT: Spring = { stiffness: 210, damping: 25 };
export const SNAPPY: Spring = { stiffness: 420, damping: 32 };

/** A spring as a CSS linear() easing plus the time it needs to settle. */
export function springEasing(s: Spring): { easing: string; ms: number } {
  const m = s.mass ?? 1, dt = 1 / 240;
  let x = 0, v = 0, t = 0;
  const pts: [number, number][] = [[0, 0]];
  while (t < 2.5) {
    const a = (-s.stiffness * (x - 1) - s.damping * v) / m;
    v += a * dt; x += v * dt; t += dt;
    pts.push([t, x]);
    if (t > 0.1 && Math.abs(x - 1) < 0.0015 && Math.abs(v) < 0.02) break;
  }
  const ms = Math.round(t * 1000);
  // about 40 evenly spaced points describe the curve closely enough
  const step = Math.max(1, Math.floor(pts.length / 40));
  const keep = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  return { easing: `linear(${keep.map(([tt, xx]) => `${+xx.toFixed(4)} ${+((tt / t) * 100).toFixed(2)}%`).join(", ")})`, ms };
}

export const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const supportsLinear = typeof CSS !== "undefined" && CSS.supports?.("transition-timing-function", "linear(0, 1)");
const soft = springEasing(SOFT), snappy = springEasing(SNAPPY);
export const EASE = {
  soft: supportsLinear ? soft.easing : "cubic-bezier(.2, .9, .25, 1.05)", softMs: soft.ms,
  snappy: supportsLinear ? snappy.easing : "cubic-bezier(.3, .9, .3, 1)", snappyMs: snappy.ms,
};

/** The springs as CSS variables for stylesheets: --spring / --spring-dur and --snappy / --snappy-dur. */
export function installMotionTokens() {
  const r = document.documentElement.style;
  r.setProperty("--spring", EASE.soft); r.setProperty("--spring-dur", `${EASE.softMs}ms`);
  r.setProperty("--snappy", EASE.snappy); r.setProperty("--snappy-dur", `${EASE.snappyMs}ms`);
}

/** A short vibration on phones that have it: a tick for crossing a threshold, a double for something that landed. */
export function haptic(kind: "tick" | "land" = "tick") { try { navigator.vibrate?.(kind === "tick" ? 8 : [10, 40, 16]); } catch {} }

/** Web Animations with the shared springs; resolves when done (at once under reduced motion). */
export function animate(el: Element, frames: Keyframe[], o: { spring?: "soft" | "snappy"; ms?: number; delay?: number; fill?: FillMode; easing?: string } = {}): Promise<void> {
  if (reduced()) { const last = frames[frames.length - 1]; if (o.fill === "forwards" && last) Object.assign((el as HTMLElement).style, last); return Promise.resolve(); }
  const sp = o.spring ?? "soft";
  const a = el.animate(frames, { duration: o.ms ?? (sp === "soft" ? EASE.softMs : EASE.snappyMs), easing: o.easing ?? (sp === "soft" ? EASE.soft : EASE.snappy), delay: o.delay ?? 0, fill: o.fill ?? "none" });
  return a.finished.then(() => {}, () => {});
}

/** The tab a thing flies to: the visible link for that path (bottom bar on phones, sidebar on desktop). */
export function navTarget(path: string): HTMLElement | null {
  return [...document.querySelectorAll<HTMLElement>(`.nav a[href="${path}"]`)].find(a => a.offsetParent !== null) ?? null;
}

const LEAF = `<svg viewBox="-30 -99 60 102" aria-hidden="true"><path d="M0 0 C 22 -18 26 -60 0 -96 C -26 -60 -22 -18 0 0 Z" fill="currentColor"/><path d="M0 -4 L0 -88" stroke="rgb(255 255 255 / .55)" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;
const centre = (r: DOMRect) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** The aroma rising from where something landed: three wisps, once. */
export function puff(at: Element) {
  if (reduced()) return;
  const r = at.getBoundingClientRect(), c = centre(r);
  for (let k = 0; k < 3; k++) {
    const w = document.createElement("i");
    w.className = "pm-wisp";
    w.style.left = `${c.x - 6 + (k - 1) * 9}px`; w.style.top = `${r.top - 4}px`;
    document.body.append(w);
    animate(w, [{ transform: "translateY(4px) scaleY(.6)", opacity: 0 }, { opacity: .9, offset: .3 }, { transform: "translateY(-22px) scaleY(1)", opacity: 0 }], { ms: 900, delay: k * 90, easing: "ease-out" }).then(() => w.remove());
  }
}

/** A small "+1" (or any text) popping up from a tab. */
export function badge(at: Element, text = "+1") {
  if (reduced()) return;
  const r = at.getBoundingClientRect(), b = document.createElement("b");
  b.className = "pm-badge"; b.textContent = text;
  b.style.left = `${r.left + r.width / 2 + 6}px`; b.style.top = `${r.top}px`;
  document.body.append(b);
  animate(b, [{ transform: "translate(-50%, 6px) scale(.4)", opacity: 0 }, { transform: "translate(-50%, -8px) scale(1)", opacity: 1, offset: .35 }, { transform: "translate(-50%, -18px) scale(1)", opacity: 0 }], { ms: 1100, easing: "ease-out" }).then(() => b.remove());
}

/** A tab answers a landing: a little bounce. */
export const bump = (el: Element) => animate(el, [{ transform: "scale(1)" }, { transform: "scale(1.22) rotate(-6deg)", offset: .35 }, { transform: "scale(1)" }], { spring: "snappy", ms: 520 });

/**
 * Something flies to a tab: a copy of `from` lifts off where it is, shrinks along an arc and turns into a mint leaf on
 * the way, and lands in the tab, which bounces and lets the aroma rise. Several elements (a story's headline, picture
 * and chips going to Research) leave one after another and land once. Resolves when the last one has landed.
 */
export async function flyTo(from: Element | Element[], path: string, text?: string): Promise<void> {
  const target = navTarget(path);
  const els = (Array.isArray(from) ? from : [from]).filter(e => e.getBoundingClientRect().width > 0);
  if (!target || reduced() || !els.length) { if (target) { bump(target); badge(target, text); } return; }
  const b = target.querySelector("svg")?.getBoundingClientRect() ?? target.getBoundingClientRect();
  await Promise.all(els.map((el, k) => flight(el, b, k * 110, k === 0 || k === els.length - 1)));
  haptic("land"); bump(target); puff(target); badge(target, text);
}
async function flight(from: Element, b: DOMRect, delay: number, withLeaf: boolean) {
  if (delay) await new Promise(r => setTimeout(r, delay));
  const a = from.getBoundingClientRect();
  const ghost = from.cloneNode(true) as HTMLElement;
  ghost.removeAttribute("id");
  ghost.classList.add("pm-ghost");
  Object.assign(ghost.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
  const leaf = document.createElement("i");
  leaf.className = "pm-leaf-flyer"; leaf.innerHTML = LEAF;
  const L = 34;
  Object.assign(leaf.style, { left: `${a.left + a.width / 2 - L / 2}px`, top: `${a.top + a.height / 2 - L / 2}px`, width: `${L}px`, height: `${L}px` });
  document.body.append(ghost, ...(withLeaf ? [leaf] : []));
  const c0 = centre(a), c1 = centre(b);
  // an arc that rises before it falls into the tab
  const ctrl = { x: (c0.x + c1.x) / 2 + (c1.x < c0.x ? -60 : 60), y: Math.min(c0.y, c1.y) - 120 };
  const at = (t: number) => ({ x: (1 - t) ** 2 * c0.x + 2 * (1 - t) * t * ctrl.x + t * t * c1.x, y: (1 - t) ** 2 * c0.y + 2 * (1 - t) * t * ctrl.y + t * t * c1.y });
  const N = 18, ms = 760;
  const ghostFrames: Keyframe[] = [], leafFrames: Keyframe[] = [];
  for (let k = 0; k <= N; k++) {
    const t = k / N, p = at(t), dx = p.x - c0.x, dy = p.y - c0.y;
    const s = Math.max(0.04, (1 - t) ** 2.2);
    ghostFrames.push({ offset: t, transform: `translate(${dx}px, ${dy}px) perspective(900px) rotateX(${(1 - t) * 10}deg) rotate(${-t * 18}deg) scale(${s})`, opacity: t < .45 ? 1 : Math.max(0, 1 - (t - .45) / .25) });
    leafFrames.push({ offset: t, transform: `translate(${dx}px, ${dy}px) rotate(${-40 + t * 220}deg) scale(${t < .3 ? 0.2 : Math.min(1, .3 + t)})`, opacity: t < .32 ? 0 : t > .95 ? 0 : 1 });
  }
  await Promise.all([
    animate(ghost, ghostFrames, { ms, easing: "cubic-bezier(.45, 0, .2, 1)" }),
    withLeaf ? animate(leaf, leafFrames, { ms, easing: "cubic-bezier(.45, 0, .2, 1)" }) : null,
  ]);
  ghost.remove(); leaf.remove();
}

/** The reverse, for undo: a leaf leaves the tab and the element unfolds where it lands. */
export async function flyFrom(path: string, to: Element): Promise<void> {
  const source = navTarget(path);
  if (!source || reduced()) return;
  const a = source.getBoundingClientRect(), b = to.getBoundingClientRect();
  const leaf = document.createElement("i");
  leaf.className = "pm-leaf-flyer"; leaf.innerHTML = LEAF;
  const L = 30;
  Object.assign(leaf.style, { left: `${a.left + a.width / 2 - L / 2}px`, top: `${a.top + a.height / 2 - L / 2}px`, width: `${L}px`, height: `${L}px` });
  document.body.append(leaf);
  const c0 = centre(a), c1 = centre(b);
  await animate(leaf, [{ transform: "translate(0, 0) scale(.6)", opacity: 0 }, { opacity: 1, offset: .2 }, { transform: `translate(${c1.x - c0.x}px, ${c1.y - c0.y}px) rotate(200deg) scale(1.4)`, opacity: 0 }], { ms: 520, easing: "cubic-bezier(.4, 0, .2, 1)" });
  leaf.remove();
  animate(to, [{ transform: "perspective(900px) rotateX(10deg) scale(.9)", opacity: 0 }, { transform: "none", opacity: 1 }]);
}

/** Text that steeps in: blurred and faint, settling, one block after another. */
export function steepIn(blocks: Element[], max = 8) {
  if (reduced()) return;
  blocks.slice(0, max).forEach((el, k) => animate(el, [{ opacity: 0, filter: "blur(6px)", transform: "translateY(8px)" }, { opacity: 1, filter: "blur(0)", transform: "none" }], { delay: k * 55, ms: 520, easing: "cubic-bezier(.2, .8, .2, 1)" }));
}

