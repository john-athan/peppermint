// How much a story really has to read, and the research that looks for more when it is only a headline.
// A card never gets a paragraph about missing material: either research finds something to read (the original page,
// an archived copy, the discussion, another report), or the story is marked unreadable and shows as a slim card.
import { db, json, now } from "./db";
import { get, host, parseFeed, stripTags } from "./connectors/util";
import { searchPodcasts } from "./connectors/creators";
import { reextract } from "./connectors";
import { newsSearch } from "./connectors/more";
import { keysOf } from "./pipeline";

export type Grade = "walled" | "thin" | "partial" | "full";
const RANK: Record<Grade, number> = { walled: 0, thin: 1, partial: 2, full: 3 };
export const readableGrade = (g: Grade) => RANK[g] >= RANK.partial;

/** Source kinds whose items are articles; a podcast, a video or a post is complete as it comes. */
const ARTICLE_KINDS = ["hackernews", "merkur", "feed", "topic", "agent"];

// what a page says instead of the article: a login, a paywall, a cookie or script wall, a bot check, an error page
const WALL = [
  /\b(log ?in|sign ?in|anmelden|einloggen)\b[^.]{0,80}\b(to|um)\b[^.]{0,40}\b(continue|read|view|see|access|comment|weiterzulesen|weiterlesen|lesen)/i,
  /\b(subscribe|subscription|subscribers?|abonnieren|abonnenten|abo)\b[^.]{0,60}\b(continue|read|access|only|weiterlesen|lesen|freischalten|exklusiv)/i,
  /(enable|turn on|activate) javascript|javascript (is )?(required|disabled|deaktiviert)|aktivieren sie javascript/i,
  /(accept|agree to)( all)? cookies|we use cookies|cookie (settings|preferences|einstellungen)|cookies (zustimmen|akzeptieren)/i,
  /are you a (human|robot)|verify (that )?you are (a )?human|captcha|unusual traffic|access denied|403 forbidden|404 not found|page not found|seite nicht gefunden|this page (is|was) (not available|removed)/i,
  /adult content|members only|paywall|this content is (only )?available to/i,
  /melden sie sich an|registrieren sie sich|um weiterzulesen|jetzt abonnieren|weiterlesen mit (abo|plus)/i,
  // a consent wall instead of the page: zeit.de sends servers to /zustimmung ("mit Werbung und Tracking" or "pur")
  /mit werbung und tracking|werbefrei (lesen|nutzen)|\bpur[- ]?abo\b|zustimmung zu (werbung|tracking)/i,
];
const clean = (s: string) => s.replace(/[#*>`_|]+/g, " ").replace(/\s+/g, " ").trim();

/** The grade of one text: under 60 words is thin, under 180 partial; a short text that reads like a wall is walled. */
export function grade(title: string, text: string | null | undefined): Grade {
  let t = clean(text ?? "");
  const h = clean(title).toLowerCase();
  if (h && t.toLowerCase().startsWith(h)) t = t.slice(h.length).trim(); // the headline repeated is no material
  const words = t.split(" ").filter(w => w.length > 1).length;
  if (words < 250 && WALL.some(r => r.test(t))) return "walled";
  return words < 60 ? "thin" : words < 180 ? "partial" : "full";
}

/** The page behind a wrapper: an archive copy, an AMP cache, a redirect link. Null when the link is no wrapper. */
export function unwrap(url: string | null | undefined): string | null {
  if (!url) return null;
  let u: URL; try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, "");
  const abs = (s: string) => /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
  let out: string | null = null;
  if (h === "web.archive.org") out = /^\/web\/\d+[a-z_]*\/(.+)$/i.exec(u.pathname + u.search)?.[1] ?? null;
  else if (h.endsWith("google.com") && u.pathname.startsWith("/amp/s/")) out = u.pathname.slice(7) + u.search;
  else if (h.endsWith(".cdn.ampproject.org")) { const m = /^\/[a-z]+\/(s\/)?(.+)$/i.exec(u.pathname + u.search); out = m ? (m[1] ? m[2] : `http://${m[2]}`) : null; }
  else if (h.endsWith("google.com") && u.pathname === "/url") out = u.searchParams.get("q") ?? u.searchParams.get("url");
  else if (h === "l.facebook.com" || h === "lm.facebook.com") out = u.searchParams.get("u");
  if (!out) return null;
  try { const r = new URL(abs(out)); return r.protocol === "http:" || r.protocol === "https:" ? r.href : null; } catch { return null; }
}

type ItemRow = { id: number; url: string | null; title: string; summary: string | null; body: string | null; meta: string; kind: string; lang: string | null };
const storyItems = (storyId: number) => db.query(`SELECT i.id, i.url, i.title, i.summary, i.body, i.meta, i.lang, s.kind FROM items i JOIN sources s ON s.id = i.source_id
  WHERE i.story_id = ?`).all(storyId) as ItemRow[];

/** One item's grade, counting what research added: another report, or the discussion (enough for a brief that says so). */
export function itemGrade(it: { title: string; summary: string | null; body: string | null; kind: string; meta: any }): Grade {
  if (!ARTICLE_KINDS.includes(it.kind)) return "full";
  const m = typeof it.meta === "string" ? json<any>(it.meta, {}) : it.meta ?? {};
  let g = grade(it.title, it.body || it.summary);
  if (m.coverage?.text) { const c = grade(m.coverage.title ?? "", m.coverage.text); if (RANK[c] > RANK[g]) g = c; }
  if ((m.discussion?.length ?? 0) >= 600 && RANK[g] < RANK.partial) g = "partial";
  // the episode itself was found: there is something to listen to, whatever the page said
  if (typeof m.audio === "string" && RANK[g] < RANK.partial) g = "partial";
  return g;
}
export const storyGrade = (items: Parameters<typeof itemGrade>[0][]): Grade =>
  items.reduce<Grade>((best, it) => { const g = itemGrade(it); return RANK[g] > RANK[best] ? g : best; }, "walled");

/** Research runs once per story: when its material is short and an article item has not been researched yet. */
export function needsResearch(storyId: number) {
  const items = storyItems(storyId);
  if (!items.length || RANK[storyGrade(items)] >= RANK.full) return false;
  return items.some(i => { const m = json<any>(i.meta, {}); return ARTICLE_KINDS.includes(i.kind) && (!m.researched || (podcastName(i.title) && !m.episodeTried && !m.audio)); });
}
/** A brief condenses: it is written only when the story has more to read than a card shows (graded full). A shorter
 *  story keeps the summary the tagger wrote, so Claude is never asked to fill sentences it has no material for. */
export const briefWorthy = (storyId: number) => storyGrade(storyItems(storyId)) === "full";
/** Short for good: not full, and research has nothing left to try. Cards and the Reader leave out brief and TL;DR. */
export const shortStory = (storyId: number) => !briefWorthy(storyId) && !needsResearch(storyId);
/** Unreadable: every item was researched and nothing to read was found, or Claude judged the material empty. */
export const unreadable = (metas: any[]) => metas.length > 0 && metas.every(m => (typeof m === "string" ? json<any>(m, {}) : m)?.unreadable === true);
export const storyUnreadable = (storyId: number) => unreadable((db.query("SELECT meta FROM items WHERE story_id = ?").all(storyId) as { meta: string }[]).map(r => r.meta));

/** The article itself could not be read and another report or the discussion stands in for it: the Reader says so in a
 *  pill, so Claude's text never has to. Null when an article (or a source that is no article) can be read. */
export function standIn(storyId: number): { kind: "report" | "discussion"; site: string } | null {
  const items = storyItems(storyId);
  if (!items.length || items.some(i => !ARTICLE_KINDS.includes(i.kind) || readableGrade(grade(i.title, i.body || i.summary)))) return null;
  const metas = items.map(i => json<any>(i.meta, {}));
  if (unreadable(metas)) return null;
  const cov = metas.find(m => m.coverage?.text)?.coverage;
  if (cov) return { kind: "report", site: String(cov.site ?? "another outlet") };
  return metas.some(m => (m.discussion?.length ?? 0) >= 600) ? { kind: "discussion", site: "Hacker News" } : null;
}

const patch = (id: number, meta: Record<string, unknown>) => db.query("UPDATE items SET meta = json_patch(meta, ?) WHERE id = ?").run(JSON.stringify(meta), id);
/** Claude found nothing to write about: the story stays a slim card from now on. */
export function markUnreadable(storyId: number) { for (const it of storyItems(storyId)) patch(it.id, { unreadable: true, researched: now() }); }


/** The podcast a headline announces: "SZ-Podcast „Hey München“: ..." gives "Hey München". */
export function podcastName(title: string): string | null {
  if (!/podcast/i.test(title)) return null;
  const m = /[„"“»«‚']([^„"“”»«‚‘’']{3,60})[“”"«»‘’']/.exec(title);
  return m ? m[1].trim() : null;
}
type Episode = { show: string; title: string; link: string; audio: string; duration: number | null; image: string | null; notes: string };
/** The episode of a podcast that a news headline describes: the show by name in Apple's directory, then the episode in
 *  its feed by shared words and a date close to the article's (podcasts are announced the day they come out). */
export async function findEpisode(show: string, headline: string, at: number): Promise<Episode | null> {
  const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
  const shows = (await searchPodcasts(show)).filter(p => norm(p.name).includes(norm(show)));
  // the headline without the "SZ-Podcast „Hey München“:" part names the episode
  const topic = headline.slice(headline.indexOf(":") + 1).trim() || headline;
  const want = new Set(keysOf(topic, {}).filter(k => k[0] !== "@"));
  for (const p of shows.slice(0, 2)) {
    const feed = await get(p.feed, { timeout: 10_000, maxBytes: 8_000_000, guard: true }).catch(() => null);
    if (!feed?.text) continue;
    let best: { e: ReturnType<typeof parseFeed>["entries"][number]; score: number } | null = null;
    for (const e of parseFeed(feed.text).entries.slice(0, 60)) {
      if (!e.audio) continue;
      const shared = keysOf(e.title, {}).filter(k => want.has(k)).length;
      const days = Math.abs((e.published || 0) - at) / 86400_000;
      const score = shared + (days <= 1 ? 2 : days <= 4 ? 1 : 0);
      if ((shared >= 2 || (shared >= 1 && days <= 2)) && score > (best?.score ?? 0)) best = { e, score };
    }
    if (best) return { show: p.name, title: best.e.title, link: best.e.link, audio: best.e.audio!, duration: best.e.duration ?? null, image: best.e.image ?? p.image ?? null, notes: best.e.description.slice(0, 8000) };
  }
  return null;
}

/** The comments of a Hacker News thread, top level first, as plain text capped at about 6000 characters. */
async function hnDiscussion(hnId: string) {
  const r = await get(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(hnId)}`, { timeout: 8000, maxBytes: 4_000_000 });
  const root = JSON.parse(r.text) as { children?: { text?: string | null; author?: string | null; children?: any[] }[] };
  const out: string[] = []; let n = 0;
  for (const c of root.children ?? []) {
    const t = c.text ? stripTags(c.text).replace(/\s+/g, " ").slice(0, 700) : "";
    if (t.length < 40) continue;
    out.push(`- ${t}`); n += t.length;
    if (n > 6000) break;
  }
  return out.join("\n");
}

export type ResearchNote = { status: string };
type Run = { status: string; p: Promise<void> };
const running = new Map<number, Run>();
const DEADLINE_MS = 25_000;

/** The research ladder for one story. Yields what it is doing, so the one card waiting for it can say so; a second
 *  caller (another lens, the background warm-up) joins the run already going instead of starting its own. */
export async function* research(storyId: number): AsyncGenerator<ResearchNote> {
  let run = running.get(storyId);
  if (!run) {
    const r: Run = { status: "Looking for more to read", p: Promise.resolve() };
    r.p = ladder(storyId, s => { r.status = s; }).catch(e => console.error("research", storyId, e)).finally(() => running.delete(storyId));
    running.set(storyId, r); run = r;
  }
  let last = "";
  for (;;) {
    if (run.status !== last) { last = run.status; yield { status: last }; }
    const done = await Promise.race([run.p.then(() => true), Bun.sleep(250).then(() => false)]);
    if (done) return;
  }
}
/** Research for many stories, one after another, without waiting on a reader: after a harvest, for the edition. */
export async function researchMany(storyIds: number[]) {
  for (const id of storyIds) if (needsResearch(id)) for await (const _ of research(id)) {}
}

/** The newest archived copy of a page: what a walled or script-built page said, read from the Wayback Machine. */
export async function archivedText(url: string): Promise<{ text: string; url: string } | null> {
  const snap = await get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeout: 8000 }).then(r => JSON.parse(r.text)?.archived_snapshots?.closest).catch(() => null);
  if (!snap?.available || typeof snap.url !== "string") return null;
  const raw = snap.url.replace(/^http:/, "https:").replace(/\/web\/(\d+)\//, "/web/$1id_/");
  const x = await reextract("feed", raw).catch(() => null);
  return x?.text ? { text: x.text, url: snap.url } : null;
}

async function ladder(storyId: number, say: (s: string) => void) {
  const until = now() + DEADLINE_MS;
  const items = storyItems(storyId).filter(i => ARTICLE_KINDS.includes(i.kind));
  const better = (it: ItemRow, text: string) => RANK[grade(it.title, text)] > RANK[grade(it.title, it.body || it.summary)];
  for (const it of items.sort((a, b) => RANK[itemGrade(a)] - RANK[itemGrade(b)]).slice(0, 2)) {
    if (RANK[itemGrade(it)] >= RANK.full) continue;
    const meta = json<any>(it.meta, {});
    // 0. a news page that announces a podcast episode ("SZ-Podcast „Hey München“: ..."): the page is often walled,
    //    the episode is public; take its audio and show notes from the podcast's own feed
    const show = podcastName(it.title);
    if (show && !meta.audio && !meta.episodeTried && now() < until) {
      say(`Looking for the podcast ${show}`);
      const ep = await findEpisode(show, it.title, it.published_at).catch(() => null);
      patch(it.id, { episodeTried: now() });
      if (ep) {
        patch(it.id, { audio: ep.audio, duration: ep.duration ?? undefined, image: meta.image ?? ep.image ?? undefined, unreadable: false, episode: { show: ep.show, title: ep.title, link: ep.link } });
        if (ep.notes && better(it, ep.notes)) { db.query("UPDATE items SET body = ? WHERE id = ?").run(ep.notes, it.id); it.body = ep.notes; }
        meta.audio = ep.audio;
      }
    }
    // 1. the page behind a wrapper (an archive copy, AMP, a redirect): read the original
    const orig = unwrap(it.url);
    if (orig && now() < until) {
      say(`Reading the original page on ${host(orig)}`);
      const x = await reextract("feed", orig).catch(() => null);
      if (x?.text && better(it, x.text)) { db.query("UPDATE items SET body = ? WHERE id = ?").run(x.text, it.id); it.body = x.text; patch(it.id, { original: orig }); }
    }
    // 2. a page that showed a wall or next to nothing (often a script-built page): the newest archived copy of it
    if (!orig && it.url && /^https?:/.test(it.url) && !readableGrade(grade(it.title, it.body || it.summary)) && now() < until) {
      say("Looking for an archived copy");
      const x = await archivedText(it.url);
      if (x && better(it, x.text)) { db.query("UPDATE items SET body = ? WHERE id = ?").run(x.text, it.id); it.body = x.text; patch(it.id, { original: x.url }); }
    }
    // 3. the discussion: for a link post the thread often says more than the page we got
    const hnId = typeof meta.hn === "string" ? /id=(\d+)/.exec(meta.hn)?.[1] : null;
    if (hnId && !meta.discussion && RANK[itemGrade(it)] < RANK.full && now() < until) {
      say("Reading the Hacker News discussion");
      const d = await hnDiscussion(hnId).catch(() => "");
      if (d) { meta.discussion = d; it.meta = JSON.stringify(meta); patch(it.id, { discussion: d }); }
    }
  }
  // 4. another report on the same story, found by its headline, when nothing above gave an article
  const now_ = storyItems(storyId);
  if (RANK[storyGrade(now_.map(i => ({ ...i, meta: { ...json<any>(i.meta, {}), discussion: undefined } })))] < RANK.partial && now() < until) {
    const lead = now_.find(i => ARTICLE_KINDS.includes(i.kind));
    if (lead) {
      say("Looking for other reports on this story");
      const tags = (db.query("SELECT tags FROM stories WHERE id = ?").get(storyId) as { tags: string } | null)?.tags;
      const want = new Set(keysOf(lead.title, {}).filter(k => k[0] !== "@"));
      const hits = await newsSearch(lead.title, (json<any>(tags ?? "{}", {}).lang ?? lead.lang) === "de" ? "de" : "en").catch(() => []);
      const seen = new Set(now_.map(i => i.url));
      for (const h of hits.slice(0, 8)) {
        if (now() >= until || seen.has(h.url)) continue;
        const got = keysOf(h.title, {}).filter(k => want.has(k)).length;
        if (got < 3 || got / Math.max(1, want.size) < 0.6) continue; // the same event, not just the same subject
        say(`Reading another report on ${host(h.url)}`);
        const x = await reextract("feed", h.url).catch(() => null);
        if (x?.text && RANK[grade(h.title, x.text)] >= RANK.partial) { patch(lead.id, { coverage: { url: h.url, site: h.source ?? host(h.url), title: h.title, text: x.text.slice(0, 8000) } }); break; }
      }
    }
  }
  // what research could not fix makes the story a slim card; every article item counts as researched either way
  const after = storyItems(storyId);
  const none = !readableGrade(storyGrade(after));
  for (const it of after) patch(it.id, { researched: now(), ...(none ? { unreadable: true } : {}) });
}
