// Sharing a story as a short public link, and switching between several accounts signed in on one browser.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_LLM = "off";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const auth = await import("../server/auth");
const { server } = await import("../server/main");
const BASE = `http://localhost:${server.port}`, ORIGIN = "http://localhost:4317";
const O = 2001, OTHER = 2002;
let me = "", other = "", story = 0;
const call = (who: string, method: string, path: string, json?: unknown) => fetch(BASE + path, { method, headers: { cookie: `__Host-peppermint=${who}`, origin: ORIGIN, "content-type": "application/json" }, body: json ? JSON.stringify(json) : undefined });

beforeAll(async () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'Jo', ?), (?, 'Shared desk', ?)").run(O, now(), OTHER, now());
  const src = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (?, 'feed', 'merkur', ?) RETURNING id").get(O, now()) as any).id;
  story = (db.query("INSERT INTO stories (owner_id, title, title_en, first_at, last_at) VALUES (?, 'Stammstrecke gesperrt', 'Trunk line closed', ?, ?) RETURNING id").get(O, now(), now()) as any).id;
  db.query("INSERT INTO items (owner_id, source_id, ext_id, title, url, published_at, fetched_at, tagged, story_id) VALUES (?, ?, 'a', 'Stammstrecke gesperrt', 'https://merkur.de/a', ?, ?, 1, ?), (?, ?, 'b', 'Evil', 'javascript:alert(1)', ?, ?, 1, ?)")
    .run(O, src, now(), now(), story, O, src, now(), now(), story);
  db.query("INSERT INTO lens_cache (story_id, lens, lang, level, text, done, model, created_at) VALUES (?, 'tldr', 'en', 2, 'The **trunk** line closes for <b>repairs</b>.', 1, 'm', ?), (?, 'digest', 'en', 2, '## What happens\n\nTrains stop.\n\n- one\n- two\n\n```chart\n{}\n```', 1, 'm', ?)").run(story, now(), story, now());
  me = await auth.createSession(O); other = await auth.createSession(OTHER);
});

test("a shared story is one short public link: the retelling and its reports, nothing more, until it is stopped", async () => {
  expect((await (await call(me, "GET", `/api/stories/${story}`)).json()).share).toBeNull();
  const { url } = await (await call(me, "POST", `/api/stories/${story}/share`, { lang: "en", level: 2 })).json() as any;
  expect(url).toMatch(/^http:\/\/localhost:4317\/s\/[A-Za-z0-9]{7}$/);
  // sharing again keeps the link
  expect((await (await call(me, "POST", `/api/stories/${story}/share`, { lang: "de", level: 3 })).json() as any).url).toBe(url);
  await call(me, "POST", `/api/stories/${story}/share`, { lang: "en", level: 2 });
  expect((await (await call(me, "GET", `/api/stories/${story}`)).json()).share).toBe(url);
  // somebody else's story cannot be shared
  expect((await call(other, "POST", `/api/stories/${story}/share`, {})).status).toBe(404);

  const path = new URL(url).pathname;
  const page = await fetch(BASE + path);
  expect(page.status).toBe(200);
  expect(page.headers.get("x-robots-tag")).toBe("noindex");
  const html = await page.text();
  expect(html).toContain("<h1>Trunk line closed</h1>");
  expect(html).toContain('src="/icon.svg"');
  expect(html).toContain("The <b>trunk</b> line closes for &lt;b&gt;repairs&lt;/b&gt;.");
  expect(html).toContain("<h2>What happens</h2>");
  expect(html).toContain("<li>two</li>");
  expect(html).not.toContain("```");
  expect(html).toContain('href="https://merkur.de/a"');
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("<script");
  expect((db.query("SELECT views FROM shares").get() as any).views).toBe(1);

  expect((await fetch(BASE + "/s/nothere")).status).toBe(404);
  expect((await fetch(BASE + "/s/%E0%A4%A")).status).toBe(404);
  await call(me, "DELETE", `/api/stories/${story}/share`);
  expect((await fetch(BASE + path)).status).toBe(404);
});

const cookies = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map(c => { const [kv] = c.split(";"); const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const as = (main: string, more = "") => ({ cookie: `__Host-peppermint=${main}; __Host-peppermint-more=${more}`, origin: ORIGIN, "content-type": "application/json" });

test("several accounts in one browser: add one, switch with a tap, sign out brings the next forward", async () => {
  const a = await auth.createSession(O);
  // stepping back to add another account keeps this one signed in, in the second cookie
  const add = await fetch(BASE + "/api/auth/add", { method: "POST", headers: as(a), body: "{}" });
  let c = cookies(add);
  expect(c["__Host-peppermint"]).toBe("");
  expect(c["__Host-peppermint-more"]).toBe(a);
  // the sign-in made a session for the other account
  const b = await auth.createSession(OTHER);
  const list = await (await fetch(BASE + "/api/auth/accounts", { headers: as(b, a) })).json() as any;
  expect(list).toEqual({ current: { id: OTHER, name: "Shared desk" }, others: [{ id: O, name: "Jo" }] });
  // a forged token in the second cookie is dropped, never trusted
  expect((await (await fetch(BASE + "/api/auth/accounts", { headers: as(b, "x".repeat(43)) })).json() as any).others).toEqual([]);

  // switching swaps the two
  const sw = await fetch(BASE + "/api/auth/switch", { method: "POST", headers: as(b, a), body: JSON.stringify({ id: O }) });
  c = cookies(sw);
  expect(c["__Host-peppermint"]).toBe(a);
  expect(c["__Host-peppermint-more"]).toBe(b);
  expect((await fetch(BASE + "/api/auth/switch", { method: "POST", headers: as(a, b), body: JSON.stringify({ id: 9999 }) })).status).toBe(404);
  // from another site it does nothing
  expect((await fetch(BASE + "/api/auth/switch", { method: "POST", headers: { ...as(b, a), origin: "https://evil.example" }, body: JSON.stringify({ id: O }) })).status).toBe(403);

  // signing out ends only the account in front
  const out = await fetch(BASE + "/api/auth/logout", { method: "POST", headers: as(a, b), body: "{}" });
  expect(await out.json()).toEqual({ ok: true, switched: true });
  c = cookies(out);
  expect(c["__Host-peppermint"]).toBe(b);
  expect((await call(a, "GET", "/api/edition")).status).toBe(401);
  expect((await call(b, "GET", "/api/edition")).status).toBe(200);
});
