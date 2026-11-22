// What a stranger reaches without a passkey. peppermint is on the open internet with no gate in front, so this is the
// whole list: every app route answers 401, the shell carries no data, and only the pieces named here are open.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_SETUP_TOKEN = "first-run";
process.env.PEPPERMINT_LLM = "off";
import { expect, test } from "bun:test";
const { server, routes } = await import("../server/main");
const { db } = await import("../server/db");
const { createSession, COOKIE } = await import("../server/auth");
const BASE = `http://localhost:${server.port}`, ORIGIN = "http://localhost:4317";

// Marking a route open is a decision about the public surface: add it here, with the reason, in the same commit.
const OPEN: string[] = [];

test("no app route is open unless this file names it", () => {
  expect(routes.length).toBeGreaterThan(50);
  expect(routes.filter(r => r.open).map(r => `${r.method} ${r.path}`)).toEqual(OPEN);
});

test("every app route refuses a request without a session", async () => {
  const let_through: string[] = [];
  for (const r of routes) {
    if (r.open) continue;
    const path = r.path.replace(/:(\w+)/g, "1");
    // same origin, so the origin check passes and only the session is missing
    const res = await fetch(BASE + path, { method: r.method, headers: { origin: ORIGIN, "content-type": "application/json" }, body: r.method === "GET" || r.method === "HEAD" ? undefined : "{}" });
    if (res.status !== 401) let_through.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  expect(let_through).toEqual([]);
});

test("a forged session cookie or device token gets nothing either", async () => {
  expect((await fetch(BASE + "/api/edition", { headers: { cookie: "__Host-peppermint=" + "a".repeat(43) } })).status).toBe(401);
  expect((await fetch(BASE + "/api/edition", { headers: { authorization: "Bearer " + "a".repeat(43) } })).status).toBe(401);
});

test("outside /api: the voice files need a session, the shell carries no data, health and the public pages are open", async () => {
  expect((await fetch(BASE + "/voice/model.onnx")).status).toBe(401);
  const shell = await fetch(BASE + "/");
  expect(shell.status).toBe(200);
  const boot = /<script type="application\/json" id="boot">(.*?)<\/script>/s.exec(await shell.text())?.[1];
  if (boot) expect(JSON.parse(boot)).toEqual({ auth: false, setup: true });
  expect((await fetch(BASE + "/healthz")).status).toBe(200);
  const links = await fetch(BASE + "/.well-known/assetlinks.json");
  expect(links.status).toBe(200);
  expect((await links.json())[0].target.package_name).toBe("dev.kaleve.peppermint");
  expect((await fetch(BASE + "/@nobody")).status).toBe(404);
  // the share target only turns its form into a query string and sends the browser on
  const share = await fetch(BASE + "/share", { method: "POST", body: new URLSearchParams({ url: "https://example.com" }), redirect: "manual" });
  expect(share.status).toBe(303);
});

test("a paired phone reaches the listening routes and nothing else", async () => {
  const owner = (db.query("INSERT INTO users (name, created_at) VALUES ('Reader', ?) RETURNING id").get(Date.now()) as { id: number }).id;
  const cookie = `${COOKIE}=${await createSession(owner)}`;
  const pair = await (await fetch(BASE + "/api/devices/pair", { method: "POST", headers: { cookie, origin: ORIGIN } })).json() as any;
  const claim = await fetch(BASE + "/api/devices/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pair.code, name: "Phone", kind: "android" }) });
  expect(claim.status).toBe(200);
  const phone = { authorization: `Bearer ${((await claim.json()) as any).token}` };
  const q = await fetch(BASE + "/api/listen/queue", { headers: phone });
  expect(q.status).toBe(200);
  expect(await q.json()).toMatchObject({ name: "Reader", edition: null, episodes: [] });
  expect((await fetch(BASE + "/api/listen/episodes/1", { headers: phone })).status).toBe(404);
  // everything a reader does in the browser stays out of the phone's reach
  const scoped = new Set(routes.filter(r => r.scope === "listen").map(r => `${r.method} ${r.path}`));
  expect([...scoped].sort()).toEqual(["GET /api/listen", "GET /api/listen/episodes/:id", "GET /api/listen/queue", "POST /api/listen/episodes/:id/heard"]);
  const leaked: string[] = [];
  for (const r of routes) {
    if (r.open || r.scope) continue;
    const res = await fetch(BASE + r.path.replace(/:(\w+)/g, "1"), { method: r.method, headers: { ...phone, "content-type": "application/json" }, body: r.method === "GET" ? undefined : "{}" });
    if (res.status !== 401) leaked.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  expect(leaked).toEqual([]);
  // the accounts module's own pages are for people, never for a device
  expect((await fetch(BASE + "/api/members", { headers: phone })).status).not.toBe(200);
});
