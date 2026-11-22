// Turns article and lens text into display blocks. It is a small
// markdown subset, the same one the article extractor writes: "## " and "### " headings, "- " list items, "> " quotes,
// **bold**, blank lines between blocks, and ```chart fences holding a chart as JSON (shared/chart.ts).
import { normalize, splitCharts, type Chart } from "../../shared/chart";
export type Run = { s: string; b?: boolean };
export type LensBlock =
  | { t: "p"; s: string; runs: Run[] }
  | { t: "h"; level: 2 | 3; s: string }
  | { t: "ul"; items: Run[][]; s: string }
  | { t: "quote"; s: string; runs: Run[] }
  | { t: "chart"; s: string; chart: Chart | null; error: string | null }
  | { t: "chart-wait"; s: string };

/** "**bold** text" into runs; unbalanced markers stay as they are. */
export function runs(s: string): Run[] {
  const out: Run[] = [];
  const parts = s.split(/\*\*/);
  if (parts.length % 2 === 0) return [{ s }];
  parts.forEach((p, i) => { if (p) out.push(i % 2 ? { s: p, b: true } : { s: p }); });
  return out;
}

export function blocks(lens: string, text: string): LensBlock[] {
  const out: LensBlock[] = [];
  const { parts, open } = splitCharts(text);
  for (const part of parts) {
    if ("chart" in part) { const r = normalize(part.chart); out.push("chart" in r ? { t: "chart", s: part.chart, chart: r.chart, error: null } : { t: "chart", s: part.chart, chart: null, error: r.error }); continue; }
    prose(part.text, out);
  }
  // a chart still streaming in waits behind the shimmer
  if (open) out.push({ t: "chart-wait", s: "" });
  return out;
}

function prose(text: string, out: LensBlock[]) {
  for (const chunk of text.split(/\n{2,}/)) {
    const lines = chunk.split("\n").map(l => l.trim()).filter(Boolean);
    let para: string[] = [], list: string[] = [];
    const flushPara = () => { if (para.length) { const s = para.join(" "); out.push({ t: "p", s, runs: runs(s) }); para = []; } };
    const flushList = () => { if (list.length) { out.push({ t: "ul", items: list.map(runs), s: list.join("\n") }); list = []; } };
    for (const l of lines) {
      const h = /^(#{2,3})\s+(.+)$/.exec(l);
      const li = /^[-•*]\s+(.+)$/.exec(l);
      const q = /^>\s?(.*)$/.exec(l);
      if (h) { flushPara(); flushList(); out.push({ t: "h", level: h[1].length as 2 | 3, s: h[2].replace(/\*\*/g, "") }); }
      else if (li) { flushPara(); list.push(li[1]); }
      else if (q) { flushPara(); flushList(); out.push({ t: "quote", s: q[1], runs: runs(q[1]) }); }
      else { flushList(); para.push(l); }
    }
    flushPara(); flushList();
  }
  return out;
}

/** One key figure of the morning briefing: a number from a story, what it measures, and the story's {n}. */
export type Kpi = { value: string; unit: string; label: string; n: number | null };
const KPIS = /```kpis[ \t]*\n([\s\S]*?)\n```[ \t]*\n?/;
/** The briefing's ```kpis block (a JSON list Claude writes after the lead) and the text without it. A broken block
 *  is dropped, so it never shows as raw JSON. At most four figures. */
export function kpis(text: string): { kpis: Kpi[]; text: string } {
  const m = KPIS.exec(text);
  if (!m) return { kpis: [], text };
  let list: Kpi[] = [];
  const str = (v: unknown, max: number) => typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "";
  try {
    const raw = JSON.parse(m[1]);
    if (Array.isArray(raw)) list = raw.map((k: any) => ({ value: str(k?.value, 14), unit: str(k?.unit, 14), label: str(k?.label, 90), n: Number.isInteger(k?.n) ? k.n : null }))
      .filter(k => k.value && k.label).slice(0, 4);
  } catch {}
  return { kpis: list, text: text.slice(0, m.index) + text.slice(m.index + m[0].length) };
}
