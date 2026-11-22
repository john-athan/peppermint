// Studio: drafts made of blocks, with Claude beside the writer. Two streams:
//  suggest: the next paragraph, shown as a ghost the writer accepts, skips or asks again for
//  preview: the whole draft steeped into another form (LinkedIn post, TL;DR, podcast, Einfach)
// Quotes carry the story and source they came from, so credit travels with every block.
import { db, json, now } from "./db";
import { CHART_RULE, streamText } from "./llm";
import { normalize } from "../shared/chart";
import { palateNote, storyMaterial } from "./lens";
import { forget, steep } from "./steep";

import type { Block, Draft } from "../shared/types";
export type { Block, Draft };

const TYPES = new Set(["h", "p", "q", "c", "chart"]);
const bid = () => crypto.randomUUID().slice(0, 8);

/** Blocks from the client are untrusted: known types only, capped sizes, citations only to the owner's own stories. */
export function cleanBlocks(owner: number, raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const own = db.query("SELECT 1 FROM stories WHERE id = ? AND owner_id = ?"), ownEv = db.query("SELECT 1 FROM evidence WHERE id = ? AND owner_id = ?");
  return raw.slice(0, 200).flatMap((b: any): Block[] => {
    if (!b || !TYPES.has(b.type)) return [];
    const out: Block = { id: typeof b.id === "string" && /^[\w-]{1,40}$/.test(b.id) ? b.id : bid(), type: b.type, text: String(b.text ?? "").slice(0, 8000) };
    // evidence ids only from the owner's own case files; the support grade only as one of its three words
    if (Array.isArray(b.ev)) { const ids = b.ev.map(Number).filter((n: number) => Number.isInteger(n) && ownEv.get(n, owner)).slice(0, 8); if (ids.length) out.ev = ids; }
    if (b.support === "strong" || b.support === "ok" || b.support === "weak") out.support = b.support;
    if (b.open === true && b.type === "p") out.open = true;
    const c = b.cite;
    if (c && Number.isInteger(c.story_id) && own.get(c.story_id, owner))
      out.cite = { story_id: c.story_id, source: String(c.source ?? "").slice(0, 80), kind: String(c.kind ?? "").slice(0, 20), url: typeof c.url === "string" && /^https?:\/\//.test(c.url) ? c.url.slice(0, 500) : null };
    return [out];
  });
}

const row = (r: any): Draft => r && { ...r, blocks: json<Block[]>(r.blocks, []), meta: json(r.meta, {}) };
export const words = (bs: Block[]) => bs.reduce((n, b) => n + (b.text.match(/\S+/g)?.length ?? 0), 0);

export function listDrafts(owner: number) {
  return (db.query("SELECT * FROM drafts WHERE owner_id = ? ORDER BY updated_at DESC").all(owner) as any[]).map(row)
    .map(d => ({ id: d.id, title: d.title || d.blocks.find(b => b.type === "h")?.text || "Untitled", words: words(d.blocks), status: d.status, updated_at: d.updated_at, investigation_id: d.investigation_id ?? null, publish_at: d.publish_at ?? null }));
}
export const getDraft = (owner: number, id: number) => row(db.query("SELECT * FROM drafts WHERE id = ? AND owner_id = ?").get(id, owner));

/** A new draft, empty or seeded from a story: its headline, the strongest facts as cited quotes, claims marked as such. */
export function createDraft(owner: number, storyId?: number): Draft {
  // New draft opens the empty one you left behind instead of adding another "Untitled" to the list
  if (!storyId) {
    const blank = (db.query("SELECT * FROM drafts WHERE owner_id = ? AND status = 'draft' ORDER BY updated_at DESC").all(owner) as any[]).map(row).find(d => d.blocks.length > 0 && d.blocks.every(x => !x.text.trim()));
    if (blank) return blank;
  }
  let blocks: Block[] = [{ id: bid(), type: "h", text: "" }, { id: bid(), type: "p", text: "" }];
  if (storyId) {
    const st = db.query("SELECT id, title, title_en FROM stories WHERE id = ? AND owner_id = ?").get(storyId, owner) as any;
    if (st) {
      const items = storyMaterial(st.id).items;
      const lead = items[0]; const t = json<any>(lead?.tags, {});
      const cite = lead ? { story_id: st.id, source: lead.source, kind: lead.kind, url: lead.url } : undefined;
      const atoms: { kind: string; text: string }[] = items.flatMap(i => json<any>(i.tags, {}).atoms ?? []);
      blocks = [{ id: bid(), type: "h", text: (t.by !== "local" && t.title_en) || st.title_en || st.title }];
      for (const a of atoms.filter(a => a.kind !== "claim").slice(0, 2)) blocks.push({ id: bid(), type: "q", text: a.text, cite });
      for (const a of atoms.filter(a => a.kind === "claim").slice(0, 1)) blocks.push({ id: bid(), type: "c", text: `${a.text.replace(/[\s.]*$/, ".")} Single source, not verified.` });
      blocks.push({ id: bid(), type: "p", text: "" });
    }
  }
  const r = db.query("INSERT INTO drafts (owner_id, blocks, created_at, updated_at) VALUES (?, ?, ?, ?) RETURNING *").get(owner, JSON.stringify(blocks), now(), now());
  return row(r);
}

/** Saves when the client's base version is the stored one; otherwise reports a conflict instead of overwriting newer text. */
export function saveDraft(owner: number, id: number, b: { blocks?: unknown; status?: string; base?: number }): { draft?: Draft; conflict?: Draft } {
  const cur = getDraft(owner, id); if (!cur) return {};
  if (b.base != null && Number(b.base) !== cur.updated_at) return { conflict: cur };
  // blocks that are no list keep the draft as it is: a broken save must never empty it
  const blocks = Array.isArray(b.blocks) ? cleanBlocks(owner, b.blocks) : cur.blocks;
  // a piece with a public page goes live and comes down only through publish(), which runs the checks
  const status = cur.investigation_id || cur.slug ? cur.status : b.status === "published" ? "published" : b.status === "draft" ? "draft" : cur.status;
  const title = blocks.find(x => x.type === "h")?.text.slice(0, 200) ?? "";
  const t = Math.max(now(), cur.updated_at + 1);
  const r = db.query("UPDATE drafts SET blocks = ?, title = ?, status = ?, updated_at = ?, published_at = CASE WHEN ? = 'published' THEN coalesce(published_at, ?) ELSE published_at END WHERE id = ? AND owner_id = ? RETURNING *")
    .get(JSON.stringify(blocks), title, status, t, status, t, id, owner);
  // a piece from an investigation keeps your own edits as versions too, at most one every quarter of an hour
  if (cur.investigation_id && Array.isArray(b.blocks)) {
    const last = db.query("SELECT created_at FROM draft_versions WHERE draft_id = ? AND by = 'you' ORDER BY id DESC LIMIT 1").get(id) as { created_at: number } | null;
    if (!last || now() - last.created_at > 15 * 60_000) db.query("INSERT INTO draft_versions (draft_id, owner_id, by, label, blocks, created_at) VALUES (?, ?, 'you', 'Your edits', ?, ?)").run(id, owner, JSON.stringify(blocks), now());
  }
  return { draft: row(r) };
}

const asText = (bs: Block[]) => bs.filter(b => b.text.trim()).map(b =>
  b.type === "h" ? `# ${b.text}` : b.type === "chart" ? "```chart\n" + b.text + "\n```" : b.type === "q" ? `> ${b.text}${b.cite ? ` (${b.cite.source})` : ""}` : b.type === "c" ? `Unverified claim: ${b.text}` : b.text).join("\n\n");

const sig = (d: Draft) => Bun.hash(JSON.stringify(d.blocks.map(b => [b.type, b.text]))).toString(36);

export const FORMS: Record<string, { label: string; rule: string }> = {
  linkedin: { label: "LinkedIn", rule: "Rewrite the draft as a LinkedIn post: a strong first line, short paragraphs, first person, at most 1300 characters, no hashtags spam (at most two at the end), no emoji. Credit quoted sources by name." },
  tldr: { label: "TL;DR", rule: "Rewrite the draft as a TL;DR of one to three sentences." },
  podcast: { label: "Podcast", rule: "Rewrite the draft as a spoken script of about 45 seconds for one host: written for the ear, short sentences, no symbols." },
  einfach: { label: "Einfach", rule: "Schreibe den Entwurf in einfacher deutscher Sprache neu: kurze Sätze, bekannte Wörter, jedes Fachwort erklärt. Keine Überschriften." },
};

const SYSTEM = (owner: number) => `You are the writing partner in peppermint Studio. The writer drafts posts from news they read. Plain prose, no markdown, no emoji. A \`\`\`chart block in the draft is a chart the writer made: use its key numbers in words where they help, never copy the JSON.
Keep the writer's voice and claims; never add facts that are not in the draft or its quotes. A paragraph starting with "Unverified claim:" is a claim from a single source; whenever you use it, say in plain words that it is not confirmed. Never copy labels like that one into your text.
What the writer cares about: ${palateNote(owner)}`;

export function previewStream(owner: number, d: Draft, form: string, lastEventId: number, signal: AbortSignal) {
  const f = FORMS[form];
  const key = `pv:${d.id}:${form}:${sig(d)}`;
  return steep({
    key, open: { form, label: f.label }, lastEventId, signal,
    produce: () => streamText(SYSTEM(owner), `${f.rule}\n\nDraft:\n${asText(d.blocks)}`, { effort: "low", maxTokens: 1500 }),
  });
}

export function suggestStream(owner: number, d: Draft, after: string | null, nth: number, lastEventId: number, signal: AbortSignal) {
  const i = after ? d.blocks.findIndex(b => b.id === after) : d.blocks.length - 1;
  const before = d.blocks.slice(0, i + 1), rest = d.blocks.slice(i + 1);
  const key = `sg:${d.id}:${after}:${nth}:${sig(d)}`;
  forget(`sg:${d.id}:${after}:${nth - 1}:${sig(d)}`);
  const user = `Write the single next paragraph that should follow at the marked point: 1 to 3 sentences, in the draft's language and voice, moving the argument forward. Output only the paragraph.${nth > 0 ? ` This is attempt ${nth + 1}; take a different angle than before.` : ""}

Draft up to the point:
${asText(before)}

[the new paragraph goes here]
${rest.length ? `\nWhat follows it:\n${asText(rest)}` : ""}`;
  return steep({ key, open: { after, nth }, lastEventId, signal, produce: () => streamText(SYSTEM(owner), user, { effort: "low", maxTokens: 400 }) });
}

/** "Chart from my numbers": Claude reads the draft (up to the marked block) and writes one chart as JSON, checked
 *  before it reaches the writer. Returns the JSON pretty-printed, or why there is no chart to make. */
export async function chartFromDraft(owner: number, d: Draft, after: string | null): Promise<{ json: string } | { error: string }> {
  const i = after ? d.blocks.findIndex(b => b.id === after) : d.blocks.length - 1;
  const text = asText(d.blocks.slice(0, i + 1).filter(b => b.type !== "chart"));
  if (!/\d/.test(text)) return { error: "The draft has no numbers to chart yet." };
  let out = "";
  for await (const t of streamText(SYSTEM(owner), `${CHART_RULE}\nWrite exactly one chart for the numbers in this draft. If there are not at least two comparable numbers, answer only NONE.\n\nDraft:\n${text}`, { effort: "low", maxTokens: 900 })) out += t;
  if (/^\s*NONE\b/.test(out)) return { error: "Claude found no numbers in the draft that compare well." };
  const m = /\{[\s\S]*\}/.exec(out);
  if (!m) return { error: "Claude did not return a chart. Try again, or write the JSON yourself." };
  const r = normalize(m[0]);
  if ("error" in r) return { error: r.error };
  return { json: JSON.stringify(JSON.parse(m[0]), null, 2) };
}

/** The quote picker: facts from the owner's recent stories, newest first, filtered by full-text search when a query is given. */
export function atomsFor(owner: number, q: string) {
  const fts = q.trim().replace(/["*^():]/g, " ").split(/\s+/).filter(Boolean).map(w => `"${w}"*`).join(" ");
  const rows = (fts
    ? db.query(`SELECT DISTINCT i.story_id FROM search f JOIN items i ON i.id = f.rowid WHERE search MATCH ? AND i.owner_id = ? AND i.story_id IS NOT NULL ORDER BY i.published_at DESC LIMIT 20`).all(fts, owner)
    : db.query(`SELECT st.id AS story_id FROM stories st WHERE st.owner_id = ? ORDER BY st.last_at DESC LIMIT 20`).all(owner)) as { story_id: number }[];
  return rows.map(({ story_id }) => {
    const items = storyMaterial(story_id).items;
    const lead = items[0]; const t = json<any>(lead?.tags, {});
    return { story_id, title: (t.by !== "local" && t.title_en) || lead?.title, source: lead?.source, kind: lead?.kind, url: lead?.url,
      atoms: items.flatMap(i => json<any>(i.tags, {}).atoms ?? []).slice(0, 6) as { kind: string; text: string }[] };
  }).filter(s => s.atoms.length);
}
