import { digParts } from "../client/lib/format";
process.env.PEPPERMINT_DB = ":memory:";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const { parseFeed, extract, decode } = await import("../server/connectors/util");
const { kindForUrl } = await import("../server/connectors");
const { tagLocally, detectLang } = await import("../server/tag");
const { keysOf, insertItems, clusterPending } = await import("../server/pipeline");
const { scoreStories, buildEdition, applySignal, slotNow } = await import("../server/palate");
const { blocks } = await import("../client/lib/lens");

beforeAll(() => {
  db.query("INSERT OR IGNORE INTO users (id, name, created_at) VALUES (1, 'me', ?)").run(now());
  db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (1, 1, 'merkur', 'merkur.de', ?), (2, 1, 'hackernews', 'Hacker News', ?)").run(now(), now());
});

test("parses RSS with CDATA and entities", () => {
  const f = parseFeed(`<rss><channel><title>Merkur.de - München</title><link>https://www.merkur.de/lokales/muenchen/</link>
    <item><title><![CDATA[U6 &amp; U3: Sperrung]]></title><link>https://x.de/a-1.html</link><description>Ab &quot;Montag&quot;</description><pubDate>Wed, 18 Nov 2026 08:32:50 +0100</pubDate><dc:creator>A. B</dc:creator></item></channel></rss>`);
  expect(f.link).toBe("https://www.merkur.de/lokales/muenchen/");
  expect(f.entries[0].title).toBe("U6 & U3: Sperrung");
  expect(f.entries[0].description).toBe('Ab "Montag"');
  expect(f.entries[0].published).toBe(Date.parse("2026-11-18T07:32:50Z"));
});

test("extracts article paragraphs and description, decodes double-escaped text", async () => {
  const r = await extract(`<html lang="de"><head><meta name="description" content="Eine ziemlich lange Beschreibung des Artikels &amp;middot; mit Punkt."></head><body><nav><p>Menu that should not count at all in any case</p></nav>
    <p class="id-StoryElement-paragraph">München &amp;middot; Die U6 fährt ab Montag nicht.</p><aside><p class="id-StoryElement-paragraph">ad</p></aside></body></html>`, { paragraphSelector: "p.id-StoryElement-paragraph" });
  expect(r.lang).toBe("de");
  expect(r.text).toBe("München · Die U6 fährt ab Montag nicht.");
  expect(r.description).toContain("· mit Punkt");
  expect(decode("&#x27;a&#39;")).toBe("'a'");
});

test("routes pasted links to connectors", () => {
  expect(kindForUrl("https://news.ycombinator.com/item?id=1")).toBe("hackernews");
  expect(kindForUrl("https://www.merkur.de/lokales/muenchen/")).toBe("merkur");
  expect(kindForUrl("https://example.org")).toBe("feed");
  expect(kindForUrl("jvns.ca")).toBe("feed");
  expect(kindForUrl("not a url")).toBeNull();
});

test("local tagger finds language, topics and places from the lead", () => {
  const t = tagLocally({ title: "U6 ab Montag zwei Wochen gesperrt", body: "Die MVG richtet Ersatzbusse ein. Die U-Bahn fährt zwischen Münchner Freiheit und Implerstraße nicht." });
  expect(t.lang).toBe("de");
  expect(t.topics).toContain("Transport");
  expect(t.places).toContain("U6");
  expect(detectLang("The quick brown fox and the lazy dog are not here")).toBe("en");
});

test("clusters the same event, keeps unrelated Munich stories apart", () => {
  const t = (title: string) => ({ ext_id: title, url: null, title, published_at: now(), lang: "de" });
  insertItems({ id: 1, owner_id: 1 } as any, [t("A99 Vollsperrung zwischen München Süd und Ost am Wochenende"), t("Weihnachtsmarkt am Marienplatz in München eröffnet")]);
  insertItems({ id: 2, owner_id: 1 } as any, [t("A99 Vollsperrung: München Süd bis Ost am Wochenende dicht")]);
  db.query("UPDATE items SET tagged = 1, tags = ?").run(JSON.stringify({ topics: ["Traffic"], places: ["München"] }));
  clusterPending(1);
  const stories = db.query("SELECT title, item_count FROM stories ORDER BY id").all() as any[];
  expect(stories.length).toBe(2);
  expect(stories.find(s => s.title.startsWith("A99"))!.item_count).toBe(2);
});

test("scores stay in 0..1 with readable reasons; never rules gate; signals move weights", () => {
  db.query("INSERT INTO affinities (owner_id, kind, name, weight, updated_at) VALUES (1, 'topic', 'Traffic', 2, ?)").run(now());
  const st = db.query("SELECT * FROM stories").all() as any[];
  const s = scoreStories(1, st);
  for (const x of s) { expect(x.score).toBeGreaterThan(0); expect(x.score).toBeLessThan(1); }
  expect(s[0].reasons.find(r => r.label === "Topic: Traffic")!.v).toBeCloseTo(0.32);
  db.query("INSERT INTO rules (owner_id, action, kind, value, created_at) VALUES (1, 'never', 'topic', 'Traffic', ?)").run(now());
  expect(scoreStories(1, st).every(x => x.verdict === "never")).toBe(true);
  const ed = buildEdition(1);
  expect(ed.added).toBe(0);
  db.query("DELETE FROM rules").run();
  applySignal(1, st[0].id, "less", { subjects: ["topic:Traffic"] });
  expect((db.query("SELECT weight FROM affinities WHERE name = 'Traffic'").get() as any).weight).toBeCloseTo(1.4);
});

test("edition slots follow Berlin time", () => {
  expect(slotNow(new Date("2026-11-18T05:00:00Z")).slot).toBe("morning");
  expect(slotNow(new Date("2026-11-18T16:30:00Z")).slot).toBe("evening");
  expect(slotNow(new Date("2026-11-18T23:30:00Z")).day).toBe("2026-11-19");
});

test("article text keeps its structure: headings, lists, quotes and bold", () => {
  const b = blocks("orig", "Lead with **Midnightbazar** inside.\n\n## Termine\n\n### Freitag, 20. November\n\n- 7 Uhr: **Daglfing** | Trabrennbahn\n- 17 Uhr: Nachtflohmarkt\n\n> a quote");
  expect(b.map(x => x.t)).toEqual(["p", "h", "h", "ul", "quote"]);
  expect(b[0]).toMatchObject({ runs: [{ s: "Lead with " }, { s: "Midnightbazar", b: true }, { s: " inside." }] });
  expect(b[2]).toMatchObject({ level: 3, s: "Freitag, 20. November" });
  expect((b[3] as any).items).toEqual([[{ s: "7 Uhr: " }, { s: "Daglfing", b: true }, { s: " | Trabrennbahn" }], [{ s: "17 Uhr: Nachtflohmarkt" }]]);
  expect(blocks("orig", "odd **marker")[0]).toMatchObject({ runs: [{ s: "odd **marker" }] });
});

test("extraction keeps headings, lists and bold, drops link lists and promotion", async () => {
  const { extract } = await import("../server/connectors/util");
  const { MERKUR_BODY } = await import("../server/connectors");
  const html = `<html lang=de><body><article>
    <p class=id-StoryElement-leadText>Am Wochenende warten in München Schnäppchen.</p>
    <h2 class=id-StoryElement-crosshead>Münchner Flohmarkttermine</h2>
    <p class=id-StoryElement-paragraph><strong>Freitag, 20. November</strong></p>
    <ul><li class=id-StoryElement-list-item>7 Uhr &#8211; <strong>Antik- &amp; Flohmarkt Daglfing</strong> | Trabrennbahn</li>
    <li class=id-StoryElement-list-item>17 Uhr &#8211; <strong> Thrifty Friday </strong>| Paketposthalle</li></ul>
    <p class=id-StoryElement-paragraph>Immer Neues: Damit Sie keinen Termin verpassen, gibt es den Flohmarkt-Newsletter. Nach der Anmeldung über USER.ID erhalten Sie ihn.</p>
    <p class=id-StoryElement-paragraph>Hinweis: Eine Auswahl der Redaktion ohne Anspruch auf Vollständigkeit.</p>
  </article></body></html>`;
  const m = await extract(html, { paragraphSelector: MERKUR_BODY });
  expect(m.text).toBe("Am Wochenende warten in München Schnäppchen.\n\n## Münchner Flohmarkttermine\n\n### Freitag, 20. November\n\n- 7 Uhr \u2013 **Antik- & Flohmarkt Daglfing** | Trabrennbahn\n- 17 Uhr \u2013 **Thrifty Friday** | Paketposthalle");
  const g = await extract(`<article><h2>Why</h2><p>${"Real text here. ".repeat(30)}</p><ul><li><a href="/a">Related one</a></li><li>A point with <a href="/x">a link</a> inside</li></ul><footer><p>Share this</p></footer></article>`);
  expect(g.text).toBe(`## Why\n\n${"Real text here. ".repeat(30).trim()}\n\n- A point with a link inside`);
});

test("extraction closes paragraphs and list items whose end tags minified HTML leaves out", async () => {
  const { extract } = await import("../server/connectors/util");
  const long = "A sentence long enough to be real text in an article. ".repeat(4).trim();
  // kapteko.com: no </p> or </li>, code blocks between paragraphs, a nested list
  const html = `<article><p>${long}<p>Second paragraph, ${long}<pre><code>let x = 1;</code></pre><h2 id=refs>References</h2>`
    + `<ul><li><a href=https://a.example/x>https://a.example/x</a> the source, with a few words about it<li>Second point<ul><li>Nested point</ul><li>Third point</ul><p>The end of it.</article>`;
  const r = await extract(html);
  expect(r.text).toBe(`${long}\n\nSecond paragraph, ${long}\n\n## References\n\n- https://a.example/x the source, with a few words about it\n- Second point Nested point\n- Third point\n\nThe end of it.`);
});

test("reads JSON Feed and finds feeds announced in a page head", async () => {
  const { feedLinks, assertPublic } = await import("../server/connectors/util");
  const f = parseFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", title: "Blog", home_page_url: "https://b.example/", items: [{ id: "1", url: "https://b.example/p/1", title: "Hello &amp; welcome", content_html: "<p>Body</p>", date_published: "2026-11-18T08:00:00Z" }] }));
  expect(f.title).toBe("Blog");
  expect(f.entries[0]).toMatchObject({ title: "Hello & welcome", guid: "1", description: "Body", published: Date.parse("2026-11-18T08:00:00Z") });
  const links = feedLinks(`<head><link rel="stylesheet" href="/a.css"><link rel="alternate" type="application/rss+xml" title="All posts" href="/feed.xml"><link type="application/atom+xml" rel="alternate" href="https://c.example/atom"></head>`, "https://b.example/blog/");
  expect(links).toEqual([{ url: "https://b.example/feed.xml", title: "All posts" }, { url: "https://c.example/atom", title: "" }]);
  for (const u of ["http://127.0.0.1/", "http://10.0.0.8/", "http://[::1]/", "http://localhost/", "ftp://example.org/", "http://169.254.169.254/"])
    expect(assertPublic(u), u).rejects.toThrow();
  await expect(assertPublic("http://1.1.1.1/")).resolves.toBeUndefined();
});

test("podcast feeds keep episodes without a page, with audio and duration", () => {
  const f = parseFeed(`<rss><channel><title>Show</title><item><title>Ep 1</title><guid>g1</guid><itunes:duration>1:02:03</itunes:duration>
    <enclosure length="1" type="audio/mpeg" url="https://cdn.example/ep1.mp3"/><description><![CDATA[<p>Notes</p>]]></description></item></channel></rss>`);
  expect(f.entries[0]).toMatchObject({ title: "Ep 1", link: "", audio: "https://cdn.example/ep1.mp3", duration: 3723, description: "Notes" });
});

test("YouTube channel feeds carry the video id, thumbnail and description", () => {
  const f = parseFeed(`<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Chan</title><entry><id>yt:video:abcdefghijk</id><yt:videoId>abcdefghijk</yt:videoId>
    <title>A video</title><link rel="alternate" href="https://www.youtube.com/watch?v=abcdefghijk"/><author><name>Chan</name></author><published>2026-11-17T10:00:00+00:00</published>
    <media:group><media:thumbnail url="https://i1.ytimg.com/vi/abcdefghijk/hqdefault.jpg" width="480" height="360"/><media:description>What it is about</media:description></media:group></entry></feed>`);
  expect(f.entries[0]).toMatchObject({ video: "abcdefghijk", author: "Chan", description: "What it is about", image: "https://i1.ytimg.com/vi/abcdefghijk/hqdefault.jpg" });
});

test("a dig answer yields its sources, verdict and quotes, and hides a first line still streaming in", () => {
  const a = digParts('@sources [{"site":"zeit.de","url":"https://zeit.de/a","title":"A"}]\n@partly\nIt holds in part.[1]\n---\n[1] "only in Bavaria" (zeit.de)');
  expect(a.verdict).toBe("partly");
  expect(a.sources[0].url).toBe("https://zeit.de/a");
  expect(a.quotes).toEqual([{ n: 1, text: "only in Bavaria", source: "zeit.de" }]);
  expect(digParts('@sources [{"site":').head).toEqual([]);
  expect(digParts("@hol").verdict).toBe(null);
});
