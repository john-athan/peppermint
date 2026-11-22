// Today's reading signals: viewed cards leave the next load, pins lead across harvests, a dismiss can be undone,
// reading time counts, and the history is one account's own.
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

let me = "", other = "";
const ids: number[] = [];
const call = (cookie: string, method: string, path: string, json?: unknown) =>
  fetch(BASE + path, { method, headers: { cookie: `__Host-peppermint=${cookie}`, origin: "http://localhost:4317", "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
const signal = (kind: string, story_id: number, extra: object = {}) => call(me, "POST", "/api/signals", { kind, story_id, ...extra });
const cards = async () => ((await (await call(me, "GET", "/api/edition")).json()).edition.cards as any[]).map(c => c.id);

beforeAll(async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (301, 'me', ?), (302, 'other', ?)").run(now(), now());
  const src = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (301, 'merkur', 'merkur.de', ?) RETURNING id").get(now()) as any).id;
  const ed = (db.query("INSERT INTO editions (owner_id, day, slot, created_at, updated_at) VALUES (301, '2026-11-18', 'morning', ?, ?) RETURNING id").get(now(), now()) as any).id;
  for (let i = 0; i < 4; i++) {
    const st = (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at) VALUES (301, ?, '[]', '{\"topics\":[\"Transport\"]}', ?, ?) RETURNING id").get(`Story ${i}`, now(), now()) as any).id;
    db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, tagged, story_id) VALUES (301, ?, ?, ?, ?, ?, 1, ?)").run(src, `x${i}`, `Story ${i}`, now(), now(), st);
    db.query("INSERT INTO edition_items (edition_id, story_id, rank, score, reasons, added_at) VALUES (?, ?, ?, ?, '[]', ?)").run(ed, st, i, 0.9 - i / 10, now());
    ids.push(st);
  }
  me = await auth.createSession(301); other = await auth.createSession(302);
});

test("a card scrolled past is gone on the next load, and counted as viewed", async () => {
  expect(await cards()).toEqual(ids);
  await signal("seen", ids[0], { ms: 4200 });
  await signal("seen", ids[0], { ms: 100 }); // counted once
  const r = await (await call(me, "GET", "/api/edition")).json();
  expect(r.edition.cards.map((c: any) => c.id)).toEqual(ids.slice(1));
  expect(r.edition.viewed).toBe(1);
  expect(db.query("SELECT count(*) AS n FROM signals WHERE owner_id = 301 AND kind = 'seen'").get()).toEqual({ n: 1 });
});

test("a saved story leaves Today for the reading list, and comes back when unsaved", async () => {
  await signal("pin", ids[0]); await signal("pin", ids[3]);
  expect(await cards()).toEqual([ids[1], ids[2]]);
  const list = await (await call(me, "GET", "/api/list")).json();
  expect(list.cards.map((c: any) => c.id)).toEqual([ids[3], ids[0]]);
  expect(list.cards.every((c: any) => c.pinned)).toBe(true);
  expect((await (await call(other, "GET", "/api/list")).json()).cards).toEqual([]);
  await signal("unpin", ids[3]);
  expect(await cards()).toEqual([ids[1], ids[2], ids[3]]);
});

test("dismiss removes the card and undo brings it back", async () => {
  await signal("hide", ids[2]);
  expect(await cards()).not.toContain(ids[2]);
  await signal("unhide", ids[2]);
  expect(await cards()).toContain(ids[2]);
});

test("reading time is recorded and moves the palate only once it is real reading", async () => {
  await signal("dwell", ids[1], { ms: 5000 });
  await signal("dwell", ids[1], { ms: 120_000 });
  const rows = db.query("SELECT value, meta FROM signals WHERE owner_id = 301 AND kind = 'dwell' ORDER BY id").all() as any[];
  expect(rows.map(r => r.value > 0)).toEqual([false, true]);
  const h = await (await call(me, "GET", "/api/history")).json();
  expect(h.items.find((x: any) => x.story_id === ids[1]).read_ms).toBe(125_000);
  expect(h.items.find((x: any) => x.story_id === ids[0]).seen).toBe(true);
});

test("history is per account: another account sees none of it and cannot signal on these stories", async () => {
  const h = await (await call(other, "GET", "/api/history")).json();
  expect(h.items).toEqual([]);
  expect((await call(other, "POST", "/api/signals", { kind: "pin", story_id: ids[1] })).status).toBe(404);
  expect(await (await call(other, "GET", "/api/history/export")).text()).not.toContain("Story");
});

test("clearing history deletes the signals and nothing else", async () => {
  const before = db.query("SELECT count(*) AS n FROM affinities WHERE owner_id = 301").get();
  const r = await (await call(me, "DELETE", "/api/history")).json();
  expect(r.deleted).toBeGreaterThan(0);
  expect(db.query("SELECT count(*) AS n FROM signals WHERE owner_id = 301").get()).toEqual({ n: 0 });
  expect(db.query("SELECT count(*) AS n FROM affinities WHERE owner_id = 301").get()).toEqual(before);
});
