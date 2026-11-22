// Every route that takes an id must refuse another owner's row. Two accounts, one server, each route tried across the line.
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
const ORIGIN = "http://localhost:4317";

let mine = "", theirs = "", story = 0, source = 0, rule = 0, edition = 0;
const call = (cookie: string, method: string, path: string, json?: unknown) =>
  fetch(BASE + path, { method, headers: { cookie: `__Host-peppermint=${cookie}`, origin: ORIGIN, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });

beforeAll(async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (101, 'owner', ?), (102, 'other', ?)").run(now(), now());
  source = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (101, 'merkur', 'merkur.de', ?) RETURNING id").get(now()) as any).id;
  story = (db.query("INSERT INTO stories (owner_id, title, title_en, keys, tags, first_at, last_at) VALUES (101, 'Geheim', 'Secret', '[]', '{\"topics\":[\"Transport\"]}', ?, ?) RETURNING id").get(now(), now()) as any).id;
  db.query("INSERT INTO items (owner_id, source_id, ext_id, url, title, body, published_at, fetched_at, tagged, story_id, tags, meta) VALUES (101, ?, 'x', 'https://x', 'Geheim', 'secret body text', ?, ?, 1, ?, '{}', '{}')").run(source, now(), now(), story);
  rule = (db.query("INSERT INTO rules (owner_id, action, kind, value, created_at) VALUES (101, 'never', 'topic', 'Crime', ?) RETURNING id").get(now()) as any).id;
  edition = (db.query("INSERT INTO editions (owner_id, day, slot, created_at, updated_at) VALUES (102, '2026-11-18', 'morning', ?, ?) RETURNING id").get(now(), now()) as any).id;
  mine = await auth.createSession(101);
  theirs = await auth.createSession(102);
});

test("the owner can read their own story (the fixture is valid)", async () => {
  expect((await call(mine, "GET", `/api/stories/${story}`)).status).toBe(200);
});

test("another owner cannot read the story, its original or a lens", async () => {
  for (const p of [`/api/stories/${story}`, `/api/stories/${story}/original`, `/api/stories/${story}/lens/tldr`]) {
    const r = await call(theirs, "GET", p);
    expect(r.status, p).toBe(404);
    expect(await r.text(), p).not.toContain("secret");
  }
});

test("another owner cannot change or delete the source", async () => {
  expect((await call(theirs, "PATCH", `/api/sources/${source}`, { enabled: false })).status).toBe(404);
  await call(theirs, "DELETE", `/api/sources/${source}`);
  expect(db.query("SELECT enabled FROM sources WHERE id = ?").get(source)).toEqual({ enabled: 1 });
  expect((db.query("SELECT count(*) AS n FROM items WHERE source_id = ?").get(source) as any).n).toBe(1);
});

test("another owner cannot delete the rule", async () => {
  await call(theirs, "DELETE", `/api/rules/${rule}`);
  expect(db.query("SELECT id FROM rules WHERE id = ?").get(rule)).toBeTruthy();
});

test("signals on another owner's story are refused and change nothing", async () => {
  for (const kind of ["rescue", "hide", "open", "more"]) {
    const r = await call(theirs, "POST", "/api/signals", { story_id: story, kind });
    expect(r.status, kind).toBe(404);
  }
  expect(db.query("SELECT story_id FROM edition_items WHERE edition_id = ?").all(edition)).toEqual([]);
  expect(db.query("SELECT count(*) AS n FROM signals WHERE owner_id = 102").get()).toEqual({ n: 0 });
});

test("drafts stay with their owner, and citations only point at the owner's stories", async () => {
  const d = await (await call(mine, "POST", "/api/drafts", { story_id: story })).json() as any;
  expect(d.blocks[0].text).toBe("Secret");
  expect((await call(theirs, "POST", "/api/drafts", { story_id: story })).status).toBe(404);
  for (const [m, p] of [["GET", `/api/drafts/${d.id}`], ["PUT", `/api/drafts/${d.id}`], ["GET", `/api/drafts/${d.id}/preview/tldr`], ["GET", `/api/drafts/${d.id}/suggest`]] as const)
    expect((await call(theirs, m, p, m === "PUT" ? { blocks: [] } : undefined)).status, `${m} ${p}`).toBe(404);
  await call(theirs, "DELETE", `/api/drafts/${d.id}`);
  expect((await call(mine, "GET", `/api/drafts/${d.id}`)).status).toBe(200);
  const own = await (await call(theirs, "POST", "/api/drafts", {})).json() as any;
  const saved = await (await call(theirs, "PUT", `/api/drafts/${own.id}`, { blocks: [{ type: "q", text: "x", cite: { story_id: story, source: "s" } }, { type: "script", text: "y" }] })).json() as any;
  expect(saved.blocks).toHaveLength(1);
  expect(saved.blocks[0].cite).toBeUndefined();
  expect(JSON.stringify(await (await call(theirs, "GET", "/api/atoms?q=Geheim")).json())).not.toContain("Secret");
});

test("a stale save reports a conflict instead of overwriting", async () => {
  const d = await (await call(mine, "POST", "/api/drafts", {})).json() as any;
  const a = await call(mine, "PUT", `/api/drafts/${d.id}`, { base: d.updated_at, blocks: [{ type: "p", text: "first" }] });
  expect(a.status).toBe(200);
  const b = await call(mine, "PUT", `/api/drafts/${d.id}`, { base: d.updated_at, blocks: [{ type: "p", text: "stale" }] });
  expect(b.status).toBe(409);
  expect(((await b.json()) as any).draft.blocks[0].text).toBe("first");
});

test("lists only show the caller's rows", async () => {
  const s = await (await call(theirs, "GET", "/api/sources")).json() as any;
  expect(s.sources).toEqual([]);
  const p = await (await call(theirs, "GET", "/api/palate")).json() as any;
  expect(p.rules).toEqual([]);
  expect(JSON.stringify(p)).not.toContain("Secret");
});

test("unauthenticated and cross-site requests are refused", async () => {
  expect((await fetch(BASE + "/api/sources")).status).toBe(401);
  const r = await fetch(BASE + "/api/rules", { method: "POST", headers: { cookie: `__Host-peppermint=${mine}`, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
  expect(r.status).toBe(403);
});

test("the agent's tasks, proposals, asks and search stay with their owner", async () => {
  const task = (db.query("INSERT INTO tasks (owner_id, kind, input, title, status, result, story_id, created_at, updated_at) VALUES (101, 'dossier', 'q', 'Secret dossier', 'done', '{}', ?, ?, ?) RETURNING id").get(story, now(), now()) as any).id;
  const prop = (db.query("INSERT INTO proposals (owner_id, origin, said, changes, created_at) VALUES (101, 'inference', 'x', '[{\"type\":\"weight\",\"kind\":\"topic\",\"name\":\"AI\",\"weight\":2}]', ?) RETURNING id").get(now()) as any).id;
  db.query("INSERT INTO asks (owner_id, story_id, q, lang, answer, created_at) VALUES (101, ?, 'why', 'en', 'Secret answer', ?)").run(story, now());
  expect((await call(mine, "GET", `/api/agent/tasks/${task}`)).status).toBe(200);
  for (const [m, p] of [["GET", `/api/agent/tasks/${task}`], ["POST", `/api/agent/tasks/${task}/steer`], ["POST", `/api/agent/tasks/${task}/follow`], ["POST", `/api/agent/tasks/${task}/dismiss`],
    ["POST", `/api/agent/tasks/${task}/react`], ["POST", `/api/agent/tasks/${task}/draft`], ["POST", `/api/agent/proposals/${prop}/apply`], ["POST", `/api/agent/proposals/${prop}/dismiss`],
    ["POST", `/api/agent/proposals/${prop}/undo`], ["GET", `/api/stories/${story}/asks`], ["GET", `/api/stories/${story}/ask?q=why`]]) {
    const r = await call(theirs, m, p, m === "POST" ? { text: "more", on: true } : undefined);
    expect(r.status, p).toBe(404);
    expect(await r.text(), p).not.toContain("Secret");
  }
  expect(db.query("SELECT status FROM tasks WHERE id = ?").get(task)).toEqual({ status: "done" });
  expect(db.query("SELECT status FROM proposals WHERE id = ?").get(prop)).toEqual({ status: "open" });
  expect(JSON.stringify(await (await call(theirs, "GET", "/api/agent")).json())).not.toContain("Secret");
  expect(((await (await call(theirs, "GET", "/api/search?q=geheim")).json()) as any).cards).toEqual([]);
  expect(((await (await call(mine, "GET", "/api/search?q=geheim")).json()) as any).cards.map((c: any) => c.id)).toEqual([story]);
  const r = await call(theirs, "POST", "/api/agent", { input: "what is this", scope: { kind: "story", story_id: story } });
  expect(r.status).toBe(404);
});

// removing a source takes the stories only it reported with it; a story another source also reported stays
test("removing a source removes its stories and recounts shared ones", async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (951, 'reader', ?)").run(now());
  const src = (k: string) => (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (951, ?, ?, ?) RETURNING id").get(k, k, now()) as any).id as number;
  const gone = src("hackernews"), kept = src("merkur");
  const story = (t: string, n: number) => (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at, item_count) VALUES (951, ?, '[]', '{}', ?, ?, ?) RETURNING id").get(t, now(), now(), n) as any).id as number;
  const only = story("Only on HN", 1), shared = story("On both", 2);
  const item = (s: number, st: number, ext: string) => db.query("INSERT INTO items (owner_id, source_id, ext_id, url, title, published_at, fetched_at, story_id, tags, meta) VALUES (951, ?, ?, 'https://x', 't', ?, ?, ?, '{}', '{}')").run(s, ext, now(), now(), st);
  item(gone, only, "a"); item(gone, shared, "b"); item(kept, shared, "c");
  const ed = (db.query("INSERT INTO editions (owner_id, day, slot, created_at, updated_at) VALUES (951, '2026-11-19', 'evening', ?, ?) RETURNING id").get(now(), now()) as any).id;
  db.query("INSERT INTO edition_items (edition_id, story_id, rank, score, reasons, added_at) VALUES (?, ?, 0, 1, '[]', ?)").run(ed, only, now());
  const cookie = await auth.createSession(951);
  const r = await fetch(`${BASE}/api/sources/${gone}`, { method: "DELETE", headers: { cookie: `__Host-peppermint=${cookie}`, origin: "http://localhost:4317" } });
  expect(r.status).toBe(200);
  expect(db.query("SELECT id FROM stories WHERE id = ?").get(only)).toBeNull();
  expect((db.query("SELECT item_count FROM stories WHERE id = ?").get(shared) as any).item_count).toBe(1);
});
