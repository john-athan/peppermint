const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return Math.round(s / 60) + " min";
  if (s < 86400) return new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return rtf.format(-Math.round(s / 86400), "day");
}
export const dayLabel = (day: string) => new Date(day + "T12:00:00").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
export const signed = (v: number) => (v < 0 ? "−" : "+") + Math.abs(v).toFixed(2);
export const favChar: Record<string, string> = { hackernews: "Y", merkur: "M", feed: "⌁", youtube: "▶", podcast: "P", bluesky: "B", mastodon: "M", topic: "#", github: "GH", arxiv: "Ar", watch: "◎", catalog: "★", mail: "@", echa: "E", consult: "EU" };
/** A search snippet: the matched words sit between \u0002 and \u0003. Split here so the page can wrap them in <mark>, never in {@html}. */
export function marked(s: string): { t: string; m: boolean }[] {
  const out: { t: string; m: boolean }[] = [];
  for (const [i, part] of s.split("\u0002").entries()) {
    const [a, b] = i ? part.split("\u0003") : [undefined, part];
    if (a) out.push({ t: a, m: true });
    if (b) out.push({ t: b, m: false });
  }
  return out;
}
/** An ask answer: sentences with [n] markers, a line "---", then one line per marker: [n] "quoted words" (source). Tolerates a half-streamed tail. */
export type AskParts = { head: ({ t: string } | { n: number })[]; quotes: { n: number; text: string; source: string }[] };
export function askParts(answer: string): AskParts {
  const [h, ...rest] = answer.split(/\n-{3,}\n?/);
  // while streaming, the divider may be half there: "\n-" or "\n--"
  const head = h.replace(/\n-{1,2}$/, "").split(/\[(\d+)\]/).flatMap((p, i) => i % 2 ? [{ n: Number(p) }] : p ? [{ t: p }] : []);
  const quotes = rest.join("\n").split("\n").flatMap(l => {
    const m = /^\[(\d+)\]\s*(.*)$/.exec(l.trim()); if (!m) return [];
    const q = /^[“"„]?(.*?)[”"“]?\s*(?:\(([^()]*)\))?\s*$/.exec(m[2]);
    return q && q[1] ? [{ n: Number(m[1]), text: q[1], source: q[2] ?? "" }] : [];
  });
  return { head, quotes };
}

/** A dig answer: an optional first line `@sources [...]` (the pages its quotes come from), for "is it true" a verdict line
 *  (`@holds`, `@partly`, `@disputed`, `@unclear`), then an ask answer. A first line still streaming in stays hidden. */
export type DigParts = AskParts & { sources: { site: string; url: string; title: string }[]; verdict: "holds" | "partly" | "disputed" | "unclear" | null };
export function digParts(answer: string): DigParts {
  let rest = answer, sources: DigParts["sources"] = [], verdict: DigParts["verdict"] = null;
  for (;;) {
    const t = rest.trimStart();
    if (!t.startsWith("@")) break;
    const nl = t.indexOf("\n");
    if (nl < 0) return { head: [], quotes: [], sources, verdict };
    const line = t.slice(0, nl).trim();
    if (line.startsWith("@sources ")) { try { sources = JSON.parse(line.slice(9)); } catch {} }
    else { const v = /^@(holds|partly|disputed|unclear)\b/.exec(line); if (v) verdict = v[1] as DigParts["verdict"]; }
    rest = t.slice(nl + 1);
  }
  return { ...askParts(rest.trimStart()), sources, verdict };
}
