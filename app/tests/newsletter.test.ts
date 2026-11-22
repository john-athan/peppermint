// Newsletters: a mail's HTML to text with its useful links, mails to items, a confirm link kept until the first issue,
// and keyword filters on any source.
import { expect, test } from "bun:test";
import { newsletterItems, newsletterText, newsletterToken } from "../server/connectors/newsletter";
import { cleanFilter, filterFor } from "../server/filter";
import type { Mail } from "../server/jmap";
import { isDue } from "../server/pipeline";

const HTML = `<html><head><title>x</title><style>.a{color:red}</style></head><body>
<span style="display:none;max-height:0">Preheader you never see</span>
<table><tr><td><a href="https://news.example/view?id=1">View this email in your browser</a></td></tr>
<tr><td><h1>ECHA Weekly</h1><p>New restriction proposal on <b>PFAS</b> in firefighting foams.</p>
<ul><li>Candidate List: two new substances</li><li>SCIP database update</li></ul>
<img src="https://t.example/pixel.gif" width="1" height="1"></td></tr>
<tr><td>|</td></tr>
<tr><td><a href="https://news.example/unsubscribe?u=9">Unsubscribe</a></td></tr></table></body></html>`;

test("newsletterText keeps the reading, drops layout and hidden text, finds view and unsubscribe links", () => {
  const t = newsletterText(HTML, "plain fallback", "ECHA Weekly 21 November");
  expect(t.text).toBe("View this email in your browser\nECHA Weekly\nNew restriction proposal on PFAS in firefighting foams.\n- Candidate List: two new substances\n- SCIP database update\nUnsubscribe");
  expect(t.view).toBe("https://news.example/view?id=1");
  expect(t.unsubscribe).toBe("https://news.example/unsubscribe?u=9");
  expect(t.confirm).toBeNull();
});

test("a confirmation mail yields its confirm link, in HTML and in plain text", () => {
  expect(newsletterText(`<p>Please <a href="https://list.example/confirm?t=abc">confirm your subscription</a></p>`, "", "Confirm your subscription").confirm).toBe("https://list.example/confirm?t=abc");
  expect(newsletterText(null, "Bitte bestätigen Sie Ihre Anmeldung: https://list.example/optin?t=1\nDanke", "Bitte Anmeldung bestätigen").confirm).toBe("https://list.example/optin?t=1");
  // an ordinary issue that mentions "subscribe" is no confirmation
  expect(newsletterText(`<p><a href="https://x.example/subscribe">Subscribe to our podcast</a></p>`, "", "Weekly digest").confirm).toBeNull();
});

const mail = (id: string, subject: string, at: number, html: string | null = "<p>Hello</p>"): Mail => ({ token: "nl-abc", from: "news@mailer.echa.europa.eu", fromName: "ECHA", subject, html, text: "Hello", receivedAt: at, messageId: id, listUnsubscribe: "https://echa.example/u" });

test("newsletterItems: one item per mail, each once; a confirmation is no story, its link waits on the source until the first real issue", () => {
  const a = newsletterItems([mail("m1", "Confirm your subscription", 100, `<a href="https://echa.example/confirm?t=1">Confirm subscription</a>`)], {});
  expect(a.items).toEqual([]);
  expect(a.cursor.confirm).toEqual({ url: "https://echa.example/confirm?t=1", subject: "Confirm your subscription", at: 100 });
  const b = newsletterItems([mail("m1", "Confirm your subscription", 100), mail("m2", "Fwd: ECHA Weekly", 200)], a.cursor);
  expect(b.items.map(i => i.title)).toEqual(["ECHA Weekly"]);
  expect(b.items[0]).toMatchObject({ ext_id: "m2", author: "ECHA", url: null, published_at: 200, meta: { site: "echa.europa.eu", newsletter: true, unsubscribe: "https://echa.example/u" } });
  expect(b.cursor.confirm).toBeNull();
  expect(b.cursor.since).toBe(200);
});

test("newsletterToken: a fresh plus-address token every time, in the mailbox's token alphabet", () => {
  const a = newsletterToken(), b = newsletterToken();
  expect(a).toMatch(/^nl-[a-z2-9]{10}$/);
  expect(a).not.toBe(b);
});

test("keyword filters: whole words, any accent or case, prefixes with *, none wins over any", () => {
  const f = filterFor(cleanFilter({ any: ["REACH", "restrict*", "Produktpass"], none: ["football"] }));
  expect(f({ title: "ECHA proposes a REACH restriction" })).toBe(true);
  expect(f({ title: "Sales reached a record" })).toBe(false);           // REACH is a word, not a prefix
  expect(f({ title: "New rules", body: "restricted substances in toys" })).toBe(true);
  expect(f({ title: "Der digitale PRODUKTPASS kommt" })).toBe(true);
  expect(f({ title: "REACH and football", summary: "" })).toBe(false);   // none wins
  expect(filterFor(cleanFilter({}))({ title: "anything" })).toBe(true);
  expect(cleanFilter({ any: "PFAS, pfas\nRoHS, x", none: [" "] })).toEqual({ any: ["PFAS", "RoHS"], none: [] });
  expect(filterFor(cleanFilter({ any: ["Annex XVII"] }))({ title: "entry 79 of annex\nxvii" })).toBe(true); // phrases span any whitespace
});

test("a newsletter waiting for its first mail is checked every two minutes, then at its cadence", () => {
  const at = 10_000_000, src = (kind: string, cursor: unknown, ago: number) => ({ kind, cadence_min: 30, last_pull_at: at - ago * 60_000, cursor: JSON.stringify(cursor) });
  expect(isDue(src("mail", {}, 3), at)).toBe(true);
  expect(isDue(src("mail", {}, 1), at)).toBe(false);
  expect(isDue(src("mail", { since: 5 }, 3), at)).toBe(false);   // it has mail: every 30 min
  expect(isDue(src("mail", { since: 5 }, 31), at)).toBe(true);
  expect(isDue(src("feed", {}, 3), at)).toBe(false);
  expect(isDue({ ...src("feed", {}, 0), last_pull_at: null }, at)).toBe(true);
});
