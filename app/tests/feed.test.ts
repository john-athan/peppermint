// Today does not end with the edition: the feed route keeps serving stories the palate rates as interesting, and
// leaves out what was seen, dismissed (unless undone) or saved, what is already shown, and what a never rule blocks.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_LLM = "off";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const auth = await import("../server/auth");
const { server } = await import("../server/main");
const BASE = `http://localhost:${server.port}`;
const O = 801;
let cookie = "";
const ids: Record<string, number> = {};
const call = (method: string, path: string, json?: unknown) => fetch(BASE + path, { method, headers: { cookie, origin: "http://localhost:4317", "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
const feed = async (shown: number[] = []) => (await (await call("POST", "/api/feed", { shown })).json()) as { cards: { id: number }[]; more: boolean };

beforeAll(async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'me', ?)").run(O, now());
  const src = (db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (801, ?, 'feed', 'blog', ?) RETURNING id").get(O, now()) as any).id;
  const mk = (name: string, topic: string, ageH: number) => {
    const t = now() - ageH * 3600_000;
    const id = (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at) VALUES (?, ?, '[]', ?, ?, ?) RETURNING id").get(O, name, JSON.stringify({ topics: [topic] }), t, t) as any).id;
    db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, tagged, story_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)").run(O, src, name, name, t, t, id);
    ids[name] = id;
  };
  // "always" makes the topic clear any threshold, so the test does not depend on palate weights
  db.query("INSERT INTO rules (owner_id, action, kind, value, created_at) VALUES (?, 'always', 'topic', 'Rust', ?), (?, 'never', 'topic', 'Crypto', ?)").run(O, now(), O, now());
  for (const n of ["a", "b", "seen", "hidden", "undone", "saved"]) mk(n, "Rust", 30);
  mk("crypto", "Crypto", 30); mk("old", "Rust", 24 * 9);
  cookie = `__Host-peppermint=${await auth.createSession(O)}`;
  db.query("INSERT INTO signals (owner_id, story_id, kind, value, at) VALUES (?, ?, 'seen', 0, ?), (?, ?, 'hide', 0, ?), (?, ?, 'hide', 0, ?), (?, ?, 'unhide', 0, ?)").run(O, ids.seen, now(), O, ids.hidden, now(), O, ids.undone, now() - 1000, O, ids.undone, now());
  db.query("INSERT INTO pins (owner_id, story_id, at) VALUES (?, ?, ?)").run(O, ids.saved, now());
});

test("after the edition the feed serves the stories the palate keeps, and nothing seen, dismissed, saved, blocked or older than a week", async () => {
  const r = await feed();
  expect(r.cards.map(c => c.id).sort()).toEqual([ids.a, ids.b, ids.undone].sort());
});

test("what the client already shows is not served again, and an empty page says there is no more", async () => {
  const r = await feed([ids.a, ids.b, ids.undone]);
  expect(r.cards).toEqual([]);
  expect(r.more).toBe(false);
});

test("a feed is a feed with a stylesheet line before it (EUR-Lex's feeds start with one)", async () => {
  const { isFeed } = await import("../server/connectors/index");
  expect(isFeed(`<?xml version="1.0" encoding="UTF-8"?>\n<?xml-stylesheet type="text/xsl" media="screen" href="./../screen-rss.xsl"?>\n<rss version="2.0"><channel></channel></rss>`)).toBe(true);
  expect(isFeed(`<?xml version="1.0"?><!-- c --><feed xmlns="http://www.w3.org/2005/Atom"></feed>`)).toBe(true);
  expect(isFeed(`<!doctype html><html><body>rss</body></html>`)).toBe(false);
});
