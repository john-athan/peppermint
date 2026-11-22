// Following a story: peppermint keeps collecting reports for it (clustering keeps it in the pool however old it is),
// and when new ones arrive, Today leads with an update card that says what changed since you last looked.
// Saving a story to the reading list follows it too; removing it from the list stops that follow again.
import { db, json, now } from "./db";

export const FOLLOW_DAYS = 30; // a followed story keeps collecting reports this long after its last one

export function follow(owner: number, storyId: number, via: "follow" | "save" = "follow") {
  // a follow you chose stays chosen; saving only adds one when there is none
  db.query(`INSERT INTO follows (owner_id, story_id, via, at, seen_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, story_id) DO UPDATE SET via = CASE WHEN excluded.via = 'follow' THEN 'follow' ELSE follows.via END`).run(owner, storyId, via, now(), now());
}
export function unfollow(owner: number, storyId: number, via: "follow" | "save" = "follow") {
  // un-saving ends only a follow that saving started
  if (via === "save") db.query("DELETE FROM follows WHERE owner_id = ? AND story_id = ? AND via = 'save'").run(owner, storyId);
  else db.query("DELETE FROM follows WHERE owner_id = ? AND story_id = ?").run(owner, storyId);
}
export const isFollowing = (owner: number, storyId: number) => !!db.query("SELECT 1 FROM follows WHERE owner_id = ? AND story_id = ?").get(owner, storyId);

/** You looked at the story: what is there now counts as seen. */
export function markSeen(owner: number, storyId: number) {
  db.query("UPDATE follows SET seen_at = ? WHERE owner_id = ? AND story_id = ?").run(now(), owner, storyId);
}

/** Stories that clustering keeps open for new reports beyond its usual 72 hours. */
export function followedOpen(owner: number): number[] {
  return (db.query(`SELECT f.story_id FROM follows f JOIN stories s ON s.id = f.story_id WHERE f.owner_id = ? AND s.last_at > ?`)
    .all(owner, now() - FOLLOW_DAYS * 86400_000) as { story_id: number }[]).map(r => r.story_id);
}

export type NewReport = { title: string; source: string; kind: string; at: number; url: string | null };
/** Reports of a followed story that arrived after you last looked. */
export function newSince(owner: number, storyId: number): NewReport[] {
  const f = db.query("SELECT seen_at FROM follows WHERE owner_id = ? AND story_id = ?").get(owner, storyId) as { seen_at: number } | null;
  if (!f) return [];
  return db.query(`SELECT i.title, s.name AS source, s.kind, i.fetched_at AS at, i.url FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.story_id = ? AND i.fetched_at > ? ORDER BY i.fetched_at`).all(storyId, f.seen_at) as NewReport[];
}

/** Followed stories with news, newest change first. */
export function updates(owner: number): { storyId: number; reports: NewReport[] }[] {
  const rows = db.query(`SELECT f.story_id, max(i.fetched_at) AS last FROM follows f JOIN items i ON i.story_id = f.story_id
    WHERE f.owner_id = ? AND i.fetched_at > f.seen_at GROUP BY f.story_id ORDER BY last DESC`).all(owner) as { story_id: number }[];
  return rows.map(r => ({ storyId: r.story_id, reports: newSince(owner, r.story_id) }));
}

/** What the update lens is given: the reports you already knew, then the new ones in full. */
export function updateMaterial(owner: number, storyId: number) {
  const f = db.query("SELECT seen_at FROM follows WHERE owner_id = ? AND story_id = ?").get(owner, storyId) as { seen_at: number } | null;
  const since = f?.seen_at ?? 0;
  const items = db.query(`SELECT i.title, i.summary, i.body, i.fetched_at, i.tags, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.story_id = ? ORDER BY i.fetched_at`).all(storyId) as any[];
  const known = items.filter(i => i.fetched_at <= since), fresh = items.filter(i => i.fetched_at > since);
  const facts = (xs: any[]) => xs.flatMap(i => json<any>(i.tags, {}).atoms ?? []).map((a: any) => `- ${a.text}`).slice(0, 10).join("\n");
  return {
    known: known.map(i => `[${i.source}] ${i.title}\n${(i.summary || "").slice(0, 400)}`).join("\n\n") + (facts(known) ? `\nFacts known:\n${facts(known)}` : ""),
    fresh: fresh.map(i => `[${i.source}] ${i.title}\n${(i.body || i.summary || "").slice(0, 3000)}`).join("\n\n---\n\n"),
    count: fresh.length,
  };
}
