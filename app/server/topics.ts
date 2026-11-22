// Your own topics: words or phrases a reader adds to the 35 built-in topics (server/llm.ts TOPICS), like "REACH",
// "PFAS" or "Packaging" on a reader who follows product compliance. They are stored per reader (setting "topics"),
// offered to Claude when it tags that reader's items, matched by whole word when tagging runs locally, and weighted
// on the palate like any other topic.
//
// Adding one also marks it on the reader's stories of the last week that mention it, so the palate and the edition
// use it at once instead of after the next harvest. Removing one takes it off again.
import { db, json, now, setting, setSetting } from "./db";
import { mentions } from "./filter";
import { TOPICS } from "./llm";

export const MAX_OWN = 20;
const BACK_MS = 7 * 86400_000;

export const ownTopics = (owner: number): string[] => (setting<unknown>(owner, "topics", []) as unknown[] ?? []).filter((t): t is string => typeof t === "string");
/** Every topic this reader's items may carry: the built-in ones and their own. */
export const topicsFor = (owner: number): string[] => [...TOPICS, ...ownTopics(owner)];
const builtin = (name: string) => TOPICS.find(t => t.toLowerCase() === name.toLowerCase()) ?? null;

export class TopicError extends Error { constructor(public status: number, message: string) { super(message); } }

/** Adds a topic and gives it +1, or for a built-in topic only the +1. Returns the topic's name as stored. */
export function addTopic(owner: number, raw: unknown): { name: string; builtin: boolean; marked: number } {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (name.replace(/[^\p{L}\p{N}]/gu, "").length < 2) throw new TopicError(400, "A topic needs at least two letters.");
  const known = builtin(name);
  const own = ownTopics(owner);
  const existing = own.find(t => t.toLowerCase() === name.toLowerCase());
  const stored = known ?? existing ?? name;
  if (!known && !existing) {
    if (own.length >= MAX_OWN) throw new TopicError(409, `You have ${MAX_OWN} topics of your own. Remove one first.`);
    setSetting(owner, "topics", [...own, name]);
  }
  // a topic you add is one you want: +1 to start with, unless you already weighted it
  db.query(`INSERT INTO affinities (owner_id, kind, name, weight, manual, updated_at) VALUES (?, 'topic', ?, 1, 1, ?)
    ON CONFLICT(owner_id, kind, name) DO NOTHING`).run(owner, stored, now());
  return { name: stored, builtin: !!known, marked: known ? 0 : markRecent(owner, stored) };
}

/** Takes an own topic away: from the list, the palate and the stories that carry it. */
export function removeTopic(owner: number, raw: unknown) {
  const own = ownTopics(owner), name = own.find(t => t.toLowerCase() === String(raw ?? "").trim().toLowerCase());
  if (!name) throw new TopicError(404, "That is not one of your own topics.");
  setSetting(owner, "topics", own.filter(t => t !== name));
  db.transaction(() => {
    db.query("DELETE FROM affinities WHERE owner_id = ? AND kind = 'topic' AND name = ?").run(owner, name);
    for (const table of ["items", "stories"] as const) {
      const rows = db.query(`SELECT id, tags FROM ${table} WHERE owner_id = ? AND tags LIKE ?`).all(owner, `%${JSON.stringify(name).slice(1, -1)}%`) as { id: number; tags: string }[];
      for (const r of rows) {
        const t = json<any>(r.tags, {});
        if (!Array.isArray(t.topics) || !t.topics.includes(name)) continue;
        t.topics = t.topics.filter((x: string) => x !== name);
        db.query(`UPDATE ${table} SET tags = ? WHERE id = ?`).run(JSON.stringify(t), r.id);
      }
    }
  })();
}

/** Puts a new topic on this reader's items and stories of the last week that mention it. Returns how many stories. */
export function markRecent(owner: number, name: string): number {
  const says = mentions(name);
  const items = db.query("SELECT id, story_id, title, summary, body, tags FROM items WHERE owner_id = ? AND tagged = 1 AND published_at > ?").all(owner, now() - BACK_MS) as
    { id: number; story_id: number | null; title: string; summary: string | null; body: string | null; tags: string }[];
  const stories = new Set<number>();
  db.transaction(() => {
    for (const it of items) {
      if (!says(`${it.title}\n${it.summary ?? ""}\n${(it.body ?? "").slice(0, 20_000)}`)) continue;
      const t = json<any>(it.tags, {});
      t.topics = [...new Set([name, ...(Array.isArray(t.topics) ? t.topics : [])])].slice(0, 4);
      db.query("UPDATE items SET tags = ? WHERE id = ?").run(JSON.stringify(t), it.id);
      if (it.story_id) stories.add(it.story_id);
    }
    for (const id of stories) {
      const st = db.query("SELECT tags FROM stories WHERE id = ? AND owner_id = ?").get(id, owner) as { tags: string } | null;
      if (!st) continue;
      const t = json<any>(st.tags, {});
      t.topics = [...new Set([name, ...(Array.isArray(t.topics) ? t.topics : [])])].slice(0, 4);
      db.query("UPDATE stories SET tags = ? WHERE id = ?").run(JSON.stringify(t), id);
    }
  })();
  return stories.size;
}
