// The morning briefing: once a morning, Claude writes the harvest as one short read in your style and language,
// with its key figures up top and a chart for each story whose numbers compare. It lives in the app at /briefing, and goes out as an email when you gave an
// address (through the mail server on the same machine, see mail.ts).
import type { Card } from "../shared/types";
import { db, json, now, setting } from "./db";
import { palateNote, readingLang, readingStyle, storyMaterial } from "./lens";
import { CHART_RULE, hasLLM, streamText } from "./llm";
import { slotNow } from "./palate";
import { mailPicture } from "./media";
import { iconFor } from "./images";
import { blocks, kpis, type LensBlock, type Run } from "../client/lib/lens";
import { chartSvg, headerSvg, svgToPng } from "./chartsvg";
import { iconSvg } from "../shared/logo.mjs";
import { send, validAddress, type Inline } from "./mail";

export type Briefing = { day: string; text: string; stories: { n: number; id: number; img: string | null }[]; created_at: number; sent_at: number | null; error: string | null };
export const MAX_STORIES = 8;

export function latest(owner: number, day?: string): Briefing | null {
  const r = (day ? db.query("SELECT * FROM briefings WHERE owner_id = ? AND day = ?").get(owner, day) : db.query("SELECT * FROM briefings WHERE owner_id = ? ORDER BY day DESC LIMIT 1").get(owner)) as any;
  if (!r) return null;
  // briefings written before headings were marked on compose get their {n} here, for the page and the email alike
  const stories = json<Briefing["stories"]>(r.stories, []);
  return { ...r, stories, text: markHeadings(r.text, stories) };
}

const SYSTEM = (style: string, lang: string, interests: string) => `You write one reader's morning briefing: the one short read they take with their coffee.
Write in ${lang === "de" ? "German" : "English"}, in their style: ${style}
${interests}
Format, a small markdown subset:
- First line: one sentence that sums up the morning. No greeting.
- Then the morning's key figures: two to four numbers from the stories that say most about what happened (an amount, a count of people or systems affected, a share, a score, a price change), each with what it measures in a few words and the story's number "n". Only numbers stated in the material, the value written as the reader's language writes it (German "4,2", English "4.2"), any unit or scale in "unit". Never figures about the briefing itself (stories, sources, reading time). Leave the block out when the material has fewer than two such numbers. One fenced block, valid compact JSON:
\`\`\`kpis
[{"value": "9.8", "unit": "/ 10", "label": "severity of the flaw", "n": 1}, {"value": "4.2", "unit": "bn €", "label": "fine against the company", "n": 3}]
\`\`\`
- Then one section per story worth their time, most important first, at most 7, skip weak ones: a line "## Headline {n}": the headline, then the story's number from the material in curly braces, braces included (for story 3: "## Strike stops the S-Bahn {3}"), then two to four sentences: what happened and why it matters to this reader. Stories marked FOLLOWED: say what changed.
- Last line: "${lang === "de" ? "Im Blick:" : "Watch:"}" and one thing to keep an eye on today, only if the material gives one.
${CHART_RULE}
For the briefing these limits replace the ones above: a story section gets one chart, right after its sentences, whenever its material has numbers that truly compare; aim for a chart in most sections, but a story without such numbers goes without one. Two values are enough when they are the same quantity measured twice (before and after, this year against last, the subject against a rival or an average). Never chart: values in different units or of different things ("3 providers" next to "125 endpoints"), the days between two dates, a count of articles or posts about the story, or anything you had to compute or estimate rather than read in the material.
Use only the material. No sign-off, no preamble, no meta talk about the briefing.`;

/** Writes today's briefing from the given cards (update cards first). Returns null without Claude or without stories. */
export async function compose(owner: number, cards: Card[]): Promise<Briefing | null> {
  if (!hasLLM() || !cards.length) return null;
  const picked = cards.slice(0, MAX_STORIES);
  const material = picked.map((c, i) => {
    const m = storyMaterial(c.id);
    return `[${i + 1}]${c.update ? " FOLLOWED, new reports since last read" : ""} ${c.title}\nSources: ${c.sources.map(s => s.name).join(", ")}\n${c.brief || c.summary || ""}\n${m ? `${m.atoms}\n${m.text.slice(0, 1500)}` : ""}`;
  }).join("\n\n---\n\n");
  let text = "";
  for await (const t of streamText(SYSTEM(readingStyle(owner), readingLang(owner), palateNote(owner)), material, { effort: "low", maxTokens: 6000 })) text += t;
  text = text.trim();
  if (!text) return null;
  const { day } = slotNow();
  // the picture of each story, as its media key (only real, finished pictures)
  const stories = picked.map((c, i) => ({ n: i + 1, id: c.id, img: c.image && !c.image.pending && c.image.src.startsWith("/api/media/") ? c.image.src.slice(11) : null }));
  text = markHeadings(text, stories);
  db.query(`INSERT INTO briefings (owner_id, day, text, stories, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, day) DO UPDATE SET text = excluded.text, stories = excluded.stories, created_at = excluded.created_at, sent_at = NULL, error = NULL`)
    .run(owner, day, text, JSON.stringify(stories), now());
  return latest(owner, day);
}

const norm = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The story a heading names when Claude left out its {n}: the same title (original or English), or one starting the other. */
export function storyByTitle(title: string, stories: Briefing["stories"]): Briefing["stories"][number] | undefined {
  const h = norm(title);
  if (h.length < 12) return undefined;
  for (const st of stories) {
    const r = db.query("SELECT title, title_en FROM stories WHERE id = ?").get(st.id) as { title: string; title_en: string | null } | null;
    for (const t of [r?.title, r?.title_en]) { const n = t ? norm(t) : ""; if (n && (n === h || (n.length >= 24 && h.startsWith(n.slice(0, 40))) || (h.length >= 24 && n.startsWith(h.slice(0, 40))))) return st; }
  }
  return undefined;
}
/** Gives every "## Headline" without a marker its {n}: from a bare trailing number when Claude dropped the braces
 *  ("## Riemann-Beweis im Entwurf 8"), else when the title names one of the stories. A bare number counts only when at
 *  least two headings end in distinct story numbers, so a single "iPhone 7" is not taken for story 7. */
export function markHeadings(text: string, stories: Briefing["stories"]): string {
  const ns = new Set(stories.map(s => s.n)), heads = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1]);
  const used = new Set(heads.map(h => /\{(\d+)\}$/.exec(h)?.[1]).filter(Boolean).map(Number));
  const bare = heads.map(h => /\{\d+\}$/.test(h) ? null : Number(/\s(\d{1,2})$/.exec(h)?.[1])).filter(n => n && ns.has(n) && !used.has(n));
  const trustBare = new Set(bare).size >= 2;
  return text.replace(/^(##\s+)(.+?)\s*$/gm, (all, hash, title) => {
    if (/\{\d+\}\s*$/.test(title)) return all;
    const b = /^(.+?)\s+(\d{1,2})$/.exec(title);
    if (trustBare && b && ns.has(Number(b[2])) && !used.has(Number(b[2]))) { used.add(Number(b[2])); return `${hash}${b[1]} {${b[2]}}`; }
    const st = storyByTitle(title, stories);
    return st ? `${hash}${title} {${st.n}}` : all;
  });
}

/** "## Headline {3}": the heading without its marker, and the story it points to. */
export function headingStory(s: string, stories: Briefing["stories"]): { title: string; id: number | null; img: string | null } {
  const m = /\s*\{(\d+)\}\s*$/.exec(s);
  const st = m ? stories.find(x => x.n === Number(m[1])) : undefined;
  return { title: m ? s.slice(0, m.index).trim() : s, id: st?.id ?? null, img: st?.img ?? null };
}

// ---- the email ----
// Built for the strictest reader: a fixed 600px table skeleton (Outlook lays out with Word), every style inline (the
// Gmail app shows no <style> for IMAP accounts), the <style> block only adds dark mode and phone padding. Pictures and
// charts travel inside the message by Content-ID (peppermint sits behind a login, links to images would not load),
// photos as JPEG (Outlook shows no WebP), charts and the header as PNG at twice their size, on their own paper so
// Gmail's dark mode, which recolours the HTML but not images, cannot make them unreadable. Gmail clips HTML over
// 102 KB, so the weight is in the pictures, not the markup.
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const runsHtml = (rs: Run[]) => rs.map(r => r.b ? `<b>${esc(r.s)}</b>` : esc(r.s)).join("");
const C = { bg: "#e8f7ec", card: "#f7fdf8", ink: "#0f2a1b", muted: "#4c6b58", rule: "#c2e2cc", mint: "#12804c", soft: "#c9f0d8", track: "#daf1e1" };
const DISPLAY = `ui-rounded,'SF Pro Rounded',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const BODY = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;
const type = (size: number, weight: number, color: string, lh = 1.5, family = BODY) => `font-family:${family};font-size:${size}px;line-height:${lh};font-weight:${weight};color:${color}`;
const TABLE = `role="presentation" cellpadding="0" cellspacing="0" border="0"`;
const GAP = `<tr><td height="14" style="font-size:0;line-height:0">&nbsp;</td></tr>`;
const card = (inner: string, cls = "card", bg = C.card) => `<tr><td class="${cls}" style="background:${bg};border:1px solid ${C.rule};border-radius:20px">${inner}</td></tr>${GAP}`;
const WATCH = /^\s*(?:\*\*)?(Watch|Im Blick)\s*:\s*(?:\*\*)?\s*/i;

const WORDS = {
  en: { kicker: "Your morning briefing", read: "Read the story", watch: "Watch", harvest: "Your harvest", topics: "Today's topics", open: "Open in peppermint",
    minutes: "min to read",
    stories: (n: number) => `${n} ${n === 1 ? "story" : "stories"}`, foot: "Turn it off or change the address in Palate." },
  de: { kicker: "Dein Morgen", read: "Weiterlesen", watch: "Im Blick", harvest: "Deine Ernte", topics: "Die Themen von heute", open: "In peppermint öffnen",
    minutes: "Min. Lesezeit",
    stories: (n: number) => `${n} ${n === 1 ? "Beitrag" : "Beiträge"}`, foot: "Abbestellen oder Adresse ändern: in Palate." },
};

/** What the email shows besides Claude's text: the day's edition in numbers and its topics. */
export function dayStats(owner: number, day: string) {
  const ed = db.query("SELECT id, considered FROM editions WHERE owner_id = ? AND day = ? ORDER BY CASE slot WHEN 'morning' THEN 0 ELSE 1 END LIMIT 1").get(owner, day) as { id: number; considered: number } | null;
  const sources = (db.query("SELECT count(*) AS n FROM sources WHERE owner_id = ? AND enabled = 1").get(owner) as { n: number }).n;
  const tags = ed ? db.query("SELECT st.tags FROM edition_items ei JOIN stories st ON st.id = ei.story_id WHERE ei.edition_id = ?").all(ed.id) as { tags: string }[] : [];
  const freq = new Map<string, number>();
  for (const t of tags) for (const x of json<any>(t.tags, {}).topics ?? []) freq.set(x, (freq.get(x) ?? 0) + 1);
  return { considered: ed?.considered ?? 0, picked: tags.length, sources, topics: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6) };
}

/** The sources behind a story, for its byline, and the icon of the first one that has one. */
function byline(owner: number, storyId: number): { names: string[]; icon: string | null } {
  const rows = db.query("SELECT s.name, s.kind, s.config, i.meta FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = ? ORDER BY i.published_at").all(storyId) as any[];
  const names = [...new Set(rows.map(r => r.name as string))];
  let icon: string | null = null;
  for (const r of rows) { icon = iconFor(owner, { kind: r.kind, meta: json<any>(r.meta, {}), config: r.config }); if (icon) break; }
  return { names, icon: icon?.startsWith("/api/media/") ? icon.slice(11) : null };
}

/** The briefing as an email: HTML with inline pictures and charts, and a plain-text part. */
export async function email(owner: number, b: Briefing, origin: string): Promise<{ subject: string; html: string; text: string; inline: Inline[] }> {
  const lang = readingLang(owner), w = lang === "de" ? WORDS.de : WORDS.en;
  const figs = kpis(b.text), bl: LensBlock[] = blocks("briefing", figs.text);
  const inline: Inline[] = [], text: string[] = [];
  const attach = (cid: string, mime: string, bytes: Uint8Array, name: string) => { if (!inline.some(i => i.cid === cid)) inline.push({ cid, mime, bytes, name }); return `cid:${cid}`; };
  const png = async (svg: string, name: string) => { const p = await svgToPng(svg); return p ? attach(`${name}@peppermint`, "image/png", p, `${name}.png`) : null; };

  // Claude's text in parts: the lead before the first heading, one section per heading, the closing "Watch:" line
  type Sec = { title: string; id: number | null; img: string | null; body: string[]; plain: string[] };
  const lead: string[] = [], secs: Sec[] = [];
  let watch: string | null = null, charts = 0;
  for (const x of bl) {
    const sec = secs[secs.length - 1];
    if (x.t === "h") { const h = headingStory(x.s, b.stories); secs.push({ ...h, body: [], plain: [] }); continue; }
    if (x.t === "p" && WATCH.test(x.s)) { watch = x.s.replace(WATCH, "").replace(/\*\*/g, ""); continue; }
    let html = "", plain = "";
    if (x.t === "p") { html = `<p class="ink" style="margin:0 0 12px;${type(16, 400, C.ink, 1.55)}">${runsHtml(x.runs)}</p>`; plain = x.s.replace(/\*\*/g, ""); }
    else if (x.t === "ul") { html = `<ul style="margin:0 0 12px;padding-left:20px">${x.items.map(i => `<li class="ink" style="margin:0 0 6px;${type(16, 400, C.ink, 1.5)}">${runsHtml(i)}</li>`).join("")}</ul>`; plain = x.items.map(i => `- ${i.map(r => r.s).join("")}`).join("\n"); }
    else if (x.t === "quote") { html = `<p class="muted" style="margin:0 0 12px;padding-left:14px;border-left:3px solid ${C.mint};${type(16, 400, C.muted, 1.5)}">${runsHtml(x.runs)}</p>`; plain = `> ${x.s}`; }
    else if (x.t === "chart" && x.chart) {
      const src = charts < 8 ? await png(chartSvg(x.chart, lang), `chart${++charts}`) : null;
      if (src) html = `<img src="${src}" width="552" alt="${esc(x.chart.title)}" style="display:block;width:100%;max-width:552px;height:auto;border:0;margin:6px 0 14px">`;
      plain = `[${x.chart.title}] ${x.chart.labels.map((l, i) => `${l}: ${x.chart!.series[0]?.values[i] ?? ""}`).join(", ")}`;
    }
    if (!html && !plain) continue;
    // before the first heading: the lead sentence(s); anything else there has no section to sit in
    if (sec) { sec.body.push(html); sec.plain.push(plain); } else if (x.t === "p") lead.push(plain);
  }

  const stats = dayStats(owner, b.day);
  const minutes = Math.max(1, Math.round(b.text.split(/\s+/).length / 220));
  const d = new Date(`${b.day}T12:00:00Z`), loc = lang === "de" ? "de-DE" : "en-GB";
  const dayName = d.toLocaleDateString(loc, { weekday: "long", day: "numeric", month: "long" });
  const subject = lang === "de" ? `Dein Morgen · ${dayName}` : `Your morning · ${dayName}`;
  const rows: string[] = [];

  // header: drawn, with the date in text as its alt so nothing is lost when pictures are off
  const head = await png(headerSvg({ kicker: w.kicker, day: d.toLocaleDateString(loc, { weekday: "long" }), date: d.toLocaleDateString(loc, { day: "numeric", month: "long", year: "numeric" }),
    line: `${w.stories(secs.filter(x => x.id).length || secs.length)} · ${minutes} ${w.minutes}`, mark: iconSvg() }), "header");
  rows.push(head ? `<tr><td><a href="${origin}/briefing"><img src="${head}" width="600" alt="${esc(`${w.kicker} · ${dayName}`)}" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a></td></tr>${GAP}`
    : card(`<div class="pad" style="padding:22px 24px"><p class="accent" style="margin:0;${type(13, 800, C.mint, 1.3)};letter-spacing:.08em;text-transform:uppercase">${esc(w.kicker)}</p><p class="ink" style="margin:6px 0 0;${type(28, 800, C.ink, 1.2, DISPLAY)}">${esc(dayName)}</p></div>`));

  // the lead, and the morning's key figures as tiles (two by two, so they fit a phone without media queries): numbers
  // from the stories themselves, each linked to its story
  const tile = (k: (typeof figs.kpis)[number]) => {
    const id = k.n ? b.stories.find(x => x.n === k.n)?.id : undefined, link = id ? `${origin}/story/${id}` : null;
    const inner = `<p class="accent" style="margin:0;${type(28, 800, C.mint, 1.1, DISPLAY)}">${esc(k.value)}${k.unit ? `<span style="${type(15, 700, C.mint, 1.1, DISPLAY)}">&nbsp;${esc(k.unit)}</span>` : ""}</p><p class="muted" style="margin:4px 0 0;${type(13, 600, C.muted, 1.3)}">${esc(k.label)}</p>`;
    return `<td width="50%" valign="top" style="padding:6px"><table ${TABLE} width="100%"><tr><td class="tile" style="background:${C.track};border-radius:14px;padding:14px 16px">${link ? `<a href="${link}" style="text-decoration:none">${inner}</a>` : inner}</td></tr></table></td>`;
  };
  const pairs: string[] = [];
  for (let i = 0; i < figs.kpis.length; i += 2) pairs.push(`<tr>${tile(figs.kpis[i])}${figs.kpis[i + 1] ? tile(figs.kpis[i + 1]) : `<td width="50%"></td>`}</tr>`);
  const tiles = pairs.length ? `<div style="padding:0 18px 18px"><table ${TABLE} width="100%">${pairs.join("")}</table></div>` : "";
  if (lead.length || tiles) rows.push(card(`${lead.length ? `<div class="pad" style="padding:22px 24px ${tiles ? 16 : 22}px"><p class="ink" style="margin:0;${type(20, 700, C.ink, 1.4, DISPLAY)}">${esc(lead.join(" "))}</p></div>` : `<div style="height:18px"></div>`}${tiles}`));
  if (lead.length) text.push(lead.join(" "));
  if (figs.kpis.length) text.push(figs.kpis.map(k => `${k.value}${k.unit ? ` ${k.unit}` : ""}: ${k.label}`).join("\n"));

  // one card per story: its picture, the sources it came from, the headline, Claude's sentences, a way in
  for (const s of secs) {
    const link = s.id ? `${origin}/story/${s.id}` : null;
    let img = "", by = "";
    if (s.img) {
      const pic = await mailPicture(owner, s.img, 1200).catch(() => null);
      if (pic) img = `<tr><td>${link ? `<a href="${link}">` : ""}<img src="${attach(`s${s.id}@peppermint`, pic.mime, pic.bytes, `story-${s.id}.${pic.mime.includes("png") ? "png" : "jpg"}`)}" width="598" alt="" style="display:block;width:100%;max-width:598px;height:auto;border:0;border-radius:19px 19px 0 0">${link ? "</a>" : ""}</td></tr>`;
    }
    if (s.id) {
      const bl2 = byline(owner, s.id);
      const ic = bl2.icon ? await mailPicture(owner, bl2.icon, 64).catch(() => null) : null;
      const icon = ic ? `<td valign="middle" style="padding-right:8px"><img src="${attach(`i-${bl2.icon}@peppermint`, ic.mime, ic.bytes, `icon.${ic.mime.includes("png") ? "png" : "jpg"}`)}" width="18" height="18" alt="" style="display:block;border:0;border-radius:5px"></td>` : "";
      if (bl2.names.length) by = `<table ${TABLE} style="margin:0 0 8px"><tr>${icon}<td valign="middle" class="muted" style="${type(13, 600, C.muted, 1.3)}">${esc(bl2.names.slice(0, 3).join(" · "))}${bl2.names.length > 3 ? ` +${bl2.names.length - 3}` : ""}</td></tr></table>`;
    }
    const h = `<h2 class="ink" style="margin:0 0 10px;${type(22, 800, C.ink, 1.25, DISPLAY)};letter-spacing:-.01em">${link ? `<a href="${link}" class="ink" style="color:${C.ink};text-decoration:none">${esc(s.title)}</a>` : esc(s.title)}</h2>`;
    const more = link ? `<p style="margin:4px 0 0"><a href="${link}" class="accent" style="${type(14, 700, C.mint, 1.4)};text-decoration:none">${esc(w.read)} &rarr;</a></p>` : "";
    rows.push(card(`<table ${TABLE} width="100%">${img}<tr><td class="pad" style="padding:20px 24px 22px">${by}${h}${s.body.join("")}${more}</td></tr></table>`));
    text.push(`${s.title.toUpperCase()}${link ? `\n${link}` : ""}\n${s.plain.join("\n\n")}`);
  }

  if (watch) {
    rows.push(card(`<div class="pad" style="padding:18px 24px"><p class="accent" style="margin:0 0 6px;${type(12, 800, C.mint, 1.3)};letter-spacing:.1em;text-transform:uppercase">${esc(w.watch)}</p><p class="ink" style="margin:0;${type(17, 600, C.ink, 1.45)}">${esc(watch)}</p></div>`, "callout", C.soft));
    text.push(`${w.watch}: ${watch}`);
  }

  // the harvest: the topics of today's edition as bars of live text
  const parts: string[] = [];
  if (stats.topics.length) {
    const max = stats.topics[0][1];
    parts.push(`<p class="ink" style="margin:0 0 10px;${type(15, 700, C.ink, 1.3)}">${esc(w.topics)}</p><table ${TABLE} width="100%">${stats.topics.map(([t, n]) => `<tr>
<td class="ink" width="38%" style="padding:5px 10px 5px 0;${type(14, 500, C.ink, 1.3)}">${esc(t)}</td>
<td style="padding:5px 0"><table ${TABLE} width="100%"><tr><td class="track" style="background:${C.track};border-radius:99px"><table ${TABLE} width="${Math.max(6, Math.round((n / max) * 100))}%"><tr><td class="fill" height="12" style="background:${C.mint};border-radius:99px;font-size:0;line-height:0">&nbsp;</td></tr></table></td></tr></table></td>
<td class="ink" width="34" align="right" style="padding:5px 0 5px 10px;${type(14, 700, C.ink, 1.3)}">${n}</td></tr>`).join("")}</table>`);
    text.push(`${w.topics}: ${stats.topics.map(([t, n]) => `${t} ${n}`).join(", ")}`);
  }
  if (parts.length) rows.push(card(`<div class="pad" style="padding:20px 24px 22px"><p class="accent" style="margin:0 0 12px;${type(12, 800, C.mint, 1.3)};letter-spacing:.1em;text-transform:uppercase">${esc(w.harvest)}</p>${parts.join("")}</div>`));

  // a button that is a table cell, so Outlook draws it too
  rows.push(`<tr><td align="center" style="padding:6px 0 10px"><table ${TABLE}><tr><td class="btn" align="center" style="background:${C.mint};border-radius:14px"><a href="${origin}/briefing" style="display:inline-block;padding:14px 26px;${type(16, 700, "#ffffff", 1.2)};text-decoration:none">${esc(w.open)}</a></td></tr></table>
<p class="muted" style="margin:14px 0 0;${type(12.5, 400, C.muted, 1.4)}"><a href="${origin}/palate" class="muted" style="color:${C.muted}">${esc(w.foot)}</a></p></td></tr>`);

  const html = `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(subject)}</title>
<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
a{color:${C.mint}}
@media (prefers-color-scheme:dark){
.bg{background:#071a10!important}.card{background:#0d2618!important;border-color:#1d4029!important}.callout{background:#134a2c!important;border-color:#1d4029!important}
.tile,.track{background:#123220!important}.fill{background:#5fe39b!important}
.ink,.ink a,a.ink{color:#ddf7e6!important}.muted,a.muted{color:#8db39b!important}.accent,a.accent{color:#5fe39b!important}
.btn{background:#5fe39b!important}.btn a{color:#04160b!important}}
@media (max-width:480px){.pad{padding-left:18px!important;padding-right:18px!important}.outer{padding:12px 8px!important}}
</style></head>
<body class="bg" style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${esc(lead.join(" ").slice(0, 140))}</div>
<table ${TABLE} width="100%" class="bg" bgcolor="${C.bg}" style="background:${C.bg}"><tr><td class="outer" align="center" style="padding:24px 12px">
<table ${TABLE} width="600" style="width:100%;max-width:600px">
${rows.join("\n")}
</table></td></tr></table></body></html>`;
  return { subject, html, text: `${text.join("\n\n")}\n\n${w.open}: ${origin}/briefing\n`, inline };
}

/** The email as one page for a browser: the same HTML, with its inline pictures as data URLs instead of Content-IDs. */
export function previewHtml(m: { html: string; inline: Inline[] }): string {
  return m.html.replace(/src="cid:([^"]+)"/g, (all, cid) => { const i = m.inline.find(x => x.cid === cid); return i ? `src="data:${i.mime};base64,${Buffer.from(i.bytes).toString("base64")}"` : all; });
}

/** Sends a briefing to the address in settings; records success or the server's refusal. */
export async function mailBriefing(owner: number, b: Briefing, origin: string): Promise<string | null> {
  const to = setting<string>(owner, "briefing_email", "");
  if (!to || !validAddress(to)) return "No email address for the briefing.";
  const from = process.env.PEPPERMINT_MAIL_FROM ?? `peppermint@${new URL(origin).hostname.split(".").slice(-2).join(".")}`;
  try {
    const m = await email(owner, b, origin);
    await send({ from, to, ...m });
    db.query("UPDATE briefings SET sent_at = ?, error = NULL WHERE owner_id = ? AND day = ?").run(now(), owner, b.day);
    return null;
  } catch (e: any) {
    db.query("UPDATE briefings SET error = ? WHERE owner_id = ? AND day = ?").run(String(e.message).slice(0, 300), owner, b.day);
    return e.message;
  }
}

/** From the scheduler: once each morning from 06:30 (Berlin), write today's briefing and mail it. */
export function due(owner: number, d = new Date()): boolean {
  if (!setting<boolean>(owner, "briefing", true) || !hasLLM()) return false;
  const { day, slot } = slotNow(d);
  const hm = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).replace(":", ""));
  return slot === "morning" && hm >= 630 && !latest(owner, day);
}
