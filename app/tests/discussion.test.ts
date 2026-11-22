process.env.PEPPERMINT_DB = ":memory:";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const D = await import("../server/discussion");

const node = (id: number, text: string, children: any[] = [], author: string | null = "u" + id) => ({ id, type: "comment", author, text, created_at: "2026-11-18T10:00:00.000Z", children });

test("Algolia item tree becomes comments: top level in order, two replies each, html as plain text", () => {
  const t = D.hnThread({ id: 77, children: [
    node(1, "<p>First <i>point</i></p><p>second &amp; third</p>", [node(11, "reply a"), node(12, "reply b"), node(13, "reply c", [node(131, "deep")])]),
    node(2, "gone", [], null),
    node(3, "last"),
  ] })!;
  expect(t.source).toBe("hn");
  expect(t.url).toBe("https://news.ycombinator.com/item?id=77");
  expect(t.comments.map(c => c.id)).toEqual(["1", "11", "12", "3"]);
  expect(t.comments.map(c => c.depth)).toEqual([0, 1, 1, 0]);
  expect(t.comments[0].text).toBe("First point\n\nsecond & third");
  expect(t.comments[0].by).toBe("u1");
  expect(t.count).toBe(6); // 1, 11, 12, 13, 131 and 3; the deleted one is not counted
  expect(D.hnThread({ id: 5, children: [] })).toBeNull();
});

test("normUrl ignores scheme, www, fragment, trailing slash and tracking, and keeps the rest", () => {
  const n = D.normUrl;
  expect(n("http://www.Example.com/a/b/?utm_source=x&id=2#top")).toBe("example.com/a/b?id=2");
  expect(n("https://example.com/a/b")).toBe(n("http://example.com/a/b/"));
  expect(n("https://example.com/a?b=1&a=2")).toBe(n("https://example.com/a?a=2&b=1"));
  expect(n("https://example.com/a?id=1")).not.toBe(n("https://example.com/a?id=2"));
  expect(n("ftp://example.com/a")).toBeNull();
  expect(n("not a url")).toBeNull();
});

test("only exact URL matches count as the story's HN discussion, the biggest first", () => {
  const hits = [
    { objectID: "1", url: "https://example.com/post-2", num_comments: 500 },
    { objectID: "2", url: "http://www.example.com/post/", num_comments: 12 },
    { objectID: "3", url: "https://example.com/post?utm_source=hn", num_comments: 40 },
    { objectID: "4", url: "https://example.com/post", num_comments: 0 },
    { objectID: "5", url: "https://other.com/post", num_comments: 90 },
  ];
  expect(D.hnMatches(hits, "https://example.com/post")).toEqual([{ id: "3", comments: 40 }, { id: "2", comments: 12 }]);
  expect(D.hnMatches(hits, "https://example.com/post", 1)).toEqual([{ id: "3", comments: 40 }]);
  expect(D.hnMatches(hits, "nonsense")).toEqual([]);
});

test("Bluesky thread: replies ranked by likes, nested replies kept as depth 1", () => {
  const post = (n: number, text: string, likes: number, replies: any[] = []) => ({ post: { uri: `at://did:plc:x/app.bsky.feed.post/r${n}`, author: { handle: `h${n}.bsky.social` }, record: { text, createdAt: "2026-11-18T10:00:00Z" }, likeCount: likes }, replies });
  const t = D.blueskyThread({ thread: { post: { uri: "at://did:plc:x/app.bsky.feed.post/root", author: { handle: "me.bsky.social" }, record: { text: "root" } }, replies: [
    post(1, "meh", 1), post(2, "great point", 40, [post(21, "agreed", 3), post(22, "no", 9), post(23, "third", 1)]), { $type: "app.bsky.feed.defs#blockedPost" },
  ] } })!;
  expect(t.url).toBe("https://bsky.app/profile/me.bsky.social/post/root");
  expect(t.comments.map(c => c.text)).toEqual(["great point", "no", "agreed", "meh"]);
  expect(t.comments[0]).toMatchObject({ by: "@h2.bsky.social", likes: 40, depth: 0 });
  expect(t.count).toBe(5);
  expect(D.blueskyThread({ thread: { post: { uri: "at://x/app.bsky.feed.post/a", author: {}, record: {} }, replies: [] } })).toBeNull();
});

test("Mastodon context: tree rebuilt from in_reply_to_id, ranked by favourites, html as plain text", () => {
  const s = (id: string, parent: string, html: string, fav: number, acct = "a@b.social") => ({ id, in_reply_to_id: parent, content: html, favourites_count: fav, created_at: "2026-11-18T10:00:00.000Z", account: { acct } });
  const t = D.mastodonThread({ descendants: [
    s("2", "1", "<p>low</p>", 1), s("3", "1", '<p>high <a href="https://x.test/">link</a><img src=x onerror=alert(1)></p>', 9, "c@d.social"), s("4", "3", "<p>reply</p>", 0), s("5", "99", "<p>orphan</p>", 5),
  ] }, "1", "https://b.social/@me/1")!;
  expect(t.comments.map(c => c.id)).toEqual(["3", "4", "2"]);
  expect(t.comments[0].text).toBe("high link");
  expect(t.comments[0].by).toBe("@c@d.social");
  expect(t.count).toBe(4);
  expect(D.mastodonThread({ descendants: [] }, "1", "u")).toBeNull();
  expect(D.mastodonStatus("https://mastodon.social/@user/117639807473394429")?.instance).toBe("mastodon.social");
  expect(D.mastodonStatus("https://localhost/@user/117639807473394429")).toBeNull();
  expect(D.mastodonStatus("https://x.social/about")).toBeNull();
});

test("Lobsters story: flat list rebuilt, deleted comments skipped, ranked by score", () => {
  const c = (id: string, parent: string | null, html: string, score: number, extra = {}) => ({ short_id: id, parent_comment: parent, comment: html, score, commenting_user: "user_" + id, created_at: "2026-11-18T10:00:00.000-06:00", ...extra });
  const t = D.lobstersThread({ short_id: "abc123", comments_url: "https://lobste.rs/s/abc123/title", comments: [c("a", null, "<p>meh</p>", 2), c("b", null, "<p>best</p>", 30), c("c", "b", "<p>reply</p>", 4), c("d", null, "<p>deleted</p>", 50, { is_deleted: true })] })!;
  expect(t.url).toBe("https://lobste.rs/s/abc123/title");
  expect(t.comments.map(x => x.id)).toEqual(["b", "c", "a"]);
  expect(t.count).toBe(3);
});

test("YouTube next response: top-level comments from the entity payloads", () => {
  const m = (id: string, level: number, text: string, likes: string) => ({ payload: { commentEntityPayload: { properties: { commentId: id, replyLevel: level, content: { content: text } }, author: { displayName: "@" + id }, toolbar: { likeCountNotliked: likes } } } });
  const t = D.youtubeThread({ frameworkUpdates: { entityBatchUpdate: { mutations: [m("a", 0, "nice", "1.2K"), m("b", 1, "a reply", "3"), { payload: {} }, m("c", 0, "<b>ok</b>", "7")] } } }, "dQw4w9WgXcQ")!;
  expect(t.comments.map(c => c.id)).toEqual(["a", "c"]);
  expect(t.comments[0].likes).toBe(1200);
  expect(t.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  expect(D.youtubeThread({}, "dQw4w9WgXcQ")).toBeNull();
});

test("remote html never survives: scripts, images, links and handlers become plain words", () => {
  const t = D.plainText('<p>Hi <a href="javascript:alert(1)" onclick="x()">there</a></p><script>alert(1)</script><img src=x onerror=alert(2)><style>p{}</style><!-- c --><p>Bye &lt;b&gt;</p>');
  expect(t).toBe("Hi there\n\nBye <b>");
  expect(t).not.toMatch(/alert|onerror|javascript|<img|<script/);
  expect(D.plainText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  expect(D.plainText("a​b\u0007c")).toBe("abc");
});

test("caps: at most 60 comments and 20000 characters across threads, earlier ones win", () => {
  const mk = (n: number, len: number, source: any = "hn"): any => ({ source, url: "u" + source, count: n, comments: Array.from({ length: n }, (_, i) => ({ id: String(i), by: "x", at: 0, text: "w".repeat(len), likes: null, depth: 0 })) });
  const a = D.capThreads([mk(50, 10), mk(50, 10, "lobsters")]);
  expect(a.map(t => t.comments.length)).toEqual([50, 10]);
  const b = D.capThreads([mk(40, 1000)]);
  expect(b[0].comments.length).toBe(20);
  expect(D.capThreads([mk(3, 5)], 60, 20_000)[0].count).toBe(3);
  const big = D.hnThread({ id: 1, children: Array.from({ length: 80 }, (_, i) => node(i + 1, "x".repeat(3000))) })!;
  expect(big.comments.length).toBeLessThanOrEqual(D.TOP_LEVEL * 3);
  expect(Math.max(...big.comments.map(c => c.text.length))).toBeLessThanOrEqual(D.PER_COMMENT);
});

test("refresh rule: fetch when never fetched, or when over 3 hours old while the story is under 2 days old", () => {
  const t = 1_000_000_000_000, h = 3600_000;
  expect(D.isStale(null, t - 10 * 86400_000, t)).toBe(true);
  expect(D.isStale(t - 2 * h, t - 5 * h, t)).toBe(false);
  expect(D.isStale(t - 4 * h, t - 5 * h, t)).toBe(true);
  expect(D.isStale(t - 40 * h, t - 47 * h, t)).toBe(true);
  expect(D.isStale(t - 40 * h, t - 49 * h, t)).toBe(false); // an old story is left alone
});

test("plan: what to look up for a story's items", () => {
  const jobs = D.plan([
    { kind: "hackernews", ext_id: "4242", url: "https://example.com/post?utm_source=x", meta: JSON.stringify({ hn: "https://news.ycombinator.com/item?id=4242" }) },
    { kind: "feed", ext_id: "g", url: "https://example.com/post/", meta: "{}" },
    { kind: "bluesky", ext_id: "at://did:plc:abc/app.bsky.feed.post/3xyz", url: "https://bsky.app/profile/a/post/3xyz", meta: JSON.stringify({ link: "https://other.com/story" }) },
    { kind: "mastodon", ext_id: "g2", url: "https://mastodon.social/@u/117639807473394429", meta: "{}" },
    { kind: "youtube", ext_id: "y", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", meta: JSON.stringify({ video: "dQw4w9WgXcQ" }) },
  ]);
  const key = jobs.map(j => `${j.kind}:${j.arg}`);
  expect(key).toContain("hn-item:4242");
  expect(key.filter(k => k.startsWith("hn-url:"))).toEqual(["hn-url:https://example.com/post?utm_source=x", "hn-url:https://other.com/story"]); // the same article once
  expect(key).toContain("bluesky:at://did:plc:abc/app.bsky.feed.post/3xyz");
  expect(key).toContain("mastodon:https://mastodon.social/@u/117639807473394429");
  expect(key).toContain("youtube:dQw4w9WgXcQ");
  expect(key.some(k => k.includes("bsky.app") || k.includes("youtube.com"))).toBe(false); // social posts are not articles
});

beforeAll(() => {
  db.query("INSERT OR IGNORE INTO users (id, name, created_at) VALUES (1, 'me', ?)").run(now());
  db.query("INSERT INTO stories (id, owner_id, title, first_at, last_at) VALUES (900, 1, 'Story', ?, ?), (901, 1, 'Quiet', ?, ?)").run(now(), now(), now(), now());
});

test("stored discussion: read back sorted, material for Claude lists comments, a story with nothing found has no material", () => {
  const th = (n: number) => JSON.stringify([{ id: "1", by: "alice", at: 0, text: "Line one\ntwo", likes: 5, depth: 0 }, { id: "2", by: "bob", at: 0, text: "reply", likes: null, depth: 1 }].slice(0, n));
  db.query("INSERT INTO discussions (story_id, source, url, fetched_at, comments_json, count) VALUES (900, 'bluesky', 'https://bsky.app/x', ?, ?, 3), (900, 'hn', 'https://news.ycombinator.com/item?id=1', ?, ?, 40)").run(now(), th(1), now(), th(2));
  db.query("INSERT INTO discussions (story_id, source, url, fetched_at, comments_json, count) VALUES (901, 'none', '', ?, '[]', 0)").run(now());
  const d = D.storedDiscussion(900);
  expect(d.threads.map(t => t.source)).toEqual(["hn", "bluesky"]);
  expect(d.count).toBe(43);
  const m = D.discussionMaterial(900)!;
  expect(m).toContain("Discussion on Hacker News (40 comments):");
  expect(m).toContain("- alice (5 likes): Line one two");
  expect(m).toContain("  > bob: reply");
  expect(D.discussionMaterial(900, 30)!.length).toBeLessThan(m.length);
  expect(D.storedDiscussion(901)).toMatchObject({ threads: [], count: 0 });
  expect(D.discussionMaterial(901)).toBeNull();
});

test("a fresh stored copy is served without any network", async () => {
  const d = await D.discussionFor(900);
  expect(d.count).toBe(43);
  const none = await D.discussionFor(901);
  expect(none.threads).toEqual([]);
});
