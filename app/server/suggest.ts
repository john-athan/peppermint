// Sources for you: Claude reads your palate, research and reading habits and names feeds you do not have yet. A model
// will invent feed URLs, so every one is fetched and parsed before you see it; what does not parse, or what you
// already have, is left out. Added from here, a source is on trial for a week: its stories get a slot in the edition
// ("New to you"), and what you do with them says whether it stays.
import { db, json, now, setting, setSetting } from "./db";
import { askJSON } from "./llm";
import { feed } from "./connectors";
import { pool } from "./connectors/util";

export const TRIAL_MS = 7 * 86400_000;
const FRESH_MS = 12 * 3600_000;

export type Suggestion = { name: string; site: string; feed: string; lang: "en" | "de"; about: string; stretch: boolean; sample: string[]; perDay: number };
type Picks = { sources: { name: string; site: string; feed: string; lang: "en" | "de"; why: string; stretch: boolean }[] };

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["sources"],
  properties: { sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "site", "feed", "lang", "why", "stretch"], properties: {
    name: { type: "string" }, site: { type: "string" }, feed: { type: "string" }, lang: { type: "string", enum: ["en", "de"] }, why: { type: "string" }, stretch: { type: "boolean" },
  } } } },
};

const SYSTEM = `You suggest news sources for one reader of a personal news app. The app reads RSS, Atom and JSON feeds.
Suggest 14 sources the reader does not have yet: 10 close to what they like and read, and 4 marked stretch: good sources one step outside their habits (a neighbouring field, a different kind of outlet, the other language), so their reading does not narrow. Never suggest anything about the subjects they muted, and nothing that mostly covers them.
Each source needs its exact feed URL. Only name feeds you are confident exist; prefer a site's main or section feed. Prefer sources that publish at most a few items a day and whose articles can be read without a subscription. No aggregators of other sources, no podcasts or YouTube, and no second outlet of a newsroom they already read (tz.de is merkur.de).
"why" is one short sentence for the reader, in English, naming what in their palate it serves, e.g. "Munich city politics firsthand, without the crime and traffic pages". "site" is the bare host, e.g. lwn.net.`;

const host = (u: string) => { try { return new URL(/^https?:/.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** What Claude is told: the palate, what was opened from which source, research topics and the sources there are. */
export function profile(owner: number) {
  const aff = db.query("SELECT kind, name, weight FROM affinities WHERE owner_id = ? AND kind IN ('topic','place','person','org') ORDER BY weight DESC").all(owner) as { kind: string; name: string; weight: number }[];
  const liked = aff.filter(a => a.weight >= 0.8).slice(0, 16).map(a => `${a.name} (${a.kind}, ${a.weight.toFixed(1)})`);
  const muted = aff.filter(a => a.weight <= -1).map(a => a.name);
  const sources = db.query("SELECT id, name, kind, config FROM sources WHERE owner_id = ? AND kind != 'agent'").all(owner) as { id: number; name: string; kind: string; config: string }[];
  const reads = db.query(`SELECT i.source_id, count(DISTINCT sg.story_id) AS n FROM signals sg JOIN items i ON i.story_id = sg.story_id
    WHERE sg.owner_id = ? AND sg.kind IN ('open','read') GROUP BY i.source_id`).all(owner) as { source_id: number; n: number }[];
  const have = sources.map(s => `${s.name} [${s.kind}${(json<any>(s.config, {}).feeds ?? []).map((f: string) => " " + host(f)).join("")}]: opened ${reads.find(r => r.source_id === s.id)?.n ?? 0} stories`);
  const research = [
    ...(db.query("SELECT title FROM tasks WHERE owner_id = ? AND kind = 'dossier' AND status != 'dismissed' AND title != '' ORDER BY updated_at DESC LIMIT 10").all(owner) as { title: string }[]).map(r => r.title),
    ...(db.query("SELECT coalesce(s.title_en, s.title) AS t FROM follows f JOIN stories s ON s.id = f.story_id WHERE f.owner_id = ? ORDER BY f.at DESC LIMIT 10").all(owner) as { t: string }[]).map(r => r.t),
  ];
  const langs = setting<string[]>(owner, "langs", ["en", "de"]);
  return { liked, muted, have, research, langs, sources };
}

function haveFeeds(owner: number) {
  const rows = db.query("SELECT config FROM sources WHERE owner_id = ?").all(owner) as { config: string }[];
  const feeds = new Set<string>(), hosts = new Set<string>();
  for (const r of rows) for (const f of json<any>(r.config, {}).feeds ?? []) { feeds.add(f); hosts.add(host(f).replace(/^(rss|feeds?|newsfeed)\./, "")); }
  return { feeds, hosts };
}

/** Asks Claude, then keeps only the suggestions whose feed (or site) parses and that you do not have. Cached for 12 h. */
export async function suggestSources(owner: number, fresh = false): Promise<{ at: number; list: Suggestion[] }> {
  const cached = setting<{ at: number; list: Suggestion[] } | null>(owner, "suggestions", null);
  if (cached && !fresh && now() - cached.at < FRESH_MS) return cached;
  const p = profile(owner);
  const user = [
    `Likes (weight on a -3..3 scale): ${p.liked.join("; ") || "nothing learned yet"}`,
    `Muted, never suggest: ${p.muted.join(", ") || "nothing"}`,
    `Reads in: ${p.langs.join(", ")}`,
    `Research topics and followed stories: ${p.research.join("; ") || "none yet"}`,
    `Sources they have, and how many stories they opened from each:\n${p.have.join("\n")}`,
    cached?.list.length ? `Suggested last time (pick others): ${cached.list.map(s => s.name).join(", ")}` : "",
  ].filter(Boolean).join("\n\n");
  const r = await askJSON<Picks>(SYSTEM, user, SCHEMA, { effort: "medium" });
  const { feeds, hosts } = haveFeeds(owner);
  const checked = await pool((r?.sources ?? []).slice(0, 16), 4, async s => {
    if (hosts.has(host(s.site)) || feeds.has(s.feed)) return null;
    // the feed as named, else whatever feed the site itself points to
    const d = await feed.discover(s.feed).catch(() => feed.discover(s.site));
    const url = d.options[0]?.key;
    if (!url || feeds.has(url) || !d.sample.length) return null;
    return { name: s.name.slice(0, 60), site: host(s.site) || host(url), feed: url, lang: s.lang, about: s.why.slice(0, 160), stretch: !!s.stretch, sample: d.sample.slice(0, 3).map(x => x.title), perDay: d.options[0].perDay } satisfies Suggestion;
  });
  const seen = new Set<string>();
  const list = checked.filter((s): s is Suggestion => !!s && !seen.has(s.feed) && !!seen.add(s.feed));
  const out = { at: now(), list };
  setSetting(owner, "suggestions", out);
  return out;
}

/** Sources on trial, with what you did with their stories since they were added. */
export function trials(owner: number) {
  const rows = db.query("SELECT id, name, created_at, trial_until FROM sources WHERE owner_id = ? AND trial_until IS NOT NULL").all(owner) as { id: number; name: string; created_at: number; trial_until: number }[];
  const shown = db.query(`SELECT count(DISTINCT ei.story_id) AS n FROM edition_items ei JOIN items i ON i.story_id = ei.story_id WHERE i.source_id = ?`);
  const did = db.query(`SELECT count(DISTINCT sg.story_id) AS n FROM signals sg JOIN items i ON i.story_id = sg.story_id WHERE i.source_id = ? AND sg.owner_id = ? AND sg.kind IN (SELECT value FROM json_each(?))`);
  return new Map(rows.map(r => [r.id, {
    until: r.trial_until, over: r.trial_until <= now(),
    shown: (shown.get(r.id) as { n: number }).n,
    opened: (did.get(r.id, owner, '["open","read"]') as { n: number }).n,
    hidden: (did.get(r.id, owner, '["hide","less"]') as { n: number }).n,
  }]));
}

/** Story ids from sources whose trial is still running. */
export function trialStories(owner: number, ids: number[]) {
  if (!ids.length) return new Set<number>();
  const rows = db.query(`SELECT DISTINCT i.story_id FROM items i JOIN sources s ON s.id = i.source_id WHERE s.owner_id = ? AND s.trial_until > ?
    AND i.story_id IN (${ids.map(() => "?").join(",")})`).all(owner, now(), ...ids) as { story_id: number }[];
  return new Set(rows.map(r => r.story_id));
}
