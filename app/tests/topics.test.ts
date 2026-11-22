// A reader's own topics: added with +1, marked at once on the last week's stories that mention them, used by the local
// tagger and offered to Claude, taken off everything again when removed. Built-in topics only get their weight.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PEPPERMINT_LLM = "off";
import { expect, test } from "bun:test";
const { db, now } = await import("../server/db");
const { addTopic, ownTopics, removeTopic, topicsFor, TopicError, MAX_OWN } = await import("../server/topics");
const { tagLocally } = await import("../server/tag");
const { validTags, TOPICS } = await import("../server/llm");

const O = 1701, OTHER = 1702;
db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'p', ?), (?, 'q', ?)").run(O, now(), OTHER, now());
const src = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (?, 'feed', 'f', ?) RETURNING id").get(O, now()) as any).id;
function story(owner: number, title: string, body: string, ago = 3600_000) {
  const st = (db.query("INSERT INTO stories (owner_id, title, title_en, keys, tags, first_at, last_at) VALUES (?, ?, ?, '[]', '{\"topics\":[\"Law\"]}', ?, ?) RETURNING id").get(owner, title, title, now() - ago, now() - ago) as any).id;
  db.query("INSERT INTO items (owner_id, source_id, ext_id, url, title, body, published_at, fetched_at, tagged, story_id, tags, meta) VALUES (?, ?, ?, 'https://x', ?, ?, ?, ?, 1, ?, '{\"topics\":[\"Law\"]}', '{}')")
    .run(owner, src, `e${st}`, title, body, now() - ago, now(), st);
  return st as number;
}
const topicsOf = (id: number) => JSON.parse((db.query("SELECT tags FROM stories WHERE id = ?").get(id) as any).tags).topics;
const weight = (owner: number, name: string) => (db.query("SELECT weight FROM affinities WHERE owner_id = ? AND kind = 'topic' AND name = ?").get(owner, name) as any)?.weight ?? null;

test("adding a topic: +1 on the palate, marked on last week's stories that mention it, nobody else's", () => {
  const hit = story(O, "ECHA adds two substances to the SVHC list", "The REACH Candidate List grows.");
  const miss = story(O, "Weather in Munich", "Rain, then sun. Reached 12 degrees.");
  const old = story(O, "REACH review from last month", "REACH again", 20 * 86400_000);
  const theirs = story(OTHER, "REACH restriction proposal", "REACH");
  const r = addTopic(O, "  REACH ");
  expect(r).toEqual({ name: "REACH", builtin: false, marked: 1 });
  expect(ownTopics(O)).toEqual(["REACH"]);
  expect(weight(O, "REACH")).toBe(1);
  expect(topicsOf(hit)).toEqual(["REACH", "Law"]);
  expect(topicsOf(miss)).toEqual(["Law"]);   // "Reached" is not REACH
  expect(topicsOf(old)).toEqual(["Law"]);    // older than a week
  expect(topicsOf(theirs)).toEqual(["Law"]); // another reader's story
  expect(topicsFor(O)).toEqual([...TOPICS, "REACH"]);
  expect(topicsFor(OTHER)).toEqual([...TOPICS]);
});

test("a built-in topic is not added twice, only weighted; a weight you set stays; duplicates and junk are refused", () => {
  expect(addTopic(O, "climate")).toEqual({ name: "Climate", builtin: true, marked: 0 });
  expect(ownTopics(O)).toEqual(["REACH"]);
  db.query("UPDATE affinities SET weight = 3 WHERE owner_id = ? AND name = 'REACH'").run(O);
  expect(addTopic(O, "reach").name).toBe("REACH");
  expect(weight(O, "REACH")).toBe(3);
  expect(() => addTopic(O, "!")).toThrow(TopicError);
  for (let i = ownTopics(O).length; i < MAX_OWN; i++) addTopic(O, `Topic ${i}`);
  expect(() => addTopic(O, "One too many")).toThrow(/Remove one first/);
  for (let i = 1; i < MAX_OWN; i++) removeTopic(O, `Topic ${i}`);
  expect(ownTopics(O)).toEqual(["REACH"]);
});

test("the local tagger puts the reader's own topics first; the tag check accepts them only for that reader", () => {
  const t = tagLocally({ title: "New PFAS restriction in the EU", body: "The restriction covers firefighting foams. PFAS are persistent." }, ["PFAS", "Packaging"]);
  expect(t.topics[0]).toBe("PFAS");
  expect(t.topics).not.toContain("Packaging");
  const tags = { lang: "en", title_en: "x", summary_en: "x", topics: ["PFAS"], people: [], orgs: [], places: [], atoms: [], opinion: false };
  expect(validTags(tags)).toBe(false);
  expect(validTags(tags, new Set([...TOPICS, "PFAS"]))).toBe(true);
});

test("removing a topic takes it off the list, the palate and every story and item", () => {
  const st = story(O, "REACH annex update", "REACH");
  addTopic(O, "REACH");
  expect(topicsOf(st)).toContain("REACH");
  removeTopic(O, "reach");
  expect(ownTopics(O)).toEqual([]);
  expect(weight(O, "REACH")).toBeNull();
  expect(topicsOf(st)).toEqual(["Law"]);
  expect((db.query("SELECT count(*) AS n FROM items WHERE owner_id = ? AND tags LIKE '%REACH%'").get(O) as any).n).toBe(0);
  expect(() => removeTopic(O, "REACH")).toThrow(/not one of your own/);
});
