// Every source kind implements the same contract: discover() turns an input into choices,
// pull() returns new raw items since the cursor.
import { extract, feedLinks, freshEntries, get, parseFeed, pool, stripTags, type FeedCursor, type FeedEntry, type RawItem } from "./util";
import { resolveYouTube } from "./creators";
import { arxiv, bluesky, github, githubRepo, mastodon, topic, watch } from "./more";
import { consult, echa } from "./official";
import { newsletter } from "./newsletter";

export type SourceRow = { id: number; owner_id: number; kind: string; name: string; config: string; cursor: string; cadence_min: number; trust: number };
export type Option = { key: string; label: string; perDay: number; on: boolean; note?: string };
export type Discovery = { kind: string; name: string; subtitle: string; options: Option[]; cadence: number; image?: string | null; config?: Record<string, unknown>; sample: { title: string; lang: string }[] };
export type Pulled = { items: RawItem[]; cursor: Record<string, unknown>; updates?: { ext_id: string; meta: Record<string, unknown> }[] };

export interface Connector {
  kind: string; label: string;
  discover(input?: string): Promise<Discovery>;
  pull?(src: SourceRow, config: any, cursor: any): Promise<Pulled>;
}

/* ---------- Hacker News (official Firebase API) ---------- */
const HN = "https://hacker-news.firebaseio.com/v0";
const HN_LISTS: Record<string, { label: string; path: string; perDay: number }> = {
  top: { label: "Top stories", path: "topstories", perDay: 60 },
  best: { label: "Best of the week", path: "beststories", perDay: 25 },
  show: { label: "Show HN", path: "showstories", perDay: 30 },
  ask: { label: "Ask HN", path: "askstories", perDay: 15 },
};
type HNItem = { id: number; type: string; by?: string; time: number; title?: string; url?: string; text?: string; score?: number; descendants?: number; dead?: boolean; deleted?: boolean };

export const hackernews: Connector = {
  kind: "hackernews", label: "Hacker News",
  async discover() {
    const ids = await (await fetch(`${HN}/topstories.json`, { signal: AbortSignal.timeout(8000) })).json() as number[];
    const sample = (await pool(ids.slice(0, 4), 4, async id => (await fetch(`${HN}/item/${id}.json`)).json() as Promise<HNItem>)).filter(Boolean) as HNItem[];
    return {
      kind: "hackernews", name: "Hacker News", subtitle: "Official API · points floor keeps the noise out", cadence: 30,
      options: Object.entries(HN_LISTS).map(([key, l]) => ({ key, label: l.label, perDay: l.perDay, on: key === "top" || key === "best" })),
      sample: sample.map(s => ({ title: s.title ?? "", lang: "en" })),
    };
  },
  async pull(_src, config: { lists?: string[]; minPoints?: number }, cursor: { seen?: number[] }) {
    const lists = (config.lists?.length ? config.lists : ["top"]).filter(l => HN_LISTS[l]);
    const minPoints = config.minPoints ?? 150;
    const ids = new Set<number>();
    for (const l of lists) {
      const list = await (await fetch(`${HN}/${HN_LISTS[l].path}.json`, { signal: AbortSignal.timeout(10_000) })).json() as number[];
      list.slice(0, l === "top" ? 90 : 60).forEach(id => ids.add(id));
    }
    const fetched = (await pool([...ids], 16, async id => {
      const r = await fetch(`${HN}/item/${id}.json`, { signal: AbortSignal.timeout(8000) });
      return r.json() as Promise<HNItem>;
    })).filter((i): i is HNItem => !!i && i.type === "story" && !i.dead && !i.deleted && !!i.title);
    const isAsk = (i: HNItem) => !i.url;
    const passing = fetched.filter(i => (i.score ?? 0) >= (isAsk(i) ? Math.round(minPoints / 2) : minPoints));
    const seen = new Set(cursor.seen ?? []);
    const fresh = passing.filter(i => !seen.has(i.id));
    // linked article text for new stories only
    const bodies = await pool(fresh, 6, async i => {
      if (!i.url || /\.(pdf|zip|mp4|png|jpe?g)$/i.test(i.url)) return null;
      const page = await get(i.url, { timeout: 8000, maxBytes: 2_500_000 });
      if (!/<html|<p[\s>]/i.test(page.text)) return null;
      return extract(page.text, { base: page.url });
    });
    const items: RawItem[] = fresh.map((i, k) => ({
      ext_id: String(i.id), url: i.url ?? `https://news.ycombinator.com/item?id=${i.id}`, title: i.title!, author: i.by ?? null,
      summary: i.text ? stripTags(i.text).slice(0, 600) : bodies[k]?.description ?? null,
      body: (bodies[k]?.text || (i.text ? stripTags(i.text) : null)) ?? null, lang: bodies[k]?.lang ?? "en",
      published_at: i.time * 1000, meta: { ev: EXTRACT_VERSION, points: i.score ?? 0, comments: i.descendants ?? 0, hn: `https://news.ycombinator.com/item?id=${i.id}`, site: i.url ? new URL(i.url).hostname.replace(/^www\./, "") : "news.ycombinator.com", image: bodies[k]?.image ?? undefined, credit: bodies[k]?.credit ?? undefined, figures: bodies[k]?.figures?.length ? bodies[k]!.figures : undefined },
    }));
    const updates = passing.filter(i => seen.has(i.id)).map(i => ({ ext_id: String(i.id), meta: { points: i.score ?? 0, comments: i.descendants ?? 0 } }));
    const keep = [...new Set([...passing.map(i => i.id), ...(cursor.seen ?? [])])].slice(0, 2000);
    return { items, updates, cursor: { seen: keep } };
  },
};

/* ---------- merkur.de (RSS per section + article pages) ---------- */
const MERKUR_SECTIONS: { key: string; label: string; perDay: number; on?: boolean }[] = [
  { key: "lokales/muenchen", label: "München", perDay: 18, on: true },
  { key: "bayern", label: "Bayern", perDay: 20, on: true },
  { key: "lokales/muenchen-lk", label: "Landkreis München", perDay: 12 },
  { key: "politik", label: "Politik", perDay: 30 },
  { key: "wirtschaft", label: "Wirtschaft", perDay: 25 },
  { key: "welt", label: "Welt", perDay: 20 },
  { key: "sport", label: "Sport", perDay: 30 },
];
const merkurFeed = (key: string) => key === "" ? "https://www.merkur.de/rssfeed.rdf" : `https://www.merkur.de/${key}/rssfeed.rdf`;

export const merkur: Connector = {
  kind: "merkur", label: "merkur.de",
  async discover() {
    const checks = await pool(MERKUR_SECTIONS, 7, async s => {
      const r = await get(merkurFeed(s.key), { timeout: 8000 });
      const f = parseFeed(r.text);
      // merkur answers unknown sections with the front page feed, so check the channel link
      const real = f.link.replace(/\/$/, "").endsWith("/" + s.key);
      return real ? { s, f } : null;
    });
    const ok = checks.filter(Boolean) as { s: typeof MERKUR_SECTIONS[0]; f: ReturnType<typeof parseFeed> }[];
    return {
      kind: "merkur", name: "merkur.de", subtitle: `Münchner Merkur · German · ${ok.length} feeds found`, cadence: 60,
      options: ok.map(({ s }) => ({ key: s.key, label: s.label, perDay: s.perDay, on: !!s.on })),
      sample: ok.flatMap(({ f }) => f.entries.slice(0, 2)).slice(0, 5).map(e => ({ title: e.title, lang: "de" })),
    };
  },
  async pull(_src, config: { sections?: string[] }, cursor: { etag?: Record<string, string>; seen?: string[] }) {
    const sections = config.sections?.length ? config.sections : ["lokales/muenchen"];
    const etag = { ...(cursor.etag ?? {}) }; const seen = new Set(cursor.seen ?? []);
    const entries: (ReturnType<typeof parseFeed>["entries"][0] & { section: string })[] = [];
    for (const s of sections) {
      const r = await get(merkurFeed(s), { timeout: 10_000, headers: etag[s] ? { "if-none-match": etag[s] } : {} });
      if (r.status === 304) continue;
      const e = r.headers.get("etag"); if (e) etag[s] = e;
      for (const it of parseFeed(r.text).entries) entries.push({ ...it, section: s });
    }
    const fresh = entries.filter((e, i) => !seen.has(e.guid) && entries.findIndex(x => x.guid === e.guid) === i);
    const bodies = await pool(fresh, 4, async e => extract((await get(e.link, { timeout: 10_000 })).text, { base: e.link, paragraphSelector: MERKUR_BODY }));
    const items: RawItem[] = fresh.map((e, k) => ({
      ext_id: e.guid, url: e.link, title: e.title, author: e.author, summary: e.description || null,
      body: bodies[k]?.text || null, lang: "de", published_at: e.published,
      meta: { ev: EXTRACT_VERSION, section: MERKUR_SECTIONS.find(s => s.key === e.section)?.label ?? e.section, image: e.image ?? bodies[k]?.image ?? undefined, credit: bodies[k]?.credit ?? undefined, figures: bodies[k]?.figures?.length ? bodies[k]!.figures : undefined, site: "merkur.de" },
    }));
    fresh.forEach(e => seen.add(e.guid));
    return { items, cursor: { etag, seen: [...seen].slice(-3000) } };
  },
};

/** Bumped when article extraction changes; older stored bodies are read again from their pages (see refreshBodies). */
export const EXTRACT_VERSION = 4;

/** merkur.de article body: lead, paragraphs, Q&A answers, crossheads and lists (event listings live in lists). */
export const MERKUR_BODY = "p.id-StoryElement-leadText, p.id-StoryElement-paragraph, p.id-StoryElement-answer, h2.id-StoryElement-crosshead, li.id-StoryElement-list-item";

/* ---------- Any feed (RSS, Atom, JSON Feed), found from a page or a feed link ---------- */
const COMMON_FEEDS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml", "/feed.json", "/blog/feed", "/blog/rss.xml"];
// processing instructions may come first: EUR-Lex's feeds start with <?xml-stylesheet ...?> after the declaration
export const isFeed = (text: string) => /^\s*(<\?[^>]*\?>\s*|<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)[\s>]/i.test(text) || /^\s*\{[\s\S]*"version"\s*:\s*"https:\/\/jsonfeed\.org/.test(text);
function perDay(entries: FeedEntry[]) {
  const ts = entries.map(e => e.published).sort((a, b) => b - a);
  if (ts.length < 2) return 1;
  const days = Math.max(1, (ts[0] - ts[ts.length - 1]) / 86_400_000);
  return Math.max(1, Math.round(ts.length / days));
}
export const feed: Connector = {
  kind: "feed", label: "Feed",
  async discover(input) {
    if (!input) throw new Error("Paste the link of a site or a feed.");
    const start = /^https?:\/\//i.test(input) ? input : `https://${input}`;
    const page = await get(start, { guard: true, timeout: 10_000 });
    let found: { url: string; title: string; f: ReturnType<typeof parseFeed> }[] = [];
    if (isFeed(page.text)) found = [{ url: page.url, title: "", f: parseFeed(page.text) }];
    else {
      let cands = feedLinks(page.text, page.url);
      if (!cands.length) cands = COMMON_FEEDS.map(p => ({ url: new URL(p, page.url).href, title: "" }));
      const got = await pool(cands.slice(0, 9), 4, async c => { const r = await get(c.url, { guard: true, timeout: 8000 }); return isFeed(r.text) ? { url: r.url, title: c.title, f: parseFeed(r.text) } : undefined; });
      found = got.filter((g): g is NonNullable<typeof g> => !!g && g.f.entries.length > 0);
      found = found.filter((g, i) => found.findIndex(x => x.url === g.url) === i);
    }
    if (!found.length) throw new Error("No feed found on that page. Paste the feed link itself if the site has one.");
    const site = found[0].f.title || new URL(page.url).hostname.replace(/^www\./, "");
    const host = new URL(found[0].f.link || page.url).hostname.replace(/^www\./, "");
    return {
      kind: "feed", name: site.slice(0, 60), subtitle: `${host} · ${found.length} feed${found.length === 1 ? "" : "s"} found`, cadence: 60,
      options: found.slice(0, 6).map((g, i) => ({ key: g.url, label: (found.length > 1 && g.title) || g.f.title || g.title || new URL(g.url).pathname, perDay: perDay(g.f.entries), on: i === 0 })),
      sample: found[0].f.entries.slice(0, 5).map(e => ({ title: e.title, lang: "" })),
    };
  },
  async pull(_src, config: { feeds?: string[] }, cursor: FeedCursor) {
    const { fresh, next } = await freshEntries(config.feeds ?? [], cursor);
    // a short summary means the feed only teases; read the article itself
    const bodies = await pool(fresh, 4, async e => e.description.length > 700 || !e.link ? null : (async () => { const p = await get(new URL(e.link).href, { guard: true, timeout: 10_000 }); return extract(p.text, { base: p.url }); })());
    const items: RawItem[] = fresh.map((e, k) => ({
      ext_id: e.guid, url: e.link || e.audio || null, title: e.title, author: e.author, summary: e.description.slice(0, 600) || bodies[k]?.description || null,
      body: e.description.length > 700 ? e.description : bodies[k]?.text || null, lang: bodies[k]?.lang ?? null, published_at: e.published,
      meta: { ev: EXTRACT_VERSION, image: e.image ?? bodies[k]?.image ?? undefined, credit: bodies[k]?.credit ?? undefined, figures: bodies[k]?.figures?.length ? bodies[k]!.figures : undefined, audio: e.audio ?? undefined, site: new URL(e.link || e.audio!).hostname.replace(/^www\./, "") },
    }));
    return { items, cursor: next };
  },
};

/* ---------- Podcasts and YouTube channels: creators picked by name, read through their public feeds ---------- */
// No account and no API key: a podcast's RSS feed carries each episode's audio and show notes, a YouTube channel's
// public feed (youtube.com/feeds/videos.xml) carries each video's id, thumbnail and description.
const picked = (kind: string, label: string) => ({
  kind, label,
  async discover(): Promise<Discovery> { throw Object.assign(new Error(`Search for ${label === "YouTube" ? "a channel" : "a show"} by name in the creator picker.`), { status: 422 }); },
});
export const podcast: Connector = {
  ...picked("podcast", "Podcast"),
  async pull(_src, config: { feeds?: string[]; image?: string }, cursor: FeedCursor) {
    const { fresh, next } = await freshEntries(config.feeds ?? [], cursor, { maxBytes: 30_000_000 });
    const items: RawItem[] = fresh.filter(e => e.audio).map(e => ({
      ext_id: e.guid, url: e.link || e.audio!, title: e.title, author: e.author, summary: e.description.slice(0, 600) || null,
      body: e.description || null, lang: null, published_at: e.published,
      meta: { image: e.image ?? config.image ?? null, audio: e.audio, duration: e.duration, site: (() => { try { return new URL(e.link || e.audio!).hostname.replace(/^www\./, ""); } catch { return ""; } })() },
    }));
    return { items, cursor: next };
  },
};
export const youtube: Connector = {
  ...picked("youtube", "YouTube"),
  // a pasted channel link or @handle needs no search
  async discover(input) {
    const c = input ? await resolveYouTube(input) : null;
    if (!c) throw Object.assign(new Error("Search for a channel by name in the creator picker, or paste the channel link."), { status: 422 });
    return { kind: "youtube", name: c.name, subtitle: `YouTube channel${c.note ? ` · ${c.note}` : ""}`, cadence: 60, options: [{ key: c.feed, label: "New videos", perDay: 1, on: true }], sample: [] };
  },
  async pull(_src, config: { feeds?: string[] }, cursor: FeedCursor) {
    const { fresh, next } = await freshEntries((config.feeds ?? []).filter(isYouTubeFeed), cursor);
    const items: RawItem[] = fresh.filter(e => e.video).map(e => ({
      ext_id: e.guid, url: `https://www.youtube.com/watch?v=${e.video}`, title: e.title, author: e.author, summary: e.description.slice(0, 600) || null,
      body: e.description || null, lang: null, published_at: e.published,
      meta: { image: `https://i.ytimg.com/vi/${e.video}/maxresdefault.jpg`, video: e.video, site: "youtube.com" },
    }));
    return { items, cursor: next };
  },
};
export const isYouTubeFeed = (u: string) => /^https:\/\/www\.youtube\.com\/feeds\/videos\.xml\?channel_id=UC[\w-]{22}$/.test(u);

export const CONNECTORS: Record<string, Connector> = { hackernews, merkur, feed, podcast, youtube, bluesky, mastodon, topic, github, arxiv, watch, echa, consult, mail: newsletter };

export function kindForUrl(input: string): string | null {
  let host = "";
  try { host = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`).hostname.replace(/^www\./, ""); } catch { return null; }
  if (host === "news.ycombinator.com" || host === "hn.algolia.com") return "hackernews";
  if (host === "merkur.de" || host.endsWith(".merkur.de")) return "merkur";
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") return "youtube";
  if (host === "bsky.app") return "bluesky";
  if (host === "arxiv.org" || host.endsWith(".arxiv.org")) return "arxiv";
  // a repository page, not a profile or an organisation page
  if (host === "github.com" && githubRepo(input.trim())) return "github";
  return "feed";
}

/** Reads one stored article again with the current extractor. merkur.de uses its own body selector; other pages the
 *  generic one, always through the address guard. */
export async function reextract(kind: string, url: string) {
  const page = await get(url, { guard: true, timeout: 10_000, maxBytes: 2_500_000 });
  return extract(page.text, kind === "merkur" ? { base: page.url, paragraphSelector: MERKUR_BODY } : { base: page.url });
}
