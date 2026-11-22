// Emblems: a story without a picture gets a drawn seal instead, like an engraved coin or a banknote rosette.
// The meaning is a few words, written by the tagger (server/llm.ts) or derived from the story's topics:
//
//   { "motif": "bolt", "mood": "sun", "word": "Ørsted" }
//
// Everything intricate is drawn here from a seed (the story's id): the frame, the guilloche ring, the pattern behind
// the motif, the waves across the field. Two stories with the same motif never get the same emblem. Colours are one
// accent per mood, mixed with the theme's tokens in app.css (.emblem), so light and dark both work.

export const MOODS = ["mint", "sun", "lilac", "sky", "rose", "stone"] as const;
export type Mood = typeof MOODS[number];
export type EmblemSpec = { motif: string; mood: Mood; word: string };

const f = (n: number) => +n.toFixed(1);
const C = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;

/** The motifs: line glyphs on a 24 grid, drawn at about three times that size in the middle of the seal. */
export const MOTIFS: Record<string, string> = {
  neuron: C(12, 12, 2.6) + [0, 60, 120, 180, 240, 300].map(a => { const r = a * Math.PI / 180, x = 12 + Math.sin(r) * 8, y = 12 - Math.cos(r) * 8; return C(f(x), f(y), 1.6) + `M${f(12 + Math.sin(r) * 2.6)} ${f(12 - Math.cos(r) * 2.6)}L${f(12 + Math.sin(r) * 6.4)} ${f(12 - Math.cos(r) * 6.4)}`; }).join("") + "M12 4l6.9 4M18.9 16L12 20M5.1 16V8",
  brackets: "M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 4.5l-3 15",
  globe: C(12, 12, 9) + "M3 12h18M12 3c3.2 3 3.6 15 0 18M12 3c-3.2 3-3.6 15 0 18M4.8 7.5h14.4M4.8 16.5h14.4",
  cylinder: "M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3-3.1 3-7 3-7-1.3-7-3zM5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3",
  lock: "M6.5 11h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11" + C(12, 15, 1.3) + "M12 16.3v2",
  server: "M4 3.5h16v5H4zM4 9.5h16v5H4zM4 15.5h16v5H4zM12 6h5M12 12h5M12 18h5" + C(7, 6, .7) + C(7, 12, .7) + C(7, 18, .7),
  branch: C(6, 5, 2) + C(6, 19, 2) + C(18, 6.5, 2) + "M6 7v10M18 8.5c0 5.5-12 3.5-12 8.5",
  chip: "M7 7h10v10H7zM10 10h4v4h-4zM9.5 3v4M14.5 3v4M9.5 17v4M14.5 17v4M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4",
  rocket: "M12 2.5c3.6 2.6 5 6.8 4 11.5H8c-1-4.7.4-8.9 4-11.5zM8 14l-3.2 3.6H9M16 14l3.2 3.6H15M10.4 17.6L12 21.5l1.6-3.9" + C(12, 9, 1.8),
  briefcase: "M3.5 8h17v11.5h-17zM9 8V5.5h6V8M3.5 13h17M10.8 11.8v2.5h2.4v-2.5",
  coin: C(12, 12, 9) + C(12, 12, 6.6) + "M13.8 9.6c-.5-.8-1.2-1.1-2-1.1-1.2 0-2 .7-2 1.6 0 2.2 4.4 1.3 4.4 3.6 0 1-.9 1.7-2.2 1.7-.9 0-1.7-.4-2.2-1.2M12 7.3v1.2M12 15.4v1.3",
  column: "M3 9l9-5 9 5zM4 20h16M2.5 22h19M6 10.5v7.5M10 10.5v7.5M14 10.5v7.5M18 10.5v7.5M4.5 18.5h15",
  ballot: "M4 12.5h16V21H4zM8.5 15.5h7M7 12.5l1.8-8.7 8.3 1.7-1.4 7",
  scales: "M12 3v17M7.5 21h9M4.5 6.5h15M12 3.5l-1 3M5 6.5l-3 6.5a3 3 0 0 0 6 0zM19 6.5l-3 6.5a3 3 0 0 0 6 0zM2 13h6M16 13h6",
  flask: "M9.5 3h5M10 3v6.2L4.6 18.6A1.6 1.6 0 0 0 6 21h12a1.6 1.6 0 0 0 1.4-2.4L14 9.2V3M7 15h10" + C(10.5, 17.8, .9) + C(14, 18.3, .6),
  planet: C(12, 12, 6) + "M7.4 15.9c-3.2 1.9-4.9 3.4-4.3 4.2 1 1.4 6.7-.8 12.6-4.8s9.8-8.7 8.8-10.1c-.5-.8-2.6-.4-5.6.9" + C(4.5, 5, .6) + C(19.5, 19.5, .6),
  pulse: "M12 20.5s-8.5-4.8-8.5-10.6A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 8.5 2.3c0 5.8-8.5 10.6-8.5 10.6zM5 12.5h3.5L10 10l2.2 5 1.5-2.5H19",
  thermometer: "M10 4.5a2 2 0 0 1 4 0v9.6a4 4 0 1 1-4 0zM12 9v8.5M16.5 5.5h2.5M16.5 8.5h2.5M16.5 11.5h2.5" + C(12, 17.5, 1.6),
  bolt: "M13.5 2L5 13.5h6.2L10 22l9-12.2h-6.3z",
  train: "M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a1.5 1.5 0 0 1 1.5-1.5zM5 10.5h14M10 6.5h4M8 18l-2.5 3.5M16 18l2.5 3.5" + C(8.5, 14.5, 1) + C(15.5, 14.5, 1),
  signal: "M8.5 2.5h7a1 1 0 0 1 1 1v17a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1zM7.5 6.5H5M7.5 12H5M16.5 6.5H19M16.5 12H19" + C(12, 6.5, 1.8) + C(12, 12, 1.8) + C(12, 17.5, 1.8),
  house: "M3 11.5L12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-6h4v6M15.5 6V3.5h2V7.5",
  book: "M12 6.5C10 5 7 4.5 3.5 5v14c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5c-3.5-.5-6.5 0-8.5 1.5zM12 6.5v14M6 8.5c1.6-.1 3 .2 4 .7M6 11.5c1.6-.1 3 .2 4 .7M14 9.2c1-.5 2.4-.8 4-.7",
  note: "M9 18V5.5l11-2.5v13M9 9.5l11-2.5" + C(6.5, 18, 2.5) + C(17.5, 16, 2.5),
  cutlery: "M6 3v6.5A2.5 2.5 0 0 0 8.5 12v9M11 3v6.5A2.5 2.5 0 0 1 8.5 12M8.5 3v6M18 21V3c-2.8 1.6-4 4.8-4 8.5h4",
  weather: C(9, 9, 3.2) + "M9 2.5v1.5M3.8 4l1 1M2.5 9H4M14.2 4l-1 1M8 20h10a3.5 3.5 0 0 0 0-7 5 5 0 0 0-9.5 1.2A2.9 2.9 0 0 0 8 20z",
  ball: C(12, 12, 9) + "M12 8.2l3.3 2.4-1.3 3.9h-4l-1.3-3.9zM12 8.2V3M15.3 10.6l5-1.6M14 14.5l3.1 4.2M10 14.5l-3.1 4.2M8.7 10.6l-5-1.6",
  trophy: "M7 3.5h10V9a5 5 0 0 1-10 0zM7 5.5H4a3 3 0 0 0 3 4.5M17 5.5h3a3 3 0 0 1-3 4.5M12 14v3.5M8.5 21h7M9.5 21l.5-3.5h4l.5 3.5",
  magnifier: C(10, 10, 6.5) + "M14.8 14.8L21 21M6.8 10a3.2 3.2 0 0 1 3.2-3.2",
  star: "M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5l-5.4 3 1.2-6-4.5-4.2 6.1-.7z",
  cube: "M12 2.5l8.2 4.7v9.6L12 21.5l-8.2-4.7V7.2zM3.8 7.2L12 12l8.2-4.8M12 12v9.5M8 5l8.2 4.7",
  stairs: "M3 20.5h4.5v-4H12v-4h4.5v-4H21M17.5 8.5V3l3.5 1.6-3.5 1.6",
  hourglass: "M6 3h12M6 21h12M7 3c0 5.5 10 4.5 10 9s-10 3.5-10 9M17 3c0 5.5-10 4.5-10 9s10 3.5 10 9M9.5 18.5h5M12 12v3",
  nib: "M12 3l5.5 6.5L15 17H9L6.5 9.5zM12 3v7.6M9 17h6v3.5H9z" + C(12, 12, 1.4),
  keyhole: C(12, 12, 9) + "M12 6.8a2.6 2.6 0 0 0-1.4 4.8L9.7 17.2h4.6l-.9-5.6A2.6 2.6 0 0 0 12 6.8z",
  pin: "M12 21.5s-6.8-6.2-6.8-11.5a6.8 6.8 0 0 1 13.6 0c0 5.3-6.8 11.5-6.8 11.5z" + C(12, 10, 2.4),
  plane: "M12 2.5c1 0 1.5 1 1.5 2.5v4.5l7.5 4.5v2l-7.5-2.3V18l2.5 2v1.5L12 20.5l-4 1V20l2.5-2v-4.3L3 16v-2l7.5-4.5V5c0-1.5.5-2.5 1.5-2.5z",
  mountain: "M2 20.5l7-12 4 6.5 2.6-3.6 6.4 9.1zM7.3 11.4l1.7 1.6 1.6-1.4M2 20.5h20",
  factory: "M3 21V11l5 3v-3l5 3v-3l5 3V3.5h3V21zM3 21h18M6.5 17.5h2M11 17.5h2M15.5 17.5h2",
  speech: "M4.5 4.5h15a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9.5l-5 4v-15a1 1 0 0 1 1-1zM8 9h8M8 12.5h5",
  sprig: "M12 21.5V8.5M12 14c-4.2 0-7.2-2.6-7.2-7.2 4.2 0 7.2 2.6 7.2 7.2zM12 11c0-3.8 2.6-6.6 6.8-6.6 0 3.8-2.6 6.6-6.8 6.6zM12 14L7.5 9.5M12 11l3.8-3.8",
  wave: "M2 8c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 13c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 18c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2",
};
export const MOTIF_NAMES = Object.keys(MOTIFS);

/** Every topic the tagger knows (server/llm.ts TOPICS) has a motif and a mood, for stories the tagger saw without Claude. */
export const TOPIC_EMBLEM: Record<string, [string, Mood]> = {
  "AI": ["neuron", "lilac"], "Programming": ["brackets", "mint"], "Web development": ["globe", "sky"], "Databases": ["cylinder", "sky"],
  "Security": ["lock", "stone"], "Infrastructure": ["server", "stone"], "Open source": ["branch", "mint"], "Hardware": ["chip", "stone"],
  "Startups": ["rocket", "sun"], "Business": ["briefcase", "stone"], "Economy": ["coin", "sun"], "Politics": ["column", "lilac"],
  "Local politics": ["ballot", "lilac"], "Law": ["scales", "stone"], "Science": ["flask", "sky"], "Space": ["planet", "lilac"],
  "Health": ["pulse", "rose"], "Climate": ["thermometer", "rose"], "Energy": ["bolt", "sun"], "Transport": ["train", "sky"],
  "Traffic": ["signal", "sun"], "Housing": ["house", "mint"], "Education": ["book", "sky"], "Culture": ["note", "lilac"],
  "Food": ["cutlery", "sun"], "Weather": ["weather", "sky"], "Football": ["ball", "mint"], "Sports": ["trophy", "sun"],
  "Crime": ["magnifier", "rose"], "Celebrities": ["star", "rose"], "Crypto": ["cube", "sun"], "Careers": ["stairs", "mint"],
  "History": ["hourglass", "sun"], "Design": ["nib", "lilac"], "Privacy": ["keyhole", "stone"],
};

/** Checks what the tagger wrote; anything off is dropped, so a bad answer falls back to the topics. */
export function normalizeEmblem(x: any): EmblemSpec | null {
  if (!x || typeof x !== "object" || typeof x.motif !== "string" || !MOTIFS[x.motif]) return null;
  return { motif: x.motif, mood: MOODS.includes(x.mood) ? x.mood : "mint", word: typeof x.word === "string" ? x.word.replace(/\s+/g, " ").trim().slice(0, 22) : "" };
}

/** The emblem of a story: the tagger's choice when there is one, otherwise the first topic's, with a place or the topic on the ring. */
export function emblemFor(s: { emblem?: EmblemSpec | null; topics?: string[]; places?: string[] }): EmblemSpec {
  const own = normalizeEmblem(s.emblem);
  if (own) return own;
  const topic = (s.topics ?? []).find(t => TOPIC_EMBLEM[t]);
  const [motif, mood] = topic ? TOPIC_EMBLEM[topic] : ["sprig", "mint" as Mood];
  return { motif, mood, word: (s.places?.[0] ?? topic ?? "").slice(0, 22) };
}

/** A small seeded generator (mulberry32), so one seed always draws the same emblem. */
function rng(seed: number | string) {
  let h = 2166136261;
  for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T,>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], id: (h >>> 0).toString(36) };
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** A closed curve r(θ) around the centre, as a path. */
function polar(r: (t: number) => number, steps = 240) {
  let d = "";
  for (let i = 0; i <= steps; i++) { const t = (i / steps) * Math.PI * 2, R = r(t); d += `${i ? "L" : "M"}${f(Math.sin(t) * R)} ${f(-Math.cos(t) * R)}`; }
  return d + "Z";
}

// The wide emblem moves, slowly enough to read as light on an engraving and never as a loading spinner:
// seconds per turn of the ring and of the pattern inside it (the other way), and per ripple of the waves.
const RING_S = 90, INNER_S = 140, WAVE_S = 16, PHASES = 8;
/** A turn about the centre, as SMIL, so Emblem.svelte can pause it with the waves; negative turns the other way. */
const spin = (s: number) => `<animateTransform attributeName="transform" type="rotate" from="0" to="${s < 0 ? -360 : 360}" dur="${Math.abs(s)}s" repeatCount="indefinite"/>`;

const FRAMES = ["seal", "disc", "badge", "milled"] as const;
const PATTERNS = ["rays", "hatch", "contour", "rosette"] as const;

/**
 * The emblem as SVG markup. `wide` draws the seal on a 16:9 field of guilloche waves (a card's picture strip),
 * otherwise a square seal alone; the wide one moves (ring and pattern turn, the waves ripple), the motif and word stay still; `small` leaves out the lettering for thumbnails where it could not be read.
 */
export function emblemSvg(spec: EmblemSpec, seed: number | string, o: { wide?: boolean; small?: boolean; label?: string } = {}): string {
  const R = rng(`${seed}:${spec.motif}`), id = `em${R.id}`;
  const frame = R.pick(FRAMES), pattern = R.pick(PATTERNS);
  const W = o.wide ? 356 : 200, H = 200, V = o.small ? 176 : H;
  let s = `<svg class="emblem ${spec.mood}" viewBox="${o.wide ? -W / 2 : -V / 2} ${-V / 2} ${o.wide ? W : V} ${V}" role="img" aria-label="${esc(o.label ?? spec.word ?? spec.motif)}">`;
  s += `<defs><clipPath id="${id}c"><circle r="57"/></clipPath>${spec.word && !o.small ? `<path id="${id}t" d="M-69 0A69 69 0 0 1 69 0"/>` : ""}</defs>`;
  s += `<rect x="${-W / 2}" y="${-H / 2}" width="${W}" height="${H}" fill="var(--em-field)"/>`;

  // the field: two crossing families of waves, as on a banknote, and a dotted border inset from the edge
  if (o.wide) {
    const L = R.int(9, 13), gap = R.int(3, 5), amp = R.int(10, 16), lam = R.int(46, 70), drift = 0.2 + R.next() * 0.35;
    // one wave per family, swelling towards the seal; the other lines are shifted copies (<use>), so the band is cheap
    // The waves ripple: the swell stays where it is and the phase runs through it, the two families in opposite
    // directions. A phase shift is not a translation, so the path's shape is drawn at PHASES steps and SMIL steps
    // through them; relative points keep the eight shapes small. Emblem.svelte pauses it off screen.
    s += `<g fill="none" stroke="var(--em-line)" stroke-width=".55" opacity=".75">`;
    const x0 = -W / 2 - lam, n = Math.floor((W + 2 * lam) / 5);
    // "l5 -.3 5 .2 …": one relative lineto, its pairs repeated, without leading zeros
    const num = (v: number) => String(f(v)).replace(/^(-?)0\./, "$1.");
    const wave = (fam: number, ph: number) => {
      let p = "", last = 0;
      for (let i = 0; i <= n; i++) {
        const x = x0 + i * 5, y = f(amp * (0.3 + 0.7 * Math.cos((x / W) * Math.PI) ** 2) * Math.sin((x / lam) * Math.PI * 2 + fam * Math.PI + ph));
        p += i === 0 ? `M${f(x)} ${y}l` : `${i > 1 ? " " : ""}5 ${num(y - last)}`;
        last = y;
      }
      return p;
    };
    for (const fam of [0, 1]) {
      const frames = Array.from({ length: PHASES + 1 }, (_, j) => wave(fam, (fam ? 1 : -1) * (j / PHASES) * Math.PI * 2));
      s += `<path id="${id}w${fam}" d="${frames[0]}" transform="translate(0 ${f((-(L - 1) / 2) * gap)})"><animate attributeName="d" dur="${WAVE_S}s" repeatCount="indefinite" values="${frames.join(";")}"/></path>`;
      for (let i = 1; i < L; i++) s += `<use href="#${id}w${fam}" transform="translate(${f(i * drift * lam / 6)} ${f(i * gap)})"/>`;
    }
    s += `</g>`;
    s += `<rect x="${-W / 2 + 9}" y="${-H / 2 + 9}" width="${W - 18}" height="${H - 18}" rx="14" fill="none" stroke="var(--em-line)" stroke-width="1.2" stroke-dasharray=".1 4.2" stroke-linecap="round"/>`;
    // a small rosette in each corner
    const k = R.int(5, 8);
    let ro = "";
    for (let j = 0; j < 6; j++) ro += polar(t => 9 + 4 * Math.sin(k * t + j * Math.PI / (3 * k)), k * 14);
    s += `<path id="${id}o" transform="translate(${-(W / 2 - 30)} ${-(H / 2 - 30)})" d="${ro}" fill="none" stroke="var(--em-line)" stroke-width=".5"/>`;
    for (const [cx, cy] of [[1, 0], [0, 1], [1, 1]]) s += `<use href="#${id}o" transform="translate(${cx * (W - 60)} ${cy * (H - 60)})"/>`;
  }

  // the frame: the seal's outer edge
  if (frame === "seal") { const n = R.int(26, 40); s += `<path d="${polar(t => 85 + 2.6 * Math.cos(n * t), n * 10)}" fill="var(--em-soft)" stroke="var(--em-deep)" stroke-width="1.4"/>`; }
  else if (frame === "disc") s += `<circle r="86" fill="var(--em-soft)" stroke="var(--em-deep)" stroke-width="1.4"/><circle r="81.5" fill="none" stroke="var(--em-deep)" stroke-width="1.6" stroke-dasharray=".1 5" stroke-linecap="round"/>`;
  else if (frame === "badge") { const n = R.pick([8, 10, 12]); s += `<path d="${polar(t => 86 * Math.cos(Math.PI / n) / Math.cos(((t + Math.PI / n) % (2 * Math.PI / n)) - Math.PI / n), n * 40)}" fill="var(--em-soft)" stroke="var(--em-deep)" stroke-width="1.4" stroke-linejoin="round"/>`; }
  else { let d = ""; for (let i = 0; i < 120; i++) { const t = (i / 120) * Math.PI * 2; d += `M${f(Math.sin(t) * 80)} ${f(-Math.cos(t) * 80)}L${f(Math.sin(t) * 87)} ${f(-Math.cos(t) * 87)}`; } s += `<circle r="86" fill="var(--em-soft)"/><path d="${d}" stroke="var(--em-deep)" stroke-width=".9"/>`; }

  // the guilloche ring between 60 and 78: interlaced waves, the part a copier cannot fake
  {
    const k = R.int(9, 17), M = R.int(6, 10), amp = 5 + R.next() * 3;
    // one wave, turned M times: the copies are <use>, so a dense ring costs one path
    s += `<circle r="78.5" fill="var(--em-field)" stroke="var(--em-deep)" stroke-width="1.1"/><g fill="none" stroke="var(--em-line)" stroke-width=".6">`;
    s += `<path id="${id}r" d="${polar(t => 69 + amp * Math.sin(k * t), k * 14)}"/>`;
    for (let j = 1; j < M; j++) s += `<use href="#${id}r" transform="rotate(${f((j * 360) / (k * M))})"/>`;
    s += (o.wide ? spin(RING_S) : "") + `</g>`;
  }
  if (spec.word && !o.small) {
    // the word along the top of the ring, haloed in the field colour so it reads over the waves; three dots at the bottom balance it
    s += `<text class="em-word" fill="var(--em-deep)" stroke="var(--em-field)" stroke-width="4" stroke-linejoin="round" paint-order="stroke"><textPath href="#${id}t" startOffset="50%" text-anchor="middle">${esc(spec.word.toUpperCase())}</textPath></text>`;
    for (const a of [-14, 0, 14]) { const r = a * Math.PI / 180; s += `<circle cx="${f(Math.sin(r) * 69)}" cy="${f(Math.cos(r) * 69)}" r="${a ? 1.6 : 2.4}" fill="var(--em-deep)"/>`; }
  }

  // the inner disc and its pattern
  s += `<circle r="59.5" fill="var(--em-core)" stroke="var(--em-deep)" stroke-width="1.1"/><g clip-path="url(#${id}c)" fill="none" stroke="var(--em-line)" stroke-width=".55">`;
  if (pattern === "rays") { const n = R.pick([60, 72, 90]); let d = ""; for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2, r0 = i % 2 ? 30 : 22; d += `M${f(Math.sin(t) * r0)} ${f(-Math.cos(t) * r0)}L${f(Math.sin(t) * 58)} ${f(-Math.cos(t) * 58)}`; } s += `<path d="${d}"/>`; }
  else if (pattern === "hatch") { const a = R.int(20, 70), g = 3.2; let d = ""; for (let y = -60; y <= 60; y += g) d += `M-60 ${f(y)}H60`; s += `<path d="${d}" transform="rotate(${a})"/><path d="${d}" transform="rotate(${a + 90})" opacity=".45"/>`; }
  else if (pattern === "contour") { const p = R.next() * 6, q = R.next() * 6, k1 = R.int(2, 4), k2 = R.int(5, 7); let d = ""; for (let r = 36; r < 60; r += 2.6) d += polar(t => r + 1.6 * Math.sin(k1 * t + p + r / 9) + 1.1 * Math.sin(k2 * t + q), 90); s += `<path d="${d}"/>`; }
  else { const n = R.pick([9, 12, 15]); for (let i = 0; i < n; i++) s += `<ellipse rx="57" ry="${R.int(14, 19)}" transform="rotate(${f((i * 180) / n)})"/>`; }
  // the pattern turns against the ring; a hatch would turn like a grid on a machine, so it stays
  if (o.wide && pattern !== "hatch") s += spin(-INNER_S);
  s += `</g><circle r="36" fill="var(--em-core)" opacity=".9"/><circle r="36" fill="none" stroke="var(--em-line)" stroke-width=".8"/>`;

  // the motif, engraved: a knockout in the core colour under the line, so the pattern never touches it
  const d = MOTIFS[spec.motif] ?? MOTIFS.sprig, k = o.small ? 2.9 : 2.35;
  s += `<g transform="translate(${-12 * k} ${-12 * k}) scale(${k})" fill="none" stroke-linecap="round" stroke-linejoin="round">`;
  s += `<path d="${d}" stroke="var(--em-core)" stroke-width="4"/><path d="${d}" stroke="var(--em-glyph)" stroke-width="1.5"/></g>`;
  return s + `</svg>`;
}
