// Listen: the current edition as one spoken episode. Claude writes a script for the ear (intro, one chapter per story, outro);
// without Claude the script is assembled from the stories' own summaries and facts. The browser's voices read it aloud.
// Script format, one marker line per part:  @intro  /  @story <id>  /  @outro, each followed by the spoken text.
import { db, json, now } from "./db";
import { hasLLM, streamText } from "./llm";
import { palateNote, storyMaterial } from "./lens";
import { steep } from "./steep";

type ScriptCard = { id: number; title: string; summary: string; atoms: string[]; sources: string[]; lang: string };

export function episodeInput(owner: number) {
  const ed = db.query("SELECT * FROM editions WHERE owner_id = ? ORDER BY day DESC, CASE slot WHEN 'evening' THEN 1 ELSE 0 END DESC LIMIT 1").get(owner) as any;
  if (!ed) return null;
  const rows = db.query(`SELECT st.id, st.title, st.title_en FROM edition_items ei JOIN stories st ON st.id = ei.story_id WHERE ei.edition_id = ? ORDER BY ei.rank`).all(ed.id) as any[];
  const cards: ScriptCard[] = rows.map(r => {
    const items = storyMaterial(r.id).items;
    const t = json<any>(items[0]?.tags, {});
    const llm = t.by && t.by !== "local";
    return {
      id: r.id, title: (llm && t.title_en) || items[0]?.title || r.title,
      summary: (llm && t.summary_en) || items[0]?.summary || "",
      atoms: items.flatMap(i => (json<any>(i.tags, {}).atoms ?? []).map((a: any) => a.text)).slice(0, 6),
      sources: [...new Set(items.map(i => i.source as string))], lang: t.lang ?? items[0]?.lang ?? "en",
    };
  });
  return { edition: ed, cards, sig: cards.map(c => c.id).join(",") };
}

const SLOT = { morning: { en: "Good morning", de: "Guten Morgen" }, evening: { en: "Good evening", de: "Guten Abend" } } as const;

/** A script without a model: honest, plain, built from what the stories already carry. */
export function localScript(ed: any, cards: ScriptCard[], lang: "en" | "de") {
  const hello = (SLOT as any)[ed.slot]?.[lang] ?? SLOT.morning[lang];
  const parts = [`@intro\n${hello}. ${lang === "de" ? `Heute sind es ${cards.length} Geschichten.` : `This is your ${ed.slot} edition, ${cards.length} stories.`}`];
  for (const c of cards) {
    const body = [c.summary, ...c.atoms.filter(a => !c.summary.includes(a))].filter(Boolean).slice(0, 3).join(" ");
    parts.push(`@story ${c.id}\n${c.title}. ${body} ${lang === "de" ? "Quelle" : "From"} ${c.sources.join(lang === "de" ? " und " : " and ")}.`);
  }
  parts.push(`@outro\n${lang === "de" ? "Das war die Ausgabe. Bis später." : "That was the edition. See you later."}`);
  return parts.join("\n\n");
}

async function* fromString(s: string) { for (const w of s.match(/\s*\S+\s*/g) ?? []) yield w; }

export function episodeStream(owner: number, lang: "en" | "de", lastEventId: number, signal: AbortSignal) {
  const inp = episodeInput(owner);
  if (!inp || !inp.cards.length) return null;
  const { edition: ed, cards, sig } = inp;
  const system = `You write the script of a short spoken news episode for one listener, read aloud by a speech engine.
Write for the ear: short sentences, no lists, no symbols, no URLs, no markdown, numbers written so they read well aloud. Never invent facts; use only the material given.
Output format, exactly: a line "@intro", the intro text; then for each story a line "@story <id>" and its text; then a line "@outro" and a one-sentence close. Nothing else.
What the listener cares about: ${palateNote(owner)}`;
  const user = `Language: ${lang === "de" ? "German" : "English"}. Slot: ${ed.slot}, ${ed.day}. Keep each story to 40 to 80 words, in the given order, with a light spoken transition.

${cards.map(c => `<story id="${c.id}">\nTitle: ${c.title}\nSummary: ${c.summary}\nFacts:\n${c.atoms.map(a => "- " + a).join("\n")}\nSources: ${c.sources.join(", ")}\n</story>`).join("\n\n")}`;
  return steep({
    key: `ep:${ed.id}:${lang}:${sig}`, open: { edition: ed.id, day: ed.day, slot: ed.slot, lang, stories: cards.map(c => ({ id: c.id, title: c.title, sources: c.sources })) },
    lastEventId, signal, needsLLM: false,
    cached: () => { const r = db.query("SELECT script AS text, model FROM episodes WHERE edition_id = ? AND lang = ? AND sig = ?").get(ed.id, lang, sig) as any; return r; },
    produce: () => hasLLM() ? streamText(system, user, { effort: "low", maxTokens: 6000 }) : fromString(localScript(ed, cards, lang)),
    save: (text, model) => db.query("INSERT OR REPLACE INTO episodes (edition_id, lang, sig, script, model, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(ed.id, lang, sig, text, model, now()),
  });
}
