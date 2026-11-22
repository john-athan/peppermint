// Claude judges the day's stories: Haiku reads who the reader is and one line per candidate, and answers with the ids
// it would show, most interesting first. That order makes the edition and the feed after it (palate.ts); no topic caps
// or thresholds sit on top of it. Hard rules (never, always) and stories you already touched still hold.
import { db, now, setting } from "./db";
import { askJSON, hasLLM, SMALL_MODEL } from "./llm";
import { affinities, currentEditionId, editionPool, rules, scoreStories } from "./palate";
import { palateNote } from "./lens";

const EVERY = 30 * 60_000; // a new run when new stories came in, at most this often
const MAX = 400; // stories per run; a busier day sends the palate's best 400
const lastRun = new Map<number, number>(), running = new Set<number>();

/** The palate changed in a way the reader asked for: judge again on the next tick. */
export const rejudge = (owner: number) => { lastRun.delete(owner); };

const SYSTEM = (edition: number) => `You choose the news for one reader. You get what is known about the reader, then today's stories, one per line as "id | source | headline | gist".
Return the ids of the stories this reader will find worth their time, most interesting first. Leave out the ones they would not want to see.
Order them like a good editor would for this reader: the first ${edition} make their edition, so they should not repeat the same news and should not all be about one subject.`;
const SCHEMA = { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", items: { type: "integer" } } } };

const titles = (rows: { title: string; title_en: string | null }[]) => rows.map(r => `- ${r.title_en || r.title}`).join("\n") || "- none";

/** Who the reader is: the palate's weights and rules, what they follow and had researched, what they read and waved off lately. */
export function readerProfile(owner: number) {
  const aff = [...affinities(owner).values()].filter(a => Math.abs(a.weight) >= 0.3).sort((a, b) => b.weight - a.weight);
  const w = (a: { kind: string; name: string; weight: number }) => `${a.kind} ${a.name} (${a.weight.toFixed(1)})`;
  const since = now() - 14 * 86400_000;
  const recent = (kinds: string[], n: number) => db.query(`SELECT st.title, st.title_en FROM stories st WHERE st.id IN
    (SELECT story_id FROM signals WHERE owner_id = ? AND at > ? AND kind IN (${kinds.map(() => "?").join(",")}) GROUP BY story_id ORDER BY max(at) DESC LIMIT ?)`)
    .all(owner, since, ...kinds, n) as { title: string; title_en: string | null }[];
  const follows = db.query(`SELECT st.title, st.title_en FROM follows f JOIN stories st ON st.id = f.story_id WHERE f.owner_id = ? ORDER BY f.at DESC LIMIT 15`).all(owner) as any[];
  const research = (db.query(`SELECT input FROM tasks WHERE owner_id = ? AND kind = 'dossier' AND status != 'dismissed' ORDER BY updated_at DESC LIMIT 10`).all(owner) as { input: string }[])
    .map(t => `- ${t.input.replace(/^Research:\s*/i, "").slice(0, 160)}`).join("\n") || "- none";
  return [
    palateNote(owner),
    `Reads: ${setting<string[]>(owner, "langs", ["en", "de"]).join(", ")}.`,
    `Weights from what the reader did and said (-3 to 3):\nLikes: ${aff.filter(a => a.weight > 0).slice(0, 30).map(w).join(", ") || "none yet"}\nDislikes: ${aff.filter(a => a.weight < 0).reverse().slice(0, 15).map(w).join(", ") || "none yet"}`,
    `Rules the reader set: ${rules(owner).map(r => `${r.action} ${r.kind} "${r.value}"`).join("; ") || "none"}`,
    `Stories the reader follows:\n${titles(follows)}`,
    `Questions the reader had researched:\n${research}`,
    `Read lately:\n${titles(recent(["open", "read", "more", "pin", "rescue", "dwell"], 30))}`,
    `Waved off lately:\n${titles(recent(["less", "hide"], 15))}`,
  ].join("\n\n");
}

/** One line per story, newest first (not in the palate's order, which Claude would copy): its id, sources, English
 *  headline and the gist of its first report. */
function storyLines(ids: number[]) {
  const rows = db.query(`SELECT st.id, st.title, st.title_en,
      (SELECT group_concat(DISTINCT s.name) FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = st.id) AS sources,
      (SELECT coalesce(json_extract(i.tags, '$.summary_en'), i.summary) FROM items i WHERE i.story_id = st.id ORDER BY i.published_at LIMIT 1) AS gist
    FROM stories st WHERE st.id IN (${ids.map(() => "?").join(",")}) ORDER BY st.last_at DESC`).all(...ids) as { id: number; title: string; title_en: string | null; sources: string; gist: string | null }[];
  const flat = (s: string | null, n: number) => (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "/").trim().slice(0, n);
  return rows.map(r => `${r.id} | ${flat(r.sources, 60)} | ${flat(r.title_en || r.title, 160)} | ${flat(r.gist, 220)}`).join("\n");
}

/** Stores one run: the ids Claude returned, in its order, out of the stories it was given; the rest it left out. */
export function saveJudgement(owner: number, given: number[], ids: unknown[]) {
  const pool = new Set(given), seen = new Set<number>();
  const kept = ids.map(Number).filter(id => Number.isInteger(id) && pool.has(id) && !seen.has(id) && !!seen.add(id));
  if (!kept.length) return 0; // an answer with no usable id says nothing; it must not leave every story out
  const rank = new Map(kept.map((id, i) => [id, i + 1])), at = now();
  const up = db.query(`INSERT INTO judged (owner_id, story_id, rank, of, at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, story_id) DO UPDATE SET rank = excluded.rank, of = excluded.of, at = excluded.at`);
  db.transaction(() => { for (const id of given) up.run(owner, id, rank.get(id) ?? null, kept.length, at); })();
  return kept.length;
}

/** Due when Claude has not judged since the server started (or the palate changed), or when new stories came in and the last run is half an hour old. */
export function judgeDue(owner: number) {
  if (!hasLLM() || running.has(owner)) return false;
  const last = lastRun.get(owner);
  if (last === undefined) return true;
  if (now() - last < EVERY) return false;
  const pool = editionPool(owner, currentEditionId(owner)).map(s => s.id);
  return pool.length > 0 && !!db.query(`SELECT 1 FROM (SELECT value AS id FROM json_each(?)) p WHERE p.id NOT IN (SELECT story_id FROM judged WHERE owner_id = ?)`).get(JSON.stringify(pool), owner);
}

/** One run over this slot's candidates. Returns true when it stored a new order; a failed run is tried again after EVERY. */
export async function judge(owner: number): Promise<boolean> {
  running.add(owner); lastRun.set(owner, now());
  try {
    const pool = scoreStories(owner, editionPool(owner, currentEditionId(owner))).filter(s => s.verdict !== "never")
      .sort((a, b) => b.score - a.score).slice(0, MAX).map(s => s.story_id);
    if (!pool.length) return false;
    const user = `<reader>\n${readerProfile(owner)}\n</reader>\n\n<stories>\n${storyLines(pool)}\n</stories>`;
    const out = await askJSON<{ ids: unknown[] }>(SYSTEM(setting<number>(owner, "budget", 12)), user, SCHEMA, { model: SMALL_MODEL, background: true });
    if (!Array.isArray(out?.ids) || !out.ids.length) return false;
    const n = saveJudgement(owner, pool, out.ids);
    console.log(`judge: Claude kept ${n} of ${pool.length} stories`);
    return n > 0;
  } catch (e) { console.error("judge", e); return false; } finally { running.delete(owner); }
}
