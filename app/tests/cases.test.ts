// Investigations and publishing: every case and desk route refuses another owner's ids, a piece goes public only
// through the checks, the public page shows no unverified claim and no private photo, and readers' input is bounded.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_LLM = "off";
process.env.PEPPERMINT_NO_MAIL = "1";
import { test, expect, beforeAll } from "bun:test";
const { db, now, setSetting } = await import("../server/db");
const auth = await import("../server/auth");
const { server } = await import("../server/main");
const { slugify } = await import("../server/desk");
const { langOf } = await import("../server/investigate");
const { jpegSize } = await import("../server/case-routes");
const BASE = `http://localhost:${server.port}`, ORIGIN = "http://localhost:4317";

let mine = "", theirs = "", kase = 0, draft = 0, photo = 0, evid = 0;
const call = (cookie: string, method: string, path: string, json?: unknown) =>
  fetch(BASE + path, { method, headers: { cookie: `__Host-peppermint=${cookie}`, origin: ORIGIN, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });
// a tiny JPEG header: SOI, then a SOF0 frame of 640x480
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, ...new Array(1200).fill(0)]);

beforeAll(async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (201, 'writer', ?), (202, 'other', ?)").run(now(), now());
  kase = (db.query("INSERT INTO investigations (owner_id, title, note, status, steps, place, created_at, updated_at) VALUES (201, 'Boden', 'glänzt', 'ready', '[]', '{\"name\":\"Lindenplatz\"}', ?, ?) RETURNING id").get(now(), now()) as any).id;
  evid = (db.query("INSERT INTO evidence (owner_id, investigation_id, kind, title, site, url, quote, created_at) VALUES (201, ?, 'web', 'MVG kündigt Arbeiten an', 'tz', 'https://tz.de/x', 'secret quote', ?) RETURNING id").get(kase, now()) as any).id;
  photo = (db.query("INSERT INTO photos (owner_id, investigation_id, mime, bytes, w, h, faces, created_at) VALUES (201, ?, 'image/jpeg', ?, 640, 480, '[{\"x\":0.1,\"y\":0.1,\"w\":0.1,\"h\":0.1}]', ?) RETURNING id").get(kase, JPEG, now()) as any).id;
  const blocks = [{ id: "h1", type: "h", text: "Warum der Boden glänzt" }, { id: "p1", type: "p", text: "Der Boden glänzt.", ev: [evid] }, { id: "c1", type: "c", text: "Angeblich rutschig <script>x</script>" }];
  draft = (db.query("INSERT INTO drafts (owner_id, title, blocks, investigation_id, meta, created_at, updated_at) VALUES (201, 'Warum der Boden glänzt', ?, ?, ?, ?, ?) RETURNING id").get(JSON.stringify(blocks), kase, JSON.stringify({ photo, lang: "de" }), now(), now()) as any).id;
  db.query("UPDATE investigations SET draft_id = ? WHERE id = ?").run(draft, kase);
  mine = await auth.createSession(201); theirs = await auth.createSession(202);
});

test("the writer can read their own case and desk (the fixture is valid)", async () => {
  expect((await call(mine, "GET", `/api/cases/${kase}`)).status).toBe(200);
  expect((await call(mine, "GET", `/api/drafts/${draft}/desk`)).status).toBe(200);
});

test("another owner gets nothing from the case, its photo or the desk, and changes nothing", async () => {
  for (const p of [`/api/cases/${kase}`, `/api/photos/${photo}`, `/api/drafts/${draft}/desk`]) {
    const r = await call(theirs, "GET", p);
    expect(r.status, p).toBe(404);
    expect(await r.text(), p).not.toContain("secret");
  }
  for (const [m, p, j] of [["POST", `/api/cases/${kase}/drop`, {}], ["POST", `/api/cases/${kase}/answer`, { qid: "x", answer: "y" }], ["POST", `/api/cases/${kase}/update/apply`, {}],
    ["POST", `/api/drafts/${draft}/publish`, {}], ["PATCH", `/api/drafts/${draft}/meta`, { reply_ok: true }], ["PATCH", `/api/photos/${photo}`, { blur: false }], ["POST", `/api/drafts/${draft}/preview-link`, {}]] as const)
    expect((await call(theirs, m, p, j)).status, p).toBe(404);
  expect(db.query("SELECT status FROM investigations WHERE id = ?").get(kase)).toEqual({ status: "ready" });
  expect(db.query("SELECT blur FROM photos WHERE id = ?").get(photo)).toEqual({ blur: 1 });
  expect(db.query("SELECT status FROM drafts WHERE id = ?").get(draft)).toEqual({ status: "draft" });
});

test("saved blocks keep evidence ids only from the owner's own case files", async () => {
  const other = (db.query("INSERT INTO investigations (owner_id, status, created_at, updated_at) VALUES (202, 'ready', ?, ?) RETURNING id").get(now(), now()) as any).id;
  const foreign = (db.query("INSERT INTO evidence (owner_id, investigation_id, kind, title, created_at) VALUES (202, ?, 'web', 'theirs', ?) RETURNING id").get(other, now()) as any).id;
  const d = await (await call(mine, "GET", `/api/drafts/${draft}`)).json() as any;
  const r = await call(mine, "PUT", `/api/drafts/${draft}`, { base: d.updated_at, blocks: [...d.blocks.slice(0, 2), { id: "p2", type: "p", text: "x", ev: [evid, foreign] }, d.blocks[2]], status: "published" });
  const saved = await r.json() as any;
  expect(saved.blocks.find((b: any) => b.id === "p2").ev).toEqual([evid]);
  // a piece with a public page never goes live through a plain save
  expect(saved.status).toBe("draft");
});

test("publishing waits for the checks: an unverified claim, a missing imprint, a missing public photo", async () => {
  let r = await call(mine, "POST", `/api/drafts/${draft}/publish`, {});
  expect(r.status).toBe(409);
  expect((await r.json() as any).error).toContain("unverified");
  const d = await (await call(mine, "GET", `/api/drafts/${draft}`)).json() as any;
  await call(mine, "PUT", `/api/drafts/${draft}`, { base: d.updated_at, blocks: d.blocks.filter((b: any) => b.type !== "c") });
  r = await call(mine, "POST", `/api/drafts/${draft}/publish`, {});
  expect((await r.json() as any).error).toContain("imprint");
  expect((await call(mine, "PUT", "/api/profile", { name: "Jo", handle: "Bad Handle!" })).status).toBe(400);
  expect((await call(mine, "PUT", "/api/profile", { name: "Jo Beispiel", handle: "jo", imprint: "Jo Beispiel\nMusterweg 1\n80331 München", email: "jo@example.org" })).status).toBe(200);
  expect((await call(theirs, "PUT", "/api/profile", { handle: "jo" })).status).toBe(409);
  r = await call(mine, "POST", `/api/drafts/${draft}/publish`, {});
  expect((await r.json() as any).error).toContain("public copy");
  expect((await fetch(`${BASE}/api/photos/${photo}/public`, { method: "PUT", headers: { cookie: `__Host-peppermint=${mine}`, origin: ORIGIN }, body: JPEG })).status).toBe(200);
  r = await call(mine, "POST", `/api/drafts/${draft}/publish`, {});
  expect(r.status).toBe(200);
  expect((await r.json() as any).url).toBe(`${ORIGIN}/@jo/warum-der-boden-glaenzt`);
});

test("the public page: escaped text, numbered sources, no claim, only the blurred photo, reads counted for strangers only", async () => {
  const r = await fetch(`${BASE}/@jo/warum-der-boden-glaenzt`, { headers: { "user-agent": "Mozilla/5.0" } });
  const html = await r.text();
  expect(r.status).toBe(200);
  expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(html).toContain("Der Boden glänzt.<sup><a href=\"#s1\">1</a></sup>");
  expect(html).toContain("https://tz.de/x");
  expect(html).not.toContain("<script>x</script>");
  expect(html).not.toContain("Angeblich");
  expect((await fetch(`${BASE}/@jo/photo/${photo}`)).headers.get("content-type")).toBe("image/jpeg");
  await fetch(`${BASE}/@jo/warum-der-boden-glaenzt`, { headers: { cookie: `__Host-peppermint=${mine}`, "user-agent": "Mozilla/5.0" } });
  await fetch(`${BASE}/@jo/warum-der-boden-glaenzt`, { headers: { "user-agent": "Googlebot/2.1" } });
  expect(db.query("SELECT sum(reads) AS n FROM page_stats WHERE draft_id = ?").get(draft)).toEqual({ n: 1 });
  expect((await (await fetch(`${BASE}/@jo/feed.xml`)).text())).toContain("<title>Warum der Boden glänzt</title>");
  expect((await fetch(`${BASE}/@nobody/x`)).status).toBe(404);
  // nothing under /@ (which Cloudflare Access lets through) ever falls through to the app
  for (const p of ["/@jo/..%2fapi/edition", "/@x/y/z", "/@jo/a/b/c", "/@"]) expect((await fetch(`${BASE}${p}`)).headers.get("content-type"), p).not.toContain("javascript");
  for (const p of ["/@jo/..%2fapi/edition", "/@x/y/z"]) expect(await (await fetch(`${BASE}${p}`)).text(), p).not.toContain('id="boot"');
});

test("taking a piece down closes its page and its photo", async () => {
  await call(mine, "POST", `/api/drafts/${draft}/unpublish`, {});
  expect((await fetch(`${BASE}/@jo/warum-der-boden-glaenzt`)).status).toBe(410);
  expect((await fetch(`${BASE}/@jo/photo/${photo}`)).status).toBe(404);
  await call(mine, "POST", `/api/drafts/${draft}/publish`, {});
});

test("readers: tips land with the writer, other sites cannot post, and a flood is cut off", async () => {
  const post = (body: unknown, origin = ORIGIN) => fetch(`${BASE}/@jo/warum-der-boden-glaenzt/tip`, { method: "POST", headers: { origin, "content-type": "application/json", "x-real-ip": "9.9.9.9" }, body: JSON.stringify(body) });
  expect((await post({ kind: "fix", text: "Granit, nicht Marmor" })).status).toBe(200);
  expect((await post({ text: "spam" }, "https://evil.example")).status).toBe(403);
  for (let i = 0; i < 4; i++) await post({ text: `tip ${i}` });
  expect((await post({ text: "one too many" })).status).toBe(429);
  const notes = await (await call(mine, "GET", `/api/drafts/${draft}/desk`)).json() as any;
  expect(notes.readers.some((n: any) => n.kind === "fix" && n.text === "Granit, nicht Marmor")).toBe(true);
});

test("subscribing needs a confirmation link", async () => {
  await fetch(`${BASE}/@jo/subscribe`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: "leser@example.org" }) });
  const s = db.query("SELECT token, confirmed_at FROM subscribers WHERE email = 'leser@example.org'").get() as any;
  expect(s.confirmed_at).toBeNull();
  await fetch(`${BASE}/@jo/confirm/${s.token}`);
  expect((db.query("SELECT confirmed_at FROM subscribers WHERE email = 'leser@example.org'").get() as any).confirmed_at).toBeGreaterThan(0);
});

test("helpers: slugs, the language of a note, a JPEG's size", () => {
  expect(slugify("Warum der Boden an der Lindenplatz plötzlich glänzt")).toBe("warum-der-boden-an-der-lindenplatz-ploetzlich-glaenzt");
  expect(langOf("Der Boden unten glänzt seit zwei Tagen")).toBe("de");
  expect(langOf("The floor downstairs has been shining for two days")).toBe("en");
  expect(jpegSize(JPEG)).toEqual({ w: 640, h: 480 });
  expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeNull();
});
