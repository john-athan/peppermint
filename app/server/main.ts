import type { Card } from "../shared/types";
import { backupIfDue, db, json, now, setting, setSetting } from "./db";
import * as auth from "./auth";
import { readFields } from "./body";
import { CONNECTORS, isYouTubeFeed, kindForUrl } from "./connectors";
import { searchPodcasts, searchYouTube } from "./connectors/creators";
import { CADENCE, configFor, findPicks, NEW_KINDS } from "./connectors/more";
import { CATALOG } from "./connectors/catalog";
import { suggestSources, trials, TRIAL_MS } from "./suggest";
import { harvest, clusterPending, refreshBodies, type PullEvent } from "./pipeline";
import { mediaState, pruneMedia, serveMedia } from "./media";
import { cardFigures, entitiesFor, HOST, iconFor, iconsByName, siteIcon, sourceIcon, queueImages, queueStoryImages, storyFigures, storyImage } from "./images";
import { heroChart, withoutCharts } from "../shared/chart";
import { normalizeEmblem } from "../shared/emblem";
import { applySignal, buildEdition, feedPage, rules, scoreStories, SIGNAL_KINDS, slotNow } from "./palate";
import { shortStory, standIn, unreadable } from "./material";
import { adoptLang, cachedBrief, DEFAULT_STYLE, lensStream, originalText, readingLang, readingStyle, warmBriefs } from "./lens";
import { hasLLM, LENSES } from "./llm";
import { tagPending, tagsOf } from "./tag";
import * as briefing from "./briefing";
import { serveVoice, setVoiceBundle, voiceManifest } from "./voice";
import { validAddress } from "./mail";
import { follow, isFollowing, markSeen, newSince, unfollow, updates } from "./follow";
import { episodeStream } from "./listen";
import { discussionFor, warmDiscussions } from "./discussion";
import { DIG_KINDS, digStream, type DigKind } from "./dig";
import * as agent from "./agent";
import { judge, judgeDue, rejudge } from "./judge";
import { MARK, searchStories } from "./search";
import { weatherCode } from "./weather";
import { caseRoutes, caseTick } from "./case-routes";
import { ASSETLINKS, listenRoutes } from "./listen-routes";
import { servePublic } from "./public";
import { atomsFor, chartFromDraft, createDraft, FORMS, getDraft, listDrafts, previewStream, saveDraft, suggestStream } from "./studio";
import { cleanFilter, parseFilter } from "./filter";
import { addTopic, ownTopics, removeTopic, TopicError, topicsFor } from "./topics";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const PORT = Number(process.env.PORT ?? 4317);
const ORIGIN = auth.ORIGIN;
// dist/ sits next to the sources in development and next to the binary after `bun run compile`
const DIST = process.env.PEPPERMINT_DIST ?? [join(import.meta.dir, "..", "dist"), dirname(process.execPath), join(process.cwd(), "dist")].find(p => existsSync(join(p, "manifest.json"))) ?? join(process.cwd(), "dist");

/* ---------- static assets (built by build.ts) ---------- */
type Asset = { body: Uint8Array; br?: Uint8Array; gz?: Uint8Array; type: string; etag: string };
const assets = new Map<string, Asset>();
let shell = "";
function loadDist() {
  if (!existsSync(join(DIST, "manifest.json"))) { console.warn("dist/ missing: run `bun run build`"); return; }
  const man = json<{ files: Record<string, string> }>(readFileSync(join(DIST, "manifest.json"), "utf8"), { files: {} });
  for (const [path, type] of Object.entries(man.files)) {
    const p = join(DIST, path);
    assets.set("/" + path, { body: readFileSync(p), br: existsSync(p + ".br") ? readFileSync(p + ".br") : undefined, gz: existsSync(p + ".gz") ? readFileSync(p + ".gz") : undefined, type, etag: `"${Bun.hash(readFileSync(p)).toString(36)}"` });
  }
  shell = readFileSync(join(DIST, "index.html"), "utf8");
}
loadDist();

function serveAsset(req: Request, a: Asset, immutable: boolean) {
  if (req.headers.get("if-none-match") === a.etag) return new Response(null, { status: 304, headers: { etag: a.etag } });
  const ae = req.headers.get("accept-encoding") ?? "";
  const [body, enc] = a.br && ae.includes("br") ? [a.br, "br"] : a.gz && ae.includes("gzip") ? [a.gz, "gzip"] : [a.body, ""];
  const h: Record<string, string> = { "content-type": a.type, etag: a.etag, vary: "accept-encoding", "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache" };
  if (enc) h["content-encoding"] = enc;
  return new Response(body, { headers: h });
}

const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' https: blob:; frame-src https://www.youtube-nocookie.com; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const sec = { "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "permissions-policy": "camera=(), microphone=(self), geolocation=(self)" };
const J = (data: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra } });
const err = (status: number, message: string) => J({ error: message }, status);

/* ---------- read models ---------- */
function cardFor(row: any): Card {
  const t = json<any>(row.tags, {});
  const items = db.query(`SELECT i.id, i.title, i.url, i.author, i.lang, i.summary, i.meta, i.published_at, i.tags, i.source_id, s.name AS source, s.kind, s.config FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.story_id = ? ORDER BY i.published_at`).all(row.id) as any[];
  const lead = items.find(i => i.kind !== "hackernews") ?? items[0];
  const meta = items.reduce((m, i) => ({ ...json<any>(i.meta, {}), ...m }), {} as any);
  const lt = json<any>(lead?.tags, {});
  const lang = lt.lang ?? lead?.lang ?? "en";
  return {
    id: row.id, title: lang === "en" ? (lead?.title ?? row.title) : (t.title_en && lt.by !== "local" ? lt.title_en : lead?.title ?? row.title),
    title_orig: lead?.title ?? row.title, translated: lang !== "en" && lt.by && lt.by !== "local",
    lang, summary: (lt.by && lt.by !== "local" ? lt.summary_en : null) || lead?.summary || "",
    sources: [...new Map(items.map(i => [i.source, { name: i.source, kind: i.kind, icon: iconFor(row.owner_id, { kind: i.kind, meta: json<any>(i.meta, {}), config: i.config }) }])).values()],
    authors: [...new Set(items.map(i => i.author).filter(Boolean))].slice(0, 2),
    count: items.length, at: Math.max(...items.map(i => i.published_at)), topics: t.topics ?? [], places: t.places ?? [],
    meta: { points: meta.points, comments: meta.comments, site: meta.site, section: meta.section, hn: meta.hn },
    score: row.score, reasons: json(row.reasons, []), url: lead?.url,
    pinned: !!db.query("SELECT 1 FROM pins WHERE owner_id = ? AND story_id = ?").get(row.owner_id, row.id),
    ...(() => {
      // a brief may end in a chart marked as the story's core: the card shows it where the picture would be
      const short = shortStory(row.id);
      const b = short ? null : cachedBrief(row.id, readingLang(row.owner_id));
      return { brief: b ? withoutCharts(b) : null, chart: b ? heroChart(b) : null, short };
    })(),
    image: storyImage(row.owner_id, items),
    emblem: normalizeEmblem(lt.emblem),
    figures: cardFigures(row.owner_id, items),
    unreadable: unreadable(items.map(i => i.meta)),
    ...(() => { const s = standIn(row.id); return s ? { stand_in: s } : {}; })(),
    ...(row.slot ? { slot: row.slot } : {}),
  };
}

/** Stories you follow (saved ones included), most recently changed first. */
function followingList(owner: number) {
  const rows = db.query(`SELECT f.story_id, f.via, s.last_at FROM follows f JOIN stories s ON s.id = f.story_id WHERE f.owner_id = ? ORDER BY s.last_at DESC LIMIT 60`).all(owner) as { story_id: number; via: string }[];
  return rows.flatMap(r => { const c = storyCard(owner, r.story_id); return c ? [{ ...c, via: r.via, newCount: newSince(owner, r.story_id).length }] : []; });
}

/** The reading list: stories you saved, newest first, from whichever harvest they came. */
function readingList(owner: number) {
  const saved = db.query(`SELECT st.*, p.at AS saved_at FROM pins p JOIN stories st ON st.id = p.story_id WHERE p.owner_id = ? ORDER BY p.at DESC, p.rowid DESC`).all(owner) as any[];
  return saved.map(st => {
    const ei = db.query("SELECT score, reasons FROM edition_items WHERE story_id = ? ORDER BY added_at DESC LIMIT 1").get(st.id) as any;
    const sc = ei ?? (() => { const x = scoreStories(owner, [st])[0]; return { score: x.score, reasons: JSON.stringify(x.reasons) }; })();
    return { ...cardFor({ ...st, ...sc }), saved_at: st.saved_at };
  });
}

/** One story as a card, scored now (for stories that are not on an edition). */
function storyCard(owner: number, id: number) {
  const st = db.query("SELECT * FROM stories WHERE id = ? AND owner_id = ?").get(id, owner) as any;
  if (!st) return null;
  const s = scoreStories(owner, [st])[0];
  return cardFor({ ...st, score: s.score, reasons: JSON.stringify(s.reasons) });
}
/** Update cards: followed stories with reports you have not seen, with "what changed" when Claude already wrote it. */
function followUpdates(owner: number) {
  const lang = readingLang(owner);
  const icon = iconsByName(owner);
  return updates(owner).slice(0, 8).flatMap(u => {
    const c = storyCard(owner, u.storyId); if (!c) return [];
    const text = (db.query("SELECT text FROM lens_cache WHERE story_id = ? AND lens = 'update' AND lang = ? AND level = 2 AND done = 1").get(u.storyId, lang) as { text: string } | null)?.text ?? null;
    return [{ ...c, update: { count: u.reports.length, reports: u.reports.slice(0, 4).map(r => ({ title: r.title, source: r.source, kind: r.kind, icon: icon(r.source) })), text } }];
  });
}

function editionPayload(owner: number) {
  const { day, slot } = slotNow();
  const ed = db.query("SELECT * FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
  const sources = (db.query("SELECT count(*) AS n FROM sources WHERE owner_id = ? AND enabled = 1").get(owner) as { n: number }).n;
  if (!ed) return { edition: null, sources, llm: hasLLM(), lang: readingLang(owner) };
  // saved stories live on the reading list; what you already scrolled past stays out
  const rows = [...(db.query(`SELECT st.*, ei.score, ei.reasons, ei.slot FROM edition_items ei JOIN stories st ON st.id = ei.story_id WHERE ei.edition_id = ?
    AND st.id NOT IN (SELECT story_id FROM pins WHERE owner_id = ?)
    AND st.id NOT IN (SELECT story_id FROM signals WHERE owner_id = ? AND kind = 'seen' AND story_id IS NOT NULL) ORDER BY ei.rank`).all(ed.id, owner, owner) as any[])];
  const saved = (db.query("SELECT count(*) AS n FROM pins WHERE owner_id = ?").get(owner) as { n: number }).n;
  const viewed = (db.query(`SELECT count(*) AS n FROM edition_items ei WHERE ei.edition_id = ? AND ei.story_id IN (SELECT story_id FROM signals WHERE owner_id = ? AND kind = 'seen')
    AND ei.story_id NOT IN (SELECT story_id FROM pins WHERE owner_id = ?)`).get(ed.id, owner, owner) as { n: number }).n;
  const cut = db.query("SELECT reason, count(*) AS n FROM edition_cut WHERE edition_id = ? GROUP BY reason ORDER BY n DESC").all(ed.id) as { reason: string; n: number }[];
  const merged = json<any>(ed.cut, {}).merged ?? 0;
  // followed stories with news lead Today as update cards; the same story does not show twice
  const ups = followUpdates(owner);
  const upIds = new Set(ups.map(u => u.id));
  const cards = rows.filter(r => !upIds.has(r.id)).map(cardFor);
  return {
    updates: ups,
    edition: { id: ed.id, day: ed.day, slot: ed.slot, current: ed.day === day && ed.slot === slot, considered: ed.considered, updated_at: ed.updated_at,
      cut: merged ? [{ reason: "Duplicates merged into stories", n: merged }, ...cut] : cut, cards, viewed, saved,
      minutes: Math.max(1, Math.round(cards.length * 1.4)) },
    sources, llm: hasLLM(), lang: readingLang(owner),
  };
}

const editionStoryIds = (edId: number) => (db.query("SELECT story_id FROM edition_items WHERE edition_id = ? ORDER BY rank").all(edId) as { story_id: number }[]).map(r => r.story_id);

function bootData(owner: number | null) {
  if (!owner) return { auth: false, setup: !auth.accounts.hasPasskey() };
  return { auth: true, ...editionPayload(owner) };
}

/* ---------- SSE helper ---------- */
const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" };

/* ---------- routes ---------- */
type Ctx = { req: Request; url: URL; owner: number | null; params: Record<string, string> };
type Handler = (c: Ctx) => Response | Promise<Response>;
const routes: { method: string; path: string; re: RegExp; keys: string[]; h: Handler; open?: boolean; scope?: string }[] = [];
// scope: a paired device (the Android app) with this scope may call the route too; browsers always may
function route(method: string, path: string, h: Handler, open = false, scope?: string) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, path, re, keys, h, open, scope });
}
// a body that is no JSON object (null, a string, a list) reads as empty, so handlers can look at fields without guards
const body = async (req: Request) => { try { const j = await req.json(); return (j && typeof j === "object" && !Array.isArray(j) ? j : {}) as any; } catch { return {}; } };
/** A number from a request, inside lo..hi; anything that is not a finite number becomes the default. */
const num = (v: unknown, def: number, lo: number, hi: number) => { const n = Number(v ?? def); return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : def)); };

// accounts, passkeys, sessions and the people here: the accounts module's routes, answered before these (see fetch)
route("GET", "/api/edition", ({ owner }) => J(editionPayload(owner!)));
route("GET", "/api/list", ({ owner }) => J({ cards: readingList(owner!), following: followingList(owner!) }));
// follow a story (or stop); "seen" marks what is there now as read, so its update card goes away
route("POST", "/api/follow", async ({ req, owner }) => {
  const b = await body(req); const sid = Number(b.story_id);
  if (!db.query("SELECT 1 FROM stories WHERE id = ? AND owner_id = ?").get(sid, owner)) return err(404, "Story not found.");
  // a dossier's story follows the dossier: it searches again every six hours instead of waiting for your sources
  const dossier = agent.dossierOf(owner!, sid);
  if (dossier) agent.follow(owner!, dossier, b.on !== false);
  else if (b.on === false) unfollow(owner!, sid); else follow(owner!, sid);
  return J({ following: isFollowing(owner!, sid) });
});
// what a device needs to read stories without a connection: the story, its original text, the lens texts Claude already
// wrote (only cached ones, so this never starts Claude), and the pictures. The client fetches each URL once; the service
// worker keeps the answers.
route("GET", "/api/offline", ({ url, owner }) => {
  const scope = url.searchParams.get("scope") === "harvest" ? "harvest" : "list";
  const ed = db.query("SELECT id FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as { id: number } | null;
  const ids = scope === "list"
    ? (db.query("SELECT story_id FROM pins WHERE owner_id = ? ORDER BY at DESC LIMIT 80").all(owner) as { story_id: number }[]).map(r => r.story_id)
    : ed ? (db.query("SELECT story_id FROM edition_items WHERE edition_id = ? ORDER BY rank LIMIT 60").all(ed.id) as { story_id: number }[]).map(r => r.story_id) : [];
  const urls = new Set<string>([scope === "list" ? "/api/list" : "/api/edition"]);
  const lens = db.query("SELECT lens, lang, level FROM lens_cache WHERE story_id = ? AND done = 1");
  for (const id of ids) {
    const c = storyCard(owner!, id);
    if (!c) continue;
    urls.add(`/api/stories/${id}`); urls.add(`/api/stories/${id}/original`);
    for (const l of lens.all(id) as { lens: string; lang: string; level: number }[]) urls.add(`/api/stories/${id}/lens/${l.lens}?lang=${l.lang}&level=${l.level}`);
    const pics = [c.image && !c.image.pending ? c.image.src : null, ...(c.figures ?? []).map(f => f.src), ...storyFigures(owner!, id).slice(0, 6).map(f => f.src)];
    for (const src of pics) if (src?.startsWith("/api/media/") && mediaState(src.slice(11)) !== "failed") urls.add(`${src}?w=800`);
  }
  return J({ scope, stories: ids.length, urls: [...urls] });
});
// the morning briefing: today's (or a given day's), with the stories it points to as cards
route("GET", "/api/briefing", ({ url, owner }) => {
  const b = briefing.latest(owner!, url.searchParams.get("day") ?? undefined);
  const cards = b ? b.stories.flatMap(s => { const c = storyCard(owner!, s.id); return c ? [{ n: s.n, card: c }] : []; }) : [];
  return J({ briefing: b, cards, email: setting(owner!, "briefing_email", ""), on: setting(owner!, "briefing", true), llm: hasLLM() });
});
// write it now (and mail it when an address is set); the scheduler does the same each morning
let composing = false;
const briefTried = new Map<number, number>();
async function morningBriefing(owner: number) {
  const p = editionPayload(owner);
  const b = await briefing.compose(owner, [...(p.updates ?? []), ...(p.edition?.cards ?? [])]);
  if (b && setting(owner, "briefing_email", "")) await briefing.mailBriefing(owner, b, ORIGIN);
  return b ? briefing.latest(owner, b.day) : null;
}
route("POST", "/api/briefing", async ({ owner }) => {
  if (!hasLLM()) return err(409, "The briefing needs Claude on the server.");
  if (composing) return err(409, "A briefing is being written right now.");
  composing = true;
  try {
    const p = editionPayload(owner!);
    if (!p.edition && !p.updates?.length) return err(409, "Nothing to brief yet: no harvest today.");
    if (!p.edition?.cards.length && !p.updates?.length) return err(409, "Nothing left to brief: you are through today's harvest.");
    const b = await morningBriefing(owner!);
    return b ? J({ briefing: b }) : err(502, "Claude wrote no briefing this time. Try again.");
  } finally { composing = false; }
});
// the email exactly as it is mailed, as one page (pictures as data URLs), to look at it in a browser
route("GET", "/api/briefing/email", async ({ url, owner }) => {
  const b = briefing.latest(owner!, url.searchParams.get("day") ?? undefined);
  if (!b) return err(404, "No briefing yet.");
  const m = await briefing.email(owner!, b, ORIGIN);
  return new Response(briefing.previewHtml(m), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
});
route("POST", "/api/briefing/send", async ({ owner }) => {
  const b = briefing.latest(owner!);
  if (!b) return err(404, "No briefing yet.");
  const e = await briefing.mailBriefing(owner!, b, ORIGIN);
  return e ? err(502, e) : J({ ok: true });
});
setVoiceBundle(join(DIST, "kokoro.web.js"));
route("GET", "/api/voice", () => J(voiceManifest()));
route("GET", "/api/sky", async () => J({ code: await weatherCode() }));
// what the natural voice produced on a device (numbers only), so a broken GPU path shows up in the log
route("POST", "/api/voice/report", async ({ req }) => {
  const b = await body(req);
  const pick = (k: string) => (typeof b[k] === "number" || typeof b[k] === "boolean" ? b[k] : String(b[k] ?? "").slice(0, 160));
  console.log("voice report", JSON.stringify(Object.fromEntries(["noise", "flatness", "peak", "ms", "sec", "adapter", "ua"].map(k => [k, pick(k)]))));
  return J({ ok: true });
});
route("POST", "/api/follow/seen", async ({ req, owner }) => { const b = await body(req); markSeen(owner!, Number(b.story_id)); return J({ ok: true }); });
// Today after the edition: the next page of stories the palate rates as likely interesting (never ends while there are any)
route("POST", "/api/feed", async ({ req, owner }) => {
  const b = await body(req);
  const shown = new Set<number>((Array.isArray(b.shown) ? b.shown : []).slice(0, 3000).map(Number).filter(Number.isInteger));
  const ed = db.query("SELECT id FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
  if (ed) for (const id of editionStoryIds(ed.id)) shown.add(id);
  const { scored, more } = feedPage(owner!, shown, Math.min(12, Math.max(1, Number(b.limit) || 8)));
  const rows = scored.map(s => ({ ...(db.query("SELECT * FROM stories WHERE id = ?").get(s.story_id) as any), score: s.score, reasons: JSON.stringify(s.reasons) }));
  const cards = rows.map(cardFor);
  // their pictures and figures get copied in the background, so the next look has them ready
  queueStoryImages(owner!, cards.map(c => c.id)).catch(() => {});
  return J({ cards, more });
});
route("GET", "/api/edition/cut", ({ owner }) => {
  const ed = db.query("SELECT id FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
  if (!ed) return J({ items: [] });
  const rows = db.query(`SELECT st.id, st.title, st.title_en, st.tags, ec.reason, ec.score FROM edition_cut ec JOIN stories st ON st.id = ec.story_id WHERE ec.edition_id = ? ORDER BY ec.score DESC LIMIT 60`).all(ed.id) as any[];
  return J({ items: rows.map(r => ({ id: r.id, title: json<any>(r.tags, {}).lang === "en" ? r.title : r.title_en || r.title, reason: r.reason, score: r.score, topics: json<any>(r.tags, {}).topics ?? [] })) });
});
route("GET", "/api/harvest", async ({ req, owner }) => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = (e: string, d: unknown) => { try { c.enqueue(enc.encode(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)); } catch {} };
      const before = new Set((db.query("SELECT ei.story_id FROM edition_items ei JOIN editions e ON e.id = ei.edition_id WHERE e.owner_id = ?").all(owner) as any[]).map(r => r.story_id));
      // the pipeline's own "done" stays inside: a client stream closes on done, and edition (the real end) comes after it
      await harvest(owner!, { force: true, onEvent: (ev: PullEvent) => { if (ev.type !== "done") send(ev.type, ev); } });
      const r = buildEdition(owner!);
      const after = (db.query("SELECT ei.story_id FROM edition_items ei WHERE ei.edition_id = ?").all(r.id) as any[]).filter(x => !before.has(x.story_id)).length;
      send("edition", { through: after, cut: r.cut });
      try { c.close(); } catch {}
      warmBriefs(owner!, editionStoryIds(r.id)).catch(() => {});
      queueImages(owner!, true).catch(() => {});
    },
  });
  return new Response(stream, { headers: sseHeaders });
});

route("GET", "/api/stories/:id", async ({ owner, params }) => {
  const st = db.query("SELECT * FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  if (!st) return err(404, "Story not found.");
  const ei = db.query("SELECT score, reasons, pinned FROM edition_items WHERE story_id = ? ORDER BY added_at DESC LIMIT 1").get(st.id) as any;
  const card = cardFor({ ...st, score: ei?.score ?? scoreStories(owner!, [st])[0].score, reasons: ei?.reasons ?? JSON.stringify(scoreStories(owner!, [st])[0].reasons), pinned: ei?.pinned ?? 0 });
  const items = (db.query(`SELECT i.id, i.title, i.url, i.author, i.published_at, i.lang, i.meta, s.name AS source, s.kind FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = ? ORDER BY i.published_at`).all(st.id) as any[])
    .map(({ meta, ...i }) => {
      const m = json<any>(meta, {});
      // podcast episodes and videos play in the reader
      const media = m.audio || m.video ? { audio: typeof m.audio === "string" && /^https?:\/\//.test(m.audio) ? m.audio : null, video: typeof m.video === "string" && /^[\w-]{11}$/.test(m.video) ? m.video : null, duration: m.duration ?? null, image: m.image ?? null } : undefined;
      return { ...i, media };
    });
  const t = json<any>(st.tags, {});
  // names guessed by the local fallback (no Claude) are too rough to put on screen; places come from a fixed list and stay
  const guessed = (db.query("SELECT tags FROM items WHERE story_id = ?").all(st.id) as { tags: string }[]).every(r => json<any>(r.tags, {}).by === "local");
  const entities = setting(owner!, "images", true) ? await entitiesFor(owner!, guessed ? { places: t.places } : t, card.lang) : [];
  return J({ ...card, items, entities, following: isFollowing(owner!, st.id), research: agent.topicOf(owner!, st.id), newReports: newSince(owner!, st.id).map(r => r.title), figures: storyFigures(owner!, st.id), people: t.people ?? [], orgs: t.orgs ?? [], places: t.places ?? [], atoms: (db.query("SELECT tags FROM items WHERE story_id = ?").all(st.id) as any[]).flatMap(r => json<any>(r.tags, {}).atoms ?? []).slice(0, 8) });
});
route("GET", "/api/stories/:id/original", ({ owner, params }) => {
  const st = db.query("SELECT id FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  return st ? J(originalText(st.id)) : err(404, "Story not found.");
});
route("GET", "/api/stories/:id/discussion", async ({ owner, params }) => {
  const st = db.query("SELECT id FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  return st ? J(await discussionFor(st.id)) : err(404, "Story not found.");
});
route("GET", "/api/stories/:id/lens/:lens", ({ req, url, owner, params }) => {
  const st = db.query("SELECT id FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  if (!st) return err(404, "Story not found.");
  const lens = params.lens as any; if (!(LENSES as readonly string[]).includes(lens)) return err(400, "Unknown lens.");
  const lang = url.searchParams.get("lang") === "de" ? "de" : "en";
  const level = Math.min(3, Math.max(1, Number(url.searchParams.get("level") ?? 2))) as 1 | 2 | 3;
  const last = Number(req.headers.get("last-event-id") ?? url.searchParams.get("from") ?? -1);
  return new Response(lensStream(owner!, st.id, { lens, lang, level }, Number.isFinite(last) ? last : -1, req.signal), { headers: sseHeaders });
});

route("POST", "/api/signals", async ({ req, owner }) => {
  const b = await body(req);
  if (!SIGNAL_KINDS.includes(b.kind)) return err(400, "Unknown signal.");
  if (b.story_id != null && !db.query("SELECT 1 FROM stories WHERE id = ? AND owner_id = ?").get(Number(b.story_id), owner)) return err(404, "Story not found.");
  const sid = b.story_id ? Number(b.story_id) : null;
  // a story counts as seen once; repeats would only add noise to the history and the palate
  if (b.kind === "seen" && sid && db.query("SELECT 1 FROM signals WHERE owner_id = ? AND story_id = ? AND kind = 'seen'").get(owner, sid)) return J({ ok: true, moved: [] });
  const ms = b.kind === "dwell" ? Math.max(0, Math.min(3 * 3600_000, Math.round(Number(b.ms) || 0))) : undefined;
  if (b.kind === "dwell" && !ms) return J({ ok: true, moved: [] });
  const moved = applySignal(owner!, sid, b.kind, { subjects: Array.isArray(b.subjects) ? b.subjects.slice(0, 6).map(String) : undefined, ...(ms ? { ms } : {}), ...(b.kind === "seen" && Number(b.ms) ? { ms: Math.min(600_000, Math.round(Number(b.ms))) } : {}) });
  // saving follows the story too (and un-saving ends only that follow, not one you chose)
  if (sid && b.kind === "pin") { db.query("INSERT OR IGNORE INTO pins (owner_id, story_id, at) VALUES (?, ?, ?)").run(owner, sid, now()); follow(owner!, sid, "save"); }
  if (sid && b.kind === "unpin") { db.query("DELETE FROM pins WHERE owner_id = ? AND story_id = ?").run(owner, sid); unfollow(owner!, sid, "save"); }
  if (sid && b.kind === "hide") db.query("DELETE FROM pins WHERE owner_id = ? AND story_id = ?").run(owner, sid);
  if (sid && b.kind === "unhide") {
    const ed = db.query("SELECT id FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
    if (ed && db.query("SELECT 1 FROM edition_cut WHERE edition_id = ? AND story_id = ?").get(ed.id, sid)) {
      const st = db.query("SELECT * FROM stories WHERE id = ?").get(sid) as any; const sc = scoreStories(owner!, [st])[0];
      db.query("INSERT OR IGNORE INTO edition_items (edition_id, story_id, rank, score, reasons, pinned, added_at) VALUES (?, ?, ?, ?, ?, 0, ?)").run(ed.id, sid, 0, sc.score, JSON.stringify(sc.reasons), now());
      db.query("DELETE FROM edition_cut WHERE edition_id = ? AND story_id = ?").run(ed.id, sid);
      db.query(`WITH r AS (SELECT story_id, row_number() OVER (ORDER BY score DESC) - 1 AS rn FROM edition_items WHERE edition_id = ?)
        UPDATE edition_items SET rank = (SELECT rn FROM r WHERE r.story_id = edition_items.story_id) WHERE edition_id = ?`).run(ed.id, ed.id);
    }
  }
  if (b.kind === "rescue" || b.kind === "hide") {
    const ed = db.query("SELECT id FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
    if (ed && b.kind === "rescue") {
      const st = db.query("SELECT * FROM stories WHERE id = ? AND owner_id = ?").get(Number(b.story_id), owner) as any; const s = scoreStories(owner!, [st])[0];
      const rank = (db.query("SELECT coalesce(max(rank), 0) + 1 AS r FROM edition_items WHERE edition_id = ?").get(ed.id) as any).r;
      db.query("INSERT OR IGNORE INTO edition_items (edition_id, story_id, rank, score, reasons, pinned, added_at) VALUES (?, ?, ?, ?, ?, 1, ?)").run(ed.id, st.id, rank, s.score, JSON.stringify([{ label: "You rescued it", v: 0.45 }, ...s.reasons].slice(0, 6)), now());
      db.query("DELETE FROM edition_cut WHERE edition_id = ? AND story_id = ?").run(ed.id, st.id);
    }
    if (ed && b.kind === "hide") {
      db.query("DELETE FROM edition_items WHERE edition_id = ? AND story_id = ?").run(ed.id, Number(b.story_id));
      db.query("INSERT OR REPLACE INTO edition_cut (edition_id, story_id, reason, score) VALUES (?, ?, 'You hid it', 0)").run(ed.id, Number(b.story_id));
    }
  }
  return J({ ok: true, moved });
});

/* history: what you saw, opened, read and clicked; yours to read, download and clear, used for nothing but your palate */
function history(owner: number, days = 30) {
  const rows = db.query(`SELECT s.story_id, s.kind, s.meta, s.at, st.title, st.title_en, st.tags FROM signals s JOIN stories st ON st.id = s.story_id
    WHERE s.owner_id = ? AND s.at > ? ORDER BY s.at`).all(owner, now() - days * 86400_000) as any[];
  const by = new Map<number, any>();
  for (const r of rows) {
    const t = json<any>(r.tags, {});
    const h = by.get(r.story_id) ?? by.set(r.story_id, { story_id: r.story_id, title: t.lang && t.lang !== "en" && r.title_en ? r.title_en : r.title, first: r.at, last: r.at, seen: false, opened: 0, read_ms: 0, clicks: 0, lenses: [] as string[], verdict: null as string | null, pinned: false }).get(r.story_id);
    h.last = r.at;
    const m = json<any>(r.meta, {});
    if (r.kind === "seen") h.seen = true;
    if (r.kind === "open") h.opened++;
    if (r.kind === "dwell") h.read_ms += m.ms ?? 0;
    if (r.kind === "click") h.clicks++;
    if (r.kind === "lens" && m.lens && !h.lenses.includes(m.lens)) h.lenses.push(m.lens);
    if (["more", "less", "hide", "unhide", "rescue"].includes(r.kind)) h.verdict = r.kind;
    if (r.kind === "pin") h.pinned = true; if (r.kind === "unpin") h.pinned = false;
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}
route("GET", "/api/history", ({ owner }) => {
  const items = history(owner!);
  const total = (db.query("SELECT count(*) AS n FROM signals WHERE owner_id = ?").get(owner) as any).n;
  return J({ items, total, read_ms: items.reduce((a, h) => a + h.read_ms, 0), agent: agent.agentLog(owner!) });
});
route("GET", "/api/history/export", ({ owner }) => {
  const signals = (db.query(`SELECT s.kind, s.value, s.meta, s.at, s.story_id, st.title FROM signals s LEFT JOIN stories st ON st.id = s.story_id WHERE s.owner_id = ? ORDER BY s.at`).all(owner) as any[])
    .map(r => ({ ...r, meta: json(r.meta, {}), at: new Date(r.at).toISOString() }));
  return new Response(JSON.stringify({ exported_at: new Date().toISOString(), signals }, null, 1), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="peppermint-history.json"` } });
});
route("DELETE", "/api/history", ({ owner }) => {
  const n = db.query("DELETE FROM signals WHERE owner_id = ?").run(owner).changes;
  return J({ deleted: n });
});

/* sources */
route("GET", "/api/sources", ({ owner }) => {
  const rows = db.query("SELECT id, kind, name, config, cursor, filter, cadence_min, trust, enabled, last_pull_at, last_ok_at, last_error, created_at FROM sources WHERE owner_id = ? AND kind != 'agent' ORDER BY created_at").all(owner) as any[];
  const trial = trials(owner!);
  const since = now() - 24 * 3600_000;
  const stats = db.query(`SELECT i.source_id, count(*) AS n, count(ei.story_id) AS through FROM items i
    LEFT JOIN (SELECT DISTINCT ei.story_id FROM edition_items ei JOIN editions e ON e.id = ei.edition_id WHERE e.owner_id = ?) ei ON ei.story_id = i.story_id
    WHERE i.owner_id = ? AND i.fetched_at > ? GROUP BY i.source_id`).all(owner, owner, since) as any[];
  const spark = db.query(`SELECT source_id, CAST((? - fetched_at) / 10800000 AS INTEGER) AS b, count(*) AS n FROM items WHERE owner_id = ? AND fetched_at > ? GROUP BY source_id, b`).all(now(), owner, now() - 8 * 10800_000) as any[];
  return J({
    // the cursor stays on the server; a newsletter's pending confirm link is the one part of it the page shows
    sources: rows.map(({ cursor, ...r }) => ({ ...r, config: json(r.config, {}), filter: parseFilter(r.filter), confirm: r.kind === "mail" ? json<any>(cursor, {}).confirm ?? null : null, icon: sourceIcon(owner!, r.kind, json(r.config, {})), in24: stats.find(s => s.source_id === r.id)?.n ?? 0, through24: stats.find(s => s.source_id === r.id)?.through ?? 0,
      spark: Array.from({ length: 8 }, (_, b) => spark.find(s => s.source_id === r.id && s.b === 7 - b)?.n ?? 0), trial: trial.get(r.id) ?? null })),
  });
});
route("GET", "/api/discover", async ({ url, owner }) => {
  const input = url.searchParams.get("url");
  const kind = url.searchParams.get("kind") ?? (input ? kindForUrl(input) : null);
  if (!kind || !CONNECTORS[kind]) return err(422, input ? "That is not a link peppermint can read." : "Pick a kind of source.");
  try {
    const d = await CONNECTORS[kind].discover(input ?? undefined);
    return J({ ...d, icon: sourceIcon(owner!, d.kind, { image: d.image ?? undefined, ...(d.config ?? {}), feeds: d.options.map(o => o.key).filter(k => /^https?:/.test(k)) }) });
  }
  catch (e) { const m = (e as Error).message; if ((e as any).status === 422) return err(422, m); return err(502, kind === "feed" ? m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? "" : ".") : `Could not reach ${CONNECTORS[kind].label}: ${m}`); }
});
/** The creator picker: shows, channels, people and repositories, marked when you already follow them. */
route("GET", "/api/creators", async ({ url, owner }) => {
  const kind = url.searchParams.get("kind") ?? "", q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
  const fresh = (NEW_KINDS as readonly string[]).includes(kind);
  if (!fresh && kind !== "podcast" && kind !== "youtube") return err(400, "Pick a kind of source with a picker.");
  if (q.length < 2 && kind !== "arxiv" && kind !== "echa") return J({ results: [] });
  const rows = db.query("SELECT config FROM sources WHERE owner_id = ? AND kind = ?").all(owner, kind) as any[];
  const followed = new Set(rows.flatMap(r => { const c = json<any>(r.config, {}); return [...(c.feeds ?? []), ...(c.key ? [c.key] : [])]; }));
  try {
    const results = fresh ? await findPicks(kind, q, url.searchParams.get("lang") ?? "en") : kind === "podcast" ? await searchPodcasts(q) : await searchYouTube(q);
    return J({ results: results.map((r: any) => ({ ...r, followed: followed.has(r.config?.key ?? r.feed) })) });
  } catch (e) { return err((e as any).status ?? 502, (e as Error).message); }
});
/** Sources for you: feeds Claude picked from your palate and research, each fetched and parsed before it is listed, in
 *  the catalog's shape. Added from here, a source is on trial for a week. ?fresh=1 asks again instead of the 12 h cache. */
route("GET", "/api/suggestions", async ({ url, owner }) => {
  if (!hasLLM()) return err(503, "Claude is off, so there is nobody to pick sources. Popular sources still work.");
  try {
    const { at, list } = await suggestSources(owner!, url.searchParams.get("fresh") === "1");
    const entry = (e: (typeof list)[number]) => ({ ...e, added: false, trial: true, icon: sourceIcon(owner!, "feed", { feeds: [e.feed], url: `https://${e.site}/` }) });
    return J({ at, groups: [
      { id: "close", title: "Close to what you read", entries: list.filter(e => !e.stretch).map(entry) },
      { id: "stretch", title: "One step outside", entries: list.filter(e => e.stretch).map(entry) },
    ].filter(g => g.entries.length) });
  } catch (e) { return err(502, `Claude could not pick sources: ${(e as Error).message}`); }
});
/** Popular sources: the curated catalog, each entry marked with whether this owner already has its feed. */
route("GET", "/api/catalog", ({ owner }) => {
  const have = new Set((db.query("SELECT config FROM sources WHERE owner_id = ? AND kind = 'feed'").all(owner) as any[]).flatMap(r => json<any>(r.config, {}).feeds ?? []));
  return J({ groups: CATALOG.map(g => ({ ...g, entries: g.entries.map(e => ({ ...e, added: have.has(e.feed), icon: sourceIcon(owner!, "feed", { feeds: [e.feed], url: `https://${e.site}/` }) })) })) });
});
route("POST", "/api/sources", async ({ req, owner }) => {
  const b = await body(req);
  const c = CONNECTORS[b.kind]; if (!c) return err(400, "Unknown source kind.");
  if ((NEW_KINDS as readonly string[]).includes(b.kind)) {
    // bluesky, mastodon, topic, github, arxiv, watch: one source per account, topic or page, identified by config.key
    let built; try { built = await configFor(b.kind, b.config); } catch (e) { return err((e as any).status ?? 400, (e as Error).message); }
    const image = typeof b.image === "string" && /^https:\/\//.test(b.image) ? b.image.slice(0, 500) : undefined;
    const config = { ...built.config, ...(image ? { image } : {}) };
    const name = String(b.name ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || built.name;
    const cadence = num(b.cadence, CADENCE[b.kind], 15, 1440);
    const dup = (db.query("SELECT id, config FROM sources WHERE owner_id = ? AND kind = ?").all(owner, b.kind) as any[]).find(r => json<any>(r.config, {}).key === config.key);
    if (dup) { db.query("UPDATE sources SET config = ?, cadence_min = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(config), cadence, dup.id); return J({ id: dup.id, updated: true }); }
    const r = db.query("INSERT INTO sources (owner_id, kind, name, config, cadence_min, trust, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id").get(owner, b.kind, name, JSON.stringify(config), cadence, num(b.trust, 1, 0, 2), now()) as { id: number };
    // a newsletter's address is what you subscribe with: the client shows it right away
    return J({ id: r.id, ...(config.address ? { address: config.address } : {}) });
  }
  const opts: string[] = Array.isArray(b.options) ? b.options.map(String) : [];
  // feeds, podcasts and YouTube channels are one source per site or creator, read through their feeds
  const perFeed = b.kind === "feed" || b.kind === "podcast" || b.kind === "youtube";
  const feeds = perFeed ? opts.filter(o => { try { return /^https?:$/.test(new URL(o).protocol) && (b.kind !== "youtube" || isYouTubeFeed(o)) && (b.kind !== "podcast" || !isYouTubeFeed(o)); } catch { return false; } }).slice(0, 6) : [];
  if (perFeed && !feeds.length) return err(400, b.kind === "youtube" ? "That is not a YouTube channel feed." : "Pick at least one feed.");
  const image = typeof b.image === "string" && /^https:\/\//.test(b.image) ? b.image.slice(0, 500) : undefined;
  const config = b.kind === "hackernews" ? { lists: opts, minPoints: num(b.minPoints, 150, 10, 1000) } : b.kind === "merkur" ? { sections: opts } : perFeed ? { feeds, ...(image ? { image } : {}) } : { promoted: opts.includes("promoted") };
  // one source per kind, except feeds, podcasts and channels: one per feed
  const dup = (perFeed
    ? (db.query("SELECT id, config FROM sources WHERE owner_id = ? AND kind = ?").all(owner, b.kind) as any[]).find(r => json<any>(r.config, {}).feeds?.some((f: string) => feeds.includes(f)))
    : db.query("SELECT id FROM sources WHERE owner_id = ? AND kind = ?").get(owner, b.kind)) as any;
  if (dup) {
    db.query("UPDATE sources SET config = ?, cadence_min = ?, trust = ?, enabled = 1 WHERE id = ?").run(JSON.stringify(config), num(b.cadence, 60, 5, 1440), num(b.trust, 1, 0, 2), dup.id);
    return J({ id: dup.id, updated: true });
  }
  const r = db.query("INSERT INTO sources (owner_id, kind, name, config, cadence_min, trust, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id")
    .get(owner, b.kind, perFeed ? String(b.name ?? c.label).replace(/\s+/g, " ").trim().slice(0, 60) || c.label : c.label, JSON.stringify(config), num(b.cadence, 60, 5, 1440), num(b.trust, 1, 0, 2), now()) as { id: number };
  if (b.trial === true) db.query("UPDATE sources SET trial_until = ? WHERE id = ?").run(now() + TRIAL_MS, r.id);
  return J({ id: r.id });
});
route("PATCH", "/api/sources/:id", async ({ req, owner, params }) => {
  const b = await body(req);
  const s = db.query("SELECT * FROM sources WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any; if (!s) return err(404, "Source not found.");
  if ("enabled" in b) db.query("UPDATE sources SET enabled = ? WHERE id = ?").run(b.enabled ? 1 : 0, s.id);
  if ("trust" in b) db.query("UPDATE sources SET trust = ? WHERE id = ?").run(num(b.trust, s.trust, 0, 2), s.id);
  if ("cadence" in b) db.query("UPDATE sources SET cadence_min = ? WHERE id = ?").run(num(b.cadence, s.cadence_min, 5, 1440), s.id);
  if ("filter" in b) db.query("UPDATE sources SET filter = ? WHERE id = ?").run(JSON.stringify(cleanFilter(b.filter)), s.id);
  // keeping a source on trial ends the trial: from then on it is a source like any other
  if (b.trial === false) db.query("UPDATE sources SET trial_until = NULL WHERE id = ?").run(s.id);
  return J({ ok: true });
});
route("DELETE", "/api/sources/:id", ({ owner, params }) => {
  const id = Number(params.id);
  db.transaction(() => {
    const touched = (db.query("SELECT DISTINCT story_id AS id FROM items WHERE source_id = ? AND owner_id = ? AND story_id IS NOT NULL").all(id, owner) as { id: number }[]).map(r => r.id);
    db.query("DELETE FROM lens_cache WHERE story_id IN (SELECT story_id FROM items WHERE source_id = ? AND owner_id = ?)").run(id, owner);
    db.query("DELETE FROM items WHERE source_id = ? AND owner_id = ?").run(id, owner);
    db.query("DELETE FROM sources WHERE id = ? AND owner_id = ?").run(id, owner);
    // a story left without reports would linger on Today and in search with no source and a 1970 date: it goes too
    // (agent stories have no items by design and stay); a story that still has reports from elsewhere is recounted
    const left = db.query("SELECT count(*) AS n FROM items WHERE story_id = ?"), agentOwned = db.query("SELECT 1 FROM tasks WHERE story_id = ?");
    for (const sid of touched) {
      const n = (left.get(sid) as { n: number }).n;
      if (n) { db.query("UPDATE stories SET item_count = ? WHERE id = ?").run(n, sid); continue; }
      if (agentOwned.get(sid)) continue;
      for (const t of ["edition_items", "edition_cut", "signals"]) db.query(`DELETE FROM ${t} WHERE story_id = ?`).run(sid);
      db.query("DELETE FROM stories WHERE id = ? AND owner_id = ?").run(sid, owner);
    }
  })();
  return J({ ok: true });
});
/** A site's icon, looked up on first ask: the logo of a source, a popular source or a picker. 404 keeps the letter badge. */
route("GET", "/api/icon/:host", async ({ owner, params }) => {
  const host = String(params.host).toLowerCase();
  const local = HOST.test(host) ? await siteIcon(owner!, host) : null;
  return local ? new Response(null, { status: 302, headers: { location: local, "cache-control": "private, max-age=86400" } })
    : new Response(null, { status: 404, headers: { "cache-control": "private, max-age=3600" } });
});
route("GET", "/api/media/:key", ({ url, owner, params }) => serveMedia(owner!, params.key, Number(url.searchParams.get("w")) || undefined));

/* palate */
route("GET", "/api/palate", ({ owner }) => {
  const aff = db.query("SELECT kind, name, weight, manual, seen FROM affinities WHERE owner_id = ? ORDER BY abs(weight) DESC, seen DESC LIMIT 60").all(owner) as any[];
  // topics seen recently but not yet weighted still belong on the map
  const recent = db.query("SELECT tags FROM stories WHERE owner_id = ? AND last_at > ?").all(owner, now() - 7 * 86400_000) as any[];
  const freq = new Map<string, number>(); for (const r of recent) for (const t of json<any>(r.tags, {}).topics ?? []) freq.set(t, (freq.get(t) ?? 0) + 1);
  const topics = [...freq.entries()].map(([name, n]) => ({ name, n, weight: aff.find(a => a.kind === "topic" && a.name === name)?.weight ?? 0 }));
  for (const a of aff) if (a.kind === "topic" && !freq.has(a.name)) topics.push({ name: a.name, n: 0, weight: a.weight });
  const signals = db.query("SELECT s.kind, s.value, s.at, st.title, st.title_en, st.tags FROM signals s LEFT JOIN stories st ON st.id = s.story_id WHERE s.owner_id = ? ORDER BY s.at DESC LIMIT 12").all(owner) as any[];
  const count = (db.query("SELECT count(*) AS n FROM signals WHERE owner_id = ?").get(owner) as any).n;
  return J({
    topics: topics.sort((a, b) => Math.abs(b.weight) + b.n / 20 - (Math.abs(a.weight) + a.n / 20)).slice(0, 18),
    own: ownTopics(owner!),
    others: aff.filter(a => a.kind !== "topic").slice(0, 16), rules: rules(owner!), count,
    signals: signals.map(s => ({ kind: s.kind, value: s.value, at: s.at, title: s.tags && json<any>(s.tags, {}).lang !== "en" ? (s.title_en || s.title) : s.title })),
    settings: { budget: setting(owner!, "budget", 12), threshold: setting(owner!, "threshold", 0.55), lang: readingLang(owner!), style: readingStyle(owner!), images: setting(owner!, "images", true), briefing: setting(owner!, "briefing", true), briefing_email: setting(owner!, "briefing_email", "") },
    // the latest briefing, so the email card can offer "send today's" and show why the last email failed
    briefing: (b => b ? { day: b.day, error: b.error } : null)(briefing.latest(owner!)),
  });
});
// your own topics (server/topics.ts): added with +1, marked at once on the last week's stories that mention them
route("POST", "/api/topics", async ({ req, owner }) => {
  try { const r = addTopic(owner!, (await body(req)).name); rejudge(owner!); return J({ ...r, own: ownTopics(owner!) }); }
  catch (e) { if (e instanceof TopicError) return err(e.status, e.message); throw e; }
});
route("DELETE", "/api/topics/:name", ({ owner, params }) => {
  try { removeTopic(owner!, params.name); rejudge(owner!); return J({ own: ownTopics(owner!) }); }
  catch (e) { if (e instanceof TopicError) return err(e.status, e.message); throw e; }
});
route("PUT", "/api/affinities", async ({ req, owner }) => {
  const b = await body(req);
  if (!["topic", "person", "org", "place", "source"].includes(b.kind) || typeof b.name !== "string") return err(400, "Bad weight.");
  if (!Number.isFinite(Number(b.weight))) return err(400, "Bad weight.");
  const w = num(b.weight, 0, -3, 3);
  db.query(`INSERT INTO affinities (owner_id, kind, name, weight, manual, updated_at) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(owner_id, kind, name) DO UPDATE SET weight = excluded.weight, manual = 1, updated_at = excluded.updated_at`).run(owner, b.kind, b.name.slice(0, 80), w, now());
  rejudge(owner!);
  return J({ ok: true });
});
route("PUT", "/api/settings", async ({ req, owner }) => {
  const b = await body(req);
  if ("budget" in b) setSetting(owner!, "budget", Math.round(num(b.budget, 12, 3, 30)));
  if ("threshold" in b) setSetting(owner!, "threshold", num(b.threshold, 0.55, 0.3, 0.85));
  if ("images" in b) setSetting(owner!, "images", !!b.images);
  if ("briefing" in b) setSetting(owner!, "briefing", !!b.briefing);
  if ("briefing_email" in b) {
    const e = String(b.briefing_email ?? "").trim().slice(0, 200);
    if (e && !validAddress(e)) return err(400, "That does not look like an email address.");
    setSetting(owner!, "briefing_email", e);
  }
  // language and style of the briefs: old briefs no longer fit, so they are written again
  const restyle = ("lang" in b && (b.lang === "en" || b.lang === "de") && b.lang !== readingLang(owner!)) || ("style" in b && String(b.style ?? "").trim().slice(0, 300) !== readingStyle(owner!));
  if ("lang" in b && (b.lang === "en" || b.lang === "de")) setSetting(owner!, "lang", b.lang);
  if ("style" in b) setSetting(owner!, "style", String(b.style ?? "").trim().slice(0, 300) || DEFAULT_STYLE);
  if (restyle) {
    db.query("DELETE FROM lens_cache WHERE lens IN ('brief', 'digest') AND story_id IN (SELECT id FROM stories WHERE owner_id = ?)").run(owner);
    const ed = db.query("SELECT id FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
    if (ed) warmBriefs(owner!, editionStoryIds(ed.id)).catch(() => {});
  }
  return J({ ok: true });
});
route("GET", "/api/rule-values", ({ url, owner }) => {
  const kind = url.searchParams.get("kind") ?? "topic";
  if (kind === "topic") return J({ values: topicsFor(owner!) });
  if (kind === "source") return J({ values: (db.query("SELECT name FROM sources WHERE owner_id = ?").all(owner) as any[]).map(r => r.name) });
  const recent = db.query("SELECT tags FROM stories WHERE owner_id = ? AND last_at > ? ORDER BY last_at DESC LIMIT 400").all(owner, now() - 7 * 86400_000) as any[];
  const key = kind === "person" ? "people" : kind === "org" ? "orgs" : "places";
  const f = new Map<string, number>(); for (const r of recent) for (const v of json<any>(r.tags, {})[key] ?? []) f.set(v, (f.get(v) ?? 0) + 1);
  return J({ values: [...f.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([v]) => v) });
});
route("POST", "/api/rules", async ({ req, owner }) => {
  const b = await body(req);
  if (!["always", "boost", "mute", "never"].includes(b.action) || !["topic", "person", "org", "place", "source", "word"].includes(b.kind) || !String(b.value ?? "").trim()) return err(400, "A rule needs an action, a kind and a value.");
  db.query("INSERT INTO rules (owner_id, action, kind, value, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner_id, kind, value) DO UPDATE SET action = excluded.action").run(owner, b.action, b.kind, String(b.value).trim().slice(0, 80), now());
  rejudge(owner!);
  return J({ ok: true, rules: rules(owner!) });
});
route("DELETE", "/api/rules/:id", ({ owner, params }) => { db.query("DELETE FROM rules WHERE id = ? AND owner_id = ?").run(Number(params.id), owner); return J({ ok: true, rules: rules(owner!) }); });
route("POST", "/api/edition/rebuild", ({ owner }) => { const r = buildEdition(owner!); return J(r); });
route("GET", "/api/duel", ({ owner }) => {
  const rows = db.query(`SELECT st.id, st.title, st.title_en, st.tags, st.item_count FROM stories st WHERE st.owner_id = ? AND st.last_at > ?
    AND st.id NOT IN (SELECT story_id FROM signals WHERE owner_id = ? AND kind LIKE 'duel%' AND story_id IS NOT NULL) ORDER BY random() LIMIT 40`).all(owner, now() - 3 * 86400_000, owner) as any[];
  // pair two stories with different first topics so the choice teaches something
  for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
    const a = json<any>(rows[i].tags, {}), b = json<any>(rows[j].tags, {});
    if (a.topics?.[0] && b.topics?.[0] && a.topics[0] !== b.topics[0]) {
      const src = (id: number) => (db.query("SELECT s.name FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = ? LIMIT 1").get(id) as any)?.name ?? "";
      const pick = (r: any, t: any) => ({ id: r.id, title: t.lang === "en" || !r.title_en ? r.title : r.title_en, topic: t.topics[0], source: src(r.id) });
      return J({ pair: [pick(rows[i], a), pick(rows[j], b)] });
    }
  }
  return J({ pair: null });
});

const lastId = (req: Request) => { const n = Number(req.headers.get("last-event-id") ?? -1); return Number.isInteger(n) && n >= -1 ? n : -1; };

/* listen */
route("GET", "/api/listen", ({ req, url, owner }) => {
  const lang = url.searchParams.get("lang") === "de" ? "de" : "en";
  const s = episodeStream(owner!, lang, lastId(req), req.signal);
  return s ? new Response(s, { headers: sseHeaders }) : err(404, "There is no edition to listen to yet.");
}, false, "listen");

/* studio */
route("GET", "/api/drafts", ({ owner }) => J({ drafts: listDrafts(owner!), forms: Object.entries(FORMS).map(([key, f]) => ({ key, label: f.label })) }));
route("POST", "/api/drafts", async ({ req, owner }) => {
  const b = await body(req);
  if (b.story_id != null && !db.query("SELECT 1 FROM stories WHERE id = ? AND owner_id = ?").get(Number(b.story_id), owner)) return err(404, "Story not found.");
  return J(createDraft(owner!, b.story_id != null ? Number(b.story_id) : undefined));
});
route("GET", "/api/drafts/:id", ({ owner, params }) => {
  const d = getDraft(owner!, Number(params.id)); if (!d) return err(404, "Draft not found.");
  const icon = iconsByName(owner!);
  return J({ ...d, blocks: d.blocks.map(b => b.cite ? { ...b, cite: { ...b.cite, icon: icon(b.cite.source) } } : b) });
});
route("PUT", "/api/drafts/:id", async ({ req, owner, params }) => {
  const r = saveDraft(owner!, Number(params.id), await body(req));
  if (r.conflict) return J({ error: "This draft changed in another window. Showing the newer version.", draft: r.conflict }, 409);
  return r.draft ? J(r.draft) : err(404, "Draft not found.");
});
route("DELETE", "/api/drafts/:id", ({ owner, params }) => { db.query("DELETE FROM drafts WHERE id = ? AND owner_id = ?").run(Number(params.id), owner); return J({ ok: true, drafts: listDrafts(owner!) }); });
route("GET", "/api/drafts/:id/preview/:form", ({ req, owner, params }) => {
  const d = getDraft(owner!, Number(params.id)); if (!d) return err(404, "Draft not found.");
  if (!FORMS[params.form]) return err(400, "Unknown form.");
  return new Response(previewStream(owner!, d, params.form, lastId(req), req.signal), { headers: sseHeaders });
});
route("POST", "/api/drafts/:id/chart", async ({ req, owner, params }) => {
  const d = getDraft(owner!, Number(params.id)); if (!d) return err(404, "Draft not found.");
  if (!hasLLM()) return err(503, "Charts from your numbers need Claude on the server.");
  const b = await body(req);
  const r = await chartFromDraft(owner!, d, typeof b.after === "string" ? b.after : null);
  return "json" in r ? J(r) : err(422, r.error);
});
route("GET", "/api/drafts/:id/suggest", ({ req, url, owner, params }) => {
  const d = getDraft(owner!, Number(params.id)); if (!d) return err(404, "Draft not found.");
  const nth = Math.max(0, Math.min(20, Number(url.searchParams.get("nth") ?? 0) || 0));
  return new Response(suggestStream(owner!, d, url.searchParams.get("after"), nth, lastId(req), req.signal), { headers: sseHeaders });
});
route("GET", "/api/atoms", ({ url, owner }) => { const icon = iconsByName(owner!); return J({ stories: atomsFor(owner!, (url.searchParams.get("q") ?? "").slice(0, 100)).map(s => ({ ...s, icon: s.source ? icon(s.source) : null })) }); });


/* search: what you follow, as you type */
route("GET", "/api/search", ({ url, owner }) => {
  const q = (url.searchParams.get("q") ?? "").slice(0, 200);
  const hits = searchStories(owner!, q, Math.min(20, Math.max(1, Number(url.searchParams.get("limit")) || 8)));
  const cards = hits.map(h => {
    const st = db.query("SELECT * FROM stories WHERE id = ?").get(h.story_id) as any;
    const sc = scoreStories(owner!, [st])[0];
    return { ...cardFor({ ...st, score: sc.score, reasons: JSON.stringify(sc.reasons) }), snippet: h.snippet };
  });
  return J({ q, cards, mark: MARK });
});

/* the agent: one input, and what it becomes */
const agentErr = (e: unknown) => e instanceof agent.AgentError ? err(e.status, e.message) : err(502, `The agent stopped: ${String((e as Error).message ?? e).slice(0, 200)}`);
/** A task with the story card it made, for the probe and link cards on Today. */
function taskView(owner: number, t: ReturnType<typeof agent.taskOf>) {
  if (!t.story_id || t.kind === "dossier" || t.kind === "explain") return t;
  const st = db.query("SELECT * FROM stories WHERE id = ? AND owner_id = ?").get(t.story_id, owner) as any;
  if (!st) return { ...t, card: null };
  const sc = scoreStories(owner, [st])[0];
  return { ...t, card: cardFor({ ...st, score: sc.score, reasons: JSON.stringify(sc.reasons) }) };
}
route("GET", "/api/agent", ({ owner }) => {
  const s = agent.agentState(owner!);
  return J({ ...s, tasks: s.tasks.map(t => taskView(owner!, t)), llm: hasLLM() });
});
route("POST", "/api/agent", async ({ req, owner }) => {
  const b = await body(req);
  const scope = { kind: b.scope?.kind === "palate" ? "palate" : b.scope?.kind === "story" ? "story" : "today", story_id: Number(b.scope?.story_id) || undefined } as agent.Scope;
  if (scope.story_id && !db.query("SELECT 1 FROM stories WHERE id = ? AND owner_id = ?").get(scope.story_id, owner)) return err(404, "Story not found.");
  try {
    const r = await agent.interpret(owner!, String(b.input ?? ""), scope);
    return J({ ...r, task: r.task ? taskView(owner!, r.task) : undefined });
  } catch (e) { return agentErr(e); }
});
route("GET", "/api/agent/tasks/:id", ({ owner, params }) => {
  const row = agent.getTask(owner!, Number(params.id));
  if (!row) return err(404, "Not found.");
  const t = taskView(owner!, agent.taskOf(row));
  const sources = row.story_id ? (db.query("SELECT title, url, author, published_at FROM items WHERE story_id = ? ORDER BY published_at DESC").all(row.story_id) as any[])
    .map(i => ({ title: i.title, url: i.url, site: i.author, at: i.published_at })) : [];
  return J({ task: t, sources, news: row.kind === "dossier" && row.story_id ? newSince(owner!, row.story_id).map(r => r.title) : [] });
});
const taskRoute = (path: string, f: (owner: number, id: number, b: any) => unknown | Promise<unknown>) => route("POST", `/api/agent/tasks/:id/${path}`, async ({ req, owner, params }) => {
  if (!agent.getTask(owner!, Number(params.id))) return err(404, "Not found.");
  try { return J(await f(owner!, Number(params.id), await body(req))); } catch (e) { return agentErr(e); }
});
// "Research this" on a story: a dossier planned from what the story says; the same story again opens that dossier
route("POST", "/api/stories/:id/research", async ({ req, owner, params }) => {
  if (!hasLLM()) return err(503, "Research needs Claude, and Claude is off on this server.");
  const b = await body(req).catch(() => ({}));
  try { return J({ task: agent.researchStory(owner!, Number(params.id), b?.from) }); } catch (e) { return agentErr(e); }
});
// the Research folder: topics, not articles
route("GET", "/api/research", ({ owner }) => J({ topics: agent.topics(owner!, id => storyCard(owner!, id)?.image ?? null, id => newSince(owner!, id).length, id => isFollowing(owner!, id)) }));
taskRoute("steer", async (o, id, b) => ({ task: await agent.steer(o, id, String(b.text ?? "")) }));
taskRoute("follow", (o, id, b) => ({ task: agent.follow(o, id, !!b.on) }));
taskRoute("refresh", (o, id) => ({ task: agent.refreshDossier(o, id) }));
taskRoute("react", (o, id, b) => ({ moved: agent.react(o, id, b.verdict === "less" ? "less" : "more") }));
// undo for a dismissed topic: back in the folder, and followed again if it was
taskRoute("restore", (o, id, b) => {
  const t = agent.getTask(o, id)!;
  if (t.kind !== "dossier" || t.status !== "dismissed") throw new agent.AgentError(400, "Only a removed topic comes back.");
  db.query("UPDATE tasks SET status = 'done', updated_at = ? WHERE id = ? AND owner_id = ?").run(now(), id, o);
  if (b.following && t.story_id) agent.follow(o, id, true);
  return { ok: true };
});
taskRoute("dismiss", (o, id) => {
  const t = agent.getTask(o, id)!;
  if (t.kind === "dossier" && t.story_id) unfollow(o, t.story_id);
  db.query("UPDATE tasks SET status = 'dismissed', updated_at = ? WHERE id = ? AND owner_id = ?").run(now(), id, o); return { ok: true };
});
taskRoute("draft", (o, id) => {
  const t = agent.taskOf(agent.getTask(o, id)!);
  if (t.kind !== "dossier" || !t.story_id) throw new agent.AgentError(400, "Only a dossier goes to Studio.");
  const d = createDraft(o, t.story_id);
  const lead = [{ id: "dh", type: "h", text: t.title }, ...(t.result.summary ? [{ id: "ds", type: "p", text: t.result.summary }] : [])];
  return { draft: saveDraft(o, d.id, { blocks: [...lead, ...d.blocks.filter(x => x.type !== "h")] }).draft };
});
for (const op of ["apply", "dismiss", "undo"] as const) route("POST", `/api/agent/proposals/:id/${op}`, ({ owner, params }) => {
  try { return J({ proposal: (op === "apply" ? agent.applyProposal : op === "dismiss" ? agent.dismissProposal : agent.undoProposal)(owner!, Number(params.id)) }); } catch (e) { return agentErr(e); }
});
route("GET", "/api/stories/:id/asks", ({ owner, params }) => {
  const st = db.query("SELECT id FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  return st ? J({ asks: agent.asks(owner!, st.id) }) : err(404, "Story not found.");
});
route("GET", "/api/stories/:id/ask", ({ req, url, owner, params }) => {
  const st = db.query("SELECT id FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  if (!st) return err(404, "Story not found.");
  const q = (url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!q) return err(400, "Ask a question.");
  return new Response(agent.askStream(owner!, st.id, q, lastId(req), req.signal), { headers: sseHeaders });
});
// digging into one sentence of the story: is it true, the data behind it, who said it, explained, or a question about it
route("GET", "/api/stories/:id/dig", ({ req, url, owner, params }) => {
  const st = db.query("SELECT id FROM stories WHERE id = ? AND owner_id = ?").get(Number(params.id), owner) as any;
  if (!st) return err(404, "Story not found.");
  const k = url.searchParams.get("k") as DigKind, clean = (v: string | null, n: number) => (v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  const s = clean(url.searchParams.get("s"), 600), q = clean(url.searchParams.get("q"), 300);
  if (!DIG_KINDS.includes(k) || !s || (k === "ask" && !q)) return err(400, "Pick a sentence and what to look into.");
  return new Response(digStream(owner!, st.id, k, s, q, lastId(req), req.signal), { headers: sseHeaders });
});

caseRoutes(route, ORIGIN);
listenRoutes(route);

/* ---------- command line ---------- */
// `peppermint invite <name> [--admin]`, `peppermint reset-passkeys [name]`, `peppermint members`: the accounts module's
// commands against the live database. They print a link or a list and exit before any server or scheduler starts.
if (import.meta.main && process.argv.length > 2) {
  try {
    const out = await auth.accounts.cli(process.argv.slice(2));
    if (out != null) { console.log(`\n${out}\n`); process.exit(0); }
  } catch (e) { console.error((e as Error).message); process.exit(2); }
}

/* ---------- server ---------- */
const server = Bun.serve({
  port: PORT, hostname: process.env.HOST ?? "0.0.0.0", idleTimeout: 120,
  // The largest legitimate body is a new case: up to 4 photos, each capped at 4 MB in case-routes.ts, plus a note and
  // a few fields. Bun's default is 128 MB, which a stranger could make us buffer on any route.
  maxRequestBodySize: 4 * 4_000_000 + 1_000_000,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      const own = await auth.accounts.handle(req, auth.accounts.clientIp(req, srv.requestIP(req)?.address ?? "127.0.0.1"));
      if (own) return own;
      // mutating requests must come from our own origin: Origin, or Sec-Fetch-Site where a browser sends no Origin
      if (req.method !== "GET" && req.method !== "HEAD" && !auth.accounts.sameOrigin(req)) return err(403, "Cross-site request refused.");
      const who = await auth.accounts.principal(req);
      const reader = who?.kind === "browser" ? who.owner : null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname); if (!m) continue;
        // a paired phone reaches only the routes that name its scope (docs/android.md)
        const owner = reader ?? (r.scope && who?.kind === "device" && auth.accounts.can(who, r.scope) ? who.owner : null);
        if (!r.open && !owner) return err(401, "Sign in to continue.");
        // a stray % in the path is a bad request, not a crash
        const params: Record<string, string> = {};
        try { r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1])); } catch { return err(400, "Bad link."); }
        try { return await r.h({ req, url, owner, params }); } catch (e) { console.error(e); return err(500, "Something broke on the server. It is logged."); }
      }
      return err(404, "No such endpoint.");
    }
    // the natural voice's files (model, runtime, bundle), for signed-in devices only
    if (url.pathname.startsWith("/voice/") && req.method === "GET") {
      if (!(await auth.ownerFromRequest(req))) return new Response("Sign in to continue.", { status: 401 });
      return serveVoice(req, url.pathname.slice(7));
    }
    // the share sheet without a service worker yet (first visit): the link goes on, photos need the installed app
    if (url.pathname === "/share" && req.method === "POST") {
      // no session needed: a title, text and url, never files (the installed app's service worker takes those)
      let f: Record<string, any>; try { f = await readFields(req, 16 * 1024); } catch { return err(413, "Too large."); }
      const q = new URLSearchParams();
      for (const k of ["title", "text", "url"]) { const v = f[k]; if (typeof v === "string" && v) q.set(k, v.slice(0, 2000)); }
      return new Response(null, { status: 303, headers: { location: `/share?${q}` } });
    }
    // the writer's public page: open to anyone, outside the app
    if (url.pathname.startsWith("/@")) return servePublic(req, url, ORIGIN, await auth.ownerFromRequest(req));
    // the Android app's signing key, so Chrome shows peppermint full screen inside the app
    if (url.pathname === "/.well-known/assetlinks.json") return new Response(ASSETLINKS, { headers: { "content-type": "application/json" } });
    const a = assets.get(url.pathname);
    if (a) return serveAsset(req, a, url.pathname.startsWith("/assets/"));
    if (url.pathname === "/healthz") return new Response("ok");
    // app shell with the edition inlined so the first paint needs no second request
    const owner = await auth.ownerFromRequest(req);
    if (owner) adoptLang(owner, req.headers.get("accept-language"));
    const boot = JSON.stringify(bootData(owner)).replace(/</g, "\\u003c");
    return new Response(shell.replace("<!--BOOT-->", `<script type="application/json" id="boot">${boot}</script>`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...sec } });
  },
});

/* ---------- scheduler: pull due sources every minute, build the edition per slot ---------- */
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    for (const u of db.query("SELECT DISTINCT owner_id FROM sources WHERE enabled = 1").all() as { owner_id: number }[]) {
      await harvest(u.owner_id);
      // Claude orders the new candidates in the background; the edition follows its order once it has one
      if (judgeDue(u.owner_id)) judge(u.owner_id).then(ok => { if (ok) buildEdition(u.owner_id); }).catch(() => {});
      const ed = buildEdition(u.owner_id);
      warmBriefs(u.owner_id, editionStoryIds(ed.id)).catch(() => {});
      warmDiscussions(editionStoryIds(ed.id)).catch(() => {});
      queueImages(u.owner_id).catch(() => {});
      refreshBodies(u.owner_id).catch(() => {});
      agent.agentTick(u.owner_id).catch(() => {});
      // a failed attempt (Claude busy or limited) is tried again after half an hour, not every minute
      if (briefing.due(u.owner_id) && !composing && Date.now() - (briefTried.get(u.owner_id) ?? 0) > 30 * 60_000) { briefTried.set(u.owner_id, Date.now()); composing = true; morningBriefing(u.owner_id).catch(e => console.error("briefing", e)).finally(() => { composing = false; }); }
    }
    const b = backupIfDue(); if (b) { console.log("backup written:", b); pruneMedia(); }
  } catch (e) { console.error("tick", e); } finally { ticking = false; }
}
// investigations run on their own clock, so a slow harvest never holds up a waiting piece
let casesTicking = false;
async function casesTick() {
  if (casesTicking) return; casesTicking = true;
  try { await caseTick((db.query("SELECT DISTINCT owner_id FROM investigations WHERE status IN ('running','ready','quiet') UNION SELECT DISTINCT owner_id FROM drafts WHERE publish_at IS NOT NULL").all() as { owner_id: number }[]).map(r => r.owner_id), ORIGIN); }
  catch (e) { console.error("cases tick", e); } finally { casesTicking = false; }
}
if (process.env.PEPPERMINT_NO_SCHEDULER !== "1") { setTimeout(tick, 2000); setInterval(tick, 60_000); setTimeout(casesTick, 3000); setInterval(casesTick, 30_000); }

console.log(`peppermint on ${ORIGIN} (listening on :${server.port})${hasLLM() ? "" : " · no Claude (no ANTHROPIC_API_KEY, no claude CLI): local tagging, lenses off"}`);
if (!auth.accounts.hasPasskey()) console.log(`first run: create your passkey at ${ORIGIN}/setup#${auth.SETUP_TOKEN}`);
export { server, routes };
