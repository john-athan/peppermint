process.env.PEPPERMINT_DB = ":memory:";
import { test, expect } from "bun:test";
const { db, now } = await import("../server/db");
const { parseFeed, titleOf } = await import("../server/connectors/util");
const { kindForUrl, CONNECTORS } = await import("../server/connectors");
const more = await import("../server/connectors/more");
const { CATALOG } = await import("../server/connectors/catalog");
const { insertItems } = await import("../server/pipeline");

/* ---------- Bluesky ---------- */
const DID = "did:plc:abc123";
const post = (rkey: string, record: any, embed?: any, extra: any = {}) => ({
  post: { uri: `at://${DID}/app.bsky.feed.post/${rkey}`, author: { did: DID, handle: "ada.bsky.social", displayName: "Ada" }, record: { text: "", createdAt: "2026-11-17T10:00:00.000Z", ...record }, embed, ...extra },
});
const BSKY_FEED = {
  feed: [
    post("3own", { text: "Short first line.\nSecond line with more." }),
    { ...post("3rep", { text: "Someone else's words" }), reason: { $type: "app.bsky.feed.defs#reasonRepost" } },
    { post: { ...post("3oth", { text: "Not mine" }).post, author: { did: "did:plc:other", handle: "bob.bsky.social" } } },
    post("3card", { text: "Worth a read" }, { $type: "app.bsky.embed.external#view", external: { uri: "https://example.com/a", title: "The Article", thumb: "https://cdn.bsky.app/thumb.jpg" } }),
    post("3img", { text: "A photo" }, { $type: "app.bsky.embed.images#view", images: [{ thumb: "https://cdn.bsky.app/t1.jpg", fullsize: "https://cdn.bsky.app/f1.jpg", alt: "first" }, { fullsize: "https://cdn.bsky.app/f2.jpg" }] }),
    post("3long", { text: "x".repeat(200) + ". tail" }),
  ],
};
test("bluesky: own posts only, title from first line, card and image in meta", () => {
  const items = more.blueskyItems(BSKY_FEED, DID);
  expect(items.map(i => i.ext_id.split("/").pop())).toEqual(["3own", "3card", "3img", "3long"]); // repost and foreign post dropped
  expect(items[0].title).toBe("Short first line.");
  expect(items[0].body).toBe("Short first line.\nSecond line with more.");
  expect(items[0].url).toBe("https://bsky.app/profile/ada.bsky.social/post/3own");
  expect(items[0].author).toBe("Ada");
  expect(items[0].published_at).toBe(Date.parse("2026-11-17T10:00:00.000Z"));
  expect(items[1].meta).toMatchObject({ link: "https://example.com/a", link_title: "The Article", image: "https://cdn.bsky.app/thumb.jpg" });
  expect(items[2].meta?.image).toBe("https://cdn.bsky.app/f1.jpg");
  expect(items[3].title.length).toBeLessThanOrEqual(120);
  expect(items[3].title.endsWith("…")).toBe(true);
});
test("bluesky: actor input forms", () => {
  expect(more.blueskyActor("https://bsky.app/profile/ada.bsky.social/post/3x")).toBe("ada.bsky.social");
  expect(more.blueskyActor("@ada.bsky.social")).toBe("ada.bsky.social");
  expect(more.blueskyActor("did:plc:abc123")).toBe("did:plc:abc123");
  expect(more.blueskyActor("Ada Lovelace")).toBeNull();
});
test("titleOf prefers the first line, then the first sentence", () => {
  expect(titleOf("Hello\nworld")).toBe("Hello");
  expect(titleOf("First sentence here. " + "y".repeat(150))).toBe("First sentence here.");
});

/* ---------- Mastodon ---------- */
test("mastodon: handle and link forms", () => {
  expect(more.mastodonHandle("@gargron@mastodon.social")).toEqual({ user: "gargron", instance: "mastodon.social" });
  expect(more.mastodonHandle("https://chaos.social/@user")).toEqual({ user: "user", instance: "chaos.social" });
  expect(more.mastodonHandle("hello")).toBeNull();
});
test("mastodon: untitled RSS items get a title from the post text", () => {
  const xml = `<rss><channel><title>Ada</title><item><guid>https://m.social/@ada/1</guid><link>https://m.social/@ada/1</link><pubDate>Tue, 17 Nov 2026 10:00:00 +0000</pubDate>
    <description>&lt;p&gt;Shipping the new build today.&lt;/p&gt;&lt;p&gt;More later.&lt;/p&gt;</description></item></channel></rss>`;
  expect(parseFeed(xml).entries).toHaveLength(0); // default: untitled items are dropped
  const e = parseFeed(xml, { untitled: true }).entries;
  expect(e).toHaveLength(1);
  expect(e[0].title).toBe("Shipping the new build today.");
});

/* ---------- Topic (Bing News) ---------- */
const BING = `<?xml version="1.0"?><rss version="2.0" xmlns:News="https://www.bing.com/news"><channel><title>x - Bing</title>
<item><title>Hochwasser an der Isar</title><link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=1&amp;url=https%3a%2f%2fwww.sz.de%2fa%2fisar-1%3fx%3d1%26y%3d%25C3%25BC&amp;c=1&amp;mkt=de-de</link><description>Der Pegel steigt.</description><pubDate>Tue, 17 Nov 2026 08:00:00 GMT</pubDate><News:Source>SZ</News:Source><News:Image>https://www.bing.com/th?id=1</News:Image></item>
<item><title>Dupe</title><link>http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fwww.sz.de%2fa%2fisar-1%3fx%3d1%26y%3d%25C3%25BC</link><description>same</description></item>
<item><title>Bad scheme</title><link>http://www.bing.com/news/apiclick.aspx?url=javascript%3aalert(1)</link></item>
<item><title>No url</title><link>http://www.bing.com/news/apiclick.aspx?ref=x</link></item>
<item><title>Direct</title><link>https://example.org/story</link><description>d</description></item></channel></rss>`;
test("bing: apiclick url is decoded, bad schemes dropped, duplicates removed", () => {
  expect(more.bingRealUrl("http://www.bing.com/news/apiclick.aspx?a=1&amp;url=https%3a%2f%2fx.de%2fp%3fq%3d1")).toBe("https://x.de/p?q=1");
  expect(more.bingRealUrl("http://www.bing.com/news/apiclick.aspx?url=ftp%3a%2f%2fx.de%2f")).toBeNull();
  const items = more.bingItems(BING);
  expect(items.map(i => i.url)).toEqual(["https://www.sz.de/a/isar-1?x=1&y=%C3%BC", "https://example.org/story"]);
  expect(items[0]).toMatchObject({ title: "Hochwasser an der Isar", source: "SZ", image: "https://www.bing.com/th?id=1" });
  expect(items[0].published).toBe(Date.parse("2026-11-17T08:00:00Z"));
});

/* ---------- GitHub releases ---------- */
const GH = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Release notes from bun</title><link rel="alternate" href="https://github.com/oven-sh/bun/releases"/>
<entry><id>tag:github.com,2008:Repository/1/bun-v1.4.4</id><updated>2026-10-22T21:44:54Z</updated><link rel="alternate" type="text/html" href="https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4"/><title>Bun v1.4.4</title><content type="html">&lt;p&gt;Faster installs&lt;/p&gt;</content></entry>
<entry><id>tag:github.com,2008:Repository/1/v2</id><updated>2026-10-20T00:00:00Z</updated><link rel="alternate" type="text/html" href="https://github.com/oven-sh/bun/releases/tag/v2"/><title>v2</title><content type="html">&lt;p&gt;x&lt;/p&gt;</content></entry></feed>`;
test("github: release titles are '<repo> <tag>: <title>'", () => {
  const items = more.githubItems(parseFeed(GH).entries, "bun", "oven-sh/bun");
  expect(items[0].title).toBe("bun bun-v1.4.4: Bun v1.4.4");
  expect(items[0].body).toBe("Faster installs");
  expect(items[1].title).toBe("bun v2"); // a title that only repeats the tag is dropped
  expect(more.githubRepo("https://github.com/oven-sh/bun/releases")).toEqual({ owner: "oven-sh", repo: "bun" });
  expect(more.githubRepo("oven-sh/bun")).toEqual({ owner: "oven-sh", repo: "bun" });
  expect(more.githubRepo("https://github.com/oven-sh")).toBeNull();
  expect(kindForUrl("https://github.com/oven-sh/bun")).toBe("github");
  expect(kindForUrl("https://github.com/oven-sh")).toBe("feed");
  expect(kindForUrl("https://bsky.app/profile/ada.bsky.social")).toBe("bluesky");
  expect(kindForUrl("https://arxiv.org/list/cs.CL/recent")).toBe("arxiv");
});

/* ---------- arXiv ---------- */
const ARXIV = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><title>query</title>
<entry><id>http://arxiv.org/abs/2611.01234v2</id><published>2026-11-16T18:00:01Z</published><title>Scaling   Laws
 for Tiny Models</title><summary>  We study
 small models.  </summary>
<author><name>A. One</name></author><author><name>B. Two</name></author><author><name>C. Three</name></author><author><name>D. Four</name></author>
<link href="http://arxiv.org/abs/2611.01234v2" rel="alternate" type="text/html"/><link title="pdf" href="http://arxiv.org/pdf/2611.01234v2" rel="related" type="application/pdf"/><arxiv:primary_category term="cs.CL"/></entry></feed>`;
test("arxiv: atom entries map to items", () => {
  const [i] = more.parseArxiv(ARXIV);
  expect(i.title).toBe("Scaling Laws for Tiny Models");
  expect(i.body).toBe("We study small models.");
  expect(i.author).toBe("A. One, B. Two, C. Three et al.");
  expect(i.url).toBe("https://arxiv.org/abs/2611.01234");
  expect(i.meta).toMatchObject({ pdf: "https://arxiv.org/pdf/2611.01234", category: "cs.CL" });
  expect(decodeURIComponent(more.arxivUrl({ cat: "cs.CL" }))).toContain("search_query=cat:cs.CL&sortBy=submittedDate");
  expect(decodeURIComponent(more.arxivUrl({ query: 'say "hi"' }))).toContain('all:"say  hi"');
});

/* ---------- Watch a page ---------- */
const page = (...paras: string[]) => ({ title: "Pricing", url: "https://example.com/pricing", paras });
test("watch: baseline, no change, change", () => {
  const first = more.watchStep({}, page("Free plan", "Pro plan 10 EUR"));
  expect(first.item).toBeNull(); // baseline only
  const same = more.watchStep(first.cursor, page("Free plan", "Pro plan 10 EUR"));
  expect(same.item).toBeNull();
  const changed = more.watchStep(same.cursor, page("Free plan", "Pro plan 12 EUR", "New team plan"), 1000);
  expect(changed.item?.title).toBe("Pricing: changed");
  expect(changed.item?.url).toBe("https://example.com/pricing");
  expect(changed.item?.body).toContain("Pro plan 12 EUR");
  expect(changed.item?.body).toContain("New team plan");
  expect(changed.item?.body).toContain("1 paragraph removed.");
  expect(changed.item?.body).not.toContain("Free plan");
  const after = more.watchStep(changed.cursor, page("Free plan", "Pro plan 12 EUR", "New team plan"));
  expect(after.item).toBeNull(); // the new state is the baseline now
  expect(() => more.watchStep({}, page())).toThrow();
});
test("watch: readPage extracts paragraphs and the title", async () => {
  const p = await more.readPage(`<html><head><title>Hello &amp; welcome</title></head><body><main><p>${"First paragraph. ".repeat(10)}</p><p>${"Second one. ".repeat(10)}</p></main></body></html>`, "https://example.com/");
  expect(p.title).toBe("Hello & welcome");
  expect(p.paras).toHaveLength(2);
});

/* ---------- Catalog and registry ---------- */
test("catalog: groups, no duplicate feed URLs, https only", () => {
  expect(CATALOG.map(g => g.title)).toEqual(["München & Bayern", "Deutschland", "Tech", "AI", "Wirtschaft"]);
  const urls = CATALOG.flatMap(g => g.entries.map(e => e.feed));
  expect(new Set(urls).size).toBe(urls.length);
  for (const g of CATALOG) { expect(g.entries.length).toBeGreaterThanOrEqual(4); for (const e of g.entries) { expect(e.feed.startsWith("https://")).toBe(true); expect(["de", "en"]).toContain(e.lang); expect(e.name && e.site && e.about).toBeTruthy(); } }
});
test("every new kind is registered with a pull; configs are validated", async () => {
  for (const k of more.NEW_KINDS) expect(typeof CONNECTORS[k].pull).toBe("function");
  expect((await more.configFor("topic", { q: " Isar  Hochwasser ", lang: "xx" })).config).toEqual({ q: "Isar Hochwasser", lang: "en", key: "en:isar hochwasser" });
  await expect(more.configFor("bluesky", { did: "javascript:1" })).rejects.toThrow();
  await expect(more.configFor("watch", { url: "http://127.0.0.1/admin" })).rejects.toThrow();
  await expect(more.configFor("mastodon", { user: "a", instance: "localhost" })).rejects.toThrow();
  expect((await more.configFor("arxiv", { cat: "cs.CL" })).config.key).toBe("cat:cs.CL");
});
test("new items insert with ids >= 600", () => {
  db.query("INSERT OR IGNORE INTO users (id, name, created_at) VALUES (1, 'me', ?)").run(now());
  db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (600, 1, 'bluesky', 'Ada', ?)").run(now());
  const src = db.query("SELECT * FROM sources WHERE id = 600").get() as any;
  const ids = insertItems(src, more.blueskyItems(BSKY_FEED, DID).map(({ uri: _u, ...i }) => i));
  expect(ids.length).toBe(4);
});
