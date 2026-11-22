// Newsletters: each newsletter source has its own address on peppermint's mailbox, like peppermint+nl-7f3k9q2m@example.org.
// You subscribe with that address; every mail that arrives there becomes an item: the subject is the title, the text
// of the mail the body, the "view in browser" link (when the mail has one) the link. One address per newsletter keeps
// trust, palate and filters per newsletter, and lets you drop one by deleting its source.
//
// Many newsletters ask to confirm the subscription first. Such a mail comes in like any other, and its confirm link is
// also kept on the source, so the Sources page can offer it even when the palate would never show that mail.
import { jmapConfigured, mailTo, plusAddress, type Mail } from "../jmap";
import type { Connector } from "./index";
import { decode, type RawItem } from "./util";

export const newsletterToken = () => "nl-" + Array.from(crypto.getRandomValues(new Uint8Array(10)), b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
export const newsletterReady = () => jmapConfigured() && !!plusAddress("nl-check");

const CONFIRM_MAIL = /confirm|bestätig|verify|verifiz|aktivier|activate|double opt|opt-in|subscription request|anmeldung abschließen/i;
const CONFIRM_LINK = /confirm|bestätig|verify|verifiz|activate|aktivier|subscribe|optin|opt-in|anmeld/i;
const VIEW_LINK = /view (it |this )?(email |e-mail |mail |newsletter |message )?(in|on) (your |a |the )?(web )?browser|web ?version|view online|read online|online (ansehen|lesen|anzeigen|version)|im browser|browseransicht/i;
const UNSUB_LINK = /unsubscribe|abmelden|abbestellen|austragen|manage (your )?(preferences|subscription)/i;

export type NewsletterText = { text: string; view: string | null; confirm: string | null; unsubscribe: string | null };

/** A newsletter's HTML to readable text, with its useful links. Layout tables, hidden preheaders, styles and tracking
 *  pixels go; paragraphs, headings and list items stay on lines of their own. */
export function newsletterText(html: string | null, plain: string, subject = ""): NewsletterText {
  let view: string | null = null, confirm: string | null = null, unsubscribe: string | null = null;
  const confirming = CONFIRM_MAIL.test(subject);
  const take = (href: string, label: string) => {
    const h = decode(href).trim();
    if (!/^https:\/\//i.test(h)) return;
    if (!view && VIEW_LINK.test(label)) view = h;
    else if (!unsubscribe && (UNSUB_LINK.test(label) || /unsubscribe|abmelden/i.test(h))) unsubscribe = h;
    else if (!confirm && (confirming || CONFIRM_MAIL.test(label)) && (CONFIRM_LINK.test(label) || CONFIRM_LINK.test(h))) confirm = h;
  };
  if (!html) {
    for (const m of plain.matchAll(/(.{0,80}?)\s*<?(https:\/\/[^\s>]+)>?/g)) take(m[2], m[1]);
    return { text: plain.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), view, confirm, unsubscribe };
  }
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(head|style|script|title)\b[\s\S]*?<\/\1>/gi, "");
  // preheaders and other hidden text: an element styled display:none or with zero size, one level deep is enough in practice
  h = h.replace(/<(\w+)\b[^>]*style="[^"]*(display:\s*none|max-height:\s*0|font-size:\s*0|mso-hide:\s*all)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, "");
  h = h.replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
    const label = decode(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    take(href, label);
    return label ? ` ${label} ` : " ";
  });
  const text = decode(h
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|table|h[1-6]|ul|ol|blockquote|section|article|header|footer)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<[^>]+>/g, ""))
    .replace(/ |‌|​|͏|­/g, " ")
    .split("\n").map(l => l.replace(/[ \t]+/g, " ").trim()).filter(l => l && !/^[-|·•_=*\s]+$/.test(l))
    .join("\n").replace(/\n{3,}/g, "\n\n");
  return { text, view, confirm, unsubscribe };
}

const siteOf = (email: string) => email.split("@")[1]?.toLowerCase().replace(/^(news(letter)?|mail(er)?|info|noreply|no-reply|email|e)\./, "") ?? "";

type Cursor = { since?: number; seen?: string[]; confirm?: { url: string; subject: string; at: number } | null };

/** Mails to items. Pure: the pull and the tests share it. */
export function newsletterItems(mails: Mail[], cursor: Cursor): { items: RawItem[]; cursor: Cursor } {
  const seen = new Set(cursor.seen ?? []);
  let since = cursor.since ?? 0, confirm = cursor.confirm ?? null;
  const items: RawItem[] = [];
  for (const m of mails) {
    since = Math.max(since, m.receivedAt);
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    const t = newsletterText(m.html, m.text, m.subject);
    if (t.confirm) confirm = { url: t.confirm, subject: m.subject.slice(0, 200), at: m.receivedAt };
    else if (confirm && m.receivedAt > confirm.at) confirm = null; // a regular issue arrived: the subscription runs
    const title = m.subject.replace(/^\s*((fwd?|wg|aw|re):\s*)+/i, "").trim() || "(no subject)";
    items.push({
      ext_id: m.messageId, url: t.view, title, author: m.fromName || m.from, lang: null,
      summary: t.text.slice(0, 600) || null, body: t.text.slice(0, 80_000) || null, published_at: m.receivedAt || Date.now(),
      meta: { site: siteOf(m.from), newsletter: true, unsubscribe: m.listUnsubscribe ?? t.unsubscribe ?? undefined },
    });
  }
  return { items, cursor: { since, seen: [...seen].slice(-500), confirm } };
}

export const newsletter: Connector = {
  kind: "mail", label: "Newsletter",
  async discover() { throw new Error("Name the newsletter in the Newsletter picker."); },
  async pull(_src, config: { token: string }, cursor: Cursor) {
    if (!newsletterReady()) throw new Error("No mailbox is set up for newsletters (PEPPERMINT_JMAP_URL, PEPPERMINT_JMAP_USER, PEPPERMINT_REPLY_ADDRESS).");
    // a minute of overlap: mail that arrived while the last pull ran is read again and dropped as seen
    return newsletterItems(await mailTo(config.token, Math.max(0, (cursor.since ?? 0) - 60_000)), cursor);
  },
};
