// Which picture a story gets, which logo a source gets, and which portrait a person or place gets.
// Rules come from looking at what the sources really send (see docs/backend.md, "Images"):
//  - a picture has to be at least 200 px; wide ones need 560 px to run across a card
//  - the same picture on three or more items of one source is a logo or a stock card, not news
//  - portrait pictures (posters, vertical video) show only in the reader, whole, never cropped on a card
//  - a logo is the largest icon a site offers; 32 px or more is preferred, a 16 px one still beats the letter badge
//  - people and places get the lead image of their Wikipedia article; companies do not (it is usually their building)
import { db, json, now, setting } from "./db";
import { fetchMedia, fetchPending, mediaInfo, mediaKey, mediaState, remember } from "./media";
import { get } from "./connectors/util";

import type { StoryImage } from "../shared/types";
export type { StoryImage };
type ItemRow = { meta: string; kind: string; source_id: number };

/** Picture candidates of one item. */
function candidates(meta: any): string[] {
  return typeof meta.image === "string" && /^https:\/\//.test(meta.image) ? [meta.image] : [];
}

const shapeOf = (w: number, h: number): StoryImage["shape"] | null => {
  if (w < 200 || h < 120) return null;
  const r = w / h;
  if (r < 0.8) return "tall";
  if (r >= 1.25 && w >= 560) return "wide";
  return "square";
};

function repeated(sourceId: number, url: string) {
  return (db.query("SELECT count(*) AS n FROM items WHERE source_id = ? AND json_extract(meta, '$.image') = ?").get(sourceId, url) as { n: number }).n >= 3;
}

/** The picture for a story; null when there is none worth showing (or pictures are off). A copy not fetched yet is
 *  still offered, with a guessed shape: the browser's first request fetches it, the shimmer covers the wait, and the
 *  card corrects the shape once the picture has loaded. Copies that failed are skipped. */
export function storyImage(owner: number, items: ItemRow[]): StoryImage | null {
  if (!setting(owner, "images", true)) return null;
  // the lead item first: the one the card's headline comes from
  const ordered = [...items.filter(i => i.kind !== "hackernews"), ...items.filter(i => i.kind === "hackernews")];
  for (const it of ordered) {
    const meta = json<any>(it.meta, {});
    for (const url of candidates(meta)) {
      if (url === meta.image && repeated(it.source_id, url)) continue;
      const key = mediaKey(owner, url), state = mediaState(key);
      const credit = typeof meta.credit === "string" ? meta.credit.slice(0, 90) : null;
      if (state === "failed") continue;
      if (!state || state === "pending") {
        remember(owner, url);
        return { src: `/api/media/${key}`, w: 0, h: 0, shape: it.kind === "podcast" ? "square" : "wide", credit, pending: true };
      }
      const shape = shapeOf(state.w, state.h);
      if (!shape) continue;
      return { src: `/api/media/${key}`, w: state.w, h: state.h, shape, credit };
    }
  }
  return null;
}

/* ---------- source logos ---------- */

/** Where a source's logo comes from: a picked creator's artwork or the site's own icon. */
export function iconFor(owner: number, it: { kind: string; meta: any; config?: string | null; source_id?: number }): string | null {
  const conf = json<any>(it.config, {});
  if ((it.kind === "podcast" || it.kind === "youtube" || it.kind === "feed") && typeof conf.image === "string") return copyIfFetched(owner, conf.image, 32);
  const host = it.kind === "merkur" ? "merkur.de" : typeof it.meta?.site === "string" ? it.meta.site : null;
  if (!host) return null;
  const row = db.query("SELECT url FROM icons WHERE owner_id = ? AND host = ?").get(owner, host) as { url: string | null } | null;
  return row?.url ? copyIfFetched(owner, row.url, 16) : null;
}
function copyIfFetched(owner: number, url: string, min: number) {
  const key = mediaKey(owner, url), info = mediaInfo(key);
  return info && Math.min(info.w, info.h) >= min ? `/api/media/${key}` : null;
}

/** Icon links a page declares, largest first; the conventional /favicon.ico last. */
export function iconLinks(html: string, base: string): string[] {
  const out: { url: string; size: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0], attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(t)?.slice(1).find(x => x != null);
    const rel = (attr("rel") ?? "").toLowerCase(), href = attr("href");
    if (!href || !/(^|\s)(icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel) || /\.svg(\?|$)/i.test(href) || /svg/i.test(attr("type") ?? "")) continue;
    const size = Math.max(0, ...(attr("sizes") ?? "").split(/\s+/).map(s => Number(s.split("x")[0]) || 0)) || (rel.includes("apple") ? 180 : 16);
    try { const u = new URL(href, base); if (u.protocol === "https:") out.push({ url: u.href, size }); } catch {}
  }
  const list = out.sort((a, b) => b.size - a.size).map(o => o.url);
  try { list.push(new URL("/favicon.ico", base).href); } catch {}
  return [...new Set(list)];
}

async function findIcon(owner: number, host: string) {
  // the icons the home page declares, then the two places browsers look without being told
  let declared: string[] = [];
  try { const page = await get(`https://${host}/`, { guard: true, timeout: 8000, maxBytes: 1_500_000 }); declared = iconLinks(page.text, page.url).filter(u => !/\/favicon\.ico$/.test(u)).slice(0, 3); } catch {}
  const cands = [...new Set([...declared, `https://${host}/apple-touch-icon.png`, `https://${host}/favicon.ico`])];
  let url: string | null = null, small: string | null = null;
  for (const cand of cands) {
    try {
      const key = remember(owner, cand)!.split("/").pop()!;
      await fetchMedia(key);
      const info = mediaInfo(key), side = info ? Math.min(info.w, info.h) : 0;
      if (side >= 32) { url = cand; break; }
      if (side >= 16) small ??= cand;
    } catch {}
  }
  url ??= small;
  db.query("INSERT INTO icons (owner_id, host, url, checked_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, host) DO UPDATE SET url = excluded.url, checked_at = excluded.checked_at").run(owner, host, url, now());
}

export const HOST = /^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/;
// a feed often lives on a subdomain of its own (rss.sueddeutsche.de, newsfeed.zeit.de); the logo is the site's
const FEED_SUB = /^(www|rss\d?|feeds?|newsfeed|blog)\./;
const KIND_HOST: Record<string, string> = { hackernews: "news.ycombinator.com", merkur: "merkur.de", github: "github.com", arxiv: "arxiv.org", bluesky: "bsky.app", youtube: "youtube.com" };

/** The site a source stands for: its logo is that site's icon. Podcasts and topics have none, only artwork. */
export function sourceHost(kind: string, conf: any): string | null {
  if (KIND_HOST[kind]) return KIND_HOST[kind];
  if (kind === "mastodon") return typeof conf?.instance === "string" && HOST.test(conf.instance) ? conf.instance : null;
  if (kind !== "feed" && kind !== "watch") return null;
  try { const h = new URL(conf?.url ?? conf?.feeds?.[0]).hostname.toLowerCase().replace(FEED_SUB, ""); return HOST.test(h) ? h : null; } catch { return null; }
}

/** A source's logo: its own artwork when there is a copy, otherwise its site's icon, looked up the first time it is asked for. */
export function sourceIcon(owner: number, kind: string, conf: any): string | null {
  if (typeof conf?.image === "string") { const c = copyIfFetched(owner, conf.image, 32); if (c) return c; remember(owner, conf.image); }
  const host = sourceHost(kind, conf);
  return host ? `/api/icon/${host}` : null;
}

/** Logos of this owner's sources by name, for places that only know a report's source name. */
export function iconsByName(owner: number): (name: string) => string | null {
  const rows = db.query("SELECT name, kind, config FROM sources WHERE owner_id = ?").all(owner) as { name: string; kind: string; config: string }[];
  const m = new Map(rows.map(r => [r.name, r] as const));
  return name => { const r = m.get(name); return r ? sourceIcon(owner, r.kind, json<any>(r.config, {})) : null; };
}

// a page of popular sources asks for many icons at once: four lookups at a time, each host once
const finding = new Map<string, Promise<void>>();
let running = 0;
const queue: (() => void)[] = [];
const slot = () => new Promise<void>(r => { if (running < 4) { running++; r(); } else queue.push(r); });
const done = () => { const next = queue.shift(); if (next) next(); else running--; };

/** The local copy of a site's icon, looked up when it was never looked up or the last look is two weeks old. */
export async function siteIcon(owner: number, host: string): Promise<string | null> {
  const row = () => db.query("SELECT url, checked_at FROM icons WHERE owner_id = ? AND host = ?").get(owner, host) as { url: string | null; checked_at: number } | null;
  const r = row();
  if (!r || r.checked_at < now() - 14 * 86400_000) {
    const k = `${owner}:${host}`;
    let p = finding.get(k);
    if (!p) { p = slot().then(() => findIcon(owner, host)).finally(() => { done(); finding.delete(k); }); finding.set(k, p); }
    await p;
  }
  const url = row()?.url;
  if (!url) return null;
  // the copy may have been pruned since: fetch it again
  const key = mediaKey(owner, url);
  if (!mediaInfo(key)) { remember(owner, url); await fetchMedia(key).catch(() => {}); }
  return copyIfFetched(owner, url, 16);
}

/* ---------- people and places ---------- */

const DESCRIPTIONS_SINCE = Date.parse("2026-11-19T00:00:00Z");
const WIKI_UA = { "user-agent": "peppermint/1.0 (personal reader; +https://peppermint.kaleve.dev)" };
async function lookupEntity(name: string, lang: string) {
  let url: string | null = null, page: string | null = null, description: string | null = null;
  try {
    const r = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.replace(/ /g, "_"))}`, { headers: WIKI_UA, signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const s = await r.json() as any;
      if (s.type === "standard" && s.thumbnail?.source) {
        // Wikimedia serves thumbnails in fixed widths; 330 px is one of them and sharp enough for a 24 px chip and the sheet
        url = String(s.thumbnail.source).replace(/\/\d+px-/, "/330px-");
        page = s.content_urls?.desktop?.page ?? null;
        description = typeof s.description === "string" ? s.description.slice(0, 120) : null;
      }
    }
    if (r.status === 429) return; // try again another time
  } catch { return; }
  db.query("INSERT INTO entities (name, lang, url, page, description, checked_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name, lang) DO UPDATE SET url = excluded.url, page = excluded.page, description = excluded.description, checked_at = excluded.checked_at").run(name, lang, url, page, description, now());
}

export type Entity = { name: string; kind: "person" | "place" | "org"; img: string | null; page: string | null; description?: string | null };
/** People and places with their pictures; looked up once (waiting at most a moment), then cached for everyone. */
export async function entitiesFor(owner: number, tags: { people?: string[]; places?: string[]; orgs?: string[] }, lang: string, waitMs = 2500): Promise<Entity[]> {
  const want: [string, "person" | "place"][] = [...(tags.people ?? []).slice(0, 4).map(n => [n, "person"] as [string, "person"]), ...(tags.places ?? []).slice(0, 3).map(n => [n, "place"] as [string, "place"])];
  const langs = lang === "de" ? ["de", "en"] : ["en", "de"];
  const row = (n: string, l: string) => db.query("SELECT url, page, description, checked_at FROM entities WHERE name = ? AND lang = ?").get(n, l) as { url: string | null; page: string | null; description: string | null; checked_at: number } | null;
  // a portrait found before descriptions were kept is looked up once more for its description
  const fresh = (r: ReturnType<typeof row>) => !!r && r.checked_at > now() - 30 * 86400_000 && !(r.url && r.description == null && r.checked_at < DESCRIPTIONS_SINCE);
  const best = (n: string) => langs.map(l => row(n, l)).find(r => r?.url) ?? null;
  const job = (async () => {
    for (const [n] of want) for (const l of langs) {
      if (!fresh(row(n, l))) await lookupEntity(n, l);
      if (row(n, l)?.url) break;
    }
  })();
  await Promise.race([job, Bun.sleep(waitMs)]);
  const out: Entity[] = want.map(([name, kind]) => {
    const hit = best(name);
    const src = hit?.url ? remember(owner, hit.url) : null;
    return { name, kind, img: src, page: hit?.page ?? null, description: hit?.description ?? null };
  });
  const all = [...out, ...(tags.orgs ?? []).slice(0, 3).map(name => ({ name, kind: "org" as const, img: null, page: null }))];
  // a name tagged as both place and organisation ("MVG Museum") shows once
  return all.filter((e, i) => all.findIndex(x => x.name.toLowerCase() === e.name.toLowerCase()) === i);
}

/** The article figures a card can show, once their copies exist (the queue fetches them for Today and the list). */
export function cardFigures(owner: number, items: { meta: string }[], max = 4): { src: string; w: number; h: number; caption: string }[] {
  if (!setting(owner, "images", true)) return [];
  const out: { src: string; w: number; h: number; caption: string }[] = [];
  for (const it of items) for (const f of json<any>(it.meta, {}).figures ?? []) {
    if (out.length >= max || typeof f?.src !== "string") continue;
    const key = mediaKey(owner, f.src), st = mediaState(key);
    if (st && typeof st === "object" && st.w >= 200) out.push({ src: `/api/media/${key}`, w: st.w, h: st.h, caption: String(f.caption ?? "").slice(0, 160) });
  }
  return out;
}

/* ---------- what a story video can show ---------- */

export type VideoFigure = { src: string; caption: string };
/** The pictures a story video may use: the article's own figures (copied like any picture) and the portraits of the
 *  people and places it names. Claude sees the captions and names, never the pictures themselves. */
/** The article's own figures with their captions, as local copies, numbered in the order Claude is told. */
export function storyFigures(owner: number, storyId: number): VideoFigure[] {
  const items = db.query("SELECT meta FROM items WHERE story_id = ? ORDER BY length(coalesce(body, '')) DESC").all(storyId) as { meta: string }[];
  const figures: VideoFigure[] = [];
  for (const it of items) for (const f of json<any>(it.meta, {}).figures ?? []) {
    if (figures.length >= 6 || typeof f?.src !== "string" || figures.some(x => x.caption === f.caption)) continue;
    const src = remember(owner, f.src);
    // a picture whose download failed would only be a broken frame in the reader, the video and the offline copy
    if (src && mediaState(src.slice(11)) !== "failed") figures.push({ src, caption: String(f.caption ?? "").slice(0, 200) });
  }
  return figures;
}
export async function videoMaterial(owner: number, storyId: number, lang: string) {
  const items = db.query("SELECT tags FROM items WHERE story_id = ?").all(storyId) as { tags: string }[];
  const figures = storyFigures(owner, storyId);
  const st = db.query("SELECT tags FROM stories WHERE id = ?").get(storyId) as { tags: string } | null;
  const guessed = items.every(i => json<any>(i.tags, {}).by === "local");
  const t = json<any>(st?.tags, {});
  const portraits = (await entitiesFor(owner, guessed ? { places: t.places } : t, lang, 2500)).filter(e => e.img).map(e => ({ name: e.name, img: e.img!, description: e.description ?? null }));
  return { figures, portraits };
}

/* ---------- the queue: copy what Today, the reading list and the logos will need ---------- */

/** Pictures and figures of a few given stories (a page of the endless feed), copied in the background. */
export async function queueStoryImages(owner: number, storyIds: number[]) {
  if (!storyIds.length) return;
  const rows = db.query(`SELECT meta FROM items WHERE owner_id = ? AND story_id IN (${storyIds.map(() => "?").join(",")})`).all(owner, ...storyIds) as { meta: string }[];
  for (const r of rows) {
    const meta = json<any>(r.meta, {});
    for (const u of candidates(meta).slice(0, 2)) remember(owner, u);
    for (const f of (Array.isArray(meta.figures) ? meta.figures : []).slice(0, 4)) if (typeof f?.src === "string") remember(owner, f.src);
  }
  await fetchPending(owner, 60);
}

let lastQueue = 0;
/** Remembers the pictures of stories on the newest edition and the reading list, finds missing logos, then fetches. */
export async function queueImages(owner: number, force = false) {
  if (!force && Date.now() - lastQueue < 5 * 60_000) return;
  lastQueue = Date.now();
  const rows = db.query(`SELECT i.meta, i.source_id, s.kind, s.config FROM items i JOIN sources s ON s.id = i.source_id WHERE i.owner_id = ? AND i.story_id IN (
      SELECT ei.story_id FROM edition_items ei JOIN editions e ON e.id = ei.edition_id WHERE e.owner_id = ? AND e.updated_at > ?
      UNION SELECT story_id FROM pins WHERE owner_id = ?)`).all(owner, owner, now() - 3 * 86400_000, owner) as { meta: string; source_id: number; kind: string; config: string }[];
  const hosts = new Set<string>();
  for (const r of rows) {
    const meta = json<any>(r.meta, {});
    for (const u of candidates(meta).slice(0, 2)) remember(owner, u);
    for (const f of (Array.isArray(meta.figures) ? meta.figures : []).slice(0, 6)) if (typeof f?.src === "string") remember(owner, f.src);
    const conf = json<any>(r.config, {});
    if (typeof conf.image === "string") remember(owner, conf.image);
    if (r.kind === "merkur") hosts.add("merkur.de");
    else if (r.kind === "hackernews" || r.kind === "feed") { if (typeof meta.site === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(meta.site)) hosts.add(meta.site.toLowerCase()); }
  }
  await fetchPending(owner, 120);
  const due = [...hosts].filter(h => { const r = db.query("SELECT checked_at FROM icons WHERE owner_id = ? AND host = ?").get(owner, h) as { checked_at: number } | null; return !r || r.checked_at < now() - 14 * 86400_000; });
  for (const h of due.slice(0, 25)) await findIcon(owner, h);
  // a logo found earlier may have been pruned with its copy; asking for it again re-fetches it
  for (const r of db.query("SELECT url FROM icons WHERE owner_id = ? AND url IS NOT NULL").all(owner) as { url: string }[]) remember(owner, r.url);
  await fetchPending(owner, 60);
}
