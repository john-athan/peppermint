// Lenses: generated once per (story, lens, language, level), streamed over SSE while written, then served from cache.
// SSE event ids are chunk indexes, so a client that drops off resumes with Last-Event-ID.
import { db, json, now, setting, setSetting } from "./db";
import { hasLLM, lensModel, streamLens, type LensReq, type Pic } from "./llm";
import { steep } from "./steep";
import { affinities } from "./palate";
import { storyFigures, storyImage, videoMaterial } from "./images";
import { mailPicture } from "./media";
import { updateMaterial } from "./follow";
import { discussionFor, discussionMaterial } from "./discussion";
import { briefWorthy, itemGrade, markUnreadable, needsResearch, readableGrade, research, researchMany, shortStory, storyUnreadable } from "./material";


export function storyMaterial(storyId: number) {
  const items = db.query(`SELECT i.title, i.summary, i.body, i.url, i.lang, i.tags, i.author, i.meta, s.name AS source, s.kind FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.story_id = ? ORDER BY length(coalesce(i.body, '')) DESC`).all(storyId) as any[];
  const atoms = items.flatMap(i => json<any>(i.tags, {}).atoms ?? []).map((a: any) => `- (${a.kind}) ${a.text}`);
  return {
    items,
    title: items[0]?.title ?? "",
    atoms: [...new Set(atoms)].slice(0, 14).join("\n"),
    text: items.map(itemText).join("\n\n---\n\n"),
    // the publication itself, not the aggregator: a Hacker News link names its site (kernel.dev via Hacker News)
    sources: [...new Set(items.map(i => { try { const h = i.url ? new URL(i.url).hostname.replace(/^www\./, "") : ""; return h && !i.source.toLowerCase().includes(h.split(".")[0]) ? `${h} (via ${i.source})` : i.source; } catch { return i.source; } }))].join(", "),
    lang: items[0]?.lang ?? "en",
  };
}

/** One item as material: a page that showed a wall gives no text (Claude would only describe the wall); research adds
 *  another report on the same story and the discussion, each labelled as what it is. */
function itemText(i: any) {
  const m = json<any>(i.meta, {});
  const own = readableGrade(itemGrade({ ...i, meta: { ...m, coverage: undefined, discussion: undefined } })) ? (i.body || i.summary || "") : "(the page could not be read)";
  const parts = [`[${i.source}] ${i.title}\n${own}`];
  if (m.coverage?.text) parts.push(`[${m.coverage.site}, another report on the same story] ${m.coverage.title}\n${m.coverage.text}`);
  if (m.discussion) parts.push(`[Hacker News discussion: what commenters say about the link, not the article itself]\n${m.discussion}`);
  return parts.join("\n\n---\n\n");
}

export function palateNote(owner: number) {
  const a = [...affinities(owner).values()].sort((x, y) => y.weight - x.weight);
  const likes = a.filter(x => x.weight > 0.5).slice(0, 8).map(x => x.name);
  const places = a.filter(x => x.kind === "place" && x.weight > 0.5).slice(0, 4).map(x => x.name);
  const about = setting<{ bio?: string }>(owner, "profile", {}).bio?.trim();
  return `Likes: ${likes.join(", ") || "not known yet"}. Places that matter: ${places.join(", ") || "not known yet"}.${about ? ` About the reader: ${about}` : ""}`;
}

export const DEFAULT_STYLE = "Direct and concrete, plain words, no filler, the numbers that matter.";
export const readingStyle = (owner: number) => setting<string>(owner, "style", DEFAULT_STYLE);
export const readingLang = (owner: number) => setting<"en" | "de">(owner, "lang", "en");
/** Until the reader picks a language, it is the browser's: German there means German briefs from the first harvest. */
export function adoptLang(owner: number, acceptLanguage: string | null) {
  if (setting<string | null>(owner, "lang", null) !== null) return;
  setSetting(owner, "lang", /^\s*de\b/i.test(acceptLanguage ?? "") ? "de" : "en");
}

/** The brief on a card, when Claude already wrote it in the reader's language. */
export function cachedBrief(storyId: number, lang: string): string | null {
  return (db.query("SELECT text FROM lens_cache WHERE story_id = ? AND lens = 'brief' AND lang = ? AND level = 2 AND done = 1").get(storyId, lang) as { text: string } | null)?.text ?? null;
}

/** Writes the missing briefs of an edition ahead of time, one after another, so Today opens with them in place. */
export async function warmBriefs(owner: number, storyIds: number[]) {
  // research runs alongside (fetches only, no model); a brief that reaches a story still being researched joins that run
  const researched = researchMany(storyIds).catch(() => {});
  if (!hasLLM()) return researched;
  const lang = readingLang(owner);
  for (const id of storyIds) {
    if (cachedBrief(id, lang) || storyUnreadable(id)) continue;
    const r = lensStream(owner, id, { lens: "brief", lang, level: 2 }, -1, new AbortController().signal).getReader();
    try { for (;;) { const { done } = await r.read(); if (done) break; } } catch { return; } // no Claude, or it failed: cards keep the source summary
  }
}

/** Original text needs no model when the reader wants the source language. */
export function originalText(storyId: number) {
  const m = storyMaterial(storyId);
  const main = m.items[0];
  return { text: (main?.body || main?.summary || main?.title || "").trim(), lang: main?.lang ?? "en" };
}

export function lensStream(owner: number, storyId: number, req: LensReq, lastEventId: number, signal: AbortSignal): ReadableStream {
  return steep({
    key: `lens:${storyId}:${req.lens}:${req.lang}:${req.level}`, open: { lens: req.lens, lang: req.lang, level: req.level }, lastEventId, signal, model: lensModel(req.lens),
    // a brief written before stories were graded stays unused when the story turned out short
    cached: () => req.lens === "brief" && shortStory(storyId) ? null : db.query("SELECT text, model FROM lens_cache WHERE story_id = ? AND lens = ? AND lang = ? AND level = ? AND done = 1").get(storyId, req.lens, req.lang, req.level) as any,
    produce: async function* () {
      // a short story is researched first (the one card waiting says what is happening); nothing found: no text at all
      if (needsResearch(storyId)) yield* research(storyId);
      if (storyUnreadable(storyId)) { yield { end: { material: "none" } }; return; }
      // short after research: the card keeps the tagger's summary; no model call, nothing cached
      if (req.lens === "brief" && !briefWorthy(storyId)) { yield { end: { material: "short" } }; return; }
      const m: ReturnType<typeof storyMaterial> & { extra?: string } = storyMaterial(storyId);
      // a video gets told what it may show: the article's figures by caption, the portraits by name, the photo
      // an update compares: what the reader knew, then the new reports in full
      if (req.lens === "update") {
        const u = updateMaterial(owner, storyId);
        m.extra = `What the reader already knew:\n${u.known || "(nothing yet)"}`;
        m.text = u.fresh || m.text;
      }
      if (req.lens === "video") {
        const v = await videoMaterial(owner, storyId, req.lang);
        const pic = storyImage(owner, db.query("SELECT i.meta, s.kind, i.source_id FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = ?").all(storyId) as any[]);
        m.extra = [
          `Figures: ${v.figures.length ? v.figures.map((f, i) => `\n[${i + 1}] ${f.caption || "(no caption)"}`).join("") : "none"}`,
          `Portraits: ${v.portraits.length ? v.portraits.map(p => `${p.name}${p.description ? ` (${p.description})` : ""}`).join("; ") : "none"}`,
          `Story photo: ${pic ? "yes" : "none"}`,
        ].join("\n");
      }
      // what people say: the comments are the material for their own lens and end the TL;DR
      if (req.lens === "discussion" || req.lens === "tldr") {
        await discussionFor(storyId, { wait: 15_000 });
        const c = discussionMaterial(storyId, req.lens === "tldr" ? 6000 : undefined);
        if (c) m.extra = c;
        else if (req.lens === "discussion") throw new Error("There are no comments on this story yet.");
      }
      // a retelling sees the article's figures: the benchmark tables and charts of a launch post hold the
      // comparisons the text leaves out, and the chart rule may take numbers printed there
      let images: Pic[] = [];
      if (req.lens === "digest") {
        const f = await figurePictures(owner, storyId);
        images = f.map(x => x.pic);
        if (f.length) m.extra = `Figures of the article (attached as pictures, in this order):${f.map((x, i) => `\n[${i + 1}] ${x.caption || "(no caption)"}`).join("")}`;
      }
      let empty = false;
      yield* thinGuard(streamLens(req, m, `${palateNote(owner)} How the reader likes to read: ${readingStyle(owner)}`, images), () => { empty = true; markUnreadable(storyId); });
      if (empty) yield { end: { material: "none" } };
    },
    save: (text, model) => db.query("INSERT OR REPLACE INTO lens_cache (story_id, lens, lang, level, text, done, model, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(storyId, req.lens, req.lang, req.level, text, model, now()),
  });
}

/** The article's figures as pictures Claude can read, without the story's own photo: at most six, 1568 px wide. */
async function figurePictures(owner: number, storyId: number): Promise<{ caption: string; pic: Pic }[]> {
  const photo = storyImage(owner, db.query("SELECT i.meta, s.kind, i.source_id FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id = ?").all(storyId) as any[])?.src;
  const figs = storyFigures(owner, storyId).filter(f => f.src !== photo);
  const pics = await Promise.all(figs.map(f => mailPicture(owner, f.src.slice(11), 1568).catch(() => null)));
  return figs.flatMap((f, i) => pics[i] ? [{ caption: f.caption, pic: pics[i]! }] : []);
}

/** Claude answers `@thin` when the material has nothing to write about. The first characters are held back until it is
 *  clear which it is, so that word never reaches a reader; then the story is marked unreadable. */
export async function* thinGuard(src: AsyncIterable<string>, onThin: () => void): AsyncGenerator<string> {
  let head = "", open = false;
  for await (const t of src) {
    if (open) { yield t; continue; }
    head += t;
    const h = head.trimStart();
    if (h.length < 5 && "@thin".startsWith(h)) continue;
    if (h.startsWith("@thin")) { onThin(); return; }
    open = true; yield head;
  }
  if (!open && head.trim()) { if (head.trimStart().startsWith("@thin")) onThin(); else yield head; }
}
