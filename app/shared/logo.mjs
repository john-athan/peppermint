// The peppermint mark: a sprig of Mentha x piperita drawn from the plant itself.
// Square stem, opposite leaf pairs climbing it, serrated ovate leaves with sunken veins,
// oil glands as dots, a lilac flower spike at the top, aroma rising when it loads.
const f = n => +n.toFixed(1);
const rad = d => d * Math.PI / 180;

// leaf in local coords: base at (0,0), tip at (0,-L); bend > 0 curves the midrib right
function leaf(L, W, bend, teeth) {
  const shape = t => Math.pow(t, 0.75) * Math.pow(1 - t, 1.25);
  let mx = 0; for (let i = 1; i < 100; i++) mx = Math.max(mx, shape(i / 100));
  const off = t => bend * 4 * t * (1 - t);
  const N = teeth * 2, right = [];
  for (let i = 1; i < N; i++) {
    const t = i / N, base = W * shape(t) / mx;
    const tooth = i % 2 === 1 && t > 0.1 && t < 0.9;
    const w = tooth ? base * 1.05 + 0.9 : base * 0.95;
    const y = -L * t - (tooth ? L * 0.012 : 0);
    right.push([off(t) + w, y]);
  }
  const left = right.map(([x, y], i) => [2 * off((i + 1) / N) - x, y]).reverse();
  const pts = p => p.map(([x, y]) => `L${f(x)} ${f(y)}`).join(' ');
  const outline = `M0 0 ${pts(right)} L${f(off(1))} ${-L} ${pts(left)} Z`;
  const half = `M0 0 ${pts(right)} L${f(off(1))} ${-L} Q${f(bend * 2)} ${f(-L / 2)} 0 0Z`;
  const mid = `M0 0 Q${f(bend * 2)} ${f(-L / 2)} ${f(off(1))} ${f(-L * 0.97)}`;
  const veins = [];
  for (let k = 0; k < 5; k++) {
    const t = 0.12 + k * 0.15; if (t > 0.78) break;
    const x0 = off(t), y0 = -L * t, t1 = Math.min(0.95, t + 0.17);
    const w1 = W * shape(t1) / mx * 0.8;
    for (const s of [1, -1]) {
      const x1 = off(t1) + s * w1, y1 = -L * t1;
      veins.push(`M${f(x0)} ${f(y0)} Q${f(x0 + s * w1 * 0.55)} ${f(y0 - L * 0.03)} ${f(x1)} ${f(y1)}`);
    }
  }
  const glands = [];
  for (let k = 0; k < 6; k++) {
    const t = 0.2 + k * 0.11, s = k % 2 ? 1 : -1, w = W * shape(t) / mx;
    glands.push([f(off(t) + s * w * 0.45), f(-L * t - L * 0.05)]);
  }
  return { outline, half, mid, veins, glands };
}

// [node y, angle, length, width, bend, teeth, order, shade]
const LEAVES = [
  [70, 66, 96, 22.3, -7, 8, 0, 2], [70, -66, 96, 22.3, 7, 8, 0, 1],
  [12, 50, 80, 19.4, -6, 7, 1, 1], [12, -50, 80, 19.4, 6, 7, 1, 2],
  [-40, 32, 60, 15.1, -4, 6, 2, 2], [-40, -32, 60, 15.1, 4, 6, 2, 1],
  [-74, 14, 36, 9.4, -2, 5, 3, 1], [-74, -14, 36, 9.4, 2, 5, 3, 2],
];

export function mark({ cls = '', label = 'peppermint' } = {}) {
  let s = `<svg class="pm-mark ${cls}" viewBox="-150 -150 300 300" role="img" aria-label="${label}">`;
  s += `<circle class="pm-disc" r="138" fill="var(--disc)"/>`;
  s += `<circle class="pm-ring" r="131" fill="none" stroke="var(--leaf-1)" stroke-width="1.5" stroke-dasharray="1 6" stroke-linecap="round"/>`;
  // record grooves, only shown while Listen plays: they turn at 33 1/3 rpm behind the still sprig, under a glare that stays put.
  // Each groove is broken into arcs of slightly different strength, as on a pressed record, so the turning can be seen.
  s += `<g class="pm-grooves" fill="none" stroke="var(--groove)">`;
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (let r = 128; r >= 52; r -= 3.4) {
    if (Math.abs(r - 100) < 2.5 || Math.abs(r - 74) < 2.5) continue; // the quiet bands between tracks
    let dash = [], left = 100;
    while (left > 0) { const on = Math.min(left, 6 + rnd() * 26), off = 0.6 + rnd() * 2.4; dash.push(f(on), f(off)); left -= on + off; }
    s += `<circle r="${f(r)}" pathLength="100" stroke-dasharray="${dash.join(" ")}" stroke-width="${f(0.6 + rnd() * 0.5)}" opacity="${f(0.28 + rnd() * 0.3)}"/>`;
  }
  s += `<circle r="131" stroke-width="2" opacity=".55"/></g>`;
  // the glare: two opposite sectors, each three feathered layers, brightest in the middle
  const sector = (mid, half) => { const p = (r, a) => `${f(Math.cos((mid + a) * Math.PI / 180) * r)} ${f(Math.sin((mid + a) * Math.PI / 180) * r)}`; return `M${p(136, -half)} A136 136 0 0 1 ${p(136, half)} L${p(56, half)} A56 56 0 0 0 ${p(56, -half)}Z`; };
  s += `<g class="pm-sheen" fill="var(--sheen)">${[225, 45].map(m => [22, 13, 6].map(h => `<path d="${sector(m, h)}" opacity="${m === 225 ? ".09" : ".06"}"/>`).join("")).join("")}</g>`;
  // the sky (time of day, weather) goes here; the client fills it, see shared/sky.mjs
  s += `<g class="pm-sky"></g>`;
  // aroma wisps, only shown while loading
  s += `<g class="pm-aroma" fill="none" stroke="var(--leaf-1)" stroke-width="3.2" stroke-linecap="round">`;
  [[-36, -110, 0], [0, -122, 1], [36, -110, 2]].forEach(([x, y, i]) => {
    s += `<path style="--w:${i}" pathLength="100" d="M${x} ${y} c-7 -6 7 -11 0 -17 s-7 -9 0 -13"/>`;
  });
  s += `</g>`;
  s += `<g transform="translate(0 10)"><g class="pm-sprig">`;
  // runner: peppermint spreads by stolons, so the stem rises from one
  s += `<path class="pm-runner" pathLength="100" d="M-96 122 C-60 112 -30 126 0 118 C30 110 62 124 98 116" fill="none" stroke="var(--stem)" stroke-width="4" stroke-linecap="round"/>`;
  [[-62, 117], [56, 116]].forEach(([x, y]) => { s += `<path class="pm-root" pathLength="100" d="M${x} ${y} q-3 8 -8 11 M${x} ${y} q3 9 1 13" fill="none" stroke="var(--stem)" stroke-width="1.6" stroke-linecap="round"/>`; });
  s += `<path class="pm-stem" pathLength="100" d="M0 118 C-5 70 5 20 -1 -40 C-3 -62 1 -82 0 -100" fill="none" stroke="var(--stem)" stroke-width="7" stroke-linecap="square"/>`;
  s += `<path class="pm-stem" pathLength="100" d="M1.6 116 C-3.4 70 6.6 20 0.6 -40" fill="none" stroke="var(--leaf-1)" stroke-width="1.6" opacity=".7"/>`;
  // flower spike: whorls of lilac buds
  s += `<g class="pm-flower">`;
  [[-104, 7], [-114, 6], [-123, 5], [-130, 3.6]].forEach(([y, r], i) => {
    for (const dx of [-r * 0.9, 0, r * 0.9]) s += `<circle style="--b:${i}" class="pm-bud" cx="${f(dx)}" cy="${y}" r="${f(r * (dx ? 0.75 : 0.9))}" fill="${dx ? 'var(--lilac)' : 'var(--lilac-deep)'}"/>`;
  });
  s += `</g>`;
  for (const [y, a, L, W, bend, teeth, order, shade] of LEAVES) {
    const g = leaf(L, W, bend, teeth);
    const fill = shade === 1 ? 'var(--leaf-2)' : 'var(--leaf-3)';
    s += `<g transform="translate(${a > 0 ? 2 : -2} ${y}) rotate(${a})"><g class="pm-leaf" style="--i:${order}">`;
    s += `<path d="${g.outline}" fill="${fill}" stroke="var(--leaf-edge)" stroke-width="1.6" stroke-linejoin="round"/>`;
    s += `<path d="${g.half}" fill="var(--leaf-edge)" opacity=".16"/>`;
    s += `<path class="pm-vein" pathLength="100" d="${g.mid}" fill="none" stroke="var(--vein)" stroke-width="${L > 50 ? 2.2 : 1.5}" stroke-linecap="round"/>`;
    if (L > 40) g.veins.forEach(d => { s += `<path class="pm-vein" pathLength="100" d="${d}" fill="none" stroke="var(--vein)" stroke-width="1.2" stroke-linecap="round"/>`; });
    if (L > 70) g.glands.forEach(([x, yy], k) => { s += `<circle class="pm-gland" style="--g:${k}" cx="${x}" cy="${yy}" r="1.5" fill="var(--gland)"/>`; });
    s += `</g></g>`;
  }
  // a drop of oil on the lowest right leaf
  s += `<g class="pm-drop"><ellipse cx="40" cy="50" rx="4.6" ry="5.4" fill="var(--drop)" stroke="var(--leaf-edge)" stroke-width=".8" opacity=".75"/><ellipse cx="38.6" cy="48" rx="1.4" ry="1.9" fill="#fff" opacity=".9"/></g>`;
  s += `</g></g><g class="pm-front"></g></svg>`;
  return s;
}

/** One serrated leaf of the mark as a standalone SVG (black on transparent), for CSS masks such as the loading shimmer. */
export function leafSvg() {
  const L = 96, W = 22.3, { outline } = leaf(L, W, 0, 8);
  const pad = 3, w = W * 2.4 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(-w / 2)} ${-L - pad} ${f(w)} ${L + pad * 2}"><path d="${outline}" fill="#000"/></svg>`;
}

/** The mark as a standalone SVG file with its colours filled in (favicon, and the source of the PNG app icons). */
export function iconSvg() {
  // the aroma wisps only show while the app loads (CSS hides them otherwise); a standalone icon leaves them out
  return mark().replace(/<g class="pm-(aroma|grooves|sheen)"[\s\S]*?<\/g>/g, "").replace(/<g class="pm-(sky|front)"><\/g>/g, "").replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"').replace(/var\(--([\w-]+)\)/g, (_m, v) => ({ disc: "#d3f3df", "leaf-1": "#7fdca6", "leaf-2": "#4cbf7c", "leaf-3": "#33a565", "leaf-edge": "#1b6a40", vein: "#b2efcb", gland: "#effff5", stem: "#2a7a4b", lilac: "#b48ee6", "lilac-deep": "#8a5cd0", drop: "#f4fdf0" })[v] ?? "#000");
}
