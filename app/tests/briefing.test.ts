// The morning briefing: headings point to stories, the email carries its charts as PNG and plain text, and the SMTP
// client speaks the protocol (checked against a tiny fake mail server, no network).
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_LLM = "off";
import { test, expect } from "bun:test";
import { createServer } from "node:net";
const { db, now } = await import("../server/db");
const { headingStory, markHeadings, email, due, previewHtml, dayStats } = await import("../server/briefing");
const { chartSvg, svgToPng } = await import("../server/chartsvg");
const { mime, send, validAddress } = await import("../server/mail");
const { normalize } = await import("../shared/chart");

const O = 1101;
db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'b', ?)").run(O, now());
const TEXT = `Rail strikes and a cheaper heat pump lead the morning.

## Strike hits the S-Bahn {1}
Trains stop from Thursday. **Plan the commute.**

\`\`\`chart
{"title": "Delayed trains", "unit": "%", "data": {"Mon": 12, "Tue": 18, "Wed": 31}}
\`\`\`

## Unlinked heading
- one
- two

Watch: the talks on Friday.`;
const B = { day: "2026-11-19", text: TEXT, stories: [{ n: 1, id: 42, img: null }], created_at: now(), sent_at: null, error: null };

test("a heading's {n} points to its story and leaves the title clean", () => {
  expect(headingStory("Strike hits the S-Bahn {1}", B.stories)).toEqual({ title: "Strike hits the S-Bahn", id: 42, img: null });
  expect(headingStory("No marker", B.stories)).toEqual({ title: "No marker", id: null, img: null });
  expect(headingStory("Unknown {9}", B.stories).id).toBe(null);
});

test("headings where Claude dropped the braces still find their story", () => {
  const st = [1, 2, 3, 4].map(n => ({ n, id: 100 + n, img: null }));
  const t = markHeadings("Lead.\n\n## Riemann-Beweis im Entwurf 3\n\nx\n\n## Inkling 2 Mini, stark beim Coding 1\n\n## Apple zeigt das iPhone 7 {2}", st);
  expect(t).toContain("## Riemann-Beweis im Entwurf {3}");
  expect(t).toContain("## Inkling 2 Mini, stark beim Coding {1}");
  expect(t).toContain("## Apple zeigt das iPhone 7 {2}");
  // one heading ending in a number is a headline, not a marker
  expect(markHeadings("## Apple zeigt das iPhone 4\n\n## Something else", st)).toContain("## Apple zeigt das iPhone 4\n");
});

test("a chart becomes a well-formed SVG (and a PNG where a converter exists)", async () => {
  const r = normalize(JSON.parse('{"title": "Delayed & late", "unit": "%", "data": {"Mon": 12, "Tue": 18}}'));
  if (!("chart" in r)) throw new Error(r.error);
  const svg = chartSvg(r.chart, "en");
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg).toContain("Delayed &amp; late");
  expect(svg.match(/<rect/g)!.length).toBe(5); // the paper, and a track and a bar for each of the two
  const png = await svgToPng(svg);
  if (png) expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
});

test("the email: linked headings, bold, lists, the chart inline, a plain-text part, an English subject", async () => {
  const m = await email(O, B, "https://pm.example");
  expect(m.subject).toMatch(/^Your morning · Thursday 19 November$/);
  expect(m.html).toContain('<a href="https://pm.example/story/42"');
  expect(m.html).toContain("<b>Plan the commute.</b>");
  expect(m.html).toContain("<li");
  expect(m.html).not.toContain("{1}");
  expect(m.text).toContain("STRIKE HITS THE S-BAHN\nhttps://pm.example/story/42");
  expect(m.text).toContain("[Delayed trains] Mon: 12, Tue: 18, Wed: 31");
  if (m.inline.length) expect(m.html).toContain('src="cid:chart1@peppermint"');
});

test("the email survives mail apps: table skeleton, inline styles, dark mode, the Watch line as its own card, under Gmail's clip size", async () => {
  const m = await email(O, B, "https://pm.example");
  expect(m.html).toContain('<meta name="color-scheme" content="light dark">');
  expect(m.html).toContain("@media (prefers-color-scheme:dark)");
  expect(m.html).toContain('role="presentation"');
  expect(m.html).not.toMatch(/display:\s*(flex|grid)/);
  expect(m.html).toContain(">Watch</p>");
  expect(m.html).toContain("the talks on Friday.");
  expect(m.html).not.toContain("Watch: the talks");
  expect(m.text).toContain("Watch: the talks on Friday.");
  expect(m.html).toContain("Rail strikes and a cheaper heat pump lead the morning.");
  expect(m.html).toContain('href="https://pm.example/briefing"');
  expect(m.html.length).toBeLessThan(60_000); // Gmail clips at 102 KB
  // every class the dark-mode block styles is backed by an inline light style, so apps without <style> still look right
  for (const cls of ["card", "ink", "muted", "accent"]) expect(m.html).toMatch(new RegExp(`class="${cls}"[^>]*style="`));
});

test("key figures: the kpis block becomes linked tiles under the lead, and never shows as JSON", async () => {
  const { kpis } = await import("../client/lib/lens");
  const withFigs = TEXT.replace("lead the morning.\n", 'lead the morning.\n\n```kpis\n[{"value": "31", "unit": "%", "label": "trains delayed on Wednesday", "n": 1}, {"value": "4,2", "unit": "Mrd. €", "label": "fine"}, {"label": "no value"}]\n```\n');
  const k = kpis(withFigs);
  expect(k.kpis).toEqual([{ value: "31", unit: "%", label: "trains delayed on Wednesday", n: 1 }, { value: "4,2", unit: "Mrd. €", label: "fine", n: null }]);
  expect(k.text).not.toContain("kpis");
  expect(kpis("Lead.\n\n```kpis\nnot json\n```\n\n## H {1}").kpis).toEqual([]);
  const m = await email(O, { ...B, text: withFigs }, "https://pm.example");
  expect(m.html).not.toContain("```");
  expect(m.html).toContain("trains delayed on Wednesday");
  expect(m.html).toMatch(/<a href="https:\/\/pm.example\/story\/42"[^>]*><p class="accent"[^>]*>31/);
  expect(m.text).toContain("31 %: trains delayed on Wednesday");
  // no figures about the pipeline any more
  expect(m.html).not.toContain("sources");
});

test("the preview page is the same email with its pictures as data URLs", () => {
  const html = previewHtml({ html: '<img src="cid:a@pm"><img src="cid:gone@pm">', inline: [{ cid: "a@pm", mime: "image/png", bytes: new Uint8Array([1, 2]), name: "a.png" }] });
  expect(html).toBe('<img src="data:image/png;base64,AQI="><img src="cid:gone@pm">');
});

test("the day in numbers: the edition's size and its topics by count", () => {
  const S = db.query("INSERT INTO stories (owner_id, title, tags, first_at, last_at) VALUES (?, 't', ?, ?, ?) RETURNING id");
  const ids = [["Rail", "Energy"], ["Rail"], ["Rail", "Climate"]].map(t => (S.get(O, JSON.stringify({ topics: t }), now(), now()) as any).id);
  for (const [day, n] of [["2026-11-10", 50], ["2026-11-17", 80], ["2026-11-18", 90], ["2026-11-19", 120]] as const)
    db.query("INSERT INTO editions (owner_id, slot, day, created_at, updated_at, considered) VALUES (?, 'morning', ?, ?, ?, ?)").run(O, day, now(), now(), n);
  const ed = (db.query("SELECT id FROM editions WHERE owner_id = ? AND day = '2026-11-19'").get(O) as any).id;
  ids.forEach((id, i) => db.query("INSERT INTO edition_items (edition_id, story_id, rank, score, reasons, added_at) VALUES (?, ?, ?, 1, '[]', ?)").run(ed, id, i, now()));
  const s = dayStats(O, "2026-11-19");
  expect(s.considered).toBe(120);
  expect(s.picked).toBe(3);
  expect(s.topics[0]).toEqual(["Rail", 3]);
});

test("mime: encoded subject, base64 parts, inline images by Content-ID", () => {
  const raw = mime({ from: "sender@example.org", to: "reader@example.org", subject: "Dein Morgen · Donnerstag", text: "hi", html: "<p>hi</p>", inline: [{ cid: "c1@pm", mime: "image/png", bytes: new Uint8Array([1, 2, 3]), name: "c.png" }] });
  expect(raw).toContain("Subject: =?UTF-8?B?");
  expect(raw).toContain("Content-ID: <c1@pm>");
  expect(raw).toContain('multipart/related; type="text/html"');
  expect(raw.split("\r\n").every(l => l.length <= 998)).toBe(true);
});

test("addresses are checked before anything is sent", () => {
  expect(validAddress("reader@example.org")).toBe(true);
  expect(validAddress("reader@example")).toBe(false);
  expect(validAddress("a b@x.de")).toBe(false);
  expect(validAddress("x@y.de>\r\nRCPT TO:<z@q.de")).toBe(false);
});

test("SMTP: the client walks EHLO, (AUTH,) MAIL, RCPT, DATA and stops at a refusal", async () => {
  const seen: string[] = [];
  let refuse = false;
  const srv = createServer(sock => {
    sock.write("220 fake ESMTP\r\n");
    let data = false, buf = "";
    sock.on("data", d => {
      buf += d.toString();
      if (data) { if (buf.endsWith("\r\n.\r\n")) { seen.push("BODY " + buf.length); data = false; buf = ""; sock.write("250 2.0.0 queued\r\n"); } return; }
      for (const line of buf.split("\r\n").slice(0, -1)) {
        seen.push(line.split(" ")[0]);
        if (line.startsWith("EHLO")) sock.write("250-fake\r\n250 SIZE 1000000\r\n");
        else if (line.startsWith("AUTH")) sock.write(line === `AUTH PLAIN ${btoa("\0sender@example.org\0pw")}` ? "235 2.7.0 ok\r\n" : "535 5.7.8 Authentication failed\r\n");
        else if (line.startsWith("RCPT") && refuse) sock.write("550 5.1.1 Mailbox does not exist\r\n");
        else if (line === "DATA") { sock.write("354 go\r\n"); data = true; }
        else if (line === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 ok\r\n");
      }
      buf = buf.slice(buf.lastIndexOf("\r\n") + 2);
    });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
  process.env.PEPPERMINT_SMTP = `127.0.0.1:${(srv.address() as any).port}`;
  const m = { from: "sender@example.org", to: "reader@example.org", subject: "s", text: ".starts with a dot", html: "<p>x</p>" };
  await send(m);
  expect(seen.slice(0, 4)).toEqual(["EHLO", "MAIL", "RCPT", "DATA"]);
  expect(seen[4]).toMatch(/^BODY \d+$/);
  refuse = true; seen.length = 0;
  await expect(send(m)).rejects.toThrow("550 5.1.1 Mailbox does not exist");
  // with a login: AUTH PLAIN right after EHLO, and a wrong password stops before MAIL
  refuse = false; seen.length = 0;
  process.env.PEPPERMINT_SMTP_USER = "sender@example.org"; process.env.PEPPERMINT_SMTP_PASSWORD = "pw";
  await send(m);
  expect(seen.slice(0, 5)).toEqual(["EHLO", "AUTH", "MAIL", "RCPT", "DATA"]);
  process.env.PEPPERMINT_SMTP_PASSWORD = "wrong"; seen.length = 0;
  await expect(send(m)).rejects.toThrow("535 5.7.8 Authentication failed");
  expect(seen).not.toContain("MAIL");
  delete process.env.PEPPERMINT_SMTP_USER; delete process.env.PEPPERMINT_SMTP_PASSWORD;
  srv.close();
});

test("due: only mornings from 06:30 Berlin, and only once a day", () => {
  expect(due(O, new Date("2026-11-19T05:00:00Z"))).toBe(false); // 06:00 in Berlin: too early (and no Claude in tests)
});
