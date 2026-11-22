// Claude's order decides the edition and the feed once it has judged: no topic cap or threshold on top of it, what it
// left out stays out, what it has not read yet waits. Without a judgement (or for a preview) the palate's score decides.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_LLM = "off";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const { buildEdition, currentEditionId, editionPool, feedPage } = await import("../server/palate");
const { saveJudgement } = await import("../server/judge");
const O = 901;
const ids: Record<string, number> = {};
const mk = (name: string, topic = "AI", ageH = 2) => {
  const t = now() - ageH * 3600_000;
  const id = (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at) VALUES (?, ?, '[]', ?, ?, ?) RETURNING id").get(O, name, JSON.stringify({ topics: [topic] }), t, t) as any).id;
  db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, tagged, story_id) VALUES (?, 901, ?, ?, ?, ?, 1, ?)").run(O, name, name, t, t, id);
  ids[name] = id;
};
const edition = (id: number) => db.query("SELECT story_id, reasons FROM edition_items WHERE edition_id = ? ORDER BY rank").all(id) as { story_id: number; reasons: string }[];
const cutReason = (edId: number, story: number) => (db.query("SELECT reason FROM edition_cut WHERE edition_id = ? AND story_id = ?").get(edId, story) as { reason: string } | null)?.reason;

beforeAll(() => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'me', ?)").run(O, now());
  db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (901, ?, 'feed', 'blog', ?)").run(O, now());
  db.query("INSERT INTO affinities (owner_id, kind, name, weight, updated_at) VALUES (?, 'topic', 'AI', 3, ?)").run(O, now());
  for (const n of ["a", "b", "c", "d", "e", "f"]) mk(n);
});

test("an answer without a usable id stores nothing, so it cannot leave every story out", () => {
  expect(saveJudgement(O, editionPool(O).map(s => s.id), [])).toBe(0);
  expect(saveJudgement(O, editionPool(O).map(s => s.id), [123456, "x"])).toBe(0);
  expect((db.query("SELECT count(*) AS n FROM judged").get() as any).n).toBe(0);
});

test("before Claude judged, the palate decides: two stories per topic", () => {
  expect(edition(buildEdition(O).id).length).toBe(2);
});

test("Claude's order makes the edition, without the topic cap; left-out and unread stories are cut with the reason", () => {
  const pool = editionPool(O, currentEditionId(O)).map(s => s.id);
  // unknown ids and repeats are dropped
  expect(saveJudgement(O, pool, [ids.e, ids.d, 999999, ids.c, ids.b, ids.e])).toBe(4);
  mk("late");
  const ed = buildEdition(O).id;
  expect(edition(ed).map(r => r.story_id)).toEqual([ids.e, ids.d, ids.c, ids.b]);
  expect(JSON.parse(edition(ed)[0].reasons)[0].label).toBe("Claude's pick: 1 of 4");
  expect(cutReason(ed, ids.a)).toBe("Claude left it out");
  expect(cutReason(ed, ids.late)).toBe("Claude has not read it yet");
});

test("a preview builds by the palate's score even after Claude judged", () => {
  expect(edition(buildEdition(O, { byScore: true }).id).length).toBe(2);
  buildEdition(O);
});

test("the feed after the edition leaves out what Claude left out and still offers what it has not read yet", () => {
  const shown = new Set([ids.e, ids.d, ids.c, ids.b]);
  expect(feedPage(O, shown).scored.map(s => s.story_id)).toEqual([ids.late]);
});
