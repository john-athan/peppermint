// Charts as a few lines of JSON, written by Claude in a lens or by you in Studio:
//
//   ```chart
//   { "title": "Minutes per bug fix", "unit": "min", "data": { "Gemini 4 Carbon": 22.35, "Opus 5.5": 9.55 } }
//   ```
//
// One series: "data" maps labels to numbers. Several: "x" lists the labels, "series" maps each name to its values.
// A value can be a range [low, high]. Everything else is optional:
//   type      "bar" (default for labels), "column", "line" (default for 4+ ordered labels like years), "area", "stacked"
//   title, subtitle, source, note
//   unit      "min", "km", "%", "€", "$", ...    format  "number" (default), "percent", "duration" (seconds), "currency"
//   highlight one label (or series) to emphasise; the rest go grey
//   hero      true: the chart is the story's core and may stand in for its picture
//   sort      true: bars largest first
// This module turns that into one normalized shape, formats numbers, and picks axis ticks; the drawing is Chart.svelte.

export type ChartType = "bar" | "column" | "line" | "area" | "stacked";
export type Value = number | [number, number] | null;
export type ChartSpec = {
  type?: ChartType; title?: string; subtitle?: string; source?: string; note?: string;
  unit?: string; format?: "number" | "percent" | "duration" | "currency";
  data?: Record<string, Value>; x?: (string | number)[]; series?: Record<string, Value[]>;
  highlight?: string; hero?: boolean; sort?: boolean;
};
export type Series = { name: string; values: Value[]; slot: number };
export type Chart = {
  type: ChartType; title: string; subtitle: string; source: string; note: string;
  unit: string; format: "number" | "percent" | "duration" | "currency";
  labels: string[]; series: Series[]; highlight: string | null; hero: boolean; sort: boolean;
  /** decimals used for every value in this chart, so 22.4 never stands next to 9.55 */
  digits: number;
};

/** Series past this many fold into "Other": six categorical slots passed the colour checks in both themes. */
export const MAX_SERIES = 6;
const TYPES: ChartType[] = ["bar", "column", "line", "area", "stacked"];
const str = (v: unknown, max = 160) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
function value(v: unknown): Value {
  if (Array.isArray(v) && v.length === 2) { const a = num(v[0]), b = num(v[1]); return a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : null; }
  return num(v);
}
export const hi = (v: Value) => v == null ? null : Array.isArray(v) ? v[1] : v;
export const lo = (v: Value) => v == null ? null : Array.isArray(v) ? v[0] : Math.min(0, v);

/** Parses and checks a spec. Returns the chart, or the reason it cannot be drawn (shown to a Studio writer). */
export function normalize(input: unknown): { chart: Chart } | { error: string } {
  let s: any = input;
  if (typeof input === "string") { try { s = JSON.parse(input); } catch (e) { return { error: `Not valid JSON: ${(e as Error).message.replace(/^JSON Parse error: /, "")}` }; } }
  if (!s || typeof s !== "object" || Array.isArray(s)) return { error: "A chart is a JSON object, like { \"data\": { \"A\": 3, \"B\": 5 } }." };
  // several series written inside "data" ({"data": {"x": [...], "series": {...}}}) mean the same as at the top level
  if (s.data && Array.isArray(s.data.x) && s.data.series && typeof s.data.series === "object" && !s.series) s = { ...s, x: s.data.x, series: s.data.series, data: undefined };
  let labels: string[] = [], series: Series[] = [];
  if (s.data && typeof s.data === "object" && !Array.isArray(s.data)) {
    labels = Object.keys(s.data).map(k => str(k, 80)).filter(Boolean);
    series = [{ name: str(s.title, 80) || "Value", values: Object.keys(s.data).map(k => value(s.data[k])), slot: 0 }];
  } else if (s.series && typeof s.series === "object" && !Array.isArray(s.series)) {
    if (!Array.isArray(s.x) || !s.x.length) return { error: "With \"series\", add \"x\": the labels along the axis, e.g. [\"2023\", \"2024\"]." };
    labels = s.x.map((x: unknown) => str(String(x ?? ""), 80));
    series = Object.keys(s.series).map((name, i) => {
      const vals = Array.isArray(s.series[name]) ? s.series[name] : [];
      return { name: str(name, 60) || `Series ${i + 1}`, values: labels.map((_, k) => value(vals[k])), slot: i };
    });
  } else return { error: "Add \"data\" (label to number) or \"x\" with \"series\" (name to numbers)." };
  if (!labels.length) return { error: "The chart has no labels." };
  if (labels.length > 60) return { error: "At most 60 labels fit a chart; group the rest." };
  if (!series.some(se => se.values.some(v => v != null))) return { error: "No numbers found: values must be numbers, or [low, high] ranges." };
  // past six series the smallest fold into "Other", so no seventh colour is ever invented
  if (series.length > MAX_SERIES) {
    const total = (se: Series) => se.values.reduce<number>((a, v) => a + Math.abs(hi(v) ?? 0), 0);
    const ranked = [...series].sort((a, b) => total(b) - total(a));
    const keep = new Set(ranked.slice(0, MAX_SERIES - 1));
    const rest = series.filter(se => !keep.has(se));
    series = [...series.filter(se => keep.has(se)), { name: "Other", slot: -1, values: labels.map((_, k) => rest.reduce<number | null>((a, se) => { const v = hi(se.values[k]); return v == null ? a : (a ?? 0) + v; }, null)) }];
    series.forEach((se, i) => { if (se.slot !== -1) se.slot = i; });
  }
  const ordered = labels.length >= 4 && labels.every(l => /^\d{4}([-/.]\d{1,2}){0,2}$|^(Q[1-4]|H[12])[\s/]?\d{2,4}$|^\d{1,2}[./]\d{1,2}[./]?\d{0,4}$/i.test(l));
  let type: ChartType = TYPES.includes(s.type) ? s.type : series.length > 1 && !ordered ? "bar" : ordered ? "line" : "bar";
  if ((type === "line" || type === "area") && labels.length < 2) type = "column";
  const fmt = ["number", "percent", "duration", "currency"].includes(s.format) ? s.format : s.unit === "%" ? "percent" : ["€", "$", "£", "EUR", "USD", "GBP", "CHF"].includes(s.unit) ? "currency" : "number";
  // one rounding for the whole chart: as many decimals as its values need, at most two (none from 100 up)
  const nums = series.flatMap(se => se.values.flatMap(v => v == null ? [] : Array.isArray(v) ? v : [v]));
  const big = Math.max(...nums.map(Math.abs)) >= 100;
  const digits = big ? 0 : Math.min(2, Math.max(0, ...nums.map(n => (String(n).split(".")[1] ?? "").length)));
  return { chart: {
    digits, type, title: str(s.title), subtitle: str(s.subtitle, 240), source: str(s.source, 120), note: str(s.note, 240),
    unit: fmt === "percent" ? "%" : str(s.unit, 12), format: fmt, labels, series,
    highlight: typeof s.highlight === "string" && (labels.includes(s.highlight) || series.some(se => se.name === s.highlight)) ? s.highlight : null,
    hero: s.hero === true, sort: s.sort === true,
  } };
}

/* ---------- numbers ---------- */

const CURRENCY: Record<string, string> = { "€": "EUR", "$": "USD", "£": "GBP", EUR: "EUR", USD: "USD", GBP: "GBP", CHF: "CHF" };
/** One value as people write it, in the reader's language. `compact` for axis ticks (12K, 1.2 Mio.). */
export function format(c: Pick<Chart, "format" | "unit"> & { digits?: number }, v: number, lang: string, compact = false): string {
  const loc = lang === "de" ? "de-DE" : "en-US";
  // axis ticks are round numbers and show no forced decimals; values follow the chart's own rounding
  const digits = compact ? (Number.isInteger(v) ? 0 : 1) : c.digits ?? (Math.abs(v) >= 100 || Number.isInteger(v) ? 0 : Math.abs(v) >= 10 ? 1 : 2);
  const nf = (o: Intl.NumberFormatOptions = {}) => new Intl.NumberFormat(loc, { maximumFractionDigits: digits, minimumFractionDigits: compact ? 0 : digits, ...(compact && Math.abs(v) >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}), ...o });
  if (c.format === "percent") return nf().format(v) + (lang === "de" ? " %" : "%");
  if (c.format === "currency" && CURRENCY[c.unit]) return nf({ style: "currency", currency: CURRENCY[c.unit], ...(compact ? {} : { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 }) }).format(v);
  if (c.format === "duration") {
    const s = Math.round(Math.abs(v)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60, sign = v < 0 ? "-" : "";
    if (compact) return sign + (h ? `${h} h` : m ? `${m} min` : `${r} s`);
    return sign + [h && `${h} h`, m && `${m} min`, r && !h && `${r} s`].filter(Boolean).join(" ") || "0 s";
  }
  return nf().format(v) + (c.unit ? (c.unit.length <= 2 && !/^[a-z]/i.test(c.unit) ? c.unit : ` ${c.unit}`) : "");
}
/** A value or a range ("16 to 30 %"). */
export function formatValue(c: Chart, v: Value, lang: string): string {
  if (v == null) return lang === "de" ? "keine Angabe" : "no data";
  // the unit once, at the end: "16 to 30%", "20 to 25 min" (durations and currencies keep both: "1 h to 1 h 30 min")
  if (Array.isArray(v)) { const bare = c.format === "percent" || c.format === "number"; return `${format(bare ? { format: "number", unit: "", digits: c.digits } : c, v[0], lang)} ${lang === "de" ? "bis" : "to"} ${format(c, v[1], lang)}`; }
  return format(c, v, lang);
}

/** Round axis ticks covering [min, max], about `count` of them, always including zero for bars. */
export function ticks(min: number, max: number, count = 5): number[] {
  if (min === max) { max = min === 0 ? 1 : min > 0 ? min * 1.2 : 0; if (min > 0) min = 0; }
  const span = max - min, raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= max + step * 0.5; t += step) out.push(+t.toFixed(10));
  if (out[out.length - 1] < max) out.push(+(out[out.length - 1] + step).toFixed(10));
  return out;
}

/** A sentence describing the chart, for screen readers and as the image's accessible name. */
export function describe(c: Chart, lang: string): string {
  const kind = { bar: "Bar chart", column: "Column chart", line: "Line chart", area: "Area chart", stacked: "Stacked bar chart" }[c.type];
  if (c.series.length === 1) return `${kind}${c.title ? `: ${c.title}` : ""}. ${c.labels.map((l, i) => `${l} ${formatValue(c, c.series[0].values[i], lang)}`).join("; ")}.`;
  return `${kind}${c.title ? `: ${c.title}` : ""}, ${c.series.length} series (${c.series.map(s => s.name).join(", ")}) over ${c.labels.length} labels.`;
}

/* ---------- charts inside text ---------- */

const FENCE = /```chart[ \t]*\n([\s\S]*?)\n```/g;
/** Splits text into prose and chart blocks; an unclosed fence at the end (still streaming) is reported as `open`. */
export function splitCharts(text: string): { parts: ({ text: string } | { chart: string })[]; open: boolean } {
  const parts: ({ text: string } | { chart: string })[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index! > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ chart: m[1] });
    last = m.index! + m[0].length;
  }
  let rest = text.slice(last), open = false;
  const start = rest.indexOf("```chart");
  if (start !== -1) { open = true; rest = rest.slice(0, start); }
  if (rest) parts.push({ text: rest });
  return { parts, open };
}
/** The first chart in a text that is marked as the story's core, normalized; null when there is none. */
export function heroChart(text: string): Chart | null {
  for (const p of splitCharts(text).parts) if ("chart" in p) { const r = normalize(p.chart); if ("chart" in r && r.chart.hero) return r.chart; }
  return null;
}
/** The text with every chart block (and an unfinished one) taken out. */
export const withoutCharts = (text: string) => splitCharts(text).parts.map(p => "text" in p ? p.text : "").join("").replace(/\n{3,}/g, "\n\n").trim();
