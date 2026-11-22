// Shared helpers for connectors: polite fetch, RSS parsing, article extraction.
export type RawItem = {
  ext_id: string; url: string | null; title: string; author?: string | null; summary?: string | null;
  body?: string | null; lang?: string | null; published_at: number; meta?: Record<string, unknown>;
};

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const UA = "peppermint/1.0 (personal reader; +https://peppermint.kaleve.dev)";

/** Refuses anything that is not a public http(s) address, so a pasted link cannot make the server read its own network. */
export async function assertPublic(u: string) {
  const url = new URL(u);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https links work");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw new Error("that address is not public");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => { throw new Error(`no site answers at ${host}`); })).map(a => a.address);
  if (!addrs.length || addrs.some(privateIP)) throw new Error("that address is not public");
}
function privateIP(a: string) {
  if (a.includes(":")) { const l = a.toLowerCase(); return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || (l.startsWith("::ffff:") && privateIP(l.slice(7))); }
  const [x, y] = a.split(".").map(Number);
  return x === 10 || x === 127 || x === 0 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || x >= 224;
}

export async function get(url: string, { timeout = 10_000, headers = {} as Record<string, string>, maxBytes = 3_000_000, guard = false } = {}) {
  let res: Response, at = url;
  for (let hop = 0; ; hop++) {
    if (guard) await assertPublic(at);
    res = await fetch(at, { headers: { "user-agent": UA, accept: "*/*", ...headers }, signal: AbortSignal.timeout(timeout), redirect: guard ? "manual" : "follow" });
    const loc = res.headers.get("location");
    if (!guard || res.status < 300 || res.status >= 400 || res.status === 304 || !loc) break;
    if (hop >= 5) throw new Error("too many redirects");
    at = new URL(loc, at).href;
  }
  if (res.status === 304) return { status: 304, text: "", headers: res.headers, url: guard ? at : res.url };
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${at}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error(`too large: ${len} bytes`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`too large: ${buf.byteLength} bytes`);
  const type = res.headers.get("content-type") ?? "";
  const cs = /charset=([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
  let text: string;
  try { text = new TextDecoder(cs).decode(buf); } catch { text = new TextDecoder().decode(buf); }
  return { status: res.status, text, headers: res.headers, url: guard ? at : res.url };
}

/** The site of a link without "www.", or "" when it is no link. */
export const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = undefined; } }
  }));
  return out;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "…", laquo: "«", raquo: "»", bdquo: "„", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", shy: "", middot: "·", bull: "•", euro: "€", copy: "©", reg: "®", trade: "™", times: "×", deg: "°", sect: "§", para: "¶", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", eacute: "é", egrave: "è", agrave: "à", ccedil: "ç", iexcl: "¡", iquest: "¿", sbquo: "‚", lrm: "", rlm: "", zwj: "", zwnj: "", thinsp: " ", ensp: " ", emsp: " " };
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? m;
  });
}
export const stripTags = (s: string) => decode(s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "")).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!m) return null;
  const v = m[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  return cdata ? cdata[1] : decode(v);
}

export type FeedEntry = { title: string; link: string; guid: string; description: string; published: number; author: string | null; image: string | null;
  audio?: string | null; duration?: number | null; video?: string | null };
const attr = (tagText: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tagText)?.[1] ?? null;
/** itunes:duration comes as seconds or as h:mm:ss. */
const seconds = (d: string | null) => { if (!d) return null; const p = d.trim().split(":").map(Number); if (p.some(n => !Number.isFinite(n))) return null; return p.reduce((a, n) => a * 60 + n, 0) || null; };
/** A headline for text that has none (a toot, a post): the first line, else the first sentence, else a word-boundary cut. */
export function titleOf(text: string, max = 120): string {
  const line = text.split("\n").map(l => l.trim()).find(Boolean) ?? "";
  if (line.length <= max) return line;
  const sentence = /^[\s\S]{15,}?[.!?](?=\s|$)/.exec(line)?.[0];
  if (sentence && sentence.length <= max) return sentence;
  const cut = line.slice(0, max - 1), sp = cut.lastIndexOf(" ");
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, "") + "…";
}

/** untitled: derive a missing title from the description (Mastodon RSS carries none). */
export function parseFeed(xml: string, opts: { untitled?: boolean } = {}): { title: string; link: string; entries: FeedEntry[] } {
  if (/^\s*\{/.test(xml)) return parseJSONFeed(xml);
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const first = xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = first >= 0 ? xml.slice(0, first) : xml;
  const linkOf = (b: string) => isAtom ? (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? "") : (tag(b, "link") ?? "");
  const entries = blocks.map(b => {
    const date = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const t = date ? Date.parse(date) : NaN;
    // podcasts carry the episode as an audio enclosure, YouTube feeds the video id and a thumbnail
    const enclosures = (b.match(/<enclosure\b[^>]*>/gi) ?? []).map(e => ({ url: attr(e, "url"), type: attr(e, "type") ?? "" }));
    const audio = enclosures.find(e => e.url && (/^audio\//i.test(e.type) || /\.(mp3|m4a|aac|ogg|opus)(\?|$)/i.test(e.url)))?.url ?? null;
    const author = tag(b, "dc:creator") ?? tag(b, "itunes:author") ?? tag(b, "author");
    return {
      title: stripTags(tag(b, "title") ?? ""), link: linkOf(b).trim(), guid: (tag(b, "guid") ?? tag(b, "id") ?? linkOf(b)).trim(),
      description: stripTags(tag(b, "description") ?? tag(b, "summary") ?? tag(b, "content:encoded") ?? tag(b, "content") ?? tag(b, "media:description") ?? ""),
      published: Number.isFinite(t) ? t : Date.now(), author: author ? stripTags(tag(author, "name") ?? author) : null,
      image: /<media:content[^>]*url="([^"]+)"[^>]*medium="image/i.exec(b)?.[1] ?? /<media:thumbnail[^>]*url="([^"]+)"/i.exec(b)?.[1] ?? /<itunes:image[^>]*href="([^"]+)"/i.exec(b)?.[1]
        ?? enclosures.find(e => /^image\//i.test(e.type))?.url ?? /<media:content[^>]*url="([^"]+)"/i.exec(b)?.[1] ?? null,
      audio, duration: seconds(tag(b, "itunes:duration")), video: tag(b, "yt:videoId"),
    };
  }).map(e => ({ ...e, title: e.title || (opts.untitled ? titleOf(e.description) : ""), guid: e.guid || e.audio || "" })).filter(e => e.title && (e.link || e.audio)); // podcast episodes often have no page, only their audio
  return { title: stripTags(tag(head, "title") ?? ""), link: linkOf(head).trim(), entries };
}

// Article extraction with Bun's streaming HTMLRewriter. The text keeps the article's structure in a small markdown
// subset that the reader and Claude both read: "## " for headings, "- " for list items, **bold**, blank lines between
// blocks (list items of one list are joined by single newlines).
const BODY = ["p", "h2", "h3", "li", "blockquote"];
const DEFAULT_SELECTOR = ["article", "main", "[itemprop=articleBody]"].flatMap(c => BODY.map(t => `${c} ${t}`)).join(", ");
// promotion and housekeeping that sits inside article bodies
const BOILERPLATE = [
  /^(Lesen Sie auch|Auch interessant|Mehr zum Thema|Zum Weiterlesen|Weitere Artikel|Read more|Related( articles| posts)?)\b/i,
  /ohne Anspruch auf Vollständigkeit/i,
];
const isPromo = (t: string) => BOILERPLATE.some(r => r.test(t)) || (/newsletter/i.test(t) && /anmeld|abonn|registrier|USER\.ID|sign up|subscribe/i.test(t));

type Part = { k: "p" | "h" | "sub" | "li" | "quote"; t: string; link: number };
/** Bold markers that survive whitespace and empty tags: "** Antik **" becomes "**Antik**", unbalanced ones go. */
function tidy(raw: string): string {
  let t = decode(decode(raw)).replace(/\s+/g, " ");
  t = t.replace(/\*\*([^*]*)\*\*/g, (_, x: string) => { const v = x.trim(); return v ? `${/^\s/.test(x) ? " " : ""}**${v}**${/\s$/.test(x) ? " " : ""}` : " "; });
  if ((t.match(/\*\*/g)?.length ?? 0) % 2) t = t.replace(/\*\*/g, "");
  return t.replace(/\*\*\s*\*\*/g, " ").replace(/\s+/g, " ").trim();
}
const plain = (t: string) => t.replace(/\*\*/g, "");

function serialize(parts: Part[]): string {
  const kept: Part[] = [];
  for (const p of parts) {
    const len = plain(p.t).length;
    if (len < 2 || isPromo(plain(p.t))) continue;
    // a list item that is nothing but a link is a "related articles" list
    if (p.k === "li" && p.link >= len * 0.8) continue;
    // a short paragraph that is all bold is a subheading ("Freitag, 20. November")
    if (p.k === "p" && /^\*\*[^*]+\*\*$/.test(p.t) && len <= 90) { kept.push({ ...p, k: "sub", t: plain(p.t) }); continue; }
    if (p.k === "h") { kept.push({ ...p, t: plain(p.t) }); continue; }
    if (p.k === "p" && kept.some(x => x.k === "p" && x.t === p.t)) continue;
    kept.push(p);
  }
  // headings with nothing under them (their section was all promotion) go too
  const out = kept.filter((p, i) => !(p.k === "h" || p.k === "sub") || (i + 1 < kept.length && kept[i + 1].k !== "h" && !(p.k === "sub" && kept[i + 1].k === "sub")));
  return out.map((p, i) => {
    const line = p.k === "h" ? `## ${p.t}` : p.k === "sub" ? `### ${p.t}` : p.k === "li" ? `- ${p.t}` : p.k === "quote" ? `> ${p.t}` : p.t;
    return (i === 0 ? "" : out[i - 1].k === "li" && p.k === "li" ? "\n" : "\n\n") + line;
  }).join("");
}

export type Figure = { src: string; caption: string };
/** The best candidate from a srcset: the widest entry. */
const widest = (set: string | null) => set?.split(",").map(x => x.trim().split(/\s+/)).filter(x => x[0]).sort((a, b) => (parseInt(b[1] ?? "0") || 0) - (parseInt(a[1] ?? "0") || 0))[0]?.[0] ?? null;
const NOT_A_FIGURE = /logo|icon|avatar|sprite|badge|emoji|pixel|tracking|spacer|placeholder|\.svg(\?|$)|^data:/i;

export async function extract(html: string, opts: { paragraphSelector?: string; base?: string } = {}): Promise<{ text: string; lang: string | null; description: string | null; image: string | null; credit: string | null; figures: Figure[] }> {
  let lang: string | null = null, description: string | null = null, image: string | null = null;
  const captions: string[] = []; let cap: string[] | null = null;
  // the article's own pictures (figures with their captions, and large inline images with alt text): the story video
  // shows the one whose caption fits a scene
  const figs: { src: string; caption: string }[] = []; let fig: { src: string | null; cap: string[]; alt: string } | null = null;
  const imgSrc = (e: Element) => e.getAttribute("data-src") || widest(e.getAttribute("data-srcset")) || widest(e.getAttribute("srcset")) || e.getAttribute("src");
  const tooSmall = (e: Element) => { const w = Number(e.getAttribute("width")), h = Number(e.getAttribute("height")); return (w > 0 && w < 300) || (h > 0 && h < 160); };
  const parts: Part[] = []; let cur: string[] | null = null; let depthSkip = 0, linkChars = 0;
  // HTML may leave out </p> and </li> (minified pages do), and HTMLRewriter does not close them for us: the part
  // that is open ends where the next block starts, a list item where its next sibling item or its list does
  let open: { tag: string; list: number; end: () => void } | null = null, lists = 0;
  const closeOpen = () => open?.end();
  const sel = opts.paragraphSelector ?? DEFAULT_SELECTOR;
  const rw = new HTMLRewriter()
    .on("html", { element(e) { lang = e.getAttribute("lang")?.slice(0, 2).toLowerCase() ?? null; } })
    .on('meta[name="description"], meta[property="og:description"]', { element(e) { const c = e.getAttribute("content"); if (c && (!description || c.length > description.length)) description = decode(decode(c)).replace(/\s+/g, " ").trim(); } })
    // the share picture the page names for itself, and the first photo credit in a caption
    .on('meta[property="og:image"], meta[property="og:image:url"], meta[name="twitter:image"], meta[property="twitter:image"]', { element(e) { const c = e.getAttribute("content"); if (c && !image) image = decode(c).trim(); } })
    .on("figcaption", { element(e) { if (captions.length > 2) return; cap = []; const mine = cap; e.onEndTag(() => { captions.push(decode(decode(mine.join(""))).replace(/\s+/g, " ").trim()); cap = null; }); }, text(t) { cap?.push(t.text); fig?.cap.push(t.text); } })
    // a figure's text stays out of the article body; an element takes only one end handler, so both jobs share it
    .on("figure", { element(e) {
      depthSkip++;
      const f = figs.length < 8 ? { src: null as string | null, cap: [] as string[], alt: "" } : null; if (f) fig = f;
      e.onEndTag(() => {
        depthSkip--;
        if (f?.src) figs.push({ src: f.src, caption: decode(decode(f.cap.join(""))).replace(/\s+/g, " ").trim() || f.alt });
        if (f && fig === f) fig = null;
      });
    } })
    .on("figure img, figure source", { element(e) { if (!fig || fig.src || tooSmall(e)) return; const s = imgSrc(e); if (s && !NOT_A_FIGURE.test(s)) { fig.src = s; fig.alt = decode(e.getAttribute("alt") ?? "").trim(); } } })
    .on("article img, main img, [itemprop=articleBody] img", { element(e) {
      // a large picture in the text without a figure around it counts when it says what it shows
      if (fig || figs.length >= 8 || tooSmall(e)) return;
      const s = imgSrc(e), alt = decode(e.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim();
      if (s && alt.length >= 12 && !NOT_A_FIGURE.test(s)) figs.push({ src: s, caption: alt });
    } })
    .on("script, style, noscript, aside, nav, footer, form, button", { element(e) { depthSkip++; e.onEndTag(() => { depthSkip--; }); } })
    .on("ul, ol", { element(e) {
      if (open?.tag === "p") closeOpen();
      const depth = ++lists;
      e.onEndTag(() => { if (open?.tag === "li" && open.list === depth) closeOpen(); lists--; });
    } })
    .on("pre, table, div, section, hr, h1, h2, h3, h4, h5, h6, blockquote, figure", { element() { if (open?.tag === "p") closeOpen(); } })
    .on(sel, {
      element(e) {
        if (depthSkip) return;
        const tag = e.tagName.toLowerCase();
        // a new paragraph or a sibling list item ends an open one whose end tag was left out
        if (open && (open.tag === "p" || (open.tag === "li" && tag === "li" && open.list === lists))) closeOpen();
        // a match inside a match (a paragraph inside a list item) belongs to the outer one, as words of its own
        if (cur) { cur.push(" "); return; }
        const k: Part["k"] = /^h[1-6]$/.test(tag) ? "h" : tag === "li" ? "li" : tag === "blockquote" ? "quote" : "p";
        cur = []; linkChars = 0; const mine = cur;
        const end = () => { if (cur !== mine) return; parts.push({ k, t: tidy(mine.join("")), link: linkChars }); cur = null; open = null; };
        open = { tag, list: lists, end };
        e.onEndTag(end);
      },
      text(t) { if (cur && !depthSkip) cur.push(t.text); },
    })
    .on("strong, b", { element(e) { if (!cur || depthSkip) return; const mine = cur; mine.push("**"); e.onEndTag(() => { if (cur === mine) mine.push("**"); }); } })
    .on("a", { text(t) { if (cur && !depthSkip) linkChars += t.text.replace(/\s+/g, " ").length; } })
    .on("br", { element() { if (cur && !depthSkip) cur.push(" "); } });
  await rw.transform(new Response(html)).text();
  let out = serialize(parts);
  if (plain(out).length < 300 && !opts.paragraphSelector) {
    // fallback: every long paragraph on the page
    const all: string[] = []; let c: string[] | null = null;
    await new HTMLRewriter().on("p", { element(e) { c = []; const m = c; e.onEndTag(() => { const t = decode(decode(m.join(""))).replace(/\s+/g, " ").trim(); if (t.length > 80 && !isPromo(t)) all.push(t); }); }, text(t) { if (c) c.push(t.text); } })
      .transform(new Response(html)).text();
    const flat = all.filter((p, i) => all.indexOf(p) === i).join("\n\n");
    if (flat.length > plain(out).length) out = flat;
  }
  let img: string | null = null;
  try { if (image) { const u = new URL(image, opts.base); if (u.protocol === "https:") img = u.href; } } catch {}
  const figures: Figure[] = [];
  for (const f of figs) {
    try { const u = new URL(f.src, opts.base); if (u.protocol === "https:" && !figures.some(x => x.src === u.href)) figures.push({ src: u.href, caption: f.caption.slice(0, 240) }); } catch {}
  }
  const credit = captions.map(c => /(?:©|\(c\)|Foto:|Photo:|Bild:|Image:)\s*(.{2,80})$/i.exec(c)?.[0]).find(Boolean) ?? null;
  return { text: out.slice(0, 40_000), lang, description: description && description.length > 30 ? description.slice(0, 500) : null, image: img, credit: credit?.replace(/^\(c\)/i, "©").trim() ?? null, figures: figures.slice(0, 8) };
}

/** JSON Feed 1.x (jsonfeed.org). */
function parseJSONFeed(text: string): { title: string; link: string; entries: FeedEntry[] } {
  let f: any; try { f = JSON.parse(text); } catch { return { title: "", link: "", entries: [] }; }
  const entries = (Array.isArray(f.items) ? f.items : []).map((it: any) => {
    const t = Date.parse(it.date_published ?? it.date_modified ?? "");
    const link = String(it.url ?? it.external_url ?? "");
    return {
      title: stripTags(String(it.title ?? "")) || stripTags(String(it.content_html ?? it.content_text ?? "")).slice(0, 90),
      link, guid: String(it.id ?? link), description: stripTags(String(it.summary ?? it.content_html ?? it.content_text ?? "")),
      published: Number.isFinite(t) ? t : Date.now(), author: it.authors?.[0]?.name ?? it.author?.name ?? null, image: it.image ?? it.banner_image ?? null,
    } satisfies FeedEntry;
  }).filter((e: FeedEntry) => e.title && e.link);
  return { title: String(f.title ?? ""), link: String(f.home_page_url ?? ""), entries };
}

/** Feed links a page announces in its head, resolved against the page URL. */
export function feedLinks(html: string, base: string): { url: string; title: string }[] {
  const out: { url: string; title: string }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0], attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']*)["']`, "i").exec(t)?.[1];
    if (!/alternate/i.test(attr("rel") ?? "")) continue;
    if (!/application\/(rss|atom|feed)\+(xml|json)|application\/json/i.test(attr("type") ?? "")) continue;
    const href = attr("href"); if (!href) continue;
    try { out.push({ url: new URL(decode(href), base).href, title: decode(attr("title") ?? "") }); } catch {}
  }
  return out.filter((f, i) => out.findIndex(x => x.url === f.url) === i);
}

export type FeedCursor = { etag?: Record<string, string>; seen?: string[] };
/** New entries across a source's feeds, with conditional requests; the first pull takes the newest 15 only, so an archive does not flood the palate. */
/** maxBytes: a podcast feed carries its whole back catalogue (Doppelgänger's is 5 MB), an article feed stays small. */
export async function freshEntries(feeds: string[], cursor: FeedCursor, opts: { untitled?: boolean; maxBytes?: number } = {}) {
  const etag = { ...(cursor.etag ?? {}) }; const seen = new Set(cursor.seen ?? []);
  const entries: FeedEntry[] = [];
  for (const u of feeds) {
    const r = await get(u, { guard: true, timeout: opts.maxBytes ? 30_000 : 10_000, maxBytes: opts.maxBytes, headers: etag[u] ? { "if-none-match": etag[u] } : {} });
    if (r.status === 304) continue;
    const e = r.headers.get("etag"); if (e) etag[u] = e;
    entries.push(...parseFeed(r.text, opts).entries);
  }
  const fresh = entries.filter((e, i) => !seen.has(e.guid) && entries.findIndex(x => x.guid === e.guid) === i)
    .sort((a, b) => b.published - a.published).slice(0, cursor.seen ? 60 : 15);
  entries.forEach(e => seen.add(e.guid));
  return { fresh, next: { etag, seen: [...seen].slice(-3000) } };
}
