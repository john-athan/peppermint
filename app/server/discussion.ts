// What people say: the public discussion about a story, found without accounts or keys.
// Hacker News and Lobsters (by article URL), Bluesky and Mastodon replies, YouTube comments. Stored per story in
// `discussions`, refreshed while the story is young, summarised by Claude in the "discussion" lens and fed into the TL;DR.
import { db, json, now } from "./db";
import { get, decode, stripTags } from "./connectors/util";

export type Comment = { id: string; by: string; at: number; text: string; likes: number | null; depth: 0 | 1 };
export type SourceKind = "hn" | "lobsters" | "bluesky" | "mastodon" | "youtube";
/** One discussion place: `count` is everything people wrote there, `comments` the part we keep. */
export type Thread = { source: SourceKind; url: string; count: number; comments: Comment[] };
export const SOURCE_LABEL: Record<SourceKind, string> = { hn: "Hacker News", lobsters: "Lobsters", bluesky: "Bluesky", mastodon: "Mastodon", youtube: "YouTube" };

// What we keep per story: enough to summarise, small enough to store and to read.
export const MAX_COMMENTS = 60, MAX_CHARS = 20_000, PER_COMMENT = 1500, TOP_LEVEL = 30, REPLIES = 2;
const FRESH_MS = 3 * 3600_000, YOUNG_MS = 2 * 86400_000, RETRY_MS = 5 * 60_000;

/* ---------- text and URLs ---------- */

/** Remote HTML to plain text with paragraphs. Scripts, images, links and every tag go; only the words stay. */
export function plainText(html: string): string {
  const s = html
    .replace(/<(script|style|iframe|object|embed|template|svg)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(pre|blockquote|ul|ol|div)\b[^>]*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ");
  return stripTags(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮⁠﻿]/g, "").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_(cid|eid)|ref|ref_src|igshid|si|source|share|feature)$/i;
/** One form of an address for comparing: no scheme, no www, no fragment, no tracking parameters, no trailing slash. */
export function normUrl(u: string): string | null {
  try {
    const x = new URL(u);
    if (x.protocol !== "http:" && x.protocol !== "https:") return null;
    const params = [...x.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const q = params.map(([k, v]) => `${k}=${v}`).join("&");
    const path = x.pathname.replace(/\/+$/, "");
    return `${x.hostname.toLowerCase().replace(/^www\./, "")}${x.port ? ":" + x.port : ""}${path}${q ? "?" + q : ""}`;
  } catch { return null; }
}

const likesOf = (s: unknown): number | null => {
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const m = /^([\d.,]+)\s*([KMkm]?)$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  return Math.round(n * (m[2].toLowerCase() === "k" ? 1e3 : m[2].toLowerCase() === "m" ? 1e6 : 1));
};

/* ---------- trees to comments ---------- */

type Node = { c: Comment; replies: Node[] };
/** The best parts of a tree: the first `TOP_LEVEL` roots as given (callers sort them), each with its first `REPLIES` replies. */
function flatten(roots: Node[]): Comment[] {
  const out: Comment[] = [];
  for (const r of roots.slice(0, TOP_LEVEL)) {
    out.push({ ...r.c, depth: 0 });
    for (const x of r.replies.slice(0, REPLIES)) out.push({ ...x.c, depth: 1 });
  }
  return out;
}
const countNodes = (ns: Node[]): number => ns.reduce((n, x) => n + 1 + countNodes(x.replies), 0);
const byLikes = (a: Node, b: Node) => (b.c.likes ?? 0) - (a.c.likes ?? 0);
const clean = (c: Comment): Comment => ({ ...c, text: clip(c.text, PER_COMMENT) });

/** Trims threads to the caps, in order: earlier threads and earlier comments win. */
export function capThreads(threads: Thread[], maxComments = MAX_COMMENTS, maxChars = MAX_CHARS): Thread[] {
  let n = 0, chars = 0;
  return threads.map(t => {
    const keep: Comment[] = [];
    for (const c of t.comments) {
      if (n >= maxComments || chars + c.text.length > maxChars) break;
      keep.push(c); n++; chars += c.text.length;
    }
    return { ...t, comments: keep };
  }).filter(t => t.comments.length);
}

/** An Algolia item tree (/api/v1/items/<id>). HN gives no points for comments, so the site's own order is the ranking. */
export function hnThread(tree: any): Thread | null {
  const walk = (n: any): Node | null => {
    if (!n || n.type !== "comment" || !n.text || !n.author) return null;
    const t = plainText(String(n.text));
    if (!t) return null;
    return { c: { id: String(n.id), by: String(n.author), at: Date.parse(n.created_at) || 0, text: t, likes: null, depth: 0 }, replies: (n.children ?? []).map(walk).filter(Boolean) as Node[] };
  };
  const roots = (tree?.children ?? []).map(walk).filter(Boolean) as Node[];
  if (!roots.length) return null;
  return { source: "hn", url: `https://news.ycombinator.com/item?id=${tree.id}`, count: countNodes(roots), comments: flatten(roots).map(clean) };
}

/** Algolia search hits whose address is exactly the article's, biggest discussion first. */
export function hnMatches(hits: any[], url: string, max = 2): { id: string; comments: number }[] {
  const want = normUrl(url);
  if (!want) return [];
  return (hits ?? []).filter(h => h?.url && normUrl(String(h.url)) === want && (h.num_comments ?? 0) > 0)
    .sort((a, b) => (b.num_comments ?? 0) - (a.num_comments ?? 0)).slice(0, max).map(h => ({ id: String(h.objectID), comments: h.num_comments }));
}

/** A getPostThread response. Replies are ranked by likes. */
export function blueskyThread(d: any): Thread | null {
  const walk = (n: any): Node | null => {
    const p = n?.post;
    if (!p?.record?.text) return null;
    return {
      c: { id: String(p.uri), by: `@${p.author?.handle ?? "unknown"}`, at: Date.parse(p.record.createdAt ?? p.indexedAt ?? "") || 0, text: plainText(String(p.record.text)), likes: likesOf(p.likeCount), depth: 0 },
      replies: (n.replies ?? []).map(walk).filter(Boolean).sort(byLikes) as Node[],
    };
  };
  const root = d?.thread;
  const roots = (root?.replies ?? []).map(walk).filter(Boolean).sort(byLikes) as Node[];
  if (!roots.length) return null;
  const rkey = String(root.post.uri).split("/").pop();
  return { source: "bluesky", url: `https://bsky.app/profile/${root.post.author?.handle}/post/${rkey}`, count: countNodes(roots), comments: flatten(roots).map(clean) };
}

/** A statuses/<id>/context response: descendants carry in_reply_to_id, so the tree is rebuilt from it. */
export function mastodonThread(ctx: any, rootId: string, url: string): Thread | null {
  const all: any[] = Array.isArray(ctx?.descendants) ? ctx.descendants : [];
  const kids = new Map<string, any[]>();
  for (const s of all) (kids.get(String(s.in_reply_to_id)) ?? kids.set(String(s.in_reply_to_id), []).get(String(s.in_reply_to_id))!).push(s);
  const node = (s: any): Node | null => {
    const t = plainText(String(s.content ?? ""));
    if (!t) return null;
    return { c: { id: String(s.id), by: `@${s.account?.acct ?? "unknown"}`, at: Date.parse(s.created_at) || 0, text: t, likes: likesOf(s.favourites_count), depth: 0 }, replies: (kids.get(String(s.id)) ?? []).map(node).filter(Boolean) as Node[] };
  };
  const roots = (kids.get(rootId) ?? []).map(node).filter(Boolean).sort(byLikes) as Node[];
  if (!roots.length) return null;
  return { source: "mastodon", url, count: all.length, comments: flatten(roots).map(clean) };
}

/** A lobste.rs story JSON: a flat comment list with parent_comment, scores and html. */
export function lobstersThread(s: any): Thread | null {
  const list: any[] = (s?.comments ?? []).filter((c: any) => !c.is_deleted && !c.is_moderated && c.comment);
  const kids = new Map<string | null, any[]>();
  for (const c of list) (kids.get(c.parent_comment ?? null) ?? kids.set(c.parent_comment ?? null, []).get(c.parent_comment ?? null)!).push(c);
  const node = (c: any): Node | null => {
    const t = plainText(String(c.comment));
    if (!t) return null;
    const by = typeof c.commenting_user === "string" ? c.commenting_user : c.commenting_user?.username ?? "unknown";
    return { c: { id: String(c.short_id), by, at: Date.parse(c.created_at) || 0, text: t, likes: likesOf(c.score), depth: 0 }, replies: (kids.get(c.short_id) ?? []).map(node).filter(Boolean).sort(byLikes) as Node[] };
  };
  const roots = (kids.get(null) ?? []).map(node).filter(Boolean).sort(byLikes) as Node[];
  if (!roots.length) return null;
  return { source: "lobsters", url: String(s.comments_url || s.short_id_url || `https://lobste.rs/s/${s.short_id}`), count: list.length, comments: flatten(roots).map(clean) };
}

/** The top comments of a YouTube `next` response: the text sits in frameworkUpdates, not next to the thread. */
export function youtubeThread(d: any, video: string): Thread | null {
  const muts: any[] = d?.frameworkUpdates?.entityBatchUpdate?.mutations ?? [];
  const cs = muts.map(m => m?.payload?.commentEntityPayload).filter(Boolean);
  const comments: Comment[] = cs.filter(c => (c.properties?.replyLevel ?? 0) === 0 && c.properties?.content?.content)
    .map(c => ({ id: String(c.properties.commentId), by: String(c.author?.displayName ?? "unknown"), at: 0, text: plainText(String(c.properties.content.content)), likes: likesOf(c.toolbar?.likeCountNotliked), depth: 0 as const }))
    .filter(c => c.text).slice(0, TOP_LEVEL).map(clean);
  if (!comments.length) return null;
  // the header holds the full count ("2,462,494 Comments")
  const find = (o: any): string | null => { if (!o || typeof o !== "object") return null; if (o.commentsHeaderRenderer) return o.commentsHeaderRenderer.countText?.runs?.[0]?.text ?? null; for (const v of Object.values(o)) { const r = find(v); if (r) return r; } return null; };
  const shown = find(d), total = shown && /^[\d.,\s]+$/.test(shown) ? Number(shown.replace(/\D/g, "")) : 0;
  return { source: "youtube", url: `https://www.youtube.com/watch?v=${video}`, count: Math.max(total, comments.length), comments };
}

/* ---------- fetchers (network) ---------- */

const JSON_HDR = { accept: "application/json" };
const getJSON = async (url: string, opts: { timeout?: number; guard?: boolean; maxBytes?: number } = {}) => JSON.parse((await get(url, { timeout: 12_000, headers: JSON_HDR, ...opts })).text);

export async function fetchHnItem(id: string): Promise<Thread | null> {
  return hnThread(await getJSON(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(id)}`, { timeout: 20_000, maxBytes: 15_000_000 }));
}
export async function findHn(url: string): Promise<{ id: string; comments: number }[]> {
  const d = await getJSON(`https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=10&restrictSearchableAttributes=url&query=${encodeURIComponent(url)}`);
  return hnMatches(d.hits, url);
}
/** Lobsters has no working search by address (check_url_dupe answers 500), but a domain's page lists its newest
 *  stories as JSON: the story is the one whose address matches exactly. Older stories on busy domains are missed. */
export async function fetchLobsters(url: string): Promise<Thread | null> {
  const want = normUrl(url); if (!want) return null;
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (!HOST_RE.test(host)) return null;
  let list: any;
  try { list = await getJSON(`https://lobste.rs/domains/${host}.json`, { timeout: 10_000 }); } catch (e: any) { if (/\b404\b/.test(String(e?.message))) return null; throw e; }
  const hit = (Array.isArray(list) ? list : []).find(x => x?.url && normUrl(String(x.url)) === want && x.comment_count > 0);
  if (!hit || !/^\w{4,10}$/.test(String(hit.short_id))) return null;
  return lobstersThread(await getJSON(`https://lobste.rs/stories/${hit.short_id}.json`));
}
export async function fetchBluesky(uri: string): Promise<Thread | null> {
  return blueskyThread(await getJSON(`https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread?uri=${encodeURIComponent(uri)}&depth=2`));
}
const HOST_RE = /^(?=.{4,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
export function mastodonStatus(url: string): { instance: string; id: string; url: string } | null {
  const m = /^https:\/\/([^/]+)\/@[\w.-]+(?:@[\w.-]+)?\/(\d{5,30})\/?$/.exec(url);
  return m && HOST_RE.test(m[1]) ? { instance: m[1].toLowerCase(), id: m[2], url: url.replace(/\/$/, "") } : null;
}
export async function fetchMastodon(url: string): Promise<Thread | null> {
  const s = mastodonStatus(url); if (!s) return null;
  // the instance name comes from a post's link, so it is checked like any pasted address
  return mastodonThread(await getJSON(`https://${s.instance}/api/v1/statuses/${s.id}/context`, { guard: true }), s.id, s.url);
}
/** The watch page carries a token for the comments; the same call the site makes returns them. No account involved,
 *  but it is not an official API, so any failure here means "no comments" and nothing else. */
export async function fetchYoutube(video: string): Promise<Thread | null> {
  if (!/^[\w-]{11}$/.test(video)) return null;
  const cookie = "CONSENT=YES+1; SOCS=CAI";
  const page = await get(`https://www.youtube.com/watch?v=${video}`, { timeout: 10_000, headers: { cookie, "accept-language": "en" } });
  const key = /"INNERTUBE_API_KEY":"([\w-]+)"/.exec(page.text)?.[1], ver = /"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/.exec(page.text)?.[1];
  const tokens = [...page.text.matchAll(/"continuationCommand":\{"token":"([^"]+)"/g)].map(m => m[1]);
  // the comments token is the one whose decoded form names the section
  const token = tokens.find(t => { try { return atob(decodeURIComponent(t).replace(/-/g, "+").replace(/_/g, "/")).includes("comments-section"); } catch { return false; } });
  if (!key || !ver || !token) return null;
  const r = await fetch(`https://www.youtube.com/youtubei/v1/next?key=${key}`, {
    method: "POST", headers: { "content-type": "application/json", cookie, "user-agent": "Mozilla/5.0 (compatible; peppermint)" },
    body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: ver, hl: "en" } }, continuation: token }), signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`YouTube ${r.status}`);
  return youtubeThread(await r.json(), video);
}

/* ---------- what to look up for a story ---------- */

export type Job = { source: SourceKind; kind: "hn-item" | "hn-url" | "lobsters" | "bluesky" | "mastodon" | "youtube"; arg: string };
type ItemRow = { url: string | null; ext_id: string; meta: string | null; kind: string };
const SOCIAL = new Set(["bluesky", "mastodon", "youtube", "podcast"]);

/** The lookups a story's items call for. Pure, so it can be tested without a network. */
export function plan(items: ItemRow[]): Job[] {
  const jobs: Job[] = [], seen = new Set<string>();
  const add = (j: Job) => { const k = `${j.kind}:${j.arg}`; if (!seen.has(k)) { seen.add(k); jobs.push(j); } };
  const articles = new Map<string, string>();
  for (const it of items) {
    const meta = json<any>(it.meta, {});
    if (it.kind === "hackernews") {
      const id = /id=(\d+)/.exec(String(meta.hn ?? ""))?.[1] ?? (/^\d+$/.test(it.ext_id) ? it.ext_id : null);
      if (id) add({ source: "hn", kind: "hn-item", arg: id });
    }
    if (it.kind === "bluesky" && /^at:\/\/did:[\w:.%-]+\/app\.bsky\.feed\.post\/[\w]+$/.test(it.ext_id)) add({ source: "bluesky", kind: "bluesky", arg: it.ext_id });
    if (it.kind === "mastodon" && it.url && mastodonStatus(it.url)) add({ source: "mastodon", kind: "mastodon", arg: it.url });
    if (it.kind === "youtube" && typeof meta.video === "string" && /^[\w-]{11}$/.test(meta.video)) add({ source: "youtube", kind: "youtube", arg: meta.video });
    // the article itself: its own address, or the one a post links to
    for (const u of [SOCIAL.has(it.kind) ? null : it.url, typeof meta.link === "string" ? meta.link : null]) {
      const n = u && normUrl(u);
      if (u && n && !/^(news\.ycombinator\.com|lobste\.rs|bsky\.app|hn\.algolia\.com)\b/.test(n) && !articles.has(n)) articles.set(n, u);
    }
  }
  for (const u of [...articles.values()].slice(0, 3)) { add({ source: "hn", kind: "hn-url", arg: u }); add({ source: "lobsters", kind: "lobsters", arg: u }); }
  return jobs;
}

async function runJob(j: Job): Promise<Thread[]> {
  switch (j.kind) {
    case "hn-item": return [await fetchHnItem(j.arg)].filter(Boolean) as Thread[];
    case "hn-url": return (await Promise.all((await findHn(j.arg)).map(h => fetchHnItem(h.id)))).filter(Boolean) as Thread[];
    case "lobsters": return [await fetchLobsters(j.arg)].filter(Boolean) as Thread[];
    case "bluesky": return [await fetchBluesky(j.arg)].filter(Boolean) as Thread[];
    case "mastodon": return [await fetchMastodon(j.arg)].filter(Boolean) as Thread[];
    case "youtube": return [await fetchYoutube(j.arg)].filter(Boolean) as Thread[];
  }
}
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

/* ---------- storage and refresh ---------- */

/** Fetch again? Never fetched: yes. Younger than 2 days and last fetched over 3 hours ago: yes. Otherwise the stored copy stands. */
export function isStale(lastFetched: number | null, storyFirstAt: number, at = now()): boolean {
  if (lastFetched == null) return true;
  return at - storyFirstAt < YOUNG_MS && at - lastFetched > FRESH_MS;
}

type Row = { source: string; url: string; fetched_at: number; comments_json: string; count: number };
const rowsOf = (storyId: number) => db.query("SELECT source, url, fetched_at, comments_json, count FROM discussions WHERE story_id = ?").all(storyId) as Row[];

export function storedDiscussion(storyId: number): { threads: Thread[]; count: number; fetched_at: number | null } {
  const rows = rowsOf(storyId);
  const threads = rows.filter(r => r.source !== "none").map(r => ({ source: r.source as SourceKind, url: r.url, count: r.count, comments: json<Comment[]>(r.comments_json, []) }))
    .sort((a, b) => b.count - a.count);
  return { threads, count: threads.reduce((n, t) => n + t.count, 0), fetched_at: rows.length ? Math.max(...rows.map(r => r.fetched_at)) : null };
}

const inflight = new Map<number, Promise<void>>();
const failedAt = new Map<number, number>();

/** Looks the discussion up and stores it. Sources that failed keep their old rows; one call per story at a time. */
export function refreshDiscussion(storyId: number): Promise<void> {
  const open = inflight.get(storyId); if (open) return open;
  const p = (async () => {
    const items = db.query("SELECT i.url, i.ext_id, i.meta, s.kind FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = ?").all(storyId) as ItemRow[];
    const jobs = plan(items);
    const results = await Promise.all(jobs.map(async j => { try { return { j, threads: await withTimeout(runJob(j), 30_000) }; } catch { return { j, threads: null }; } }));
    const failed = new Set(results.filter(r => !r.threads).map(r => r.j.source));
    if (failed.size) failedAt.set(storyId, now()); else failedAt.delete(storyId);
    const ok = new Set(jobs.map(j => j.source).filter(s => !failed.has(s)));
    // the same thread can be found twice (by id and by address): keep one
    const found = new Map<string, Thread>();
    for (const r of results) for (const t of r.threads ?? []) found.set(`${t.source}:${t.url}`, t);
    // earlier threads win the caps: the biggest discussions first
    const threads = capThreads([...found.values()].sort((a, b) => b.count - a.count));
    // what Claude wrote from fewer comments is written again: a TL;DR from before any comments existed, and the
    // summary once the discussion grew by half
    const before = (db.query("SELECT coalesce(sum(count), 0) AS n FROM discussions WHERE story_id = ?").get(storyId) as { n: number }).n;
    const after = threads.reduce((a, t) => a + t.count, 0);
    if (after > 0 && before === 0) db.query("DELETE FROM lens_cache WHERE story_id = ? AND lens IN ('tldr', 'discussion')").run(storyId);
    else if (after >= before * 1.5 && after - before >= 10) db.query("DELETE FROM lens_cache WHERE story_id = ? AND lens = 'discussion'").run(storyId);
    db.transaction(() => {
      db.query("DELETE FROM discussions WHERE story_id = ? AND source = 'none'").run(storyId);
      for (const s of ok) db.query("DELETE FROM discussions WHERE story_id = ? AND source = ?").run(storyId, s);
      const t = now();
      for (const th of threads) db.query("INSERT OR REPLACE INTO discussions (story_id, source, url, fetched_at, comments_json, count) VALUES (?, ?, ?, ?, ?, ?)").run(storyId, th.source, th.url, t, JSON.stringify(th.comments), th.count);
      // a story with nothing found still gets a row, so it is not looked up again on every open
      if (!db.query("SELECT 1 FROM discussions WHERE story_id = ?").get(storyId)) db.query("INSERT INTO discussions (story_id, source, url, fetched_at, comments_json, count) VALUES (?, 'none', '', ?, '[]', 0)").run(storyId, t);
    })();
  })().finally(() => inflight.delete(storyId));
  inflight.set(storyId, p);
  return p;
}

/** Stored discussion, fetched first when missing or stale. Never throws: no discussion is a normal answer. */
export async function discussionFor(storyId: number, { wait = 25_000 } = {}) {
  const st = db.query("SELECT first_at FROM stories WHERE id = ?").get(storyId) as { first_at: number } | null;
  if (st) {
    const last = storedDiscussion(storyId).fetched_at;
    const backoff = (failedAt.get(storyId) ?? 0) > now() - RETRY_MS;
    if (isStale(last, st.first_at) && !backoff) { try { await withTimeout(refreshDiscussion(storyId), wait); } catch {} }
  }
  return storedDiscussion(storyId);
}

/** Fetches a handful of the edition's stories in the background, one after another, so the reader finds them ready. */
let warming = false;
export async function warmDiscussions(storyIds: number[], max = 4, gapMs = 1500) {
  if (warming) return;
  warming = true;
  try { await warmEach(storyIds, max, gapMs); } finally { warming = false; }
}
async function warmEach(storyIds: number[], max: number, gapMs: number) {
  let done = 0;
  for (const id of storyIds) {
    if (done >= max) break;
    const st = db.query("SELECT first_at FROM stories WHERE id = ?").get(id) as { first_at: number } | null;
    if (!st || !isStale(storedDiscussion(id).fetched_at, st.first_at) || (failedAt.get(id) ?? 0) > now() - RETRY_MS) continue;
    await discussionFor(id).catch(() => {});
    done++;
    await Bun.sleep(gapMs);
  }
}

/* ---------- material for Claude ---------- */

/** The comments as text for a prompt, or null when there are none. Replies are indented under their comment. */
export function discussionMaterial(storyId: number, maxChars = MAX_CHARS): string | null {
  const d = storedDiscussion(storyId);
  if (!d.threads.length) return null;
  const parts: string[] = []; let used = 0;
  for (const t of d.threads) {
    const lines = [`Discussion on ${SOURCE_LABEL[t.source]} (${t.count} comments):`];
    for (const c of t.comments) {
      const line = `${c.depth ? "  > " : "- "}${c.by}${c.likes ? ` (${c.likes} likes)` : ""}: ${c.text.replace(/\n+/g, " ")}`;
      if (used + line.length > maxChars) break;
      used += line.length; lines.push(line);
    }
    parts.push(lines.join("\n"));
  }
  return `Public comments about this story (what people wrote, not facts):\n${parts.join("\n\n")}`;
}
