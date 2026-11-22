// Account-free source kinds: Bluesky, Mastodon, topic news (Bing), GitHub releases, arXiv and "watch a page"; the
// picker lookups and config checks of ECHA lists, EU consultations and newsletters (connectors in official.ts, newsletter.ts).
// Each kind has pure parsing functions (tested with fixtures), a picker lookup (/api/creators) and a Connector.
// Public fetches to fixed hosts use plain fetch with a timeout; anything a user typed goes through get(..., { guard: true }).
import { assertPublic, decode, extract, freshEntries, get, host, parseFeed, pool, stripTags, titleOf, type FeedCursor, type RawItem } from "./util";
import type { Connector, Discovery } from "./index";
import { ECHA_LISTS, openNow, searchInitiatives, type EchaList } from "./official";
import { newsletterReady, newsletterToken } from "./newsletter";
import { plusAddress } from "../jmap";

export type Pick = { kind: string; name: string; by: string; image: string | null; feed: string; note?: string; config: Record<string, any> };
export const NEW_KINDS = ["bluesky", "mastodon", "topic", "github", "arxiv", "watch", "echa", "consult", "mail"] as const;
// ECHA's lists change a few times a year and consultations open weekly: twice a day is plenty. Newsletters: every 30 min.
export const CADENCE: Record<string, number> = { bluesky: 60, mastodon: 60, topic: 120, github: 360, arxiv: 720, watch: 360, echa: 720, consult: 720, mail: 30 };

// Bing refuses nothing today, but a normal browser agent is the safe choice for its news RSS
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const unsupported = (what: string) => async (): Promise<Discovery> => { throw new Error(`Use the picker to ${what}.`); };
function discovery(p: Pick, label: string): Discovery {
  return { kind: p.kind, name: p.name, subtitle: [p.by, p.note].filter(Boolean).join(" · "), cadence: CADENCE[p.kind], image: p.image, config: p.config, options: [{ key: p.feed, label, perDay: 2, on: true }], sample: [] };
}

/* ---------- Bluesky (public AppView, no account) ---------- */
const BSKY = "https://public.api.bsky.app/xrpc";
async function bsky(path: string, params: Record<string, string>) {
  const r = await fetch(`${BSKY}/${path}?${new URLSearchParams(params)}`, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Bluesky answered ${r.status}.`);
  return await r.json() as any;
}
const bskyPick = (p: any): Pick => ({
  kind: "bluesky", name: String(p.displayName || p.handle).slice(0, 60), by: `@${p.handle}`, image: typeof p.avatar === "string" ? p.avatar : null, feed: p.did,
  note: [p.followersCount != null ? `${p.followersCount} followers` : "", String(p.description ?? "").replace(/\s+/g, " ").slice(0, 80)].filter(Boolean).join(" · "),
  config: { did: p.did, handle: p.handle, key: p.did },
});
/** A handle, a did, or a bsky.app/profile link. */
export function blueskyActor(input: string): string | null {
  const s = input.trim().replace(/^@/, "");
  const m = /^(?:https?:\/\/)?(?:www\.)?bsky\.app\/profile\/([^/?#\s]+)/i.exec(s);
  const a = m ? m[1] : s;
  return /^did:(plc|web):[\w.:%-]+$/.test(a) || /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(a) ? a : null;
}
export async function searchBluesky(q: string): Promise<Pick[]> {
  const actor = blueskyActor(q);
  if (actor) return [bskyPick(await bsky("app.bsky.actor.getProfile", { actor }))];
  const d = await bsky("app.bsky.actor.searchActors", { q, limit: "12" });
  return (d.actors ?? []).map(bskyPick);
}
/** Own posts of one author from a getAuthorFeed response; reposts and other people's posts are skipped. */
export function blueskyItems(feed: any, did: string): (RawItem & { uri: string })[] {
  const out: (RawItem & { uri: string })[] = [];
  for (const e of feed?.feed ?? []) {
    const p = e?.post;
    if (!p?.uri || e.reason?.$type?.includes("Repost") || p.author?.did !== did) continue;
    const text = String(p.record?.text ?? "");
    const embed = p.embed?.$type?.startsWith("app.bsky.embed.recordWithMedia") ? p.embed.media : p.embed;
    const card = embed?.$type?.startsWith("app.bsky.embed.external") ? embed.external : null;
    const img = embed?.$type?.startsWith("app.bsky.embed.images") ? embed.images?.[0] : null;
    const name = String(p.author.displayName || p.author.handle);
    const t = Date.parse(p.record?.createdAt ?? p.indexedAt ?? "");
    out.push({
      uri: p.uri, ext_id: p.uri, url: `https://bsky.app/profile/${p.author.handle}/post/${String(p.uri).split("/").pop()}`,
      title: titleOf(text) || card?.title || img?.alt?.slice(0, 120) || `Post by ${name}`, author: name, summary: text.slice(0, 600) || null, body: text || null, lang: p.record?.langs?.[0]?.slice(0, 2) ?? null,
      published_at: Number.isFinite(t) ? t : Date.now(),
      meta: { site: "bsky.app", image: img?.fullsize ?? card?.thumb ?? undefined, ...(card ? { link: card.uri, link_title: card.title } : {}) },
    });
  }
  return out;
}
export const bluesky: Connector = {
  kind: "bluesky", label: "Bluesky",
  async discover(input) {
    const p = input ? (await searchBluesky(input))[0] : null;
    if (!p) throw new Error("Search for a person in the picker, or paste a handle or profile link.");
    return discovery(p, "Posts");
  },
  async pull(_src, config: { did: string }, cursor: { seen?: string[] }) {
    const d = await bsky("app.bsky.feed.getAuthorFeed", { actor: config.did, filter: "posts_no_replies", limit: "30" });
    const seen = new Set(cursor.seen ?? []);
    const all = blueskyItems(d, config.did);
    const fresh = all.filter(i => !seen.has(i.uri)).slice(0, cursor.seen ? 60 : 15);
    all.forEach(i => seen.add(i.uri));
    return { items: fresh.map(({ uri: _u, ...i }) => i), cursor: { seen: [...seen].slice(-1000) } };
  },
};

/* ---------- Mastodon (any instance, read through the account's public RSS) ---------- */
const HOST_RE = /^(?=.{4,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
/** `@user@instance`, `user@instance` or a profile link like https://instance/@user. */
export function mastodonHandle(input: string): { user: string; instance: string } | null {
  const s = input.trim();
  const at = /^@?([\w.-]{1,60})@([a-z0-9.-]+)$/i.exec(s);
  if (at && HOST_RE.test(at[2])) return { user: at[1], instance: at[2].toLowerCase() };
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    const m = /^\/(?:@|users\/)([\w.-]{1,60})\/?$/.exec(u.pathname);
    if (m && HOST_RE.test(u.hostname)) return { user: m[1], instance: u.hostname.toLowerCase() };
  } catch {}
  return null;
}
export const mastodonFeed = (instance: string, user: string) => `https://${instance}/@${user}.rss`;
export async function resolveMastodon(input: string): Promise<Pick> {
  const h = mastodonHandle(input);
  if (!h) throw new Error("Enter a handle like @user@mastodon.social or paste a profile link.");
  const r = await get(`https://${h.instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(h.user)}`, { guard: true, timeout: 10_000, headers: { accept: "application/json" } });
  let a: any; try { a = JSON.parse(r.text); } catch { throw new Error(`${h.instance} did not answer like a Mastodon server.`); }
  if (!a?.username) throw new Error(`${h.instance} did not answer like a Mastodon server.`);
  const key = `${a.username}@${h.instance}`;
  return {
    kind: "mastodon", name: String(a.display_name || a.username).slice(0, 60), by: `@${key}`, image: typeof a.avatar === "string" && a.avatar.startsWith("https://") ? a.avatar : null, feed: key,
    note: a.followers_count != null ? `${a.followers_count} followers` : "", config: { instance: h.instance, user: a.username, key: key.toLowerCase() },
  };
}
export const mastodon: Connector = {
  kind: "mastodon", label: "Mastodon",
  async discover(input) {
    if (!input) throw new Error("Enter a handle like @user@mastodon.social.");
    return discovery(await resolveMastodon(input), "Posts");
  },
  async pull(_src, config: { instance: string; user: string }, cursor: FeedCursor) {
    // untitled: Mastodon RSS items carry no title, so the first line of the post stands in
    const { fresh, next } = await freshEntries([mastodonFeed(config.instance, config.user)], cursor, { untitled: true });
    const items: RawItem[] = fresh.map(e => ({
      ext_id: e.guid, url: e.link, title: e.title, author: e.author ?? `@${config.user}@${config.instance}`, summary: e.description.slice(0, 600) || null, body: e.description || null, lang: null,
      published_at: e.published, meta: { site: config.instance, image: e.image ?? undefined },
    }));
    return { items, cursor: next };
  },
};

/* ---------- Topic: everything about a keyword, from Bing News RSS ---------- */
/** Bing links go through apiclick.aspx?...&url=<encoded article>; the real address is the url parameter. */
export function bingRealUrl(link: string): string | null {
  try {
    const u = new URL(decode(link));
    const real = /(^|\.)bing\.com$/i.test(u.hostname) ? u.searchParams.get("url") : u.href;
    if (!real) return null;
    const r = new URL(real);
    return r.protocol === "http:" || r.protocol === "https:" ? r.href : null;
  } catch { return null; }
}
export function bingItems(xml: string): { url: string; title: string; description: string; published: number; source: string | null; image: string | null }[] {
  const seen = new Set<string>(), out: ReturnType<typeof bingItems> = [];
  for (const block of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? []) {
    const e = parseFeed(`<rss><channel>${block}</channel></rss>`).entries[0];
    const url = e && bingRealUrl(e.link);
    if (!e || !url || seen.has(url)) continue;
    seen.add(url);
    const src = /<News:Source>([^<]*)<\/News:Source>/i.exec(block)?.[1], img = /<News:Image>([^<]*)<\/News:Image>/i.exec(block)?.[1];
    out.push({ url, title: e.title, description: e.description, published: e.published, source: src ? decode(src).trim() : null, image: img && /^https:/.test(decode(img)) ? decode(img) : null });
  }
  return out;
}
const bingUrl = (q: string, lang: string) => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=${lang}`;
/** News about a query, newest first: the topic source's search, for the agent's research. */
export async function newsSearch(q: string, lang: string) {
  const r = await get(bingUrl(q, lang === "de" ? "de" : "en"), { timeout: 12_000, headers: { "user-agent": BROWSER_UA } });
  return bingItems(r.text);
}
export const topic: Connector = {
  kind: "topic", label: "Topic",
  discover: unsupported("follow a topic"),
  async pull(_src, config: { q: string; lang: string }, cursor: { seen?: string[] }) {
    const r = await get(bingUrl(config.q, config.lang), { timeout: 12_000, headers: { "user-agent": BROWSER_UA } });
    const seen = new Set(cursor.seen ?? []);
    const fresh = bingItems(r.text).filter(i => !seen.has(i.url)).slice(0, cursor.seen ? 30 : 15);
    const pages = await pool(fresh, 4, async i => { const p = await get(i.url, { guard: true, timeout: 10_000 }); return extract(p.text, { base: p.url }); });
    const items: RawItem[] = fresh.map((i, k) => ({
      ext_id: i.url, url: i.url, title: i.title, author: i.source, summary: i.description.slice(0, 600) || pages[k]?.description || null, body: pages[k]?.text || i.description || null,
      lang: pages[k]?.lang ?? config.lang, published_at: i.published, meta: { site: host(i.url), topic: config.q, image: pages[k]?.image ?? i.image ?? undefined, credit: pages[k]?.credit ?? undefined },
    }));
    fresh.forEach(i => seen.add(i.url));
    return { items, cursor: { seen: [...seen].slice(-2000) } };
  },
};

/* ---------- GitHub releases (releases.atom; the search API refuses unauthenticated server requests) ---------- */
export function githubRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, "");
  let path = s;
  if (/github\.com/i.test(s)) { try { path = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).pathname.replace(/^\//, ""); } catch { return null; } if (!/^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(s)) return null; }
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([\w.-]{1,100})(?:[/?#].*)?$/.exec(path);
  return m && !["orgs", "settings", "topics", "marketplace", "sponsors", "features", "enterprise"].includes(m[1].toLowerCase()) ? { owner: m[1], repo: m[2].replace(/\.git$/, "") } : null;
}
export const githubFeed = (owner: string, repo: string) => `https://github.com/${owner}/${repo}/releases.atom`;
/** `<repo> <tag>: <title>`; the title is dropped when it only repeats the tag. */
export function githubItems(entries: ReturnType<typeof parseFeed>["entries"], repo: string, full: string): RawItem[] {
  return entries.map(e => {
    const tag = decodeURIComponent(/\/releases\/tag\/(.+)$/.exec(e.link)?.[1] ?? e.title);
    const same = !e.title || e.title === tag;
    return {
      ext_id: e.guid, url: e.link, title: same ? `${repo} ${tag}` : `${repo} ${tag}: ${e.title}`, author: e.author, summary: e.description.slice(0, 600) || null, body: e.description || null, lang: "en",
      published_at: e.published, meta: { site: "github.com", repo: full, tag },
    };
  });
}
export async function resolveGitHub(input: string): Promise<Pick> {
  const r = githubRepo(input);
  if (!r) throw new Error("Enter owner/repo or paste a github.com repository link.");
  let feed;
  try { feed = parseFeed((await get(githubFeed(r.owner, r.repo), { guard: true, timeout: 10_000 })).text); }
  catch { throw new Error(`${r.owner}/${r.repo} was not found on GitHub.`); }
  const latest = feed.entries[0];
  return {
    kind: "github", name: `${r.repo} releases`.slice(0, 60), by: `${r.owner}/${r.repo}`, image: `https://github.com/${r.owner}.png?size=96`, feed: `${r.owner}/${r.repo}`,
    note: latest ? `latest: ${decodeURIComponent(/\/releases\/tag\/(.+)$/.exec(latest.link)?.[1] ?? latest.title)}` : "no releases yet",
    config: { owner: r.owner, repo: r.repo, key: `${r.owner}/${r.repo}`.toLowerCase() },
  };
}
export const github: Connector = {
  kind: "github", label: "GitHub",
  async discover(input) {
    if (!input) throw new Error("Enter owner/repo.");
    return discovery(await resolveGitHub(input), "New releases");
  },
  async pull(_src, config: { owner: string; repo: string }, cursor: FeedCursor) {
    const url = githubFeed(config.owner, config.repo);
    const { fresh, next } = await freshEntries([url], cursor);
    return { items: githubItems(fresh, config.repo, `${config.owner}/${config.repo}`), cursor: next };
  },
};

/* ---------- arXiv (Atom API) ---------- */
export const ARXIV_CATS: { cat: string; label: string }[] = [
  { cat: "cs.AI", label: "Artificial Intelligence" }, { cat: "cs.CL", label: "Computation and Language" }, { cat: "cs.LG", label: "Machine Learning" },
  { cat: "cs.CV", label: "Computer Vision" }, { cat: "cs.HC", label: "Human-Computer Interaction" }, { cat: "stat.ML", label: "Machine Learning (stat)" },
];
export const arxivQuery = (c: { cat?: string; query?: string }) => c.cat ? `cat:${c.cat}` : `all:"${String(c.query ?? "").replace(/["\\]/g, " ").trim()}"`;
export const arxivUrl = (c: { cat?: string; query?: string }) => `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(arxivQuery(c))}&sortBy=submittedDate&sortOrder=descending&max_results=30`;
const squash = (s: string) => decode(s).replace(/\s+/g, " ").trim();
export function parseArxiv(xml: string): (RawItem & { id: string })[] {
  const out: (RawItem & { id: string })[] = [];
  for (const b of xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? []) {
    const tagOf = (n: string) => new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i").exec(b)?.[1] ?? "";
    const id = /arxiv\.org\/abs\/([^\s<]+?)(?:v\d+)?\s*</i.exec(b)?.[1];
    const title = squash(tagOf("title"));
    if (!id || !title) continue;
    const authors = [...b.matchAll(/<author>\s*<name>([^<]*)<\/name>/gi)].map(m => squash(m[1]));
    const abs = squash(tagOf("summary")), t = Date.parse(tagOf("published").trim());
    const cat = /<arxiv:primary_category[^>]*term="([^"]+)"/i.exec(b)?.[1];
    out.push({
      id, ext_id: id, url: `https://arxiv.org/abs/${id}`, title, author: authors.slice(0, 3).join(", ") + (authors.length > 3 ? " et al." : "") || null,
      summary: abs.slice(0, 600) || null, body: abs || null, lang: "en", published_at: Number.isFinite(t) ? t : Date.now(),
      meta: { site: "arxiv.org", pdf: `https://arxiv.org/pdf/${id}`, category: cat },
    });
  }
  return out;
}
export function arxivPicks(q: string): Pick[] {
  const s = q.trim().toLowerCase(), picks: Pick[] = ARXIV_CATS.filter(c => !s || c.cat.toLowerCase().includes(s) || c.label.toLowerCase().includes(s)).map(c => ({
    kind: "arxiv", name: `arXiv ${c.cat}`, by: c.label, image: null, feed: c.cat, note: "newest submissions", config: { cat: c.cat, key: `cat:${c.cat}` },
  }));
  if (q.trim().length >= 2) picks.push({ kind: "arxiv", name: `arXiv: ${q.trim().slice(0, 40)}`, by: "Custom query", image: null, feed: `q:${q.trim()}`, note: "all fields, newest first", config: { query: q.trim().slice(0, 100), key: `all:${q.trim().toLowerCase().slice(0, 100)}` } });
  return picks;
}
export const arxiv: Connector = {
  kind: "arxiv", label: "arXiv",
  async discover(input) {
    // an arxiv.org/list/<category> link names its category
    const cat = input && /arxiv\.org\/list\/([\w.-]+)/i.exec(input)?.[1];
    const p = cat ? arxivPicks(cat).find(x => x.config.cat === cat) : null;
    if (!p) throw new Error("Pick a category in the arXiv picker.");
    return discovery(p, "New papers");
  },
  async pull(_src, config: { cat?: string; query?: string }, cursor: { seen?: string[] }) {
    const r = await get(arxivUrl(config), { timeout: 20_000 });
    const seen = new Set(cursor.seen ?? []);
    const all = parseArxiv(r.text);
    const fresh = all.filter(i => !seen.has(i.id)).slice(0, cursor.seen ? 30 : 15);
    all.forEach(i => seen.add(i.id));
    return { items: fresh.map(({ id: _i, ...i }) => i), cursor: { seen: [...seen].slice(-1000) } };
  },
};

/* ---------- Watch a page: one item when its text changes ---------- */
export type WatchCursor = { hash?: string; ps?: string[] };
export type WatchPage = { title: string; url: string; paras: string[] };
const h = (s: string) => Bun.hash(s).toString(36);
/** The page's readable paragraphs (article paragraphs, else any text block), capped so the cursor stays small. */
export async function readPage(html: string, url: string): Promise<WatchPage> {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim() || host(url);
  let paras = (await extract(html, { base: url })).text.split("\n\n").map(p => p.trim()).filter(Boolean);
  if (paras.join(" ").length < 200) {
    const plain = html.replace(/<(script|style|noscript|nav|svg)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|li|h\d|tr|section|article)>|<br\s*\/?>/gi, "\n");
    paras = stripTags(plain).split("\n").map(p => p.trim()).filter(p => p.length > 1);
  }
  return { title: title.slice(0, 120), url, paras: paras.slice(0, 400) };
}
/** Compare a page with the stored baseline. The first call stores the baseline and returns no item. */
export function watchStep(cursor: WatchCursor, page: WatchPage, at = Date.now()): { item: RawItem | null; cursor: WatchCursor } {
  if (!page.paras.length) throw new Error("The page has no readable text.");
  const ps = page.paras.map(h), hash = h(page.paras.join("\n"));
  const next = { hash, ps };
  if (!cursor.hash || cursor.hash === hash) return { item: null, cursor: cursor.hash ? cursor : next };
  const old = new Set(cursor.ps ?? []), cur = new Set(ps);
  const added = page.paras.filter((_, i) => !old.has(ps[i])), removed = (cursor.ps ?? []).filter(x => !cur.has(x)).length;
  const lines = [...(added.length ? ["Added:", ...added] : []), ...(removed ? [`${removed} paragraph${removed === 1 ? "" : "s"} removed.`] : [])];
  const body = lines.join("\n\n").slice(0, 8000);
  return {
    item: { ext_id: `${page.url}#${hash}`, url: page.url, title: `${page.title}: changed`, author: host(page.url), summary: (added[0] ?? lines[lines.length - 1] ?? "").slice(0, 300), body, lang: null, published_at: at, meta: { site: host(page.url), added: added.length, removed } },
    cursor: next,
  };
}
const fetchPage = async (url: string) => { const r = await get(url, { guard: true, timeout: 12_000, headers: { "user-agent": BROWSER_UA } }); return readPage(r.text, r.url); };
export const watch: Connector = {
  kind: "watch", label: "Watch a page",
  async discover(input) {
    if (!input) throw new Error("Paste the link of the page to watch.");
    return discovery(await resolveWatch(input), "Changes to this page");
  },
  async pull(_src, config: { url: string }, cursor: WatchCursor) {
    const { item, cursor: next } = watchStep(cursor, await fetchPage(config.url));
    return { items: item ? [item] : [], cursor: next };
  },
};
export async function resolveWatch(input: string): Promise<Pick> {
  const s = input.trim();
  let url: URL; try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { throw new Error("That is not a link."); }
  let page: Awaited<ReturnType<typeof fetchPage>>;
  try { page = await fetchPage(url.href); }
  catch (e) {
    // "404  for https://..." from the fetch helper becomes a sentence a person can act on
    const code = /^(\d{3})\b/.exec((e as Error).message)?.[1];
    throw new Error(code ? `That page answered ${code}${code === "404" ? " (not found)" : code === "403" ? " (access refused)" : ""}. Check the link.` : (e as Error).message);
  }
  if (!page.paras.length) throw new Error("That page has no readable text to compare.");
  return { kind: "watch", name: page.title.slice(0, 60), by: host(url.href), image: null, feed: url.href, note: "checked every 6 hours", config: { url: url.href, key: url.href } };
}

/* ---------- picker lookup and config validation ---------- */
export async function findPicks(kind: string, q: string, lang = "en"): Promise<Pick[]> {
  switch (kind) {
    case "bluesky": return searchBluesky(q);
    case "mastodon": return [await resolveMastodon(q)];
    case "github": return [await resolveGitHub(q)];
    case "arxiv": return arxivPicks(q);
    case "watch": return [await resolveWatch(q)];
    case "topic": { const l = lang === "de" ? "de" : "en"; return [{ kind, name: q.slice(0, 60), by: l === "de" ? "News in German" : "News in English", image: null, feed: `${l}:${q}`, note: "Bing News, newest first", config: { q, lang: l, key: `${l}:${q.toLowerCase()}` } }]; }
    case "echa": return (Object.entries(ECHA_LISTS) as [EchaList, (typeof ECHA_LISTS)[EchaList]][]).map(([list, L]) => ({ kind, name: L.name, by: "ECHA CHEM", image: null, feed: `echa:${list}`, note: L.about, config: { list, key: list } }));
    case "consult": {
      const query = q.replace(/\s+/g, " ").trim().slice(0, 80), found = await searchInitiatives(query), open = openNow(found).length;
      return [{ kind, name: `EU consultations: ${query}`, by: "Have your say", image: null, feed: `consult:${query.toLowerCase()}`, note: `${found.length} initiatives match, ${open} open for feedback now`, config: { q: query, key: query.toLowerCase() } }];
    }
    case "mail": {
      if (!newsletterReady()) throw Object.assign(new Error("Newsletters need peppermint's mailbox, and none is set up on this server (PEPPERMINT_JMAP_URL, PEPPERMINT_JMAP_USER, PEPPERMINT_REPLY_ADDRESS)."), { status: 422 });
      const name = q.replace(/\s+/g, " ").trim().slice(0, 60);
      return [{ kind, name, by: "Newsletter", image: null, feed: `mail:${name.toLowerCase()}`, note: "gets its own address to subscribe with", config: { name } }];
    }
  }
  throw new Error("Unknown kind.");
}
/** Validate what a client posts as `config` and rebuild it from known fields only. */
export async function configFor(kind: string, raw: any): Promise<{ config: Record<string, any>; name: string }> {
  const c = raw && typeof raw === "object" ? raw : {};
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  switch (kind) {
    case "bluesky": {
      if (!/^did:(plc|web):[\w.:%-]+$/.test(String(c.did))) throw bad("That is not a Bluesky account.");
      return { config: { did: c.did, handle: String(c.handle ?? "").slice(0, 100), key: c.did }, name: "Bluesky" };
    }
    case "mastodon": {
      const user = String(c.user ?? ""), instance = String(c.instance ?? "").toLowerCase();
      if (!/^[\w.-]{1,60}$/.test(user) || !HOST_RE.test(instance)) throw bad("That is not a Mastodon account.");
      return { config: { instance, user, key: `${user}@${instance}`.toLowerCase() }, name: "Mastodon" };
    }
    case "topic": {
      const q = String(c.q ?? "").replace(/\s+/g, " ").trim().slice(0, 100), lang = c.lang === "de" ? "de" : "en";
      if (q.length < 2) throw bad("Type a topic first.");
      return { config: { q, lang, key: `${lang}:${q.toLowerCase()}` }, name: q };
    }
    case "github": {
      const r = githubRepo(`${c.owner}/${c.repo}`);
      if (!r) throw bad("That is not a GitHub repository.");
      return { config: { owner: r.owner, repo: r.repo, key: `${r.owner}/${r.repo}`.toLowerCase() }, name: `${r.repo} releases` };
    }
    case "arxiv": {
      const cat = ARXIV_CATS.find(x => x.cat === c.cat)?.cat, query = String(c.query ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
      if (!cat && query.length < 2) throw bad("Pick a category or type a query.");
      return { config: cat ? { cat, key: `cat:${cat}` } : { query, key: `all:${query.toLowerCase()}` }, name: cat ? `arXiv ${cat}` : `arXiv: ${query.slice(0, 40)}` };
    }
    case "echa": {
      if (!(String(c.list) in ECHA_LISTS)) throw bad("Pick one of ECHA's lists.");
      const list = c.list as EchaList;
      return { config: { list, key: list }, name: ECHA_LISTS[list].name };
    }
    case "consult": {
      const q = String(c.q ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      if (q.length < 2) throw bad("Type a keyword first.");
      return { config: { q, key: q.toLowerCase() }, name: `EU consultations: ${q}` };
    }
    case "mail": {
      // a new address every time: two newsletters never share one, so each keeps its own source
      if (!newsletterReady()) throw Object.assign(bad("No mailbox is set up for newsletters on this server."), { status: 422 });
      const token = newsletterToken();
      return { config: { token, address: plusAddress(token), key: token }, name: String(c.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "Newsletter" };
    }
    case "watch": {
      let u: URL; try { u = new URL(String(c.url)); } catch { throw bad("That is not a link."); }
      await assertPublic(u.href);
      return { config: { url: u.href, key: u.href }, name: u.hostname.replace(/^www\./, "") };
    }
  }
  throw bad("Unknown source kind.");
}
