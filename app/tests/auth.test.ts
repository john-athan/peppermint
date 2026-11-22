// The accounts module mounted in peppermint: the first run's link, the Lax host cookie, the palate a new reader starts
// with, the origin check on the app's own routes, and invites. The module's own rules are in accounts.test.ts.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_SETUP_TOKEN = "first-run";
process.env.PEPPERMINT_LLM = "off";
import { expect, test } from "bun:test";
import { Key } from "./softkey";
const { db } = await import("../server/db");
const { server } = await import("../server/main");
const BASE = `http://localhost:${server.port}`, ORIGIN = "http://localhost:4317";

const j = (r: Response) => r.json() as Promise<any>;
const cookieOf = (r: Response) => /__Host-peppermint=([^;]+)/.exec(r.headers.get("set-cookie") ?? "")?.[1] ?? null;
const call = (method: string, path: string, o: { cookie?: string; json?: unknown; headers?: Record<string, string> } = {}) =>
  fetch(BASE + path, { method, headers: { origin: ORIGIN, "content-type": "application/json", ...(o.cookie ? { cookie: `__Host-peppermint=${o.cookie}` } : {}), ...o.headers }, body: o.json !== undefined ? JSON.stringify(o.json) : undefined });
async function register(key: Key, token: string) {
  const options = await j(await call("POST", "/api/auth/register/options", { json: { token } }));
  return call("POST", "/api/auth/register/verify", { json: { credential: await key.create(options), name: "Phone" } });
}

let admin = "";
test("the first run's link makes the first reader, an admin with a starting palate, signed in with a Lax host cookie", async () => {
  expect(await j(await fetch(BASE + "/api/auth/state"))).toMatchObject({ setupOpen: true, loggedIn: false });
  const r = await register(await Key.make(-7, ORIGIN), "first-run");
  expect(r.status).toBe(200);
  expect(r.headers.get("set-cookie")).toMatch(/^__Host-peppermint=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  admin = cookieOf(r)!;
  expect((await j(await call("GET", "/api/account", { cookie: admin }))).role).toBe("admin");
  expect((db.query("SELECT count(*) AS n FROM affinities WHERE owner_id = 1").get() as { n: number }).n).toBeGreaterThan(5);
  expect((await call("GET", "/api/edition", { cookie: admin })).status).toBe(200);
});

test("the app's own routes need a session and a same-origin request", async () => {
  expect((await fetch(BASE + "/api/edition")).status).toBe(401);
  expect((await call("POST", "/api/rules", { cookie: admin, json: {}, headers: { origin: "https://evil.example" } })).status).toBe(403);
  // no Origin and no Sec-Fetch-Site: refused; Sec-Fetch-Site same-origin alone: fine
  const bare = (h: Record<string, string>) => fetch(BASE + "/api/briefing", { method: "POST", headers: { cookie: `__Host-peppermint=${admin}`, ...h } });
  expect((await bare({})).status).toBe(403);
  expect((await bare({ "sec-fetch-site": "same-origin" })).status).not.toBe(403);
});

test("an invite gives a second reader their own account and palate; they see the group but cannot invite", async () => {
  const inv = await j(await call("POST", "/api/members", { cookie: admin, json: { name: "Sam" } }));
  expect(inv.link).toStartWith(`${ORIGIN}/setup#`);
  const r = await register(await Key.make(-257, ORIGIN), inv.link.split("#")[1]);
  expect(r.status).toBe(200);
  const sam = cookieOf(r)!;
  expect(await j(await call("GET", "/api/account", { cookie: sam }))).toMatchObject({ id: inv.member, name: "Sam", role: "member" });
  expect((db.query("SELECT count(*) AS n FROM affinities WHERE owner_id = ?").get(inv.member) as { n: number }).n).toBeGreaterThan(5);
  expect((await j(await call("GET", "/api/members", { cookie: sam }))).map((m: any) => m.name)).toEqual(["Me", "Sam"]);
  expect((await call("POST", "/api/members", { cookie: sam, json: { name: "Kim" } })).status).toBe(403);
  // Sam has a palate now: taking access away keeps it
  expect(await j(await call("DELETE", `/api/members/${inv.member}`, { cookie: admin }))).toEqual({ ok: true, result: "revoked" });
  expect((await call("GET", "/api/edition", { cookie: sam })).status).toBe(401);
});
