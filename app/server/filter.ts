// Keyword filters on a source: "only items that mention one of these" and "never items that mention any of these".
// They run when a source is pulled, before anything is stored, so a wide source (the EU Official Journal, a general
// sustainability site) brings in only what you would read. Items already stored stay as they are.
//
// A term matches as a whole word or phrase, ignoring case and accents ("REACH" does not match "reached"). A term that
// ends in * matches the start of a word ("restrict*" finds restriction, restricted).

export type SourceFilter = { any: string[]; none: string[] };
export const NO_FILTER: SourceFilter = { any: [], none: [] };

const fold = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A term to a regular expression over folded text: whole words, spaces match any whitespace, a trailing * a prefix. */
function termRe(term: string): RegExp {
  const t = fold(term.trim());
  const prefix = t.endsWith("*");
  const body = esc(prefix ? t.slice(0, -1) : t).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}${prefix ? "" : "(?![\\p{L}\\p{N}])"}`, "u");
}

/** A tester for one word or phrase over any text, by the same rules as a filter term. */
export function mentions(term: string): (text: string) => boolean {
  const re = termRe(term);
  return text => re.test(fold(text));
}

/** What a client sends, cleaned: at most 30 terms per list, each 2 to 60 characters, no duplicates. */
export function cleanFilter(raw: unknown): SourceFilter {
  const list = (v: unknown) => {
    const terms = (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]/) : []).map(x => String(x).replace(/\s+/g, " ").trim()).filter(x => x.replace(/\*$/, "").length >= 2 && x.length <= 60);
    const seen = new Set<string>();
    return terms.filter(t => !seen.has(fold(t)) && !!seen.add(fold(t))).slice(0, 30); // the first spelling wins
  };
  const r = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return { any: list(r.any), none: list(r.none) };
}

export function parseFilter(stored: string | null | undefined): SourceFilter {
  try { return cleanFilter(JSON.parse(stored ?? "{}")); } catch { return NO_FILTER; }
}

/** A tester for one filter, built once per pull. True when the item is kept. */
export function filterFor(f: SourceFilter): (it: { title: string; summary?: string | null; body?: string | null }) => boolean {
  if (!f.any.length && !f.none.length) return () => true;
  const any = f.any.map(termRe), none = f.none.map(termRe);
  return it => {
    const text = fold(`${it.title}\n${it.summary ?? ""}\n${(it.body ?? "").slice(0, 40_000)}`);
    if (none.some(r => r.test(text))) return false;
    return !any.length || any.some(r => r.test(text));
  };
}
