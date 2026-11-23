// Who is asking: the fleet's accounts module (server/accounts, docs/accounts.md) configured for peppermint. Passkeys,
// links, roles, sessions and rate limits live there; this file only says what is peppermint's.
import { db } from "./db";
import { createAccounts } from "./accounts";

const PORT = Number(process.env.PORT ?? 4317);
export const ORIGIN = process.env.PEPPERMINT_ORIGIN ?? `http://localhost:${PORT}`;
/** The first run's token. Without one in the environment the server makes one and prints the link at start. */
export const SETUP_TOKEN = process.env.PEPPERMINT_SETUP_TOKEN || Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
export const COOKIE = "__Host-peppermint";
// A new reader starts with an empty palate: no weights, no rules. What they open, save, wave off and set by hand
// fills it in; their own topics (server/topics.ts) give it a head start.

export const accounts = createAccounts({
  db, table: "users", app: "peppermint", origin: ORIGIN, cookie: COOKIE, lang: "en", setupToken: SETUP_TOKEN,
  // Lax, not Strict: the morning briefing mail and shared links open peppermint from elsewhere and must arrive signed
  // in. Cross-site POSTs still carry no cookie, and every state-changing request is checked for our origin.
  sameSite: "Lax",
  // the Android app (android/, docs/android.md): it fetches episodes and the edition to listen to, nothing else
  devices: { android: "listen" },
  // sources, a palate, writing, settings: a reader who has any of these is never deleted, only signed out for good
  hasData: id => !!db.query("SELECT 1 FROM sources WHERE owner_id = ? UNION ALL SELECT 1 FROM affinities WHERE owner_id = ? UNION ALL SELECT 1 FROM drafts WHERE owner_id = ? UNION ALL SELECT 1 FROM settings WHERE owner_id = ? LIMIT 1").get(id, id, id, id),
});

/** The signed-in reader in a browser, or null. A paired phone is no reader: main.ts lets it through only on the routes
 *  that name its scope. */
export async function ownerFromRequest(req: Request): Promise<number | null> {
  const p = await accounts.principal(req);
  return p?.kind === "browser" ? p.owner : null;
}
/** A browser session for a reader, as the login makes one (tests use it to sign in without a ceremony). */
export const createSession = (owner: number) => accounts.createSession(owner, "browser", null, null);

/* ---------- several accounts in one browser ---------- */
// Someone with two accounts (their own and a shared one, say) switches with one tap instead of signing out and in.
// The browser keeps the sessions of the accounts it is not showing in a second cookie, as HttpOnly as the first;
// each is a real session in auth_session, so it can be ended from any browser and expires like any other. Switching
// swaps which token sits in which cookie. Signing out ends only the account in front and brings the next one forward.
// This lives here, not in the shared accounts module, because it only moves tokens between two cookies.
export const MORE = "__Host-peppermint-more";
const MAX_MORE = 4;
const moreRe = new RegExp(`(?:^|;\\s*)${MORE}=([^;]+)`);
const mainRe = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`);
const TOKEN = /^[A-Za-z0-9_-]{40,64}$/;
const tokensIn = (req: Request) => (moreRe.exec(req.headers.get("cookie") ?? "")?.[1] ?? "").split(".").filter(t => TOKEN.test(t));
const mainToken = (req: Request) => mainRe.exec(req.headers.get("cookie") ?? "")?.[1] ?? null;
const moreCookie = (toks: string[]) => toks.length
  ? `${MORE}=${toks.join(".")}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${180 * 86400}`
  : `${MORE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
/** Whose browser session a token is, or null once it has ended. */
async function ownerOfToken(tok: string | null): Promise<number | null> {
  if (!tok) return null;
  const p = await accounts.principal(new Request(ORIGIN, { headers: { cookie: `${COOKIE}=${tok}` } }));
  return p?.kind === "browser" ? p.owner : null;
}
const nameOf = (id: number) => (db.query("SELECT name FROM users WHERE id = ?").get(id) as { name: string } | null)?.name ?? "";
/** The other accounts' live tokens, one per account and none for the one in front. */
async function others(req: Request, current: number | null) {
  const out: { owner: number; tok: string }[] = [];
  for (const tok of tokensIn(req)) {
    const owner = await ownerOfToken(tok);
    if (owner && owner !== current && !out.some(o => o.owner === owner)) out.push({ owner, tok });
  }
  return out.slice(0, MAX_MORE);
}
function reply(data: unknown, cookies: string[]) {
  const h = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) h.append("set-cookie", c);
  return new Response(JSON.stringify(data), { headers: h });
}

/** GET /api/auth/accounts, POST /api/auth/switch {id}, POST /api/auth/add, and sign-out that keeps the others. */
export async function keyring(req: Request, path: string): Promise<Response | null> {
  const known = (req.method === "GET" && path === "/api/auth/accounts") || (req.method === "POST" && ["/api/auth/switch", "/api/auth/add", "/api/auth/logout"].includes(path));
  if (!known) return null;
  if (req.method === "POST" && !accounts.sameOrigin(req)) return accounts.json({ error: "Cross-site request refused." }, 403);
  const tok = mainToken(req), current = await ownerOfToken(tok), rest = await others(req, current);
  if (path === "/api/auth/accounts") {
    return reply({ current: current ? { id: current, name: nameOf(current) } : null, others: rest.map(o => ({ id: o.owner, name: nameOf(o.owner) })) }, [moreCookie(rest.map(o => o.tok))]);
  }
  if (path === "/api/auth/switch") {
    let b: any = {}; try { b = await req.json(); } catch {}
    const to = rest.find(o => o.owner === Number(b?.id));
    if (!to) return accounts.json({ error: "That account is no longer signed in here. Sign in to it again." }, 404);
    const keep = [...(current && tok ? [tok] : []), ...rest.filter(o => o !== to).map(o => o.tok)].slice(0, MAX_MORE);
    return reply({ ok: true }, [accounts.sessionCookie(to.tok), moreCookie(keep)]);
  }
  if (path === "/api/auth/add") {
    // the account in front steps back; the sign-in page then makes a session for the next one
    const keep = [...(current && tok ? [tok] : []), ...rest.map(o => o.tok)].slice(0, MAX_MORE);
    return reply({ ok: true }, [accounts.clearCookie(), moreCookie(keep)]);
  }
  // sign out: this account's session ends; the next signed-in account comes forward
  await accounts.endSession(req);
  const [next, ...after] = rest;
  return reply({ ok: true, switched: !!next }, [next ? accounts.sessionCookie(next.tok) : accounts.clearCookie(), moreCookie(after.map(o => o.tok))]);
}
