// Who is asking: the fleet's accounts module (server/accounts, docs/accounts.md) configured for peppermint. Passkeys,
// links, roles, sessions and rate limits live there; this file only says what is peppermint's.
import { db, now } from "./db";
import { createAccounts } from "./accounts";

const PORT = Number(process.env.PORT ?? 4317);
export const ORIGIN = process.env.PEPPERMINT_ORIGIN ?? `http://localhost:${PORT}`;
/** The first run's token. Without one in the environment the server makes one and prints the link at start. */
export const SETUP_TOKEN = process.env.PEPPERMINT_SETUP_TOKEN || Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
export const COOKIE = "__Host-peppermint";

/** A new reader starts with a sensible palate; every value is visible and editable on the Palate page. */
export function seedOwner(owner: number) {
  if (db.query("SELECT 1 FROM sources WHERE owner_id = ? AND kind != 'agent'").get(owner)) return;
  const up = db.query("INSERT OR IGNORE INTO affinities (owner_id, kind, name, weight, manual, updated_at) VALUES (?, ?, ?, ?, 1, ?)");
  for (const [k, n, w] of [["topic", "Programming", 1.5], ["topic", "Databases", 1.5], ["topic", "Web development", 1.5], ["topic", "Infrastructure", 1], ["topic", "Security", 1], ["topic", "AI", 1], ["topic", "Transport", 1.5], ["topic", "Traffic", 1], ["topic", "Local politics", 0.5], ["topic", "Weather", 0.5], ["topic", "Celebrities", -2], ["topic", "Football", -1.5], ["topic", "Crime", -1.5], ["place", "München", 1.5]] as const)
    up.run(owner, k, n, w, now());
}

export const accounts = createAccounts({
  db, table: "users", app: "peppermint", origin: ORIGIN, cookie: COOKIE, lang: "en", setupToken: SETUP_TOKEN,
  // Lax, not Strict: the morning briefing mail and shared links open peppermint from elsewhere and must arrive signed
  // in. Cross-site POSTs still carry no cookie, and every state-changing request is checked for our origin.
  sameSite: "Lax",
  // the Android app (android/, docs/android.md): it fetches episodes and the edition to listen to, nothing else
  devices: { android: "listen" },
  onJoin: seedOwner,
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
