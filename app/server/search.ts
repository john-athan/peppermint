// Search over everything you follow, fast enough to run on every keystroke. Two FTS5 indexes kept by triggers
// (server/db.ts, migration 10): `search` holds title, the tag names, summary and article text with unicode61 words;
// `search_tri` holds title and names as trigrams, for parts of words that unicode61 cannot split ("markt" in
// "Flohmarkt"). Hits are items; a story ranks by its best item, bm25 weighted title > names > summary > text, lifted
// a little when it is recent.
import { db } from "./db";

export const MARK = ["\u0002", "\u0003"] as const; // around the matched words in a snippet; the client draws them

/** The words of a query, lower case, at most eight. */
export const words = (q: string) => (q.normalize("NFC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);

type Hit = { story_id: number; score: number; snippet: string };

export function searchStories(owner: number, q: string, limit = 8, exclude: Set<number> = new Set()): Hit[] {
  const ws = words(q);
  if (!ws.length) return [];
  // every word must match; the last one as a prefix, so results follow the typing ("flohm" finds "Flohmarkt")
  const fts = ws.map((w, i) => `"${w}"${i === ws.length - 1 ? "*" : ""}`).join(" ");
  const best = new Map<number, Hit>();
  const take = (rows: { story_id: number; r: number; at: number; snip: string }[], weight: number) => {
    for (const row of rows) {
      if (exclude.has(row.story_id)) continue;
      const ageDays = Math.max(0, (Date.now() - row.at) / 86400_000);
      const score = -row.r * weight * (1 + 0.6 * Math.exp(-ageDays / 5));
      const cur = best.get(row.story_id);
      if (!cur || score > cur.score) best.set(row.story_id, { story_id: row.story_id, score, snippet: row.snip });
    }
  };
  take(db.query(`SELECT i.story_id, i.published_at AS at, bm25(search, 10.0, 6.0, 2.0, 1.0) AS r, snippet(search, -1, ?, ?, '…', 14) AS snip
    FROM search JOIN items i ON i.id = search.rowid WHERE search MATCH ? AND i.owner_id = ? AND i.story_id IS NOT NULL ORDER BY r LIMIT 200`)
    .all(MARK[0], MARK[1], fts, owner) as any[], 1);
  // few word matches: try parts of words, at half weight so whole words still lead
  const parts = ws.filter(w => w.length >= 3);
  if (best.size < 3 && parts.length) {
    take(db.query(`SELECT i.story_id, i.published_at AS at, bm25(search_tri, 4.0, 2.0) AS r, snippet(search_tri, -1, ?, ?, '…', 14) AS snip
      FROM search_tri JOIN items i ON i.id = search_tri.rowid WHERE search_tri MATCH ? AND i.owner_id = ? AND i.story_id IS NOT NULL ORDER BY r LIMIT 100`)
      .all(MARK[0], MARK[1], parts.map(w => `"${w}"`).join(" "), owner) as any[], 0.5);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
