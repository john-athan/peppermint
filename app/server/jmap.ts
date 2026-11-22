// Reading mail: a small JMAP client (RFC 8620 core, RFC 8621 mail) for the peppermint@ mailbox on Stalwart. Every use
// has its own plus address, so one mailbox serves them all without mixing them up:
//   peppermint+case-48-k3j9x2@example.org   a reply to an investigation's question (repliesSince)
//   peppermint+nl-7f3k9q2m@example.org      a newsletter source (mailTo, connectors/newsletter.ts)
// Each query asks only for its own prefix, so a busy newsletter never pushes a reply out of the window. No database, no
// package: just fetch.

export type Reply = { token: string; from: string; fromName: string | null; subject: string; text: string; receivedAt: number; messageId: string };
/** One mail as it arrived, for a newsletter: the HTML part when there is one, the text part otherwise. */
export type Mail = { token: string; from: string; fromName: string | null; subject: string; html: string | null; text: string; receivedAt: number; messageId: string; listUnsubscribe: string | null };

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const TOKEN = /^[a-z0-9-]{4,60}$/;
const SESSION_MS = 10 * 60 * 1000;

type Session = { apiUrl: string; accountId: string };
let session: { key: string; at: number; value: Session } | null = null;

export const jmapConfigured = (): boolean => !!(process.env.PEPPERMINT_JMAP_URL && process.env.PEPPERMINT_JMAP_USER);

export function replyAddress(token: string): string | null {
  const base = process.env.PEPPERMINT_REPLY_ADDRESS;
  if (!base) return null;
  if (!TOKEN.test(token)) throw new Error(`Bad reply token "${token}": use 4 to 60 characters of a-z, 0-9 and "-".`);
  const at = base.lastIndexOf("@");
  if (at < 1) return null;
  return `${base.slice(0, at)}+${token}${base.slice(at)}`;
}

export function plainReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const isHeader = (l: string) => /^(Gesendet|Sent|An|To|Datum|Date|Betreff|Subject|Cc):/i.test(l.trim());
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    const joined = `${l} ${(lines[i + 1] ?? "").trim()}`;
    if (
      /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Originalnachricht|Weitergeleitete Nachricht)\s*-{2,}$/i.test(l) ||
      (/^On\s.+/.test(l) && (/wrote:$/.test(l) || /^On\s.+wrote:$/.test(joined))) ||
      (/^Am\s.+/.test(l) && (/schrieb.*:$/.test(l) || /^Am\s.+schrieb.*:$/.test(joined))) ||
      (/^(Von|From):\s/.test(l) && lines.slice(i + 1, i + 5).some(isHeader))
    ) { end = i; break; }
  }
  let kept = lines.slice(0, end).filter((l) => !l.startsWith(">"));
  const sig = kept.findIndex((l) => l === "-- " || l === "--");
  if (sig >= 0) kept = kept.slice(0, sig);
  return kept.join("\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
}

async function jmap(url: string, init: RequestInit, f: typeof fetch): Promise<any> {
  let res: Response;
  try { res = await f(url, { redirect: "follow", ...init }); }
  catch (e) { throw new Error(`Mail server not reachable: ${(e as Error).message}.`); }
  if (res.status === 401 || res.status === 403) throw new Error(`Mail server refused the login (${res.status}).`);
  if (!res.ok) throw new Error(`Mail server answered ${res.status}.`);
  try { return await res.json(); } catch { throw new Error("Mail server sent an answer that is not JSON."); }
}

async function getSession(auth: string, f: typeof fetch): Promise<Session> {
  const url = process.env.PEPPERMINT_JMAP_URL!;
  const key = `${url}|${auth}`;
  if (session && session.key === key && Date.now() - session.at < SESSION_MS) return session.value;
  const j = await jmap(url, { headers: { authorization: auth, accept: "application/json" } }, f);
  const accountId = j?.primaryAccounts?.[MAIL];
  if (!j?.apiUrl || !accountId) throw new Error("Mail server session has no mail account.");
  const value = { apiUrl: j.apiUrl as string, accountId: accountId as string };
  session = { key, at: Date.now(), value };
  return value;
}

/** The plus address for a token on the mailbox, or null when no mailbox is configured. */
export function plusAddress(token: string): string | null { return replyAddress(token); }

/** Mail received after `sinceMs` whose recipients carry a plus address starting with `prefix` ("case-", "nl-7f3k9q2m"),
 *  oldest first, at most `limit`. Each message comes with the token it was sent to. */
async function mailSince(prefix: string, sinceMs: number, limit: number, f: typeof fetch): Promise<(Mail & { raw: any })[]> {
  const base = process.env.PEPPERMINT_REPLY_ADDRESS;
  if (!jmapConfigured() || !base || base.lastIndexOf("@") < 1) throw new Error("No mailbox is set up (PEPPERMINT_JMAP_URL, PEPPERMINT_JMAP_USER, PEPPERMINT_REPLY_ADDRESS).");
  const auth = "Basic " + Buffer.from(`${process.env.PEPPERMINT_JMAP_USER}:${process.env.PEPPERMINT_JMAP_PASSWORD ?? ""}`).toString("base64");
  const { apiUrl, accountId } = await getSession(auth, f);
  const at = base.lastIndexOf("@");
  const body = {
    using: [CORE, MAIL],
    methodCalls: [
      ["Email/query", { accountId, filter: { after: new Date(sinceMs).toISOString(), to: `${base.slice(0, at)}+${prefix}` }, sort: [{ property: "receivedAt", isAscending: true }], limit }, "q"],
      ["Email/get", {
        accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "messageId", "from", "to", "cc", "subject", "receivedAt", "textBody", "htmlBody", "bodyValues", "header:List-Unsubscribe:asURLs"],
        fetchTextBodyValues: true, fetchHTMLBodyValues: true, maxBodyValueBytes: 400_000,
      }, "g"],
    ],
  };
  const j = await jmap(apiUrl, { method: "POST", headers: { authorization: auth, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }, f);
  const calls: any[] = j?.methodResponses ?? [];
  const err = calls.find((c) => c[0] === "error");
  if (err) throw new Error(`Mail server could not list the mail: ${err[1]?.description ?? err[1]?.type ?? "unknown error"}.`);
  const list: any[] = calls.find((c) => c[0] === "Email/get" && c[2] === "g")?.[1]?.list ?? [];
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(base.slice(0, at))}\\+([a-z0-9-]{4,60})@${esc(base.slice(at + 1))}$`, "i");
  const out: (Mail & { raw: any })[] = [];
  for (const m of list) {
    let token: string | null = null;
    for (const a of [...(m.to ?? []), ...(m.cc ?? [])]) {
      const hit = re.exec(String(a?.email ?? "").trim());
      if (hit && hit[1].toLowerCase().startsWith(prefix)) { token = hit[1].toLowerCase(); break; }
    }
    if (!token) continue;
    const part = (ps: any[]) => (ps ?? []).map((p: any) => m.bodyValues?.[p.partId]?.value ?? "").join("\n");
    const html = (m.htmlBody ?? []).some((p: any) => /html/i.test(String(p.type ?? ""))) ? part(m.htmlBody) : null;
    const from = m.from?.[0];
    out.push({
      token, raw: m, from: String(from?.email ?? ""), fromName: from?.name ? String(from.name) : null, subject: String(m.subject ?? ""),
      html, text: part(m.textBody), receivedAt: Date.parse(m.receivedAt) || 0,
      messageId: String(Array.isArray(m.messageId) ? m.messageId[0] ?? m.id : m.messageId ?? m.id),
      // RFC 8621 allows only asURLs (or asRaw) for List-* headers; Stalwart refuses the whole query for asText
      listUnsubscribe: (m["header:List-Unsubscribe:asURLs"] as string[] | null)?.find(u => /^https:\/\//i.test(u)) ?? null,
    });
  }
  return out;
}

/** Newsletters sent to one source's address since a moment. */
export const mailTo = (token: string, sinceMs: number, f: typeof fetch = fetch): Promise<Mail[]> => mailSince(token, sinceMs, 40, f);

/** Replies to investigations' questions since a moment, with the new part of each (quoted history and signature cut). */
export async function repliesSince(sinceMs: number, f: typeof fetch = fetch): Promise<Reply[]> {
  return (await mailSince("case-", sinceMs, 50, f)).map(m => ({
    token: m.token, from: m.from, fromName: m.fromName, subject: m.subject, text: plainReply(m.text), receivedAt: m.receivedAt, messageId: m.messageId,
  }));
}
