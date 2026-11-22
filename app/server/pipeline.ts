// Harvest pipeline: pull sources -> insert items -> tag -> cluster into stories.
import { AGENT_STORIES, db, json, now } from "./db";
import { filterFor, parseFilter } from "./filter";
import { CONNECTORS, EXTRACT_VERSION, reextract, type SourceRow } from "./connectors";
import { FOLLOW_DAYS } from "./follow";
import { pool } from "./connectors/util";
import type { RawItem } from "./connectors/util";
import { tagPending, tagsOf } from "./tag";

const STOP = new Set(("der die das und ist nicht mit sich auf für dem den des ein eine einer eines im in zu von bei auch wird werden wurde nach aus wie noch mehr am vom zum zur über unter so es sie er wir ihr was wer neue neuer neues jetzt heute ab bis " +
  "the a an and or of to in on for with is are was be by at from as it its this that how why what new show hn ask your you i my our we they").split(" "));
export function keysOf(title: string, tags: { people?: string[]; orgs?: string[]; places?: string[] }) {
  const words = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const k = new Set(words.filter(w => !STOP.has(w)).map(w => w.replace(/(en|er|es|s)$/, "")));
  // people and organisations identify an event; places alone do not (half of merkur is "München")
  for (const n of [...(tags.people ?? []), ...(tags.orgs ?? [])]) k.add("@" + n.toLowerCase());
  return [...k];
}

export function insertItems(src: SourceRow, raws: RawItem[]): number[] {
  const ins = db.query(`INSERT INTO items (owner_id, source_id, ext_id, url, title, author, lang, summary, body, meta, published_at, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, ext_id) DO NOTHING RETURNING id`);
  const ids: number[] = [];
  db.transaction(() => {
    for (const r of raws) {
      const row = ins.get(src.owner_id, src.id, r.ext_id, r.url, r.title.slice(0, 400), r.author ?? null, r.lang ?? null, r.summary ?? null, r.body ?? null,
        JSON.stringify(r.meta ?? {}), Math.min(r.published_at, now()), now()) as { id: number } | null;
      if (row) ids.push(row.id);
    }
  })();
  return ids;
}

export function clusterPending(owner: number) {
  const items = db.query("SELECT id, title, tags, published_at FROM items WHERE owner_id = ? AND story_id IS NULL AND tagged = 1 ORDER BY published_at").all(owner) as any[];
  if (!items.length) return 0;
  // followed stories stay open for new reports however old they are (up to a month), the rest for 72 hours
  const recent = db.query(`SELECT id, keys FROM stories WHERE owner_id = ? AND (last_at > ? OR id IN (SELECT story_id FROM follows WHERE owner_id = ? AND at > ?)) AND id NOT IN (${AGENT_STORIES})`)
    .all(owner, now() - 72 * 3600_000, owner, now() - FOLLOW_DAYS * 86400_000) as { id: number; keys: string }[];
  const followed = new Set((db.query("SELECT story_id FROM follows WHERE owner_id = ?").all(owner) as { story_id: number }[]).map(r => r.story_id));
  const pool = recent.map(s => ({ id: s.id, keys: new Set(json<string[]>(s.keys, [])) }));
  const mkStory = db.query("INSERT INTO stories (owner_id, title, title_en, lang, keys, tags, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id");
  const join = db.query("UPDATE stories SET keys = ?, last_at = max(last_at, ?), item_count = item_count + 1, tags = ? WHERE id = ?");
  const setStory = db.query("UPDATE items SET story_id = ? WHERE id = ?");
  db.transaction(() => {
    for (const it of items) {
      const tags = tagsOf(it.tags);
      const keys = keysOf(tags.title_en || it.title, tags);
      let best: { id: number; keys: Set<string> } | null = null, bestScore = 0;
      const words = keys.filter(k => k[0] !== "@");
      for (const s of pool) {
        let w = 0, ents = 0;
        for (const k of keys) if (s.keys.has(k)) { if (k[0] === "@") ents++; else w++; }
        const sWords = [...s.keys].filter(k => k[0] !== "@").length;
        const sim = w / Math.max(1, Math.min(words.length, sWords));
        // same event: most title words shared, or a shared person/org plus several shared words
        const score = (w >= 3 && sim >= 0.6) || (ents >= 1 && w >= 2 && sim >= 0.4) ? sim + ents * 0.1 : 0;
        if (score > bestScore) { bestScore = score; best = s; }
      }
      if (best) {
        for (const k of keys) best.keys.add(k);
        const st = db.query("SELECT tags FROM stories WHERE id = ?").get(best.id) as { tags: string };
        const merged = mergeTags(json(st.tags, {}), tags);
        join.run(JSON.stringify([...best.keys].slice(0, 80)), it.published_at, JSON.stringify(merged), best.id);
        setStory.run(best.id, it.id);
        // a followed story got news: its "what changed" text is written again
        if (followed.has(best.id)) db.query("DELETE FROM lens_cache WHERE story_id = ? AND lens = 'update'").run(best.id);
      } else {
        const row = mkStory.get(owner, it.title, tags.title_en ?? it.title, tags.lang ?? null, JSON.stringify(keys), JSON.stringify(mergeTags({}, tags)), it.published_at, it.published_at) as { id: number };
        setStory.run(row.id, it.id);
        pool.push({ id: row.id, keys: new Set(keys) });
      }
    }
  })();
  return items.length;
}

export function mergeTags(a: any, b: any) {
  const u = (x: string[] = [], y: string[] = []) => [...new Set([...x, ...y])].slice(0, 8);
  return { topics: u(a.topics, b.topics).slice(0, 4), people: u(a.people, b.people), orgs: u(a.orgs, b.orgs), places: u(a.places, b.places), opinion: !!(a.opinion || b.opinion), lang: a.lang ?? b.lang };
}

const running = new Map<number, Promise<unknown>>();
export type PullEvent = { type: "source"; id: number; name: string; added: number; error?: string } | { type: "tagging"; n: number } | { type: "done"; added: number };

export async function pullSource(src: SourceRow): Promise<{ added: number; error?: string }> {
  const c = CONNECTORS[src.kind];
  if (!c?.pull) return { added: 0 };
  db.query("UPDATE sources SET last_pull_at = ? WHERE id = ?").run(now(), src.id);
  try {
    const res = await c.pull(src, json(src.config, {}), json(src.cursor, {}));
    // the source's keyword filter decides before anything is stored; what it drops is gone for good
    const keep = filterFor(parseFilter((src as SourceRow & { filter?: string }).filter));
    const ids = insertItems(src, res.items.filter(keep));
    if (res.updates?.length) {
      const up = db.query("UPDATE items SET meta = json_patch(meta, ?) WHERE source_id = ? AND ext_id = ?");
      db.transaction(() => { for (const u of res.updates!) up.run(JSON.stringify(u.meta), src.id, u.ext_id); })();
    }
    db.query("UPDATE sources SET cursor = ?, last_ok_at = ?, last_error = NULL WHERE id = ?").run(JSON.stringify(res.cursor), now(), src.id);
    return { added: ids.length };
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    db.query("UPDATE sources SET last_error = ? WHERE id = ?").run(msg, src.id);
    return { added: 0, error: msg };
  }
}

/** Whether a source should be pulled now. A newsletter that has not received any mail yet is checked every two
 *  minutes instead of its cadence: right after you subscribe, its confirmation mail should show up while you wait. */
export function isDue(s: { kind: string; cadence_min: number; last_pull_at: number | null; cursor: string }, at: number): boolean {
  if (!s.last_pull_at) return true;
  const waiting = s.kind === "mail" && !json<{ since?: number }>(s.cursor, {}).since;
  return at - s.last_pull_at >= (waiting ? 2 : s.cadence_min) * 60_000;
}

export async function harvest(owner: number, { force = false, onEvent = (_: PullEvent) => {} } = {}) {
  const existing = running.get(owner);
  if (existing) { await existing; return { added: 0, joined: true }; }
  const p = (async () => {
    const sources = db.query("SELECT * FROM sources WHERE owner_id = ? AND enabled = 1").all(owner) as (SourceRow & { last_pull_at: number | null })[];
    const due = sources.filter(s => CONNECTORS[s.kind]?.pull && (force || isDue(s, now())));
    let added = 0;
    await Promise.all(due.map(async s => { const r = await pullSource(s); added += r.added; onEvent({ type: "source", id: s.id, name: s.name, added: r.added, error: r.error }); }));
    const pending = (db.query("SELECT count(*) AS n FROM items WHERE owner_id = ? AND tagged = 0").get(owner) as { n: number }).n;
    if (pending) onEvent({ type: "tagging", n: pending });
    await tagPending();
    clusterPending(owner);
    onEvent({ type: "done", added });
    return { added };
  })();
  running.set(owner, p);
  try { return await p; } finally { running.delete(owner); }
}

/** Articles stored by an older extractor are read again from their pages, newest first and a few per run: what is on
 *  Today and the reading list comes first, the last week after that. Each item is tried once per extractor version. */
export async function refreshBodies(owner: number, limit = 24) {
  const rows = db.query(`SELECT i.id, i.url, i.body, i.meta, s.kind FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.owner_id = ? AND s.kind IN ('merkur', 'hackernews', 'feed') AND i.url LIKE 'https://%' AND i.body IS NOT NULL
      AND coalesce(json_extract(i.meta, '$.ev'), 0) < ? AND i.published_at > ?
    ORDER BY (i.story_id IN (SELECT ei.story_id FROM edition_items ei JOIN editions e ON e.id = ei.edition_id WHERE e.owner_id = ? AND e.updated_at > ?)
      OR i.story_id IN (SELECT story_id FROM pins WHERE owner_id = ?)) DESC, i.published_at DESC LIMIT ?`)
    .all(owner, EXTRACT_VERSION, now() - 7 * 86400_000, owner, now() - 3 * 86400_000, owner, limit) as { id: number; url: string; body: string; meta: string; kind: string }[];
  let changed = 0;
  await pool(rows, 4, async r => {
    const meta = json<any>(r.meta, {});
    let body = r.body;
    try {
      const x = await reextract(r.kind, r.url);
      // keep the old text when the page now yields much less (paywall, error page, a redesign)
      if (x.text && x.text.replace(/[#*>-]/g, "").length >= r.body.length * 0.6) { body = x.text; changed++; }
      if (!meta.image && x.image) meta.image = x.image;
      if (!meta.credit && x.credit) meta.credit = x.credit;
      if (x.figures.length) meta.figures = x.figures;
    } catch {}
    meta.ev = EXTRACT_VERSION;
    db.query("UPDATE items SET body = ?, meta = ? WHERE id = ?").run(body, JSON.stringify(meta), r.id);
  });
  return { checked: rows.length, changed };
}

/** A story made by hand (a dossier, a probe) takes its tags and keys from its items once they are tagged. */
export function refreshStory(storyId: number) {
  const items = db.query("SELECT title, tags, published_at FROM items WHERE story_id = ?").all(storyId) as { title: string; tags: string; published_at: number }[];
  if (!items.length) return;
  let tags: any = {}; const keys = new Set<string>();
  for (const it of items) { const t = tagsOf(it.tags); tags = mergeTags(tags, t); for (const k of keysOf(t.title_en || it.title, t)) keys.add(k); }
  db.query("UPDATE stories SET tags = ?, keys = ?, lang = coalesce(?, lang), item_count = ?, first_at = min(first_at, ?), last_at = max(last_at, ?) WHERE id = ?")
    .run(JSON.stringify(tags), JSON.stringify([...keys].slice(0, 80)), tags.lang ?? null, items.length, Math.min(...items.map(i => i.published_at)), Math.max(...items.map(i => i.published_at)), storyId);
}
