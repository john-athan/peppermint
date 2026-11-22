// The story video's script: one scene per line, `Caption | Narration | Visual`, where Visual is one JSON object saying
// what the scene shows. Claude chooses it from material peppermint has (numbers in the text, the article's figures,
// portraits of the people and places named, the story's picture); nothing is generated or invented.
//
//   {"stat": "385×", "label": "less compute than the baseline"}       one striking number, counted up
//   {"chart": { ...chart JSON, see shared/chart.ts }}                   comparable numbers, drawn
//   {"figure": 2}                                                       the article's own figure number 2
//   {"quote": "exact words", "by": "Name"}                              a quote, with the speaker's portrait if known
//   {"person": "Name"}                                                  a person or place from the portraits list
//   {"compare": [["Easy puzzle", "3 steps"], ["Hard puzzle", "13 steps"]]}   two or three values side by side
//   {"picture": true}                                                   the story's own photo
import { normalize, type Chart } from "./chart";

export type Visual =
  | { kind: "stat"; value: string; label: string }
  | { kind: "chart"; chart: Chart }
  | { kind: "figure"; n: number }
  | { kind: "quote"; text: string; by: string | null }
  | { kind: "person"; name: string }
  | { kind: "compare"; items: { label: string; value: string }[] }
  | { kind: "picture" };
export type Scene = { caption: string; line: string; visual: Visual };

const s = (v: unknown, max: number) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Reads one visual; anything unknown or malformed falls back to the story's picture. */
export function visualOf(raw: string): Visual {
  let v: any;
  try { v = JSON.parse(raw); } catch { return { kind: "picture" }; }
  if (!v || typeof v !== "object") return { kind: "picture" };
  if (s(v.stat, 24)) return { kind: "stat", value: s(v.stat, 24), label: s(v.label, 90) };
  if (v.chart && typeof v.chart === "object") { const r = normalize(v.chart); if ("chart" in r) return { kind: "chart", chart: r.chart }; }
  if (Number.isInteger(v.figure) && v.figure >= 1 && v.figure <= 12) return { kind: "figure", n: v.figure };
  if (s(v.quote, 280)) return { kind: "quote", text: s(v.quote, 280), by: s(v.by, 80) || null };
  if (s(v.person, 80)) return { kind: "person", name: s(v.person, 80) };
  if (Array.isArray(v.compare)) {
    const items = v.compare.filter((x: unknown) => Array.isArray(x) && x.length >= 2).slice(0, 3).map((x: unknown[]) => ({ label: s(x[0], 40), value: s(String(x[1] ?? ""), 24) })).filter((x: { label: string; value: string }) => x.label && x.value);
    if (items.length >= 2) return { kind: "compare", items };
  }
  return { kind: "picture" };
}

/** One script line into a scene; null when it is not a scene (a stray line, or one still being written). */
export function parseScene(line: string): Scene | null {
  const t = line.trim().replace(/^\d+[.)]\s*/, "");
  const a = t.indexOf("|"); if (a < 0) return null;
  const caption = t.slice(0, a).trim();
  let rest = t.slice(a + 1), visual: Visual = { kind: "picture" };
  // the visual is the JSON after the second separator; a narration with no visual is still a scene
  const b = rest.search(/\|\s*\{/);
  if (b >= 0) { visual = visualOf(rest.slice(b + 1).trim()); rest = rest.slice(0, b); }
  const narration = rest.trim();
  return caption && narration ? { caption, line: narration, visual } : null;
}

/** All finished scenes of a script; while it streams, the last line counts only once its newline has arrived. */
export function scenesOf(raw: string, streaming: boolean): Scene[] {
  const lines = raw.split("\n");
  if (streaming && !raw.endsWith("\n")) lines.pop();
  return lines.map(parseScene).filter((x): x is Scene => !!x);
}

/** A number inside a stat ("385×", "€4.2 bn", "-12 %") split so it can count up: prefix, number, suffix, decimals. */
export function countable(v: string): { pre: string; n: number; num: string; post: string; decimals: number; comma: boolean } | null {
  const m = /^([^\d-]*)(-?\d[\d.,\s]*\d|-?\d)(.*)$/.exec(v);
  if (!m) return null;
  const raw = m[2].replace(/\s/g, "");
  // "1.234,5" (German) and "1,234.5" (English): the last separator followed by 1-2 digits is the decimal point
  const dec = /[.,](\d{1,2})$/.exec(raw);
  const comma = !!dec && raw[raw.length - dec[1].length - 1] === ",";
  const n = Number(raw.replace(dec ? new RegExp(`[.,](?=\\d{1,2}$)`) : /$^/, "#").replace(/[.,]/g, "").replace("#", "."));
  return Number.isFinite(n) ? { pre: m[1], n, num: m[2], post: m[3], decimals: dec ? dec[1].length : 0, comma } : null;
}
