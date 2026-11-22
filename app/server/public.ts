// The writer's public page: everything under /@handle is open to anyone (Cloudflare Access lets "@" through), the
// rest of peppermint stays private. A piece shows its sources at the end, its corrections and updates in the open,
// and a box for readers who know more. Pages are plain HTML with inline CSS; one small script counts finished reads
// and sends tips without leaving the page. Nothing here reads the session: an owner's own visits are not counted.
import { db, json, now } from "./db";
import { profile, subscriberCount } from "./desk";
import { send, validAddress } from "./mail";
import type { Block, DraftMeta, Profile } from "../shared/types";

const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const html = (body: string, status = 200, extra: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin", "cache-control": "no-cache", ...extra } });
const J = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const ownerOf = (handle: string) => (db.query("SELECT owner_id FROM settings WHERE key = 'profile' AND json_extract(value, '$.handle') = ?").get(handle.toLowerCase()) as { owner_id: number } | null)?.owner_id ?? null;
type Piece = { id: number; owner_id: number; title: string; blocks: Block[]; meta: DraftMeta; slug: string; status: string; published_at: number | null; investigation_id: number | null; updated_at: number };
const piece = (r: any): Piece | null => r && { ...r, blocks: json<Block[]>(r.blocks, []), meta: json<DraftMeta>(r.meta, {}) };

const T = {
  de: { sources: "Quellen", own: "Selbst gesehen", corrections: "Korrekturen und Nachträge", correction: "Korrektur", update: "Nachtrag", know: "Weißt du mehr?", knowSub: "Ein Hinweis, eine Ergänzung oder ein Fehler: es liest nur die Autorin oder der Autor.",
    tip: "Hinweis", fix: "Fehler", send: "Senden", contact: "Wie erreiche ich dich? (freiwillig)", thanks: "Danke, ist angekommen.", follow: "Neue Texte per E-Mail", followBtn: "Folgen", mail: "deine@adresse.de",
    imprint: "Impressum", more: "Mehr von", reply: "Antwort per E-Mail", firsthand: "Eigene Beobachtung vor Ort", share: "Teilen", copied: "Link kopiert", min: "Min. Lesezeit", preview: "Vorschau, noch nicht veröffentlicht", gone: "Dieser Text ist nicht mehr online." },
  en: { sources: "Sources", own: "Seen first-hand", corrections: "Corrections and updates", correction: "Correction", update: "Update", know: "Do you know more?", knowSub: "A tip, an addition or a mistake: only the writer reads it.",
    tip: "Tip", fix: "Mistake", send: "Send", contact: "How can I reach you? (optional)", thanks: "Thank you, it arrived.", follow: "New pieces by email", followBtn: "Follow", mail: "you@example.com",
    imprint: "Imprint", more: "More by", reply: "Answer by email", firsthand: "Seen on the spot", share: "Share", copied: "Link copied", min: "min read", preview: "Preview, not published yet", gone: "This piece is no longer online." },
};
const dateFmt = (t: number, lang: "de" | "en") => new Date(t).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Berlin" });

const STYLE = `<style>
:root{--bg:#f6fbf7;--paper:#ffffff;--ink:#14261b;--muted:#5a7363;--rule:#d5e9db;--mint:#12804c;--mint-soft:#dff4e7;--warn:#a8690a;--serif:"Iowan Old Style","Charter","Source Serif Pro",Georgia,serif;--sans:ui-rounded,"SF Pro Rounded",system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#071a10;--paper:#0d2618;--ink:#e2f6e9;--muted:#93b8a0;--rule:#1d4029;--mint:#5fe39b;--mint-soft:#134a2c;--warn:#f0b04a;color-scheme:dark}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;background:var(--bg);color:var(--ink);font:19px/1.62 var(--serif);overflow-wrap:break-word}
a{color:var(--mint)}.wrap{max-width:680px;margin:0 auto;padding:28px max(20px,env(safe-area-inset-left)) 64px max(20px,env(safe-area-inset-right))}
.top{display:flex;align-items:center;gap:10px;font:700 14px var(--sans);color:var(--muted);text-decoration:none}.top b{color:var(--ink)}.dot{width:26px;height:26px;border-radius:50%;background:var(--mint);display:grid;place-items:center;color:var(--paper);font:800 13px var(--sans)}
.kicker{margin:34px 0 10px;font:750 12.5px var(--sans);letter-spacing:.08em;text-transform:uppercase;color:var(--mint)}
h1{font:850 clamp(32px,7vw,46px)/1.06 var(--sans);letter-spacing:-.025em;margin:0 0 16px;text-wrap:balance}
.by{font:500 15px/1.5 var(--sans);color:var(--muted);display:flex;flex-wrap:wrap;gap:4px 14px;margin-bottom:26px}.by b{color:var(--ink);font-weight:700}
figure{margin:0 calc(-1*min(40px,4vw)) 30px}figure img{display:block;width:100%;height:auto;border-radius:18px;background:var(--rule)}figcaption{font:13.5px/1.45 var(--sans);color:var(--muted);margin:9px min(40px,4vw) 0}
.body p{margin:0 0 1.05em}.body h2{font:800 24px/1.2 var(--sans);margin:1.6em 0 .5em}sup a{font:700 11px var(--sans);text-decoration:none;padding:0 2px;border-radius:4px;background:var(--mint-soft)}
.body p:first-child::first-letter{font:850 3.3em/.8 var(--sans);float:left;margin:.08em .08em 0 0;color:var(--mint)}
section{margin-top:44px;padding-top:22px;border-top:1px solid var(--rule)}section h3{font:800 13px var(--sans);letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
ol.src{padding-left:22px;font:15px/1.5 var(--sans);margin:0}ol.src li{margin:0 0 8px}ol.src li span{color:var(--muted)}ol.src li:target{background:var(--mint-soft);border-radius:6px}
.fix{font:15px/1.5 var(--sans);margin:0 0 8px}.fix b{color:var(--warn)}.fix time{color:var(--muted)}
.box{background:var(--paper);border:1px solid var(--rule);border-radius:20px;padding:20px 20px 18px;margin-top:44px;font:15.5px/1.5 var(--sans)}.box h3{font:800 20px var(--sans);margin:0 0 4px;text-transform:none;letter-spacing:-.01em;color:var(--ink)}.box p{margin:0 0 14px;color:var(--muted)}
.seg{display:inline-flex;background:var(--bg);border:1px solid var(--rule);border-radius:12px;padding:3px;gap:2px;margin-bottom:10px}.seg label{padding:6px 14px;border-radius:9px;cursor:pointer;font-weight:700;font-size:14px}.seg input{position:absolute;opacity:0;pointer-events:none}.seg label:has(input:checked){background:var(--paper);box-shadow:0 1px 3px rgb(0 0 0/.12);color:var(--mint)}
textarea,input[type=email],input[type=text]{width:100%;font:16px var(--sans);color:var(--ink);background:var(--bg);border:1px solid var(--rule);border-radius:12px;padding:11px 12px;margin:0 0 10px}textarea{min-height:96px;resize:vertical}
button{font:750 15px var(--sans);border:0;border-radius:12px;background:var(--mint);color:var(--paper);min-height:42px;padding:0 18px;cursor:pointer}button.ghost{background:transparent;color:var(--ink);border:1px solid var(--rule)}
.row{display:flex;gap:8px}.row input{margin:0}.ok{color:var(--mint);font-weight:700}.hidden{display:none}
.list{list-style:none;padding:0;margin:26px 0 0}.list li{padding:18px 0;border-bottom:1px solid var(--rule)}.list a{font:800 23px/1.2 var(--sans);text-decoration:none;color:var(--ink)}.list p{margin:6px 0 0;font:15px/1.5 var(--sans);color:var(--muted)}
.banner{background:var(--mint-soft);color:var(--ink);font:700 14px var(--sans);padding:10px 14px;border-radius:12px;margin-top:18px}
footer{margin-top:52px;font:13px var(--sans);color:var(--muted);display:flex;gap:16px;flex-wrap:wrap}footer a{color:var(--muted)}
:focus-visible{outline:2.5px solid var(--mint);outline-offset:2px;border-radius:6px}
</style>`;
const head = (title: string, desc: string, extra = "") => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}">${extra}${STYLE}</head><body>`;
const initials = (n: string) => n.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "·";
const top = (p: Profile) => `<a class="top" href="/@${esc(p.handle)}"><span class="dot">${esc(initials(p.name))}</span><b>${esc(p.name)}</b></a>`;
const foot = (p: Profile, lang: "de" | "en") => `<footer><a href="/@${esc(p.handle)}/impressum">${T[lang].imprint}</a><a href="/@${esc(p.handle)}/feed.xml">RSS</a><span>peppermint</span></footer>`;

/** Sources, numbered in the order the text first cites them; the writer's own observations collapse into one entry. */
function sourcesOf(p: Piece) {
  const ids = [...new Set(p.blocks.flatMap(b => b.ev ?? []))];
  if (!ids.length) return { list: [] as { n: number; html: string }[], num: new Map<number, number>() };
  const rows = db.query(`SELECT id, kind, title, site, url, at FROM evidence WHERE id IN (${ids.map(() => "?").join(",")}) AND owner_id = ?`).all(...ids, p.owner_id) as any[];
  const by = new Map(rows.map(r => [r.id, r]));
  const lang = p.meta.lang === "en" ? "en" : "de";
  const num = new Map<number, number>(); const list: { n: number; html: string }[] = []; let own = 0;
  for (const id of ids) {
    const r = by.get(id); if (!r) continue;
    if (["photo", "note", "answer"].includes(r.kind)) { if (!own) { own = list.length + 1; list.push({ n: own, html: `${T[lang].firsthand}` }); } num.set(id, own); continue; }
    const n = list.length + 1; num.set(id, n);
    const label = r.kind === "reply" ? `${esc(r.site)}: ${T[lang].reply}` : `${esc(r.site)}${r.site ? ": " : ""}${r.url ? `<a href="${esc(r.url)}" rel="noopener nofollow">${esc(r.title)}</a>` : esc(r.title)}`;
    list.push({ n, html: `${label}${r.at ? ` <span>· ${dateFmt(r.at, lang)}</span>` : ""}` });
  }
  return { list, num };
}
function body(p: Piece, num: Map<number, number>) {
  return p.blocks.filter(b => b.type !== "h" || b !== p.blocks[0]).filter(b => b.text.trim() && b.type !== "c" && b.type !== "chart").map(b => {
    if (b.type === "h") return `<h2>${esc(b.text)}</h2>`;
    const refs = [...new Set((b.ev ?? []).map(e => num.get(e)).filter((n): n is number => !!n))].sort((a, z) => a - z);
    const text = b.type === "q" ? `„${esc(b.text)}“${b.cite ? ` (${esc(b.cite.source)})` : ""}` : esc(b.text);
    return `<p>${text}${refs.map(n => `<sup><a href="#s${n}">${n}</a></sup>`).join("")}</p>`;
  }).join("\n");
}
function photoOf(p: Piece) {
  if (!p.meta.photo) return null;
  return db.query("SELECT id, w, h, alt, caption FROM photos WHERE id = ? AND owner_id = ? AND public_bytes IS NOT NULL").get(p.meta.photo, p.owner_id) as { id: number; w: number; h: number; alt: string; caption: string } | null;
}

export function article(p: Piece, prof: Profile, origin: string, { preview = false } = {}) {
  const lang = p.meta.lang === "en" ? "en" : "de", t = T[lang];
  const { list, num } = sourcesOf(p);
  const ph = photoOf(p);
  const paras = p.blocks.filter(b => b.type === "p");
  const mins = Math.max(1, Math.round(paras.reduce((n, b) => n + b.text.split(/\s+/).length, 0) / 220));
  const fixes = db.query("SELECT kind, text, created_at FROM corrections WHERE draft_id = ? ORDER BY id").all(p.id) as { kind: string; text: string; created_at: number }[];
  const place = p.investigation_id ? json<any>((db.query("SELECT place FROM investigations WHERE id = ?").get(p.investigation_id) as { place: string } | null)?.place, {}).name ?? "" : "";
  const url = `${origin}/@${prof.handle}/${p.slug}`;
  const desc = paras[0]?.text.slice(0, 180) ?? "";
  const og = `<link rel="canonical" href="${esc(url)}"><meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:type" content="article">${ph ? `<meta property="og:image" content="${esc(`${origin}/@${prof.handle}/photo/${ph.id}`)}">` : ""}<link rel="alternate" type="application/rss+xml" href="/@${esc(prof.handle)}/feed.xml">${preview ? `<meta name="robots" content="noindex">` : ""}`;
  return head(`${p.title} · ${prof.name}`, desc, og) + `<main class="wrap" data-piece="${p.id}" data-handle="${esc(prof.handle)}" data-slug="${esc(p.slug)}">
${top(prof)}${preview ? `<div class="banner">${t.preview}</div>` : ""}
<p class="kicker">${esc(place || t.own)}</p>
<h1>${esc(p.title)}</h1>
<div class="by"><span><b>${esc(prof.name)}</b></span><span>${p.published_at ? dateFmt(p.published_at, lang) : ""}</span><span>${mins} ${t.min}</span></div>
${ph ? `<figure><img src="/@${esc(prof.handle)}/photo/${ph.id}" width="${ph.w}" height="${ph.h}" alt="${esc(ph.alt)}">${ph.caption ? `<figcaption>${esc(ph.caption)}</figcaption>` : ""}</figure>` : ""}
<article class="body">${body(p, num)}</article>
<div class="row" id="end"><button class="ghost" type="button" id="share" data-copied="${t.copied}">${t.share}</button></div>
${list.length ? `<section><h3>${t.sources}</h3><ol class="src">${list.map(s => `<li id="s${s.n}">${s.html}</li>`).join("")}</ol></section>` : ""}
${fixes.length ? `<section><h3>${t.corrections}</h3>${fixes.map(f => `<p class="fix"><b>${f.kind === "update" ? t.update : t.correction}</b> <time>${dateFmt(f.created_at, lang)}</time>: ${esc(f.text)}</p>`).join("")}</section>` : ""}
${preview ? "" : `<form class="box" id="tip" method="post" action="/@${esc(prof.handle)}/${esc(p.slug)}/tip"><h3>${t.know}</h3><p>${t.knowSub}</p>
<div class="seg" role="radiogroup"><label><input type="radio" name="kind" value="tip" checked>${t.tip}</label><label><input type="radio" name="kind" value="fix">${t.fix}</label></div>
<textarea name="text" required maxlength="3000" aria-label="${t.know}"></textarea><input type="text" name="contact" maxlength="200" placeholder="${t.contact}" aria-label="${t.contact}">
<button type="submit">${t.send}</button><p class="ok hidden" role="status">${t.thanks}</p></form>
<form class="box" id="follow" method="post" action="/@${esc(prof.handle)}/subscribe"><h3>${t.follow}</h3><p>${esc(prof.bio || `${t.more} ${prof.name}`)}</p>
<div class="row"><input type="email" name="email" required placeholder="${t.mail}" aria-label="${t.mail}"><button type="submit">${t.followBtn}</button></div><p class="ok hidden" role="status"></p></form>`}
${foot(prof, lang)}</main><script src="/@/pub.js" defer></script></body></html>`;
}

const PUB_JS = `(()=>{const m=document.querySelector("main[data-piece]");if(!m)return;const base="/@"+m.dataset.handle+"/"+m.dataset.slug;
const beacon=e=>{try{navigator.sendBeacon(base+"/beacon",new Blob([JSON.stringify({e})],{type:"application/json"}))}catch(_){}};
const end=document.getElementById("end");if(end&&"IntersectionObserver"in window){let t=0;const io=new IntersectionObserver(es=>{if(es.some(x=>x.isIntersecting)&&performance.now()>15000){beacon("finish");io.disconnect()}else if(es.some(x=>x.isIntersecting)&&!t){t=setTimeout(()=>{beacon("finish");io.disconnect()},15000-performance.now())}});io.observe(end)}
const sh=document.getElementById("share");if(sh)sh.addEventListener("click",async()=>{beacon("share");const u=location.href.split("#")[0];if(navigator.share){try{await navigator.share({title:document.title,url:u})}catch(_){}}else{try{await navigator.clipboard.writeText(u);sh.textContent=sh.dataset.copied}catch(_){}}});
for(const f of document.querySelectorAll("form.box"))f.addEventListener("submit",async ev=>{ev.preventDefault();const b=f.querySelector("button[type=submit]");b.disabled=true;const d=Object.fromEntries(new FormData(f));
try{const r=await fetch(f.action,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(d)});const j=await r.json().catch(()=>({}));const ok=f.querySelector(".ok");if(j.message)ok.textContent=j.message;ok.classList.remove("hidden");if(r.ok)f.reset()}catch(_){}b.disabled=false})})();`;

function authorPage(owner: number, prof: Profile) {
  const rows = (db.query("SELECT * FROM drafts WHERE owner_id = ? AND status = 'published' AND slug IS NOT NULL ORDER BY published_at DESC LIMIT 100").all(owner) as any[]).map(piece) as Piece[];
  return head(prof.name, prof.bio, `<link rel="alternate" type="application/rss+xml" href="/@${esc(prof.handle)}/feed.xml">`) + `<main class="wrap">${top(prof)}
<p class="kicker">peppermint</p><h1>${esc(prof.name)}</h1>${prof.bio ? `<p>${esc(prof.bio)}</p>` : ""}
<ul class="list">${rows.map(r => `<li><a href="/@${esc(prof.handle)}/${esc(r.slug)}">${esc(r.title)}</a><p>${r.published_at ? dateFmt(r.published_at, r.meta.lang === "en" ? "en" : "de") : ""} · ${esc((r.blocks.find(b => b.type === "p")?.text ?? "").slice(0, 160))}…</p></li>`).join("")}</ul>
<form class="box" id="follow" method="post" action="/@${esc(prof.handle)}/subscribe"><h3>${T.de.follow}</h3><p>${subscriberCount(owner) ? `${subscriberCount(owner)} lesen schon mit.` : "Sei die oder der Erste."}</p><div class="row"><input type="email" name="email" required placeholder="${T.de.mail}" aria-label="E-Mail"><button type="submit">${T.de.followBtn}</button></div><p class="ok hidden" role="status"></p></form>
${foot(prof, "de")}</main><script src="/@/pub.js" defer></script></body></html>`;
}
function feed(owner: number, prof: Profile, origin: string) {
  const x = (s: string) => esc(s);
  const rows = (db.query("SELECT * FROM drafts WHERE owner_id = ? AND status = 'published' AND slug IS NOT NULL ORDER BY published_at DESC LIMIT 30").all(owner) as any[]).map(piece) as Piece[];
  const items = rows.map(r => { const u = `${origin}/@${prof.handle}/${r.slug}`; return `<item><title>${x(r.title)}</title><link>${x(u)}</link><guid>${x(u)}</guid><pubDate>${new Date(r.published_at ?? r.updated_at).toUTCString()}</pubDate><description>${x(r.blocks.filter(b => b.type === "p").map(b => b.text).join("\n\n"))}</description></item>`; }).join("");
  return new Response(`<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>${x(prof.name)}</title><link>${x(`${origin}/@${prof.handle}`)}</link><description>${x(prof.bio || prof.name)}</description>${items}</channel></rss>`,
    { headers: { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "no-cache" } });
}
const message = (title: string, text: string, prof: Profile | null) => head(title, text) + `<main class="wrap">${prof ? top(prof) : ""}<h1 class="kicker">${esc(title)}</h1><p>${esc(text)}</p>${prof ? foot(prof, "de") : ""}</main></body></html>`;

/* ---------- reader input: tips and subscriptions, a few per hour per address ---------- */
const hits = new Map<string, number[]>();
function limited(req: Request, key: string, max = 5) {
  const ip = req.headers.get("cf-connecting-ip") ?? req.headers.get("x-real-ip") ?? "local";
  const k = `${key}:${ip}`, t = now();
  const h = (hits.get(k) ?? []).filter(x => t - x < 3600_000);
  if (h.length >= max) return true;
  h.push(t); hits.set(k, h);
  if (hits.size > 5000) hits.clear();
  return false;
}
async function form(req: Request) {
  const ct = req.headers.get("content-type") ?? "";
  try { return ct.includes("json") ? await req.json() as any : Object.fromEntries(await req.formData()); } catch { return {}; }
}
const isBot = (req: Request) => /bot|crawl|spider|preview|fetch|curl|wget|slurp|facebookexternalhit/i.test(req.headers.get("user-agent") ?? "");
function count(id: number, col: "reads" | "finishes" | "shares") {
  const day = new Date().toISOString().slice(0, 10);
  db.query(`INSERT INTO page_stats (draft_id, day, ${col}) VALUES (?, ?, 1) ON CONFLICT(draft_id, day) DO UPDATE SET ${col} = ${col} + 1`).run(id, day);
}

/** Everything under /@, and nothing else answers there: Cloudflare Access lets /@* through without a login, so an
 *  unknown path is a 404 here, never the app. */
export async function servePublic(req: Request, url: URL, origin: string, viewer: number | null): Promise<Response> {
  const parts = url.pathname.slice(2).split("/").map(decodeURIComponent);
  if (parts[0] === "" && parts[1] === "pub.js") return new Response(PUB_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" } });
  const owner = ownerOf(parts[0] ?? "");
  if (!owner) return html(message("Nicht gefunden", "Diese Seite gibt es nicht.", null), 404);
  const prof = profile(owner);
  const [, a, b] = parts;
  // a POST from a page of ours: the browser says where it came from
  if (req.method === "POST") {
    const o = req.headers.get("origin"); if (o && o !== origin) return J({ message: "Refused." }, 403);
    if (a === "subscribe") {
      if (limited(req, "sub", 5)) return J({ message: "Zu viele Versuche. Bitte später noch einmal." }, 429);
      const f = await form(req); const email = String(f.email ?? "").trim().toLowerCase().slice(0, 200);
      if (!validAddress(email)) return J({ message: "Diese Adresse sieht nicht richtig aus." }, 400);
      const token = crypto.randomUUID().replace(/-/g, "");
      const row = db.query("INSERT INTO subscribers (owner_id, email, token, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner_id, email) DO UPDATE SET token = CASE WHEN confirmed_at IS NULL THEN excluded.token ELSE token END RETURNING token, confirmed_at").get(owner, email, token, now()) as { token: string; confirmed_at: number | null };
      if (!row.confirmed_at && process.env.PEPPERMINT_NO_MAIL !== "1") {
        const link = `${origin}/@${prof.handle}/confirm/${row.token}`;
        const from = process.env.PEPPERMINT_MAIL_FROM ?? `peppermint@${new URL(origin).hostname.split(".").slice(-2).join(".")}`;
        send({ from, to: email, subject: `Bitte bestätigen: ${prof.name}`, text: `Du möchtest neue Texte von ${prof.name} per E-Mail bekommen. Bestätige es hier:\n${link}\n\nWenn du das nicht warst, ignoriere diese E-Mail.`,
          html: `<p style="font:16px/1.5 system-ui,sans-serif">Du möchtest neue Texte von <b>${esc(prof.name)}</b> per E-Mail bekommen.</p><p><a href="${esc(link)}" style="font:700 15px system-ui,sans-serif;background:#12804c;color:#fff;padding:10px 16px;border-radius:12px;text-decoration:none">Bestätigen</a></p><p style="font:13px system-ui,sans-serif;color:#5a7363">Wenn du das nicht warst, ignoriere diese E-Mail.</p>` }).catch(e => console.error("confirm mail", e.message));
      }
      return J({ message: row.confirmed_at ? "Du folgst schon." : "Fast geschafft: bitte bestätige den Link in deinem Postfach." });
    }
    const p = piece(db.query("SELECT * FROM drafts WHERE owner_id = ? AND slug = ? AND status = 'published'").get(owner, a ?? ""));
    if (!p) return J({ message: "Not found." }, 404);
    if (b === "tip") {
      if (limited(req, `tip${p.id}`, 4)) return J({ message: "Zu viele Hinweise. Bitte später noch einmal." }, 429);
      const f = await form(req); const text = String(f.text ?? "").trim().slice(0, 3000);
      if (text.length < 3) return J({ message: "Schreib ein paar Worte." }, 400);
      db.query("INSERT INTO reader_notes (draft_id, owner_id, kind, text, contact, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)").run(p.id, owner, f.kind === "fix" ? "fix" : "tip", text, String(f.contact ?? "").trim().slice(0, 200), now());
      return J({ message: p.meta.lang === "en" ? T.en.thanks : T.de.thanks });
    }
    if (b === "beacon") { const f = await form(req); if (!isBot(req) && viewer !== owner) count(p.id, f.e === "share" ? "shares" : "finishes"); return new Response(null, { status: 204 }); }
    return J({ message: "Not found." }, 404);
  }
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (!a) return html(authorPage(owner, prof));
  if (a === "feed.xml") return feed(owner, prof, origin);
  if (a === "impressum") return html(head(`${T.de.imprint} · ${prof.name}`, "") + `<main class="wrap">${top(prof)}<h1>${T.de.imprint}</h1><p>${esc(prof.imprint).replace(/\n/g, "<br>")}</p><p>E-Mail: ${esc(prof.email)}</p><p>Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV: ${esc(prof.name)}, Anschrift wie oben.</p>${foot(prof, "de")}</main></body></html>`);
  if (a === "confirm" || a === "unsubscribe") {
    const s = db.query("SELECT id FROM subscribers WHERE owner_id = ? AND token = ?").get(owner, b ?? "") as { id: number } | null;
    if (!s) return html(message("Link abgelaufen", "Dieser Link gilt nicht mehr.", prof), 404);
    if (a === "confirm") { db.query("UPDATE subscribers SET confirmed_at = coalesce(confirmed_at, ?) WHERE id = ?").run(now(), s.id); return html(message("Bestätigt", `Du bekommst neue Texte von ${prof.name} per E-Mail.`, prof)); }
    db.query("DELETE FROM subscribers WHERE id = ?").run(s.id);
    return html(message("Abgemeldet", "Du bekommst keine E-Mails mehr.", prof));
  }
  if (a === "photo") {
    // only the blurred copy, and only of a photo that is in a published piece or a preview the writer shared
    const r = db.query(`SELECT p.public_bytes FROM photos p JOIN drafts d ON d.owner_id = p.owner_id AND json_extract(d.meta, '$.photo') = p.id
      WHERE p.id = ? AND p.owner_id = ? AND p.public_bytes IS NOT NULL AND (d.status = 'published' OR json_extract(d.meta, '$.preview') IS NOT NULL) LIMIT 1`).get(Number(b), owner) as { public_bytes: Uint8Array } | null;
    return r ? new Response(r.public_bytes, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=86400" } }) : new Response("Not found", { status: 404 });
  }
  if (a === "preview") {
    const p = piece(db.query("SELECT * FROM drafts WHERE owner_id = ? AND json_extract(meta, '$.preview') = ?").get(owner, b ?? ""));
    return p ? html(article({ ...p, slug: p.slug ?? "preview" }, prof, origin, { preview: true }), 200, { "x-robots-tag": "noindex" }) : html(message("Link abgelaufen", "Diese Vorschau gibt es nicht mehr.", prof), 404);
  }
  const p = piece(db.query("SELECT * FROM drafts WHERE owner_id = ? AND slug = ?").get(owner, a));
  if (!p) return html(message("Nicht gefunden", "Diesen Text gibt es nicht.", prof), 404);
  if (p.status !== "published") return html(message("Nicht mehr online", T[p.meta.lang === "en" ? "en" : "de"].gone, prof), 410);
  if (!isBot(req) && viewer !== owner) count(p.id, "reads");
  return html(article(p, prof, origin));
}
