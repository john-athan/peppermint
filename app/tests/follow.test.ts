// Following a story: saving follows it, a report that arrives days later still joins it (clustering keeps followed
// stories open), Today leads with an update card until you look, and nobody else can follow your stories.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_LLM = "off";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const auth = await import("../server/auth");
const { server } = await import("../server/main");
const { clusterPending, keysOf } = await import("../server/pipeline");
const BASE = `http://localhost:${server.port}`;
const O = 1001, OTHER = 1002;
let me = "", other = "", story = 0, src = 0, ed = 0;
const call = (who: string, method: string, path: string, json?: unknown) => fetch(BASE + path, { method, headers: { cookie: `__Host-peppermint=${who}`, origin: "http://localhost:4317", "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
const tags = (title: string) => JSON.stringify({ lang: "en", title_en: title, summary_en: "", topics: ["Transport"], people: [], orgs: ["Deutsche Bahn"], places: ["München"], atoms: [], opinion: false });

beforeAll(async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'me', ?), (?, 'other', ?)").run(O, now(), OTHER, now());
  src = (db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (1001, ?, 'feed', 'merkur', ?) RETURNING id").get(O, now()) as any).id;
  // a story from five days ago: outside the usual 72 hours of clustering
  const old = now() - 5 * 86400_000;
  story = (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at) VALUES (?, 'S-Bahn Stammstrecke closed for repairs', ?, ?, ?, ?) RETURNING id")
    .get(O, JSON.stringify(keysOf("S-Bahn Stammstrecke closed for repairs", JSON.parse(tags("x")))), tags("x"), old, old) as any).id;
  db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, tagged, story_id, tags) VALUES (?, ?, 'a', 'S-Bahn Stammstrecke closed for repairs', ?, ?, 1, ?, ?)").run(O, src, old, old, story, tags("S-Bahn Stammstrecke closed for repairs"));
  ed = (db.query("INSERT INTO editions (owner_id, day, slot, created_at, updated_at) VALUES (?, '2026-11-19', 'morning', ?, ?) RETURNING id").get(O, now(), now()) as any).id;
  me = await auth.createSession(O); other = await auth.createSession(OTHER);
});

test("saving follows a story; un-saving ends that follow but not one you chose yourself", async () => {
  await call(me, "POST", "/api/signals", { kind: "pin", story_id: story });
  expect((await (await call(me, "GET", `/api/stories/${story}`)).json()).following).toBe(true);
  await call(me, "POST", "/api/signals", { kind: "unpin", story_id: story });
  expect((await (await call(me, "GET", `/api/stories/${story}`)).json()).following).toBe(false);
  await call(me, "POST", "/api/follow", { story_id: story, on: true });
  await call(me, "POST", "/api/signals", { kind: "pin", story_id: story });
  await call(me, "POST", "/api/signals", { kind: "unpin", story_id: story });
  expect((await (await call(me, "GET", `/api/stories/${story}`)).json()).following).toBe(true);
});

test("a new report days later joins the followed story and leads Today until you look", async () => {
  // you last looked a minute ago (so a report from now is new, even within the same millisecond)
  db.query("UPDATE follows SET seen_at = ? WHERE story_id = ?").run(now() - 60_000, story);
  db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, tagged, tags) VALUES (?, ?, 'b', 'S-Bahn Stammstrecke reopens after repairs', ?, ?, 1, ?)")
    .run(O, src, now(), now(), tags("S-Bahn Stammstrecke reopens after repairs"));
  clusterPending(O);
  expect((db.query("SELECT story_id FROM items WHERE ext_id = 'b'").get() as any).story_id).toBe(story);
  const e = await (await call(me, "GET", "/api/edition")).json();
  expect(e.updates.map((u: any) => u.id)).toEqual([story]);
  expect(e.updates[0].update).toMatchObject({ count: 1, reports: [{ title: "S-Bahn Stammstrecke reopens after repairs" }] });
  const s = await (await call(me, "GET", `/api/stories/${story}`)).json();
  expect(s.newReports).toEqual(["S-Bahn Stammstrecke reopens after repairs"]);
  await call(me, "POST", "/api/follow/seen", { story_id: story });
  expect((await (await call(me, "GET", "/api/edition")).json()).updates).toEqual([]);
});

test("the list shows what you follow; nobody else can follow your stories", async () => {
  const l = await (await call(me, "GET", "/api/list")).json();
  expect(l.following.map((f: any) => f.id)).toEqual([story]);
  expect((await call(other, "POST", "/api/follow", { story_id: story, on: true })).status).toBe(404);
  expect((await (await call(other, "GET", "/api/list")).json()).following).toEqual([]);
});
