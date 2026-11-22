// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// The accounts module on its own: an in-memory database, a software passkey (softkey.ts: ES256, RS256, and an SPKI
// key from before the module), and every rule docs/accounts.md states. The app's own tests cover how it mounts the module.
import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { createAccounts, migrateAccounts, type Accounts } from "../server/accounts";
import { Key } from "./softkey";

const ORIGIN = "https://app.test", RP = "app.test";

/* ---------- a module over an in-memory database ---------- */
let db: Database, A: Accounts, joined: number[] = [];
const COOKIE = "__Host-test";
let ipn = 0;
function call(method: string, path: string, o: { cookie?: string | null; json?: unknown; origin?: string | null; ip?: string; bearer?: string } = {}) {
  const h: Record<string, string> = {};
  if (o.cookie) h.cookie = `${COOKIE}=${o.cookie}`;
  if (o.bearer) h.authorization = `Bearer ${o.bearer}`;
  if (o.origin !== null && method !== "GET") h.origin = o.origin ?? ORIGIN;
  if (o.json !== undefined) h["content-type"] = "application/json";
  const req = new Request(ORIGIN + path, { method, headers: h, body: o.json !== undefined ? JSON.stringify(o.json) : undefined });
  return A.handle(req, o.ip ?? `10.0.${(++ipn >> 8) & 255}.${ipn & 255}`).then(r => { if (!r) throw new Error(`not a module route: ${method} ${path}`); return r; });
}
const j = (r: Response) => r.json() as Promise<any>;
const cookieOf = (r: Response) => new RegExp(`${COOKIE}=([^;]+)`).exec(r.headers.get("set-cookie") ?? "")?.[1] ?? null;
async function register(k: Key, token?: string, cookie?: string, x: Parameters<Key["create"]>[1] = {}) {
  const opt = await call("POST", "/api/auth/register/options", { json: token ? { token } : {}, cookie });
  if (!opt.ok) return { opt, options: null, ver: null as Response | null };
  const options = await j(opt);
  const ver = await call("POST", "/api/auth/register/verify", { json: { credential: await k.create(options, x), name: "Test" }, cookie });
  return { opt, options, ver };
}
async function login(k: Key, x: Parameters<Key["get"]>[1] = {}) {
  const o = await j(await call("POST", "/api/auth/login/options"));
  return call("POST", "/api/auth/login/verify", { json: { credential: await k.get(o, x) } });
}
const tokenOf = (link: string) => link.split("#")[1];

beforeAll(() => {
  db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, colour TEXT) STRICT");
  db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES people(id)) STRICT");
  migrateAccounts(db, "people");
  migrateAccounts(db, "people"); // idempotent
  A = createAccounts({
    db, table: "people", app: "Test", origin: ORIGIN, cookie: COOKIE, lang: "en", setupToken: "setup-secret",
    devices: { phone: "upload", desk: "upload,export" }, deviceInfo: () => ({ extra: 1 }),
    onCreate: (id, input) => { if (typeof input.colour === "string") db.query("UPDATE people SET colour = ? WHERE id = ?").run(input.colour, id); },
    onJoin: id => joined.push(id),
    hasData: id => !!db.query("SELECT 1 FROM things WHERE owner_id = ?").get(id),
  });
});

describe("first run", () => {
  test("setup is open with the token only; the state says so", async () => {
    expect(await j(await call("GET", "/api/auth/state"))).toEqual({ setupOpen: true, loggedIn: false, device: false, hasCredential: false, me: null });
    expect((await call("POST", "/api/auth/register/options", { json: {} })).status).toBe(403);
    expect((await call("POST", "/api/auth/register/options", { json: { token: "wrong" } })).status).toBe(403);
    expect(await j(await call("POST", "/api/auth/link", { json: { token: "setup-secret" } }))).toEqual({ purpose: "setup", name: null, expiresAt: null });
  });
});

describe("the whole group", () => {
  let admin: Key, adminCookie = "", anna: Key, annaCookie = "", annaId = 0;
  test("the first passkey makes the first account, an admin, and signs in with a strict host cookie", async () => {
    admin = await Key.make(-7);
    const { options: o, ver } = await register(admin, "setup-secret");
    expect(o.rp.id).toBe(RP);
    expect(o.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(o.pubKeyCredParams.map((p: any) => p.alg)).toEqual([-7, -257]);
    expect(ver!.status).toBe(200);
    expect(ver!.headers.get("set-cookie")).toMatch(/^__Host-test=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    adminCookie = cookieOf(ver!)!;
    expect((await j(await call("GET", "/api/auth/state", { cookie: adminCookie }))).me).toEqual({ id: 1, name: "Me", role: "admin" });
    expect(joined).toEqual([1]);
    expect((await call("POST", "/api/auth/register/options", { json: { token: "setup-secret" } })).status).toBe(403);
    expect((await j(await call("GET", "/api/auth/state"))).setupOpen).toBe(false);
  });
  test("login: a good signature works; another key, a replay, a wrong origin, no UV and a backwards counter do not", async () => {
    expect((await login(admin)).status).toBe(200);
    const other = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]) as CryptoKeyPair;
    expect((await login(admin, { signWith: other.privateKey })).status).toBe(401);
    const o = await j(await call("POST", "/api/auth/login/options"));
    const cred = await admin.get(o);
    expect((await call("POST", "/api/auth/login/verify", { json: { credential: cred } })).status).toBe(200);
    expect((await call("POST", "/api/auth/login/verify", { json: { credential: cred } })).status).toBe(400);
    expect((await login(admin, { origin: "https://evil.example" })).status).toBe(400);
    expect((await login(admin, { flags: 0x01 })).status).toBe(401);
    expect((await login(admin)).status).toBe(200);
    expect((await login(admin, { count: 1 })).status).toBe(401);
    admin.count = 100; // forward again, for the tests below
    expect((await login(await Key.make())).status).toBe(401);
  });
  test("registration refuses a wrong rp id, a missing UV flag and a key it already has", async () => {
    expect((await register(await Key.make(), undefined, adminCookie, { rpId: "evil.example" })).ver!.status).toBe(400);
    expect((await register(await Key.make(), undefined, adminCookie, { flags: 0x41 })).ver!.status).toBe(401);
    expect((await register(admin, undefined, adminCookie)).ver!.status).toBe(409);
  });
  test("state-changing requests need the same origin", async () => {
    expect((await call("POST", "/api/members", { cookie: adminCookie, json: { name: "X" }, origin: "https://evil.example" })).status).toBe(403);
    expect((await call("POST", "/api/members", { cookie: adminCookie, json: { name: "X" }, origin: null })).status).toBe(403);
  });
  test("an admin invites; the link says whose it is, works once, and opened where the admin is signed in, signs the browser over", async () => {
    const r = await call("POST", "/api/members", { cookie: adminCookie, json: { name: "Anna", colour: "blue" } });
    expect(r.status).toBe(200);
    const inv = await j(r);
    annaId = inv.member;
    expect(inv.purpose).toBe("join");
    expect(inv.link).toStartWith(`${ORIGIN}/setup#`);
    expect(inv.expiresAt - Date.now()).toBeGreaterThan(6.9 * 86400_000);
    expect(db.query("SELECT colour FROM people WHERE id = ?").get(annaId)).toEqual({ colour: "blue" });
    expect(JSON.stringify(db.query("SELECT * FROM auth_link").all())).not.toContain(tokenOf(inv.link)); // stored hashed
    expect(await j(await call("POST", "/api/auth/link", { json: { token: tokenOf(inv.link) } }))).toMatchObject({ purpose: "join", name: "Anna" });
    const list = await j(await call("GET", "/api/members", { cookie: adminCookie }));
    expect(list.find((m: any) => m.id === annaId)).toMatchObject({ status: "invited", role: "member", link: { purpose: "join" } });
    anna = await Key.make(-257);
    const { ver } = await register(anna, tokenOf(inv.link), adminCookie);
    expect(ver!.status).toBe(200);
    annaCookie = cookieOf(ver!)!;
    expect((await j(await call("GET", "/api/account", { cookie: annaCookie }))).name).toBe("Anna");
    expect((await call("GET", "/api/account", { cookie: adminCookie })).status).toBe(401); // the admin's session in that browser ended
    expect(joined).toEqual([1, annaId]);
    expect((await register(await Key.make(), tokenOf(inv.link))).opt.status).toBe(403); // used up
    expect((await login(anna)).status).toBe(200);
    adminCookie = cookieOf(await login(admin))!;
  });
  test("names are unique, ignoring case", async () => {
    expect((await call("POST", "/api/members", { cookie: adminCookie, json: { name: "anna" } })).status).toBe(409);
    expect((await call("PATCH", "/api/account", { cookie: annaCookie, json: { name: "ME" } })).status).toBe(409);
    expect((await call("POST", "/api/members", { cookie: adminCookie, json: { name: "  " } })).status).toBe(400);
  });
  test("a member sees the group but cannot invite, change roles, make links for others or remove anyone", async () => {
    const list = await j(await call("GET", "/api/members", { cookie: annaCookie }));
    expect(list.map((m: any) => m.name)).toEqual(["Me", "Anna"]);
    expect(list.every((m: any) => m.link === null)).toBe(true);
    expect((await call("POST", "/api/members", { cookie: annaCookie, json: { name: "Ben" } })).status).toBe(403);
    expect((await call("PATCH", "/api/members/1", { cookie: annaCookie, json: { role: "member" } })).status).toBe(403);
    expect((await call("POST", "/api/members/1/link", { cookie: annaCookie })).status).toBe(403);
    expect((await call("DELETE", "/api/members/1", { cookie: annaCookie })).status).toBe(403);
  });
  test("an add link gives one more passkey and keeps the others", async () => {
    const l = await j(await call("POST", "/api/account/link", { cookie: annaCookie }));
    expect(l.purpose).toBe("add");
    expect(l.expiresAt - Date.now()).toBeLessThanOrEqual(3600_000);
    const second = await Key.make();
    expect((await register(second, tokenOf(l.link))).ver!.status).toBe(200);
    expect((await j(await call("GET", "/api/passkeys", { cookie: annaCookie }))).length).toBe(2);
    expect((await login(anna)).status).toBe(200);
    expect((await login(second)).status).toBe(200);
  });
  test("a recovery link from the admin replaces every passkey and ends every browser session of that person", async () => {
    const l = await j(await call("POST", `/api/members/${annaId}/link`, { cookie: adminCookie }));
    expect(l.purpose).toBe("recover");
    expect(l.expiresAt - Date.now()).toBeLessThanOrEqual(86400_000);
    const fresh = await Key.make();
    const { ver } = await register(fresh, tokenOf(l.link));
    expect(ver!.status).toBe(200);
    expect((await call("GET", "/api/account", { cookie: annaCookie })).status).toBe(401);
    expect((await login(anna)).status).toBe(401);
    annaCookie = cookieOf(await login(fresh))!;
    expect((await j(await call("GET", "/api/passkeys", { cookie: annaCookie }))).length).toBe(1);
    expect(joined).toEqual([1, annaId]); // not a second join
  });
  test("a newer link replaces the older one for the same person", async () => {
    const a = await j(await call("POST", `/api/members/${annaId}/link`, { cookie: adminCookie }));
    const b = await j(await call("POST", `/api/members/${annaId}/link`, { cookie: adminCookie }));
    expect((await call("POST", "/api/auth/link", { json: { token: tokenOf(a.link) } })).status).toBe(404);
    expect((await call("POST", "/api/auth/link", { json: { token: tokenOf(b.link) } })).status).toBe(200);
  });
  test("roles: there is always an admin; a second admin can be made and can step down", async () => {
    expect((await call("PATCH", "/api/members/1", { cookie: adminCookie, json: { role: "member" } })).status).toBe(409);
    expect((await call("DELETE", "/api/members/1", { cookie: adminCookie })).status).toBe(409);
    expect((await j(await call("PATCH", `/api/members/${annaId}`, { cookie: adminCookie, json: { role: "admin" } }))).role).toBe("admin");
    expect((await call("POST", "/api/members", { cookie: annaCookie, json: { name: "Ben" } })).status).toBe(200);
    expect((await call("PATCH", `/api/members/${annaId}`, { cookie: annaCookie, json: { role: "member" } })).status).toBe(200);
    expect((await call("POST", "/api/members", { cookie: annaCookie, json: { name: "Cleo" } })).status).toBe(403);
  });
  test("removing: someone who never joined is deleted; someone with data keeps it but loses passkeys, sessions and links", async () => {
    const list = await j(await call("GET", "/api/members", { cookie: adminCookie }));
    const ben = list.find((m: any) => m.name === "Ben");
    expect(await j(await call("DELETE", `/api/members/${ben.id}`, { cookie: adminCookie }))).toEqual({ ok: true, result: "deleted" });
    db.query("INSERT INTO things (owner_id) VALUES (?)").run(annaId);
    expect(await j(await call("DELETE", `/api/members/${annaId}`, { cookie: adminCookie }))).toEqual({ ok: true, result: "revoked" });
    expect((await call("GET", "/api/account", { cookie: annaCookie })).status).toBe(401);
    expect(db.query("SELECT count(*) AS n FROM auth_passkey WHERE account_id = ?").get(annaId)).toEqual({ n: 0 });
    expect((await j(await call("GET", "/api/members", { cookie: adminCookie }))).find((m: any) => m.id === annaId)).toMatchObject({ status: "none", role: "member" });
    // and back: a new link is a join link again
    expect((await j(await call("POST", `/api/members/${annaId}/link`, { cookie: adminCookie }))).purpose).toBe("join");
  });
  test("passkeys: the last one cannot be deleted", async () => {
    const keys = await j(await call("GET", "/api/passkeys", { cookie: adminCookie }));
    expect(keys.length).toBe(1);
    expect((await call("DELETE", `/api/passkeys/${keys[0].id}`, { cookie: adminCookie })).status).toBe(409);
  });
  test("sessions: listed with the current one marked, another can be ended, logout ends this one", async () => {
    const other = cookieOf(await login(admin))!;
    const list = await j(await call("GET", "/api/sessions", { cookie: adminCookie }));
    expect(list.filter((s: any) => s.current).length).toBe(1);
    const victim = list.find((s: any) => !s.current);
    expect((await call("DELETE", `/api/sessions/${victim.id}`, { cookie: adminCookie })).status).toBe(200);
    expect((await call("GET", "/api/account", { cookie: other })).status).toBe(401);
    const out = await call("POST", "/api/auth/logout", { cookie: adminCookie });
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/api/account", { cookie: adminCookie })).status).toBe(401);
    adminCookie = cookieOf(await login(admin))!;
  });
  test("an SPKI key from before the module still signs in", async () => {
    const old = await Key.make(-7);
    db.query("INSERT INTO auth_passkey (id, account_id, public_key, alg, sign_count, name, created_at) VALUES (?, 1, ?, -7, 0, 'old', ?)").run(old.id, await old.spki(), Date.now());
    expect((await login(old)).status).toBe(200);
  });

  describe("devices", () => {
    let phone: { token: string; deviceId: number };
    test("a pairing code works once, tolerates case and dashes, and is stored hashed", async () => {
      const { code } = await j(await call("POST", "/api/devices/pair", { cookie: adminCookie }));
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
      const claim = (c: string, kind = "phone") => call("POST", "/api/devices/claim", { origin: null, json: { code: c, name: "P", kind } });
      expect((await claim(code, "toaster")).status).toBe(400);
      phone = await j(await claim(`${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`));
      expect(phone.token).toBeTruthy();
      expect((await claim(code)).status).toBe(403);
      expect(JSON.stringify(db.query("SELECT * FROM auth_pairing").all())).not.toContain(code);
    });
    test("a device has its scopes and nothing of a browser", async () => {
      const req = new Request(ORIGIN + "/x", { headers: { authorization: `Bearer ${phone.token}` } });
      const p = (await A.principal(req))!;
      expect(p.kind).toBe("device"); expect(A.can(p, "upload")).toBe(true); expect(A.can(p, "export")).toBe(false);
      expect((await call("GET", "/api/members", { bearer: phone.token })).status).toBe(403);
      expect((await call("POST", "/api/devices/pair", { bearer: phone.token })).status).toBe(403);
      const s = await call("POST", "/api/devices/session", { bearer: phone.token });
      expect(s.status).toBe(200);
      expect(await j(await call("GET", "/api/auth/state", { cookie: cookieOf(s) }))).toMatchObject({ loggedIn: false, device: true, me: null });
      expect((await j(await call("GET", "/api/devices", { cookie: adminCookie })))[0]).toMatchObject({ kind: "phone", scopes: ["upload"], extra: 1 });
    });
    test("revoking ends the token and its sessions", async () => {
      expect((await call("DELETE", `/api/devices/${phone.deviceId}`, { cookie: adminCookie })).status).toBe(200);
      expect(await A.principal(new Request(ORIGIN, { headers: { authorization: `Bearer ${phone.token}` } }))).toBeNull();
    });
  });

  test("the command line: invite, members, reset-passkeys", async () => {
    const out = (await A.cli(["invite", "Dora", "--admin", "--colour", "red"]))!;
    expect(out).toContain("Dora is invited as admin");
    expect(db.query("SELECT role, colour FROM people WHERE name = 'Dora'").get()).toEqual({ role: "admin", colour: "red" });
    expect(await A.cli(["members"])).toContain("Dora  admin  invited");
    const reset = (await A.cli(["reset-passkeys", "Me"]))!;
    expect(reset).toContain("replaces their existing passkeys");
    expect(await j(await call("POST", "/api/auth/link", { json: { token: tokenOf(reset.trim().split(/\s+/).pop()!) } }))).toMatchObject({ purpose: "recover", name: "Me" });
    await expect(A.cli(["reset-passkeys", "Nobody"])).rejects.toThrow(/nobody called/);
    await expect(A.cli(["invite"])).rejects.toThrow(/usage/);
    expect(await A.cli(["serve"])).toBeNull();
  });
  test("login and registration are limited to 10 a minute per address", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call("POST", "/api/auth/login/options", { ip: "10.200.0.1" })).status);
    expect(codes.slice(0, 10).every(c => c === 200)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
  test("routes that are not the module's are left to the app", async () => {
    expect(await A.handle(new Request(ORIGIN + "/api/timeline"), "10.0.0.1")).toBeNull();
    expect(await A.handle(new Request(ORIGIN + "/"), "10.0.0.1")).toBeNull();
  });
});
