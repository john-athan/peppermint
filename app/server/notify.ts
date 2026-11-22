// Telling the writer something happened while they were away: a push notification on every device that allowed
// it, an email when none did. A notification that can publish carries the draft's id; the service worker shows a
// Publish button for it and calls the same publish route the app uses.
import { db, now, setting } from "./db";
import { sendPush, vapidKeys, type PushSub } from "./push";
import { send, validAddress } from "./mail";

export type Note = { title: string; body: string; url: string; tag?: string; publish?: number };

export function subscribe(owner: number, sub: PushSub, label: string) {
  if (!/^https:\/\/[^\s]+$/.test(sub?.endpoint ?? "") || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error("This browser sent an incomplete subscription.");
  db.query(`INSERT INTO push_subs (endpoint, owner_id, p256dh, auth, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET owner_id = excluded.owner_id, p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`)
    .run(sub.endpoint.slice(0, 1000), owner, String(sub.keys.p256dh).slice(0, 200), String(sub.keys.auth).slice(0, 100), label.slice(0, 80), now());
}
export const unsubscribe = (owner: number, endpoint: string) => db.query("DELETE FROM push_subs WHERE owner_id = ? AND endpoint = ?").run(owner, endpoint);
export const devices = (owner: number) => (db.query("SELECT count(*) AS n FROM push_subs WHERE owner_id = ?").get(owner) as { n: number }).n;
export const publicKey = async () => (await vapidKeys()).publicKey;

const origin = () => process.env.PEPPERMINT_ORIGIN ?? `http://localhost:${process.env.PORT ?? 4317}`;
/** Sent notifications stay readable in tests and in the log. */
export const sent: (Note & { owner: number; via: string; at: number })[] = [];

export async function notify(owner: number, n: Note): Promise<"push" | "mail" | "none"> {
  const subs = db.query("SELECT endpoint, p256dh, auth FROM push_subs WHERE owner_id = ?").all(owner) as { endpoint: string; p256dh: string; auth: string }[];
  let ok = 0;
  for (const s of subs) {
    const r = await sendPush({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, { ...n, url: n.url }, { urgency: "high", topic: n.tag?.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined });
    if (r.gone) db.query("DELETE FROM push_subs WHERE endpoint = ?").run(s.endpoint);
    if (r.ok) ok++;
  }
  if (ok) { remember(owner, n, "push"); return "push"; }
  // no device took it: the address the morning briefing goes to, if there is one
  const to = setting<string>(owner, "briefing_email", "");
  if (to && validAddress(to) && process.env.PEPPERMINT_NO_MAIL !== "1") {
    const link = new URL(n.url, origin()).toString();
    const from = process.env.PEPPERMINT_MAIL_FROM ?? `peppermint@${new URL(origin()).hostname.split(".").slice(-2).join(".")}`;
    const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
    try {
      await send({ from, to, subject: n.title, text: `${n.body}\n\n${link}`,
        html: `<div style="font:16px/1.5 system-ui,sans-serif;max-width:560px"><p style="font-size:20px;font-weight:800;margin:0 0 8px">${esc(n.title)}</p><p>${esc(n.body)}</p><p><a href="${esc(link)}" style="display:inline-block;background:#12804c;color:#fff;padding:10px 16px;border-radius:12px;text-decoration:none;font-weight:700">Open in peppermint</a></p></div>` });
      remember(owner, n, "mail"); return "mail";
    } catch (e) { console.error("notify mail", (e as Error).message); }
  }
  remember(owner, n, "none");
  return "none";
}
function remember(owner: number, n: Note, via: string) { sent.push({ ...n, owner, via, at: now() }); if (sent.length > 50) sent.shift(); }
