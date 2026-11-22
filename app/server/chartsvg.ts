// A chart as a static SVG, for places without the app: the morning briefing email (turned into a PNG there, since
// mail apps do not show SVG). Same data rules as <Chart> (shared/chart.ts); fixed light colours on a card of paper.
import { format, hi, lo, ticks, type Chart } from "../shared/chart";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The app's light palette (client/app.css): mail shows figures on paper, the same in light and dark mode.
export const PAL = { paper: "#f7fdf8", bg: "#e8f7ec", ink: "#0f2a1b", muted: "#4c6b58", rule: "#c2e2cc", mint: "#12804c", soft: "#c9f0d8", dim: "#a9d6b8" };
const { ink: INK, muted: MUTED, rule: RULE } = PAL, SLOTS = [PAL.mint, "#8a5cd0", "#e08a2e", "#3a7bd5", "#c2405a", "#8a9a2b"];
export const FONT = `Inter, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const PADX = 26, PADY = 24, OUTER = 640, W = OUTER - PADX * 2;

/** A chart as a card of paper: title, the bars or lines, the source; drawn at 640 wide, shown at 560 or less. */
export function chartSvg(c: Chart, lang: string): string {
  const head = `<text x="0" y="18" font-size="18" font-weight="700" fill="${INK}">${esc(c.title)}</text>` +
    (c.subtitle ? `<text x="0" y="40" font-size="13.5" fill="${MUTED}">${esc(c.subtitle)}</text>` : "");
  const top = c.subtitle ? 60 : 38;
  const many = c.series.length > 1 && (c.type === "line" || c.type === "area" || c.labels.length > 6);
  const body = many ? lines(c, lang, top) : bars(c, lang, top);
  const foot = c.source ? `<text x="0" y="${body.h + top + 22}" font-size="11.5" fill="${MUTED}">${esc((lang === "de" ? "Quelle: " : "Source: ") + c.source)}</text>` : "";
  const H = body.h + top + (c.source ? 30 : 6) + PADY * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTER}" height="${H}" viewBox="0 0 ${OUTER} ${H}" font-family='${FONT}'><rect x=".5" y=".5" width="${OUTER - 1}" height="${H - 1}" rx="18" fill="${PAL.paper}" stroke="${RULE}"/><g transform="translate(${PADX} ${PADY})">${head}<g transform="translate(0 ${top})">${body.svg}</g>${foot}</g></svg>`;
}

/** One bar per label (the first series), longest scale from zero; the highlighted label in the accent colour. */
function bars(c: Chart, lang: string, _top: number) {
  const s = c.series[0], row = 32, labelW = 160;
  const val = (v: NonNullable<typeof s.values[number]>) => Array.isArray(v) ? `${format(c, v[0], lang, true)} to ${format(c, v[1], lang, true)}` : format(c, v, lang, true);
  // the value column is as wide as its longest value (about 8px a character at 13.5px bold), so nothing runs off the paper
  const valW = Math.min(200, 16 + Math.max(0, ...s.values.map(v => v == null ? 0 : val(v).length)) * 8), plot = W - labelW - valW;
  const max = Math.max(0, ...s.values.map(v => hi(v) ?? 0)), min = Math.min(0, ...s.values.map(v => lo(v) ?? 0));
  const span = max - min || 1, x = (v: number) => labelW + ((v - min) / span) * plot;
  const svg = c.labels.map((l, i) => {
    const v = s.values[i], y = i * row;
    if (v == null) return "";
    const a = Array.isArray(v) ? v[0] : Math.min(0, v), b = Array.isArray(v) ? v[1] : Math.max(0, v);
    const fill = c.highlight && c.highlight !== l ? PAL.dim : SLOTS[0];
    return `<text x="${labelW - 10}" y="${y + 20}" font-size="13.5" text-anchor="end" fill="${INK}">${esc(l.length > 22 ? l.slice(0, 21) + "…" : l)}</text>` +
      `<rect x="${labelW}" y="${y + 6}" width="${plot}" height="${row - 12}" rx="${(row - 12) / 2}" fill="${PAL.bg}"/>` +
      `<rect x="${x(a)}" y="${y + 6}" width="${Math.max(row - 12, x(b) - x(a))}" height="${row - 12}" rx="${(row - 12) / 2}" fill="${fill}"/>` +
      `<text x="${labelW + plot + 10}" y="${y + 20}" font-size="13.5" font-weight="700" fill="${INK}">${esc(val(v))}</text>`;
  }).join("");
  return { svg, h: c.labels.length * row };
}

/** Several series over the labels as lines, with a light grid and a legend underneath. */
function lines(c: Chart, lang: string, _top: number) {
  const h = 220, left = 48, right = 8, plot = W - left - right;
  const all = c.series.flatMap(s => s.values.flatMap(v => v == null ? [] : Array.isArray(v) ? v : [v]));
  const t = ticks(Math.min(0, ...all), Math.max(...all), 4), y0 = t[0], y1 = t[t.length - 1];
  const X = (i: number) => left + (c.labels.length < 2 ? plot / 2 : (i / (c.labels.length - 1)) * plot), Y = (v: number) => h - ((v - y0) / (y1 - y0 || 1)) * h;
  let svg = t.map(v => `<line x1="${left}" x2="${W - right}" y1="${Y(v)}" y2="${Y(v)}" stroke="${RULE}"/><text x="${left - 8}" y="${Y(v) + 4}" font-size="11.5" text-anchor="end" fill="${MUTED}">${esc(format(c, v, lang, true))}</text>`).join("");
  const every = Math.ceil(c.labels.length / 8);
  svg += c.labels.map((l, i) => i % every ? "" : `<text x="${X(i)}" y="${h + 18}" font-size="11.5" text-anchor="middle" fill="${MUTED}">${esc(l)}</text>`).join("");
  c.series.forEach(s => {
    const pts = s.values.map((v, i) => v == null ? null : `${X(i).toFixed(1)},${Y(hi(v)!).toFixed(1)}`).filter(Boolean);
    svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${SLOTS[s.slot % SLOTS.length]}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  svg += c.series.map((s, k) => `<g transform="translate(${left + k * 150} ${h + 36})"><rect width="12" height="12" rx="6" fill="${SLOTS[s.slot % SLOTS.length]}"/><text x="18" y="11" font-size="12.5" fill="${INK}">${esc(s.name.slice(0, 18))}</text></g>`).join("");
  return { svg, h: h + 52 };
}

/** The top of the briefing email: a mint card with the mark, the day and a line under it. 600 wide, sent at 2x. */
export function headerSvg(o: { kicker: string; day: string; date: string; line: string; mark: string }): string {
  const W = 600, H = 196;
  const mark = o.mark.replace("<svg ", `<svg x="${W - 186}" y="23" width="150" height="150" `);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family='${FONT}'>` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2fcf5"/><stop offset="1" stop-color="${PAL.soft}"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" rx="24" fill="url(#g)"/>` +
    `<circle cx="${W - 111}" cy="98" r="92" fill="#ffffff" opacity=".45"/>${mark}` +
    `<text x="32" y="50" font-size="15" font-weight="800" letter-spacing="1.4" fill="${PAL.mint}">${esc(o.kicker.toUpperCase())}</text>` +
    `<text x="32" y="100" font-size="40" font-weight="800" letter-spacing="-.6" fill="${INK}">${esc(o.day)}</text>` +
    `<text x="32" y="136" font-size="25" font-weight="600" letter-spacing="-.3" fill="${INK}">${esc(o.date)}</text>` +
    `<text x="32" y="170" font-size="17" font-weight="500" fill="${MUTED}">${esc(o.line)}</text></svg>`;
}

/** The SVG as PNG bytes: vips on the server (librsvg inside), rsvg-convert on a Mac; null when neither exists. */
export async function svgToPng(svg: string): Promise<Uint8Array | null> {
  const dir = mkdtempSync(join(tmpdir(), "pm-chart-")), src = join(dir, "c.svg"), out = join(dir, "c.png");
  writeFileSync(src, svg);
  try {
    for (const cmd of [["rsvg-convert", "-z", "2", "-o", out, src], ["vips", "copy", `${src}[scale=2]`, out]]) {
      try { if ((await Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" }).exited) === 0 && existsSync(out)) return new Uint8Array(readFileSync(out)); } catch {}
    }
    return null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
