// Tagging: Claude Haiku (API key or Claude Code), otherwise a local lexicon so the palate still works.
import { db, json, now } from "./db";
import { backend, tagItems, type Tags } from "./llm";
import { pool } from "./connectors/util";
import { mentions } from "./filter";
import { ownTopics } from "./topics";

const LEX: Record<string, string[]> = {
  AI: ["ai", "llm", "gpt", "claude", "openai", "anthropic", "machine learning", "neural", "model", "ki", "künstliche intelligenz", "chatbot", "agent", "transformer"],
  Programming: ["rust", "python", "javascript", "typescript", "golang", "java", "compiler", "programming", "code", "kotlin", "zig", "haskell", "c++", "api", "library", "refactor"],
  "Web development": ["css", "html", "browser", "web", "frontend", "react", "svelte", "sse", "websocket", "http", "javascript"],
  Databases: ["sqlite", "postgres", "postgresql", "database", "sql", "duckdb", "mysql", "redis", "index"],
  Security: ["security", "vulnerability", "exploit", "cve", "rce", "hack", "malware", "ransomware", "breach", "passkey", "password", "sicherheitslücke"],
  Infrastructure: ["server", "cloud", "kubernetes", "aws", "linux", "datacenter", "deploy", "bun", "docker", "nginx", "caddy"],
  "Open source": ["open source", "open-source", "github", "license", "foss", "maintainer"],
  Hardware: ["chip", "cpu", "gpu", "apple silicon", "nvidia", "intel", "amd", "risc-v", "hardware", "battery"],
  Startups: ["startup", "founder", "yc", "seed", "series a", "venture", "gründer"],
  Business: ["company", "revenue", "ceo", "acquisition", "layoffs", "unternehmen", "firma", "konzern", "umsatz"],
  Economy: ["inflation", "economy", "wirtschaft", "zinsen", "ezb", "dax", "börse", "preise", "konjunktur"],
  Politics: ["bundestag", "regierung", "election", "wahl", "partei", "cdu", "csu", "spd", "grüne", "afd", "fdp", "minister", "kanzler", "parliament", "president", "trump", "eu"],
  "Local politics": ["stadtrat", "bürgermeister", "oberbürgermeister", "rathaus", "gemeinderat", "kreistag", "landrat"],
  Law: ["court", "gericht", "urteil", "lawsuit", "ruling", "prozess", "anklage", "verfassung"],
  Science: ["study", "research", "studie", "forscher", "physics", "biology", "wissenschaft", "paper"],
  Space: ["nasa", "esa", "spacex", "rocket", "orbit", "mars", "moon", "raumfahrt", "satellite"],
  Health: ["health", "gesundheit", "krankenhaus", "klinik", "arzt", "virus", "medizin", "patient", "pflege"],
  Climate: ["climate", "klima", "emissions", "co2", "hitze", "unwetter"],
  Energy: ["energy", "energie", "solar", "wind", "strom", "nuclear", "atom", "gas", "heizung"],
  Transport: ["u-bahn", "s-bahn", "tram", "mvg", "mvv", "bus", "bahn", "zug", "db", "train", "flughafen", "öpnv", "u1", "u2", "u3", "u4", "u5", "u6"],
  Traffic: ["stau", "a99", "a9", "a8", "a95", "autobahn", "sperrung", "vollsperre", "baustelle", "verkehr", "unfall", "mittlerer ring"],
  Housing: ["miete", "wohnung", "housing", "rent", "immobilien", "wohnungsbau"],
  Education: ["schule", "school", "university", "universität", "lmu", "tum", "studenten", "kita"],
  Culture: ["museum", "theater", "konzert", "film", "kino", "festival", "ausstellung", "oper", "oktoberfest", "wiesn", "christkindlmarkt"],
  Food: ["restaurant", "bäckerei", "café", "essen", "food", "wirtshaus", "biergarten"],
  Weather: ["wetter", "weather", "föhn", "schnee", "regen", "gewitter", "temperatur", "frost", "glätte", "dwd"],
  Football: ["fc bayern", "bundesliga", "tsv 1860", "1860", "fußball", "football", "champions league", "trainer", "tor", "kane", "müller"],
  Sports: ["sport", "ski", "olympia", "tennis", "eishockey", "red bull münchen", "marathon", "formel 1", "f1"],
  Crime: ["polizei", "police", "festgenommen", "diebstahl", "einbruch", "messer", "täter", "ermittlungen", "staatsanwaltschaft", "mord", "überfall"],
  Celebrities: ["prinzessin", "prinz", "royals", "könig", "promi", "star", "hochzeit", "boulevard", "schauspieler"],
  Crypto: ["bitcoin", "crypto", "ethereum", "blockchain", "krypto", "token"],
  Careers: ["hiring", "job", "career", "interview", "salary", "remote", "karriere", "gehalt"],
  History: ["history", "geschichte", "historisch", "jahrhundert", "anniversary"],
  Design: ["design", "typography", "font", "ux", "ui"],
  Privacy: ["privacy", "datenschutz", "dsgvo", "gdpr", "tracking", "surveillance", "überwachung"],
};
const PLACES = ["München", "Munich", "Maxvorstadt", "Schwabing", "Sendling", "Giesing", "Haidhausen", "Bogenhausen", "Pasing", "Neuhausen", "Nymphenburg", "Laim", "Moosach", "Milbertshofen", "Freimann", "Trudering", "Berg am Laim", "Ramersdorf", "Perlach", "Neuperlach", "Thalkirchen", "Obergiesing", "Untergiesing", "Au", "Lehel", "Altstadt", "Ludwigsvorstadt", "Isarvorstadt", "Westend", "Garching", "Unterföhring", "Ismaning", "Unterhaching", "Ottobrunn", "Grünwald", "Pullach", "Starnberg", "Dachau", "Freising", "Erding", "Fürstenfeldbruck", "Augsburg", "Nürnberg", "Regensburg", "Ingolstadt", "Rosenheim", "Bayern", "Oberbayern", "Berlin", "Hamburg", "U1", "U2", "U3", "U4", "U5", "U6", "U7", "U8", "S1", "S2", "S3", "S4", "S6", "S7", "S8", "A99", "A9", "A8", "A95", "Mittlerer Ring", "Marienplatz", "Hauptbahnhof", "Sendlinger Tor", "Münchner Freiheit", "Universität", "Odeonsplatz", "Stachus", "Isar", "Englischer Garten", "Olympiapark", "Theresienwiese"];
const DE_STOP = new Set("der die das und ist nicht mit sich auf für dem den des ein eine einer eines im in zu von bei auch wird werden wurde nach aus wie noch mehr am vom zum zur über unter".split(" "));
const EN_STOP = new Set("the and is are was were with for that this from have has not but you your they their will would about into than then there what which when who how".split(" "));
const CAP_STOP = new Set(["Die", "Der", "Das", "Ein", "Eine", "Und", "Mit", "Für", "Auf", "Im", "In", "Am", "Nach", "Wie", "Was", "Wer", "The", "A", "An", "How", "Why", "What", "Show", "Ask", "HN", "Ich", "Wir", "Sie", "Er", "Es", "Bei", "Von", "Zum", "Zur", "Neue", "Neuer", "New", "This", "My", "Our", "Alle", "Auch", "Jetzt", "Heute", "Hier", "Nur"]);

export function detectLang(text: string): string {
  const words = text.toLowerCase().match(/[a-zäöüß]+/g) ?? [];
  let de = 0, en = 0;
  for (const w of words.slice(0, 400)) { if (DE_STOP.has(w)) de++; if (EN_STOP.has(w)) en++; }
  return de > en ? "de" : "en";
}

export function tagLocally(item: { title: string; summary?: string | null; body?: string | null; lang?: string | null }, own: string[] = []): Tags {
  // the structure markers of stored articles (## headings, - lists, **bold**) carry no meaning here
  const full = `${item.title}\n${item.summary ?? ""}\n${(item.body ?? "").slice(0, 5000)}`.replace(/\*\*|^#{2,3}\s|^[->]\s/gm, "");
  const lower = ` ${full.toLowerCase().replace(/[^\p{L}\p{N}+#\- ]/gu, " ")} `;
  const titleLower = ` ${item.title.toLowerCase().replace(/[^\p{L}\p{N}+#\- ]/gu, " ")} `;
  const scores: [string, number][] = Object.entries(LEX).map(([t, kws]) => {
    let s = 0;
    for (const k of kws) { const re = ` ${k} `; if (titleLower.includes(re)) s += 3; let i = 0, n = 0; while ((i = lower.indexOf(re, i)) !== -1 && n < 5) { n++; i += re.length; } s += n; }
    return [t, s];
  });
  // the reader's own topics: named in the title counts most, then in the text; they come before the general ones
  const mine = own.map(t => { const says = mentions(t); return [t, (says(item.title) ? 3 : 0) + (says(full) ? 2 : 0)] as [string, number]; }).filter(([, s]) => s >= 2);
  const topics = [...mine.sort((a, b) => b[1] - a[1]), ...scores.filter(([, s]) => s >= 2).sort((a, b) => b[1] - a[1])].slice(0, 3).map(([t]) => t);
  // places named in the title or lead count; a list of districts deep in the body does not
  const head = `${item.title}\n${item.summary ?? ""}\n${(item.body ?? "").slice(0, 600)}`;
  const places = PLACES.filter(p => new RegExp(`(^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}]|$)`, "u").test(head)).slice(0, 3);
  const counts = new Map<string, number>();
  for (const m of full.matchAll(/\b\p{Lu}[\p{L}\-]+(?: \p{Lu}[\p{L}\-]+){0,2}/gu)) {
    let c = m[0];
    // a capital at the start of a sentence or line says nothing ("Ob Nachtflohmarkt, Winterbasar ..."): drop that word
    if (/(^|[.!?\n\u2013]\s*|["„“]\s*)$/.test(full.slice(Math.max(0, m.index! - 3), m.index))) c = c.split(" ").slice(1).join(" ");
    const first = c.split(" ")[0];
    if (!c || CAP_STOP.has(first) || c.length < 3 || PLACES.includes(c)) continue;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const names = [...counts.entries()].filter(([c, n]) => n >= 2 || c.includes(" ")).sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 4);
  const sentences = (item.body || item.summary || "").split(/(?<=[.!?])\s+/).filter(s => s.length > 40 && s.length < 260).slice(0, 5);
  const lang = item.lang || detectLang(full);
  return {
    lang, title_en: item.title, summary_en: (item.summary || sentences[0] || "").slice(0, 280), topics,
    people: names.filter(n => n.includes(" ")).slice(0, 3), orgs: [], places,
    atoms: sentences.map(s => ({ kind: "what", text: s })), opinion: false, by: "local",
  };
}

export async function tagPending(limit = 50) {
  const rows = db.query(`SELECT i.id, i.owner_id, i.title, i.summary, i.body, i.lang, i.meta, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.tagged = 0 AND i.published_at > ? ORDER BY i.published_at DESC LIMIT ?`).all(now() - 72 * 3600_000, limit) as any[];
  await tagRows(rows);
  db.query("UPDATE items SET tagged = 1, tags = ? WHERE tagged = 0 AND published_at <= ?").run(JSON.stringify({ topics: [], atoms: [] }), now() - 72 * 3600_000);
  return rows.length;
}

/** Tags these items now, whatever their age: the agent's research and shared links are read the moment they arrive. */
export async function tagIds(ids: number[]) {
  if (!ids.length) return;
  const rows = db.query(`SELECT i.id, i.owner_id, i.title, i.summary, i.body, i.lang, i.meta, s.name AS source FROM items i JOIN sources s ON s.id = i.source_id
    WHERE i.id IN (${ids.map(() => "?").join(",")}) AND i.tagged = 0`).all(...ids) as any[];
  await tagRows(rows);
}

async function tagRows(rows: any[]) {
  const upd = db.query("UPDATE items SET tagged = 1, tags = ?, lang = ? WHERE id = ?");
  const save = (r: any, tags: Tags) => {
    // a local section is a place even when the text never names it
    const section = json<any>(r.meta, {}).section;
    if (section && ["München", "Landkreis München", "Bayern"].includes(section)) tags.places = [...new Set([section === "Landkreis München" ? "München" : section, ...(tags.places ?? [])])].slice(0, 5);
    upd.run(JSON.stringify(tags), tags.lang || r.lang || null, r.id);
  };
  const be = backend();
  // the CLI pays a process start per call, so it gets big batches; the API gets one item per request, four at a time
  const size = be === "cli" ? 25 : 1;
  // a batch holds one reader's items only: each reader's own topics go with their batch
  const byOwner = new Map<number, any[]>();
  for (const r of rows) byOwner.set(r.owner_id, [...(byOwner.get(r.owner_id) ?? []), r]);
  const batches: { own: string[]; rows: any[] }[] = [];
  for (const [owner, rs] of byOwner) { const own = ownTopics(owner); for (let i = 0; i < rs.length; i += size) batches.push({ own, rows: rs.slice(i, i + size) }); }
  await pool(batches, be === "cli" ? 2 : be === "api" ? 4 : 1, async ({ own, rows: batch }) => {
    let tags: (Tags | null)[] = batch.map(() => null);
    if (be !== "none") {
      try { tags = await tagItems(batch, own); }
      catch (e) { console.warn(`tag batch of ${batch.length} failed, using local:`, String(e).slice(0, 160)); }
    }
    db.transaction(() => batch.forEach((r, i) => save(r, tags[i] ?? tagLocally(r, own))))();
  });
}

export const tagsOf = (s: string) => json<Partial<Tags>>(s, {});
