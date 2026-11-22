// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// Accounts for a small group that trusts each other: passkeys only, one-time links for everything that has no
// passkey yet, two roles, sessions and paired devices. Everything that decides "who is asking" is in this folder.
// docs/accounts.md is the contract; read it before changing a rule here.
//
//   const accounts = createAccounts({ db, table: "owner", app: "Monet", origin, cookie: "__Host-monet", lang: "de", ... });
//   const r = await accounts.handle(req, ip);   // the module's own routes, or null for everything else
//   const p = await accounts.principal(req);    // who is asking, for the app's routes
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { AccountDevice, AccountLink, AccountLinkPreview, AccountMe, AccountMember, AccountPasskey, AccountRole, AccountSession, AccountState, LinkPurpose } from "../../shared/accounts";
import { MESSAGES, type Lang, type MessageKey } from "./messages";
import { AuthError, b64u, randomToken, sha256, sha256hex, verifyAssertion, verifyRegistration, type Rp } from "./webauthn";

export { migrateAccounts, tableExists } from "./schema";
export { AuthError } from "./webauthn";

export type Principal = {
  owner: number; role: AccountRole; kind: "browser" | "device"; deviceId: number | null;
  scopes: Set<string>; sessionHash: string | null; viaBearer: boolean;
};

export type AccountsConfig = {
  db: Database;
  /** The app's account table (id, name, created_at; the module adds role). */
  table: string;
  /** Shown in the passkey prompt and the password manager. */
  app: string;
  /** The public origin, https in production. Passkeys are bound to its host name. */
  origin: string;
  /** `__Host-<app>`: Secure, Path=/, no Domain, so no subdomain can set or read it. */
  cookie: string;
  /** Strict unless people open the app from links in mail or other sites and must arrive signed in (then Lax). */
  sameSite?: "Strict" | "Lax";
  lang: Lang;
  /** The first run's token (`<APP>_SETUP_TOKEN`). It works only while no passkey exists at all. */
  setupToken?: string | null;
  /** Where links open; the token follows in the fragment, which no server or log ever sees. */
  linkPath?: string;
  /** Kinds of paired devices and the scopes each gets, for example { android: "upload,index" }. None: no pairing. */
  devices?: Record<string, string>;
  /** Extra fields per device in GET /api/devices. */
  deviceInfo?: (id: number) => Record<string, unknown>;
  /** Called inside the transaction that creates an account, with the invite's request body (or the CLI's --key value). */
  onCreate?: (id: number, input: Record<string, unknown>) => void;
  /** Called after an account's first passkey exists. */
  onJoin?: (id: number) => void;
  /** True when the account owns data of the app. Such an account is never deleted, only its access is taken away. */
  hasData?: (id: number) => boolean;
};

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** A session lives 30 days after its last use and 180 days at most; then the passkey asks again. */
const IDLE_MS = 30 * DAY, MAX_MS = 180 * DAY;
const LINK_MS: Record<Exclude<LinkPurpose, "setup">, number> = { join: 7 * DAY, recover: DAY, add: HOUR };
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0, 1
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type Ceremony = { exp: number; kind: "register" | "login"; mode?: "setup" | "link" | "session"; account?: number; linkHash?: string };
type Ctx = { req: Request; url: URL; p: Principal | null; m: RegExpExecArray; ip: string };
type Handler = (c: Ctx) => Response | Promise<Response>;

async function safeEqual(a: string, b: string) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return timingSafeEqual(x, y);
}
const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function createAccounts(cfg: AccountsConfig) {
  const { db } = cfg, T = cfg.table, now = () => Date.now();
  if (!/^[a-z_]+$/.test(T)) throw new Error(`accounts: bad table name ${T}`);
  const RP: Rp = { id: new URL(cfg.origin).hostname, origin: cfg.origin };
  const LINK = cfg.origin + (cfg.linkPath ?? "/setup") + "#";
  const SAME_SITE = cfg.sameSite ?? "Strict";
  const M = MESSAGES[cfg.lang];
  const t = (k: MessageKey) => M[k];
  const no = (status: number, key: MessageKey) => new AuthError(status, key);

  // someone must always be able to invite and recover: with accounts but no admin (a database from before roles),
  // the first person who has a passkey becomes admin, else the first account
  if (!db.query(`SELECT 1 FROM ${T} WHERE role = 'admin'`).get()) {
    db.query(`UPDATE ${T} SET role = 'admin' WHERE id = coalesce((SELECT min(account_id) FROM auth_passkey), (SELECT min(id) FROM ${T}))`).run();
  }

  /* ---------- small reads ---------- */
  type Row = { id: number; name: string; role: AccountRole };
  const account = (id: number) => db.query(`SELECT id, name, role FROM ${T} WHERE id = ?`).get(id) as Row | null;
  const byName = (name: string) => db.query(`SELECT id, name, role FROM ${T} WHERE lower(name) = lower(?)`).get(name) as Row | null;
  const hasPasskey = () => !!db.query("SELECT 1 FROM auth_passkey LIMIT 1").get();
  const passkeyCount = (id: number) => (db.query("SELECT count(*) AS n FROM auth_passkey WHERE account_id = ?").get(id) as { n: number }).n;
  const adminCount = () => (db.query(`SELECT count(*) AS n FROM ${T} WHERE role = 'admin'`).get() as { n: number }).n;
  const setupOpen = () => !!cfg.setupToken && !hasPasskey();
  const me = (p: Principal): AccountMe => { const a = account(p.owner)!; return { id: a.id, name: a.name, role: a.role }; };

  /* ---------- challenges: single use, five minutes, at most 1000 open ---------- */
  const challenges = new Map<string, Ceremony>();
  function newChallenge(c: Omit<Ceremony, "exp">) {
    const ch = randomToken(32);
    for (const [k, v] of challenges) if (v.exp < now()) challenges.delete(k);
    // the options endpoints are public; the per-address limit alone does not bound many addresses. Map keeps
    // insertion order, so the oldest open ceremonies go first.
    while (challenges.size >= 1000) challenges.delete(challenges.keys().next().value!);
    challenges.set(ch, { ...c, exp: now() + 5 * MIN });
    return ch;
  }
  function takeChallenge(c: string, kind: Ceremony["kind"]): Ceremony {
    const v = challenges.get(c); challenges.delete(c);
    if (!v || v.exp < now() || v.kind !== kind) throw no(400, "expiredCeremony");
    return v;
  }

  /* ---------- links ---------- */
  type LinkRow = { hash: string; account_id: number; purpose: Exclude<LinkPurpose, "setup">; expires_at: number };
  async function openLink(token: string): Promise<LinkRow | null> {
    return db.query("SELECT hash, account_id, purpose, expires_at FROM auth_link WHERE hash = ? AND used_at IS NULL AND expires_at > ?").get(await sha256hex(token), now()) as LinkRow | null;
  }
  /** A new link for an account. Its other open links stop working: only the newest one counts. */
  async function makeLink(id: number, purpose: Exclude<LinkPurpose, "setup">, by: number | null, ms = LINK_MS[purpose]): Promise<AccountLink> {
    const token = randomToken(18), expiresAt = now() + ms;
    const hash = await sha256hex(token);
    db.transaction(() => {
      db.query("DELETE FROM auth_link WHERE account_id = ? AND used_at IS NULL").run(id);
      db.query("DELETE FROM auth_link WHERE expires_at < ?").run(now() - 30 * DAY);
      db.query("INSERT INTO auth_link (hash, account_id, purpose, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(hash, id, purpose, by, now(), expiresAt);
    })();
    return { purpose, link: LINK + token, expiresAt, member: id };
  }
  async function preview(token: unknown): Promise<AccountLinkPreview> {
    if (typeof token !== "string" || !token || token.length > 200) throw no(404, "linkGone");
    const l = await openLink(token);
    if (l) return { purpose: l.purpose, name: account(l.account_id)?.name ?? null, expiresAt: l.expires_at };
    if (setupOpen() && await safeEqual(token, cfg.setupToken!)) return { purpose: "setup", name: null, expiresAt: null };
    throw no(404, "linkGone");
  }

  /* ---------- registration and login ---------- */
  async function registerOptions(token: unknown, p: Principal | null) {
    let mode: Ceremony["mode"], id: number | null = null, linkHash: string | undefined, purpose: LinkPurpose | null = null;
    const tok = typeof token === "string" && token.length <= 200 ? token : "";
    // a link wins over a session: opened in a browser where someone else is signed in, it still makes the passkey of
    // the person it was made for (the browser then belongs to them), never another key for whoever was signed in
    if (tok) {
      const l = await openLink(tok);
      if (l) { mode = "link"; id = l.account_id; linkHash = l.hash; purpose = l.purpose; }
      else if (setupOpen() && await safeEqual(tok, cfg.setupToken!)) mode = "setup";
      else throw no(403, "linkGone");
    } else if (p?.kind === "browser") { mode = "session"; id = p.owner; }
    else throw no(403, hasPasskey() ? "signIn" : "setupClosed");
    const row = id != null ? account(id) : db.query(`SELECT id, name, role FROM ${T} ORDER BY id LIMIT 1`).get() as Row | null;
    // only this person's own keys: someone else's passkey on the same phone must not block theirs
    const exclude = purpose === "recover" || !row ? [] : (db.query("SELECT id FROM auth_passkey WHERE account_id = ?").all(row.id) as { id: string }[]).map(c => ({ type: "public-key", id: c.id }));
    const who = row?.name ?? cfg.app;
    return {
      challenge: newChallenge({ kind: "register", mode, ...(id != null ? { account: id } : {}), ...(linkHash ? { linkHash } : {}) }),
      rp: { id: RP.id, name: cfg.app },
      user: { id: b64u.enc(new TextEncoder().encode(String(row?.id ?? 1))), name: who, displayName: who },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      attestation: "none", timeout: 120_000, excludeCredentials: exclude,
    };
  }

  /** The account the passkey now belongs to, and whether a link or the setup token made it (then the browser gets a
   *  fresh session for that account). */
  async function registerVerify(cred: unknown, name: unknown, p: Principal | null): Promise<{ owner: number; viaLink: boolean }> {
    const v = await verifyRegistration(cred, RP, ch => takeChallenge(ch, "register"));
    const c = v.ceremony, label = clean(name, 60) || "Passkey";
    let owner = 0, joined = false;
    db.transaction(() => {
      if (c.mode === "setup") {
        if (hasPasskey()) throw no(403, "setupClosed");
        owner = (db.query(`SELECT id FROM ${T} ORDER BY id LIMIT 1`).get() as { id: number } | null)?.id
          ?? (db.query(`INSERT INTO ${T} (name, created_at) VALUES (?, ?) RETURNING id`).get(t("firstName"), now()) as { id: number }).id;
        db.query(`UPDATE ${T} SET role = 'admin' WHERE id = ?`).run(owner);
        joined = true;
      } else if (c.mode === "link") {
        const l = db.query("UPDATE auth_link SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id, purpose").get(now(), c.linkHash!, now()) as { account_id: number; purpose: string } | null;
        if (!l || l.account_id !== c.account) throw no(403, "linkGone");
        owner = l.account_id;
        // joining means a first passkey ever; a recovery replaces keys someone already had
        joined = passkeyCount(owner) === 0 && l.purpose === "join";
        // a recovery means a passkey may be lost or stolen: its keys and every browser session go with it
        if (l.purpose === "recover") {
          db.query("DELETE FROM auth_passkey WHERE account_id = ?").run(owner);
          db.query("DELETE FROM auth_session WHERE account_id = ? AND kind = 'browser'").run(owner);
        }
      } else {
        if (p?.kind !== "browser" || p.owner !== c.account) throw no(401, "signIn");
        owner = p.owner;
      }
      try {
        db.query("INSERT INTO auth_passkey (id, account_id, public_key, alg, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(v.credId, owner, v.publicKey, v.alg, v.signCount, label, now());
      } catch (e) {
        if (String((e as Error).message).includes("UNIQUE")) throw no(409, "alreadyRegistered");
        throw e;
      }
    })();
    if (joined) cfg.onJoin?.(owner);
    return { owner, viaLink: c.mode !== "session" };
  }

  const loginOptions = () => ({ challenge: newChallenge({ kind: "login" }), rpId: RP.id, userVerification: "required", timeout: 120_000, allowCredentials: [] });
  async function loginVerify(cred: unknown): Promise<number> {
    const { row, signCount } = await verifyAssertion(cred, RP, ch => takeChallenge(ch, "login"),
      id => db.query("SELECT id, account_id, public_key, alg, sign_count FROM auth_passkey WHERE id = ?").get(id) as { id: string; account_id: number; public_key: Uint8Array; alg: number; sign_count: number } | null);
    db.query("UPDATE auth_passkey SET sign_count = ?, last_used_at = ? WHERE id = ?").run(signCount, now(), row.id);
    return row.account_id;
  }

  /* ---------- sessions and principals ---------- */
  async function createSession(owner: number, kind: "browser" | "device", deviceId: number | null, ua: string | null) {
    const token = randomToken(32);
    db.query("INSERT INTO auth_session (hash, account_id, kind, device_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(await sha256hex(token), owner, kind, deviceId, now(), now() + IDLE_MS, now(), ua?.slice(0, 200) ?? null);
    db.query("DELETE FROM auth_session WHERE expires_at < ? OR created_at < ?").run(now(), now() - MAX_MS);
    return token;
  }
  // the browser keeps the cookie for the longest a session can live; the server decides when it is over
  const sessionCookie = (token: string) => `${cfg.cookie}=${token}; Path=/; Secure; HttpOnly; SameSite=${SAME_SITE}; Max-Age=${MAX_MS / 1000}`;
  const clearCookie = () => `${cfg.cookie}=; Path=/; Secure; HttpOnly; SameSite=${SAME_SITE}; Max-Age=0`;
  const cookieRe = new RegExp(`(?:^|;\\s*)${cfg.cookie.replace(/[^\w-]/g, "\\$&")}=([^;]+)`);
  const cookieOf = (req: Request) => cookieRe.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;

  type DeviceRow = { id: number; account_id: number; scopes: string; revoked_at: number | null; last_seen_at: number | null; role: AccountRole };
  const DEVICE = `SELECT d.id, d.account_id, d.scopes, d.revoked_at, d.last_seen_at, a.role FROM auth_device d JOIN ${T} a ON a.id = d.account_id`;
  function devicePrincipal(d: DeviceRow | null, viaBearer: boolean, sessionHash: string | null): Principal | null {
    if (!d || d.revoked_at) return null;
    if (!d.last_seen_at || d.last_seen_at < now() - MIN) db.query("UPDATE auth_device SET last_seen_at = ? WHERE id = ?").run(now(), d.id);
    return { owner: d.account_id, role: d.role, kind: "device", deviceId: d.id, scopes: new Set(d.scopes.split(",").filter(Boolean)), sessionHash, viaBearer };
  }

  async function principal(req: Request): Promise<Principal | null> {
    const auth = req.headers.get("authorization");
    if (auth?.startsWith("Bearer ")) {
      if (!cfg.devices) return null;
      return devicePrincipal(db.query(`${DEVICE} WHERE d.token_hash = ?`).get(await sha256hex(auth.slice(7).trim())) as DeviceRow | null, true, null);
    }
    const tok = cookieOf(req);
    if (!tok || tok.length > 100) return null;
    const hash = await sha256hex(tok);
    const s = db.query(`SELECT s.account_id, s.kind, s.device_id, s.created_at, s.expires_at, s.last_seen_at, a.role FROM auth_session s JOIN ${T} a ON a.id = s.account_id WHERE s.hash = ?`).get(hash) as
      { account_id: number; kind: "browser" | "device"; device_id: number | null; created_at: number; expires_at: number; last_seen_at: number; role: AccountRole } | null;
    if (!s || s.expires_at < now() || s.created_at < now() - MAX_MS) return null;
    // sliding window, written at most once an hour
    if (s.last_seen_at < now() - HOUR) db.query("UPDATE auth_session SET last_seen_at = ?, expires_at = ? WHERE hash = ?").run(now(), Math.min(now() + IDLE_MS, s.created_at + MAX_MS), hash);
    if (s.kind === "device") return devicePrincipal(db.query(`${DEVICE} WHERE d.id = ?`).get(s.device_id) as DeviceRow | null, false, hash);
    return { owner: s.account_id, role: s.role, kind: "browser", deviceId: null, scopes: new Set(["*"]), sessionHash: hash, viaBearer: false };
  }
  const can = (p: Principal, scope: string) => p.scopes.has("*") || p.scopes.has(scope);
  async function endSession(req: Request) {
    const tok = cookieOf(req);
    if (tok) db.query("DELETE FROM auth_session WHERE hash = ?").run(await sha256hex(tok));
  }

  /* ---------- members ---------- */
  function members(viewer: Principal): AccountMember[] {
    const admin = viewer.role === "admin";
    const rows = db.query(`SELECT a.id, a.name, a.role, a.created_at,
        (SELECT count(*) FROM auth_passkey k WHERE k.account_id = a.id) AS keys,
        (SELECT max(s.last_seen_at) FROM auth_session s WHERE s.account_id = a.id AND s.kind = 'browser') AS seen,
        (SELECT l.purpose FROM auth_link l WHERE l.account_id = a.id AND l.used_at IS NULL AND l.expires_at > ? ORDER BY l.created_at DESC LIMIT 1) AS lp,
        (SELECT l.expires_at FROM auth_link l WHERE l.account_id = a.id AND l.used_at IS NULL AND l.expires_at > ? ORDER BY l.created_at DESC LIMIT 1) AS le
      FROM ${T} a ORDER BY a.id`).all(now(), now()) as { id: number; name: string; role: AccountRole; created_at: number; keys: number; seen: number | null; lp: any; le: number | null }[];
    return rows.map(r => ({
      id: r.id, name: r.name, role: r.role, you: r.id === viewer.owner,
      status: r.keys ? "active" : r.lp ? "invited" : "none", passkeys: r.keys, createdAt: r.created_at, lastSeenAt: r.seen,
      link: admin && r.lp ? { purpose: r.lp, expiresAt: r.le! } : null,
    }));
  }
  function checkName(name: unknown, except: number | null): string {
    const n = clean(name, 40);
    if (!n) throw no(400, "nameMissing");
    const other = byName(n);
    if (other && other.id !== except) throw no(409, "nameTaken");
    return n;
  }
  /** A new person: their account now, a link that makes their first passkey within a week. */
  async function invite(by: number | null, name: unknown, role: AccountRole, input: Record<string, unknown> = {}): Promise<AccountLink> {
    const n = checkName(name, null);
    const id = db.transaction(() => {
      const id = (db.query(`INSERT INTO ${T} (name, role, created_at) VALUES (?, ?, ?) RETURNING id`).get(n, role, now()) as { id: number }).id;
      cfg.onCreate?.(id, input);
      return id;
    })();
    return makeLink(id, "join", by);
  }
  /** The right link for someone: recovery if they have passkeys, else joining. For yourself: one more passkey. */
  function linkFor(by: Principal, id: number, ms?: number): Promise<AccountLink> {
    if (!account(id)) throw no(404, "noSuchMember");
    if (id === by.owner) return makeLink(id, "add", by.owner, ms);
    return makeLink(id, passkeyCount(id) ? "recover" : "join", by.owner, ms);
  }
  function setRole(id: number, role: unknown) {
    if (role !== "admin" && role !== "member") throw no(400, "badRequest");
    const a = account(id); if (!a) throw no(404, "noSuchMember");
    if (a.role === "admin" && role === "member" && adminCount() <= 1) throw no(409, "lastAdmin");
    db.query(`UPDATE ${T} SET role = ? WHERE id = ?`).run(role, id);
  }
  /** Takes away someone's access: passkeys, sessions, devices and links. An account that never joined and owns no
   *  data is deleted outright; everyone else stays, with their data, and can be given a new link later. */
  function remove(id: number): "deleted" | "revoked" {
    const a = account(id); if (!a) throw no(404, "noSuchMember");
    if (a.role === "admin" && adminCount() <= 1) throw no(409, "lastAdmin");
    const everUsedLink = !!db.query("SELECT 1 FROM auth_link WHERE account_id = ? AND used_at IS NOT NULL").get(id);
    if (!passkeyCount(id) && !everUsedLink && !(cfg.hasData?.(id) ?? true)) {
      try { db.query(`DELETE FROM ${T} WHERE id = ?`).run(id); return "deleted"; }
      catch (e) { if (!String((e as Error).message).includes("FOREIGN KEY")) throw e; } // the app holds rows for it after all
    }
    db.transaction(() => {
      db.query("DELETE FROM auth_passkey WHERE account_id = ?").run(id);
      db.query("DELETE FROM auth_session WHERE account_id = ?").run(id);
      db.query("DELETE FROM auth_link WHERE account_id = ? AND used_at IS NULL").run(id);
      db.query("DELETE FROM auth_pairing WHERE account_id = ?").run(id);
      db.query("UPDATE auth_device SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL").run(now(), id);
      db.query(`UPDATE ${T} SET role = 'member' WHERE id = ?`).run(id);
    })();
    return "revoked";
  }

  /* ---------- pairing and devices ---------- */
  async function createPairing(owner: number) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const code = Array.from(bytes, b => CODE_ALPHABET[b % 32]).join(""); // 256 % 32 == 0: no modulo bias
    const expiresAt = now() + 10 * MIN;
    db.query("INSERT INTO auth_pairing (code_hash, account_id, expires_at) VALUES (?, ?, ?)").run(await sha256hex(code), owner, expiresAt);
    db.query("DELETE FROM auth_pairing WHERE expires_at < ?").run(now() - DAY);
    return { code, expiresAt };
  }
  async function claimPairing(code: unknown, name: unknown, kind: unknown) {
    if (typeof code !== "string" || typeof kind !== "string" || !cfg.devices || !Object.hasOwn(cfg.devices, kind)) throw no(400, "badRequest");
    const hash = await sha256hex(code.trim().toUpperCase().replace(/[\s-]/g, ""));
    // one atomic UPDATE, so two devices cannot both claim a code
    const p = db.query("UPDATE auth_pairing SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING account_id").get(now(), hash, now()) as { account_id: number } | null;
    if (!p) throw no(403, "codeInvalid");
    const token = randomToken(32);
    const d = db.query("INSERT INTO auth_device (account_id, name, kind, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(p.account_id, clean(name, 60) || kind, kind, await sha256hex(token), cfg.devices[kind], now()) as { id: number };
    return { token, deviceId: d.id };
  }
  function revokeDevice(owner: number, id: number): boolean {
    const r = db.query("UPDATE auth_device SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL").run(now(), id, owner);
    db.query("DELETE FROM auth_session WHERE device_id = ? AND account_id = ?").run(id, owner);
    return r.changes > 0;
  }

  /* ---------- rate limits (in memory) ---------- */
  const hits = new Map<string, number[]>();
  /** True when this key has used up `max` calls in the last minute. Counts the call. */
  function limited(key: string, max: number): boolean {
    const n = now(), a = (hits.get(key) ?? []).filter(x => x > n - MIN);
    a.push(n); hits.set(key, a);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => x > n - MIN)) hits.delete(k);
    return a.length > max;
  }
  /** The proxy in front sets X-Forwarded-For (nginx from CF-Connecting-IP) and overwrites what the client sent. */
  const clientIp = (req: Request, fallback: string) => (req.headers.get("x-forwarded-for") ?? fallback).split(",")[0].trim();
  /** For state-changing requests. Bearer requests carry no cookie, so there is nothing to forge. */
  function sameOrigin(req: Request): boolean {
    if (req.headers.get("authorization")?.startsWith("Bearer ")) return true;
    const o = req.headers.get("origin");
    if (o) return o === cfg.origin;
    return req.headers.get("sec-fetch-site") === "same-origin";
  }

  /* ---------- HTTP ---------- */
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
  async function body(req: Request): Promise<Record<string, any>> {
    const text = await req.text();
    if (text.length > 64 * 1024) throw no(413, "tooLarge");
    if (!text) return {};
    try { const v = JSON.parse(text); if (v && typeof v === "object" && !Array.isArray(v)) return v; } catch {}
    throw no(400, "badRequest");
  }
  const browser = (p: Principal | null): Principal => { if (!p) throw no(401, "signIn"); if (p.kind !== "browser") throw no(403, "forbidden"); return p; };
  const admin = (p: Principal | null): Principal => { const q = browser(p); if (q.role !== "admin") throw no(403, "adminOnly"); return q; };
  const id = (s: string) => { const n = Number(s); if (!Number.isInteger(n) || n <= 0) throw no(404, "notFound"); return n; };
  const throttle = (c: Ctx, bucket: string, max: number) => { if (limited(`${bucket}:${c.ip}`, max)) throw no(429, "tooMany"); };
  const ua = (req: Request) => req.headers.get("user-agent");
  const withSession = async (owner: number, req: Request, data: unknown = { ok: true }) =>
    json(data, 200, { "set-cookie": sessionCookie(await createSession(owner, "browser", null, ua(req))) });
  const state = (p: Principal | null): AccountState => ({
    setupOpen: setupOpen(), loggedIn: p?.kind === "browser", device: p?.kind === "device", hasCredential: hasPasskey(),
    me: p?.kind === "browser" ? me(p) : null,
  });

  const routes: [string, RegExp, Handler][] = [];
  const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path}$`), h]);

  route("GET", "/api/auth/state", c => json(state(c.p)));
  route("POST", "/api/auth/link", async c => { throttle(c, "login", 10); return json(await preview((await body(c.req)).token)); });
  route("POST", "/api/auth/register/options", async c => { throttle(c, "login", 10); return json(await registerOptions((await body(c.req)).token, c.p)); });
  route("POST", "/api/auth/register/verify", async c => {
    throttle(c, "login", 10);
    const b = await body(c.req);
    const r = await registerVerify(b.credential, b.name, c.p);
    // a signed-in browser adding a key keeps its session; a link or the setup token signs this browser in as the
    // person the passkey is for, and ends whoever was signed in before
    if (!r.viaLink) return json({ ok: true });
    if (c.p?.kind === "browser") await endSession(c.req);
    return withSession(r.owner, c.req);
  });
  route("POST", "/api/auth/login/options", c => { throttle(c, "login", 10); return json(loginOptions()); });
  route("POST", "/api/auth/login/verify", async c => { throttle(c, "login", 10); return withSession(await loginVerify((await body(c.req)).credential), c.req); });
  route("POST", "/api/auth/logout", async c => { await endSession(c.req); return json({ ok: true }, 200, { "set-cookie": clearCookie() }); });

  route("GET", "/api/account", c => json(me(browser(c.p))));
  route("PATCH", "/api/account", async c => {
    const p = browser(c.p), b = await body(c.req);
    if (b.name !== undefined) db.query(`UPDATE ${T} SET name = ? WHERE id = ?`).run(checkName(b.name, p.owner), p.owner);
    return json(me(p));
  });
  route("POST", "/api/account/link", async c => { const p = browser(c.p); return json(await makeLink(p.owner, "add", p.owner)); });

  route("GET", "/api/passkeys", c => {
    const p = browser(c.p);
    return json(db.query("SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM auth_passkey WHERE account_id = ? ORDER BY created_at").all(p.owner) as AccountPasskey[]);
  });
  route("DELETE", "/api/passkeys/([A-Za-z0-9_-]{1,1400})", c => {
    const p = browser(c.p);
    if (passkeyCount(p.owner) <= 1) throw no(409, "lastPasskey");
    if (!db.query("DELETE FROM auth_passkey WHERE id = ? AND account_id = ?").run(c.m[1], p.owner).changes) throw no(404, "notFound");
    return json({ ok: true });
  });
  route("GET", "/api/sessions", c => {
    const p = browser(c.p);
    const rows = db.query("SELECT s.hash, s.kind, s.created_at, s.last_seen_at, s.user_agent, d.name AS device FROM auth_session s LEFT JOIN auth_device d ON d.id = s.device_id WHERE s.account_id = ? AND s.expires_at > ? ORDER BY s.last_seen_at DESC").all(p.owner, now()) as any[];
    return json(rows.map((r): AccountSession => ({ id: r.hash.slice(0, 16), kind: r.kind, device: r.device, createdAt: r.created_at, lastSeenAt: r.last_seen_at, userAgent: r.user_agent, current: r.hash === p.sessionHash })));
  });
  route("DELETE", "/api/sessions/([0-9a-f]{16})", c => {
    const p = browser(c.p);
    db.query("DELETE FROM auth_session WHERE account_id = ? AND substr(hash, 1, 16) = ?").run(p.owner, c.m[1]);
    return json({ ok: true });
  });

  route("GET", "/api/members", c => json(members(browser(c.p))));
  route("POST", "/api/members", async c => {
    const p = admin(c.p), b = await body(c.req);
    return json(await invite(p.owner, b.name, b.role === "admin" ? "admin" : "member", b));
  });
  route("POST", "/api/members/(\\d+)/link", async c => json(await linkFor(admin(c.p), id(c.m[1]))));
  route("PATCH", "/api/members/(\\d+)", async c => {
    const p = admin(c.p), who = id(c.m[1]), b = await body(c.req);
    if (!account(who)) throw no(404, "noSuchMember");
    db.transaction(() => {
      if (b.name !== undefined) db.query(`UPDATE ${T} SET name = ? WHERE id = ?`).run(checkName(b.name, who), who);
      if (b.role !== undefined) setRole(who, b.role);
    })();
    return json(members(p).find(m => m.id === who));
  });
  route("DELETE", "/api/members/(\\d+)", c => { admin(c.p); return json({ ok: true, result: remove(id(c.m[1])) }); });

  if (cfg.devices) {
    route("POST", "/api/devices/pair", async c => json(await createPairing(browser(c.p).owner)));
    route("POST", "/api/devices/claim", async c => { throttle(c, "claim", 5); const b = await body(c.req); return json(await claimPairing(b.code, b.name, b.kind)); });
    // a device's own web view (Monet's Mac agent) trades its token for a cookie with the same scopes
    route("POST", "/api/devices/session", async c => {
      const p = c.p;
      if (!p?.viaBearer || p.deviceId == null) throw no(401, "needsDeviceToken");
      return json({ ok: true }, 200, { "set-cookie": sessionCookie(await createSession(p.owner, "device", p.deviceId, ua(c.req))) });
    });
    route("GET", "/api/devices", c => {
      const p = browser(c.p);
      const rows = db.query("SELECT id, name, kind, scopes, created_at, last_seen_at, revoked_at FROM auth_device WHERE account_id = ? ORDER BY created_at DESC").all(p.owner) as any[];
      return json(rows.map((r): AccountDevice => ({ id: r.id, name: r.name, kind: r.kind, scopes: r.scopes.split(","), createdAt: r.created_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at, ...(cfg.deviceInfo?.(r.id) ?? {}) })));
    });
    route("DELETE", "/api/devices/(\\d+)", c => { if (!revokeDevice(browser(c.p).owner, id(c.m[1]))) throw no(404, "notFound"); return json({ ok: true }); });
  }

  /** The module's routes. Null when the request is not one of them, so the app goes on with its own. */
  async function handle(req: Request, ip: string): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return null;
    for (const [method, re, h] of routes) {
      if (method !== req.method) continue;
      const m = re.exec(url.pathname);
      if (!m) continue;
      try {
        if (STATE_CHANGING.has(req.method) && url.pathname !== "/api/devices/claim" && !sameOrigin(req)) throw no(403, "otherOrigin");
        return await h({ req, url, p: await principal(req), m, ip });
      } catch (e) {
        if (e instanceof AuthError) return json({ error: t(e.key as MessageKey) ?? e.key }, e.status);
        throw e;
      }
    }
    return null;
  }

  /** `<app> invite <name> [--admin] [--key value ...]`, `<app> reset-passkeys [name]`, `<app> members`. Returns what
   *  to print, or null when argv is not one of these. Throws with a usage line on a wrong call. */
  async function cli(argv: string[], bin = cfg.app.toLowerCase()): Promise<string | null> {
    const [cmd, ...rest] = argv;
    if (cmd === "members") {
      const rows = members({ owner: 0, role: "admin" } as Principal);
      if (!rows.length) return "Nobody here yet. The setup link from the first start makes the first account.";
      return rows.map(m => `${String(m.id).padStart(4)}  ${m.name}  ${m.role}  ${m.status}${m.link ? `, open ${m.link.purpose} link until ${new Date(m.link.expiresAt).toISOString().slice(0, 16)}` : ""}`).join("\n");
    }
    if (cmd === "invite") {
      const name = rest[0];
      if (!name || name.startsWith("--")) throw new Error(`usage: ${bin} invite <name> [--admin] [--<field> <value> ...]`);
      const input: Record<string, unknown> = {}; let role: AccountRole = "member";
      for (let i = 1; i < rest.length; i++) {
        if (rest[i] === "--admin") role = "admin";
        else if (rest[i].startsWith("--") && rest[i + 1] !== undefined) input[rest[i].slice(2)] = rest[++i];
        else throw new Error(`usage: ${bin} invite <name> [--admin] [--<field> <value> ...]`);
      }
      try {
        const l = await invite(null, name, role, input);
        return `${name} is invited${role === "admin" ? " as admin" : ""}. Send them this link; it works once, within a week, and makes their first passkey:\n\n  ${l.link}`;
      } catch (e) { if (e instanceof AuthError) throw new Error(t(e.key as MessageKey)); throw e; }
    }
    if (cmd === "reset-passkeys") {
      const a = rest[0] ? byName(rest.join(" ")) : db.query(`SELECT id, name, role FROM ${T} WHERE role = 'admin' ORDER BY id LIMIT 1`).get() as Row | null;
      if (!a) throw new Error(rest[0] ? `nobody called ${rest.join(" ")} here (see: ${bin} members)` : "nobody here yet: open the setup link from the first start");
      const had = passkeyCount(a.id) > 0;
      const l = await makeLink(a.id, had ? "recover" : "join", null, HOUR);
      return `Open this link within an hour to make a new passkey for ${a.name}.${had ? " It replaces their existing passkeys and signs out their browsers." : ""}\n\n  ${l.link}`;
    }
    return null;
  }

  return {
    handle, principal, can, cli, state, limited, clientIp, sameOrigin, endSession, createSession, sessionCookie, clearCookie,
    hasPasskey, setupOpen, members, invite, remove, t, json, cookie: cfg.cookie,
  };
}
export type Accounts = ReturnType<typeof createAccounts>;
