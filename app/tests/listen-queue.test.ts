// The phone's queue: saved episodes first, then what the podcasts you follow published in the last two weeks, newest
// first, without what you have heard; a paused podcast and an article feed offer nothing.
process.env.PEPPERMINT_DB = ":memory:";
import { expect, test } from "bun:test";
const { db } = await import("../server/db");
const { queue, markHeard, oneEpisode, FRESH_DAYS } = await import("../server/listen-routes");

const DAY = 86_400_000, T = Date.now();
const owner = (db.query("INSERT INTO users (name, created_at) VALUES ('Reader', ?) RETURNING id").get(T) as { id: number }).id;
const source = (kind: string, name: string, enabled = 1) =>
  (db.query("INSERT INTO sources (owner_id, kind, name, enabled, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id").get(owner, kind, name, enabled, T) as { id: number }).id;
let n = 0;
const item = (src: number, title: string, ageDays: number, audio: string | null, story: number | null = null) =>
  (db.query("INSERT INTO items (owner_id, source_id, ext_id, title, meta, published_at, fetched_at, story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .get(owner, src, `x${n++}`, title, JSON.stringify(audio ? { audio, duration: 600 } : {}), T - ageDays * DAY, T, story) as { id: number }).id;

const pod = source("podcast", "Doppelgänger"), paused = source("podcast", "Old show", 0), feed = source("feed", "Blog");
const fresh = item(pod, "Fresh", 1, "https://a/1.mp3"), older = item(pod, "Older", 5, "https://a/2.mp3");
item(pod, "Too old", FRESH_DAYS + 1, "https://a/3.mp3"); item(paused, "Paused", 1, "https://b/1.mp3"); item(feed, "Article", 1, null);
const story = (db.query("INSERT INTO stories (owner_id, title, first_at, last_at) VALUES (?, 'Saved', ?, ?) RETURNING id").get(owner, T, T) as { id: number }).id;
const saved = item(paused, "Saved long ago", 60, "https://b/2.mp3", story);
db.query("INSERT INTO pins (owner_id, story_id, at) VALUES (?, ?, ?)").run(owner, story, T);

test("saved first, then fresh episodes of followed podcasts, newest first", () => {
  expect(queue(owner).map(e => e.title)).toEqual(["Saved long ago", "Fresh", "Older"]);
  expect(queue(owner)[0]).toMatchObject({ id: saved, show: "Old show", audio: "https://b/2.mp3", duration: 600, saved: true });
});

test("a heard episode leaves the queue, and can come back", () => {
  markHeard(owner, fresh);
  expect(queue(owner).map(e => e.id)).toEqual([saved, older]);
  markHeard(owner, fresh, false);
  expect(queue(owner).map(e => e.id)).toEqual([saved, fresh, older]);
});

test("one episode is found only when it is yours and has audio", () => {
  expect(oneEpisode(owner, older)?.title).toBe("Older");
  expect(oneEpisode(owner + 1, older)).toBeNull();
  expect(oneEpisode(owner, 999_999)).toBeNull();
});
