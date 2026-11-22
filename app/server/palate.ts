// The palate: hard rules, readable weights, a finite edition. Every score carries its reasons.
import { AGENT_STORIES, db, json, now, setting } from "./db";

import type { Reason } from "../shared/types";
import { storyUnreadable, unreadable } from "./material";
import { trialStories } from "./suggest";
export type { Reason };
export type Scored = { story_id: number; score: number; reasons: Reason[]; topics: string[]; lead: string | null; verdict: "always" | "never" | "score"; never?: string };

const TRUST = [-0.1, 0.05, 0.2];
// topics so close that muting one mutes the other for "Something different" (it never offers sports to a reader who muted football)
const NEAR: Record<string, string> = { Sports: "Football", Football: "Sports", Traffic: "Transport", Transport: "Traffic" };
const STEP = 0.16; // one step on the -3..+3 weight scale

export type Affinity = { kind: string; name: string; weight: number; manual: number; seen: number };
export function affinities(owner: number) {
  const rows = db.query("SELECT kind, name, weight, manual, seen FROM affinities WHERE owner_id = ?").all(owner) as Affinity[];
  const m = new Map<string, Affinity>(); for (const r of rows) m.set(r.kind + ":" + r.name.toLowerCase(), r); return m;
}
export function rules(owner: number) {
  return db.query("SELECT id, action, kind, value FROM rules WHERE owner_id = ? ORDER BY created_at").all(owner) as { id: number; action: string; kind: string; value: string }[];
}

type StoryRow = { id: number; title: string; title_en?: string | null; tags: string; last_at: number; item_count: number; lang: string | null };
export function scoreStories(owner: number, stories: StoryRow[]): Scored[] {
  const aff = affinities(owner); const rs = rules(owner);
  const langs = setting<string[]>(owner, "langs", ["en", "de"]);
  const srcRows = db.query(`SELECT i.story_id, s.name, s.trust, s.kind, i.meta FROM items i JOIN sources s ON s.id = i.source_id WHERE i.story_id IN (${stories.map(() => "?").join(",") || "NULL"})`).all(...stories.map(s => s.id)) as any[];
  const bySrc = new Map<number, any[]>(); for (const r of srcRows) { (bySrc.get(r.story_id) ?? bySrc.set(r.story_id, []).get(r.story_id)!).push(r); }
  return stories.map(st => {
    const t = json<any>(st.tags, {});
    const topics: string[] = t.topics ?? [];
    const ents: [string, string][] = [...(t.people ?? []).map((n: string) => ["person", n]), ...(t.orgs ?? []).map((n: string) => ["org", n]), ...(t.places ?? []).map((n: string) => ["place", n])];
    const srcs = bySrc.get(st.id) ?? [];
    const subjects: [string, string][] = [...topics.map(x => ["topic", x] as [string, string]), ...ents, ...srcs.map(s => ["source", s.name] as [string, string])];
    const match = (kind: string, value: string) => subjects.some(([k, n]) => (kind === k || (kind === "place" && k === "place")) && n.toLowerCase() === value.toLowerCase())
      || (kind === "word" && st.title.toLowerCase().includes(value.toLowerCase()));
    const reasons: Reason[] = [];
    let never: string | undefined, always = false;
    for (const r of rs) {
      if (!match(r.kind, r.value)) continue;
      if (r.action === "never") never = r.value;
      if (r.action === "always") always = true;
      if (r.action === "boost") reasons.push({ label: `Boost: ${r.value}`, v: 0.25 });
      if (r.action === "mute") reasons.push({ label: `Mute: ${r.value}`, v: -0.25 });
    }
    // topic: strongest liked topic plus strongest disliked, so one bad topic still counts
    const tw = topics.map(x => ({ x, w: aff.get("topic:" + x.toLowerCase())?.weight ?? 0 }));
    const pos = tw.filter(a => a.w > 0).sort((a, b) => b.w - a.w)[0]; const neg = tw.filter(a => a.w < 0).sort((a, b) => a.w - b.w)[0];
    if (pos) reasons.push({ label: `Topic: ${pos.x}`, v: pos.w * STEP });
    if (neg) reasons.push({ label: `Topic: ${neg.x}`, v: neg.w * STEP });
    for (const [kind, n] of ents) {
      const a = aff.get(kind + ":" + n.toLowerCase());
      if (a && Math.abs(a.weight) >= 0.3) reasons.push({ label: `${kind === "place" ? "Place" : kind === "person" ? "Person" : "Org"}: ${n}`, v: a.weight * STEP * 0.9 });
    }
    const trust = Math.max(...srcs.map(s => TRUST[s.trust] ?? 0), -0.1);
    const srcName = srcs[0]?.name ?? "";
    if (srcs.length) reasons.push({ label: `Source trust: ${srcName}`, v: trust });
    const srcAff = aff.get("source:" + srcName.toLowerCase());
    if (srcAff && Math.abs(srcAff.weight) >= 0.3) reasons.push({ label: `You and ${srcName}`, v: srcAff.weight * STEP * 0.6 });
    const ageH = (now() - st.last_at) / 3600_000;
    reasons.push({ label: ageH < 6 ? "Fresh: last few hours" : "Freshness", v: Math.max(-0.1, 0.18 * (1 - ageH / 24)) });
    const distinctSources = new Set(srcs.map(s => s.name)).size;
    if (st.item_count > 1) reasons.push({ label: `Story from ${st.item_count} reports`, v: Math.min(0.16, 0.05 * (st.item_count - 1) + (distinctSources > 1 ? 0.04 : 0)) });
    const pts = Math.max(0, ...srcs.map(s => json<any>(s.meta, {}).points ?? 0));
    if (pts) reasons.push({ label: `${pts} points on HN`, v: Math.min(0.18, Math.log10(Math.max(1, pts / 100)) * 0.18) });
    const lang = t.lang ?? st.lang;
    if (lang && !langs.includes(lang)) reasons.push({ label: `Language: ${lang}`, v: -0.15 });
    else if (lang === "de") reasons.push({ label: "Language: German", v: -0.04 });
    if (t.opinion) reasons.push({ label: "Mostly opinion", v: -0.06 });
    // research found nothing to read behind the headline: it may still show, slim, but rarely leads
    if (unreadable(srcs.map(s => s.meta))) reasons.push({ label: "Only the headline could be read", v: -0.3 });
    // contributions add up on a readable scale; a logistic squash keeps the score in 0..1 without piling up at 1
    const raw = reasons.reduce((a, r) => a + r.v, 0);
    const score = 1 / (1 + Math.exp(-(raw - 0.15) * 4));
    reasons.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
    return { story_id: st.id, score, reasons: reasons.filter(r => Math.abs(r.v) >= 0.01).slice(0, 6), topics, lead: pos?.x ?? topics[0] ?? null, verdict: never ? "never" : always ? "always" : "score", never };
  });
}

/* ---------- learning from signals ---------- */
// seen: scrolled past on Today without opening, a faint no. click: followed a link to the source. unhide: undoes a hide.
const SIGNAL_W: Record<string, number> = { open: 0.12, read: 0.25, lens: 0.05, more: 0.6, less: -0.6, rescue: 0.45, skip: -0.04, duel_win: 0.3, duel_lose: -0.15, hide: -0.5,
  seen: -0.02, click: 0.1, pin: 0.3, unpin: 0, unhide: 0.5 };
export const SIGNAL_KINDS = [...Object.keys(SIGNAL_W), "dwell"];
/** Reading time counts once it is real reading: nothing under 15 s, then up to the weight of an explicit "more". */
const dwellWeight = (ms: number) => ms < 15_000 ? 0 : Math.min(0.4, 0.1 + ms / 600_000);
export function applySignal(owner: number, storyId: number | null, kind: string, meta: { subjects?: string[]; ms?: number } = {}) {
  // scrolling past a story that had nothing to read says nothing about its subject
  const mute = (kind === "seen" || kind === "skip") && !!storyId && storyUnreadable(storyId);
  const w = mute ? 0 : kind === "dwell" ? dwellWeight(meta.ms ?? 0) : SIGNAL_W[kind];
  db.query("INSERT INTO signals (owner_id, story_id, kind, value, meta, at) VALUES (?, ?, ?, ?, ?, ?)").run(owner, storyId, kind, w ?? 0, JSON.stringify(meta), now());
  if (!w || !storyId) return [];
  const st = db.query("SELECT tags FROM stories WHERE id = ?").get(storyId) as { tags: string } | null; if (!st) return [];
  const t = json<any>(st.tags, {});
  // explicit tune with chosen subjects moves exactly those; implicit signals spread thinly
  const chosen = meta.subjects?.length ? meta.subjects.map(s => s.split(":") as [string, string]) : [
    ...(t.topics ?? []).map((x: string) => ["topic", x]), ...(t.places ?? []).slice(0, 2).map((x: string) => ["place", x]), ...(t.people ?? []).slice(0, 2).map((x: string) => ["person", x]),
  ];
  const scale = meta.subjects?.length ? 1 : 0.5;
  const up = db.query(`INSERT INTO affinities (owner_id, kind, name, weight, seen, updated_at) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(owner_id, kind, name) DO UPDATE SET weight = max(-3, min(3, weight + excluded.weight)), seen = seen + 1, updated_at = excluded.updated_at`);
  const moved: { kind: string; name: string; delta: number }[] = [];
  for (const [kind, name] of chosen) { const d = w * scale; up.run(owner, kind, name, d, now()); moved.push({ kind, name, delta: d }); }
  return moved;
}

/* ---------- editions ---------- */
const TZ = "Europe/Berlin";
export function slotNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => parts.find(p => p.type === t)!.value;
  const hour = Number(g("hour"));
  return { day: `${g("year")}-${g("month")}-${g("day")}`, slot: hour >= 17 ? "evening" : "morning" };
}

/** The stories an edition chooses from: active in the last 24 h, not shown by an earlier edition, not the agent's own.
 *  `edId` is this slot's edition; without one, every edition counts as earlier. */
export function editionPool(owner: number, edId = 0): StoryRow[] {
  return db.query(`SELECT id, title, title_en, tags, last_at, item_count, lang FROM stories WHERE owner_id = ? AND last_at > ?
    AND id NOT IN (SELECT ei.story_id FROM edition_items ei JOIN editions e ON e.id = ei.edition_id WHERE e.owner_id = ? AND e.id != ?)
    AND id NOT IN (${AGENT_STORIES})`).all(owner, now() - 24 * 3600_000, owner, edId) as StoryRow[];
}
/** This slot's edition id, 0 when it is not built yet. */
export function currentEditionId(owner: number) {
  const { day, slot } = slotNow();
  return (db.query("SELECT id FROM editions WHERE owner_id = ? AND day = ? AND slot = ?").get(owner, day, slot) as { id: number } | null)?.id ?? 0;
}

/* Claude's order (server/judge.ts) decides once it has judged in the last day: the score becomes its place in that
 * order (1 for the first, 0 for a story it left out), and the palate's reasons stay below it. Without Claude, or before
 * its first run, the palate's score decides as before. */
type Judgement = { rank: number | null; of: number; at: number };
function judgements(owner: number, ids: number[]): Map<number, Judgement> | null {
  if (!db.query("SELECT 1 FROM judged WHERE owner_id = ? AND at > ?").get(owner, now() - 24 * 3600_000)) return null;
  const rows = db.query(`SELECT story_id, rank, of, at FROM judged WHERE owner_id = ? AND story_id IN (${ids.map(() => "?").join(",") || "NULL"})`).all(owner, ...ids) as (Judgement & { story_id: number })[];
  return new Map(rows.map(r => [r.story_id, r]));
}
const judgedScore = (j: Judgement) => j.rank ? 1 - (j.rank - 1) / j.of : 0;
function withJudgement(s: Scored, j: Judgement | undefined): Scored {
  if (!j?.rank) return s;
  const v = judgedScore(j);
  return { ...s, score: v, reasons: [{ label: `Claude's pick: ${j.rank} of ${j.of}`, v }, ...s.reasons].slice(0, 6) };
}

export function buildEdition(owner: number, { byScore = false }: { byScore?: boolean } = {}) {
  const { day, slot } = slotNow();
  const budget = setting<number>(owner, "budget", 12), threshold = setting<number>(owner, "threshold", 0.55);
  let ed = db.query("SELECT * FROM editions WHERE owner_id = ? AND day = ? AND slot = ?").get(owner, day, slot) as any;
  if (!ed) ed = db.query("INSERT INTO editions (owner_id, slot, day, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *").get(owner, slot, day, now(), now());
  const stories = editionPool(owner, ed.id);
  const judged = byScore ? null : judgements(owner, stories.map(s => s.id));
  const scored = scoreStories(owner, stories).map(s => withJudgement(s, judged?.get(s.story_id))).sort((a, b) => b.score - a.score);
  const prev = new Set((db.query("SELECT story_id FROM edition_items WHERE edition_id = ?").all(ed.id) as any[]).map(r => r.story_id));
  // stories you already touched stay put; everything else is re-ranked on every build
  const kept = new Map((db.query(`SELECT ei.story_id, ei.pinned FROM edition_items ei WHERE ei.edition_id = ? AND (ei.pinned = 1 OR EXISTS
    (SELECT 1 FROM signals sg WHERE sg.story_id = ei.story_id AND sg.kind IN ('open', 'read', 'lens', 'more', 'rescue')))`).all(ed.id) as any[]).map(r => [r.story_id, r]));
  const chosen: Scored[] = []; const perTopic = new Map<string, number>(); const cut: { s: Scored; reason: string }[] = [];
  const take = (s: Scored) => { chosen.push(s); if (s.lead) perTopic.set(s.lead, (perTopic.get(s.lead) ?? 0) + 1); };
  for (const s of scored) if (kept.has(s.story_id) && s.verdict !== "never") take(s);
  for (const s of scored) {
    if (kept.has(s.story_id) && !(s.verdict === "never" && !kept.get(s.story_id).pinned)) continue;
    if (s.verdict === "never") { cut.push({ s, reason: `Never: ${s.never}` }); continue; }
    if (s.verdict === "always") { take(s); continue; }
    if (judged) {
      const j = judged.get(s.story_id);
      if (!j) { cut.push({ s, reason: "Claude has not read it yet" }); continue; }
      if (!j.rank) { cut.push({ s, reason: "Claude left it out" }); continue; }
    } else {
      if (s.score < threshold) { cut.push({ s, reason: "Under your threshold" }); continue; }
      if (s.lead && (perTopic.get(s.lead) ?? 0) >= 2) { cut.push({ s, reason: `Already two on ${s.lead}` }); continue; }
    }
    if (chosen.length >= budget) { cut.push({ s, reason: "Edition full" }); continue; }
    take(s);
  }
  // one local story per edition when one clears the threshold
  const isLocal = (s: Scored) => s.reasons.some(r => r.label.startsWith("Place:") && r.v > 0);
  if (!judged && !chosen.some(isLocal)) {
    const local = cut.find(c => isLocal(c.s) && c.s.score >= threshold && c.s.verdict !== "never");
    const drop = [...chosen].reverse().find(c => !kept.has(c.story_id) && c.verdict !== "always");
    if (local && drop && chosen.length >= budget) {
      chosen.splice(chosen.indexOf(drop), 1); cut.push({ s: drop, reason: "Edition full" });
      cut.splice(cut.indexOf(local), 1); chosen.push(local.s);
    } else if (local) { cut.splice(cut.indexOf(local), 1); chosen.push(local.s); }
  }
  // New to you: up to two stories from sources on trial get a place even under the threshold, so a source you are
  // trying is seen and judged by what you do with it; and one story from outside your usual subjects, so the edition
  // does not narrow to what it already knows you like. Neither pushes a chosen story out.
  const slots = new Map<number, "trial" | "different">();
  const onTrial = trialStories(owner, scored.map(s => s.story_id));
  for (const s of chosen) if (onTrial.has(s.story_id)) slots.set(s.story_id, "trial");
  const usable = (c: { s: Scored; reason: string }) => !c.reason.startsWith("Never") && c.reason !== "Claude left it out" && !c.s.reasons.some(r => r.label.startsWith("Only the headline"));
  for (const c of cut.filter(c => usable(c) && onTrial.has(c.s.story_id) && c.s.score >= 0.3).slice(0, Math.max(0, 2 - slots.size))) {
    cut.splice(cut.indexOf(c), 1); chosen.push(c.s); slots.set(c.s.story_id, "trial");
  }
  const aff = affinities(owner), w = (t: string) => aff.get("topic:" + t.toLowerCase())?.weight ?? 0;
  const usual = new Set(chosen.flatMap(c => c.topics));
  const different = !judged && cut.find(c => usable(c) && c.reason === "Under your threshold" && c.s.score >= threshold - 0.2 && c.s.topics.length
    && c.s.topics.every(t => w(t) < 1 && w(t) > -0.5 && w(NEAR[t] ?? t) > -0.5 && !usual.has(t)));
  if (different) { cut.splice(cut.indexOf(different), 1); chosen.push(different.s); slots.set(different.s.story_id, "different"); }
  const dupes = (db.query(`SELECT coalesce(sum(item_count - 1), 0) AS n FROM stories WHERE id IN (${scored.map(() => "?").join(",") || "NULL"})`).get(...scored.map(s => s.story_id)) as { n: number }).n;
  db.transaction(() => {
    // stories that a never rule now catches leave the edition, unless you rescued them by hand
    const keep = new Set([...chosen.map(c => c.story_id), ...[...kept.values()].filter(k => k.pinned).map(k => k.story_id)]);
    for (const r of db.query("SELECT story_id FROM edition_items WHERE edition_id = ?").all(ed.id) as any[]) if (!keep.has(r.story_id)) db.query("DELETE FROM edition_items WHERE edition_id = ? AND story_id = ?").run(ed.id, r.story_id);
    const ins = db.query(`INSERT INTO edition_items (edition_id, story_id, rank, score, reasons, pinned, added_at, slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(edition_id, story_id) DO UPDATE SET rank = excluded.rank, score = excluded.score, reasons = excluded.reasons, slot = excluded.slot`);
    const ordered = [...chosen].sort((a, b) => (b.verdict === "always" ? 1 : 0) - (a.verdict === "always" ? 1 : 0) || b.score - a.score);
    ordered.forEach((s, i) => ins.run(ed.id, s.story_id, i, s.score, JSON.stringify(s.reasons), s.verdict === "always" ? 1 : 0, now(), slots.get(s.story_id) ?? null));
    db.query(`WITH r AS (SELECT story_id, row_number() OVER (ORDER BY score DESC) - 1 AS rn FROM edition_items WHERE edition_id = ?)
      UPDATE edition_items SET rank = (SELECT rn FROM r WHERE r.story_id = edition_items.story_id) WHERE edition_id = ?`).run(ed.id, ed.id);
    db.query("DELETE FROM edition_cut WHERE edition_id = ?").run(ed.id);
    const ic = db.query("INSERT INTO edition_cut (edition_id, story_id, reason, score) VALUES (?, ?, ?, ?)");
    for (const c of cut) ic.run(ed.id, c.s.story_id, c.reason, c.s.score);
    const items = (db.query(`SELECT count(*) AS n FROM items WHERE owner_id = ? AND story_id IN (${scored.map(() => "?").join(",") || "NULL"})`).get(owner, ...scored.map(s => s.story_id)) as { n: number }).n;
    db.query("UPDATE editions SET updated_at = ?, considered = ?, cut = ? WHERE id = ?").run(now(), items, JSON.stringify({ merged: dupes }), ed.id);
  })();
  return { id: ed.id as number, added: chosen.filter(s => !prev.has(s.story_id)).length, cut: cut.length };
}

/** Today never ends at the edition: after it come the stories of the last week, a page at a time. Once Claude has
 *  judged, they follow its order: its latest run first, then what earlier runs kept, then what it has not read yet if
 *  the palate rates it likely interesting; what it left out stays out. Without Claude the palate's score orders them
 *  (a little below the edition's threshold, best first). Mute rules hold; anything you saw, dismissed or saved stays
 *  out, as does what the client already shows. */
export function feedPage(owner: number, shown: Set<number>, limit = 8): { scored: Scored[]; more: boolean } {
  const threshold = setting<number>(owner, "threshold", 0.55), floor = Math.max(0.3, threshold - 0.15);
  const stories = (db.query(`SELECT id, title, tags, last_at, item_count, lang FROM stories st WHERE owner_id = ? AND last_at > ?
    AND EXISTS (SELECT 1 FROM items i WHERE i.story_id = st.id)
    AND id NOT IN (SELECT story_id FROM pins WHERE owner_id = ?)
    AND id NOT IN (SELECT story_id FROM signals WHERE owner_id = ? AND kind = 'seen' AND story_id IS NOT NULL)
    AND id NOT IN (${AGENT_STORIES})
    AND id NOT IN (SELECT h.story_id FROM signals h WHERE h.owner_id = ? AND h.kind = 'hide' AND h.story_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM signals u WHERE u.owner_id = h.owner_id AND u.story_id = h.story_id AND u.kind = 'unhide' AND u.at >= h.at))`)
    .all(owner, now() - 7 * 86400_000, owner, owner, owner) as StoryRow[]).filter(s => !shown.has(s.id));
  const judged = judgements(owner, stories.map(s => s.id));
  if (judged) {
    const latest = Math.max(0, ...[...judged.values()].map(j => j.at));
    const tier = (s: Scored) => { const j = judged.get(s.story_id); return s.verdict === "always" ? 0 : !j ? 3 : j.at === latest ? 1 : 2; };
    const ranked = scoreStories(owner, stories).filter(s => {
      if (s.verdict === "never") return false;
      const j = judged.get(s.story_id);
      return s.verdict === "always" || (j ? !!j.rank : s.score >= floor);
    }).map(s => withJudgement(s, judged.get(s.story_id))).sort((a, b) => tier(a) - tier(b) || b.score - a.score);
    return { scored: ranked.slice(0, limit), more: ranked.length > limit };
  }
  const ranked = scoreStories(owner, stories).filter(s => s.verdict !== "never" && (s.verdict === "always" || s.score >= floor)).sort((a, b) => b.score - a.score);
  // variety: a page takes at most two stories per lead topic first, then fills up with the best of the rest, so a
  // palate that loves one topic still gets full pages
  const page: Scored[] = [], perTopic = new Map<string, number>();
  for (const s of ranked) {
    if (page.length >= limit) break;
    if (s.lead && (perTopic.get(s.lead) ?? 0) >= 2) continue;
    page.push(s); if (s.lead) perTopic.set(s.lead, (perTopic.get(s.lead) ?? 0) + 1);
  }
  for (const s of ranked) { if (page.length >= limit) break; if (!page.includes(s)) page.push(s); }
  return { scored: page, more: ranked.length > page.length };
}
