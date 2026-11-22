// Official EU sources without a feed: ECHA's obligation lists and the Commission's consultations ("Have your say").
//
// ECHA: echa.europa.eu refuses servers (403 even to a browser's user agent), but ECHA CHEM, its newer site, answers its
// own JSON API (the one behind https://chem.echa.europa.eu/obligation-lists/candidateList) to a browser's user agent.
// Each list is small (about 250, 80 and 60 entries), so a pull reads it whole and compares it with the last one: new and
// changed entries become an item. The first pull shows only the latest additions, the rest is the baseline.
//
// Have your say: the search API behind https://ec.europa.eu/info/law/better-regulation/have-your-say answers JSON. A
// source follows a keyword; every time an initiative opens a feedback period (a call for evidence, a public
// consultation, a draft act), that becomes an item with the deadline.
import type { Connector } from "./index";
import { get, stripTags, type RawItem } from "./util";

const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
const getJson = async (url: string) => JSON.parse((await get(url, { timeout: 20_000, headers: { "user-agent": BROWSER_UA, accept: "application/json" } })).text);

/* ---------- ECHA obligation lists ---------- */
const ECHA = "https://chem.echa.europa.eu/api-obligation-list/v1";
export const ECHA_LISTS = {
  candidate: { path: "candidateList", name: "ECHA Candidate List", about: "Substances of very high concern (SVHC): every new entry", page: "https://chem.echa.europa.eu/obligation-lists/candidateList" },
  restriction: { path: "restrictionList", name: "REACH restrictions", about: "Annex XVII: new and amended entries", page: "https://chem.echa.europa.eu/obligation-lists/restrictionList" },
  authorisation: { path: "authorisationList", name: "REACH Authorisation List", about: "Annex XIV: new entries and changed sunset dates", page: "https://chem.echa.europa.eu/obligation-lists/authorisationList" },
} as const;
export type EchaList = keyof typeof ECHA_LISTS;
export type EchaRow = {
  rmlId: string; substanceName: string[]; ecNumber?: string[]; casNumber?: string[]; dateOfInclusion?: string; reasonForInclusion?: string[];
  entryNumber?: string; conditionsPath?: string; latestApplicationDate?: string; sunsetDate?: string; decision?: { decisionPath?: string }[];
};
type EchaCursor = { seen?: Record<string, string> };

export async function echaRows(list: EchaList): Promise<EchaRow[]> {
  const rows: EchaRow[] = [];
  for (let page = 1; page <= 10; page++) {
    const j = await getJson(`${ECHA}/${ECHA_LISTS[list].path}?pageSize=100&pageIndex=${page}`);
    rows.push(...(j.items ?? []));
    if (page >= (j.state?.totalPages ?? 1)) break;
  }
  if (!rows.length) throw new Error("ECHA sent an empty list.");
  return rows;
}

/** "04-Feb-2026" to epoch ms (noon UTC, so no zone moves it to another day), or null. */
export function echaDate(s: string | undefined): number | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s?.trim() ?? "");
  const mon = m ? ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(m[2].toLowerCase()) : -1;
  return m && mon >= 0 ? Date.UTC(Number(m[3]), mon, Number(m[1]), 12) : null;
}
const ids = (r: EchaRow) => { const ec = (r.ecNumber ?? []).filter(x => x && x !== "-"), cas = (r.casNumber ?? []).filter(x => x && x !== "-"); return [ec.length ? `EC ${ec.join(", ")}` : "", cas.length ? `CAS ${cas.join(", ")}` : ""].filter(Boolean).join(", "); };
const nameOf = (r: EchaRow) => r.substanceName.filter(Boolean).join("; ") || r.rmlId;
/** What identifies an entry, and what, when it changes, makes the entry worth a note. */
const keyOf = (list: EchaList, r: EchaRow) => list === "candidate" ? r.rmlId : `${r.entryNumber ?? ""}|${r.rmlId}`;
const sigOf = (list: EchaList, r: EchaRow) => list === "candidate" ? r.dateOfInclusion ?? "" : list === "restriction" ? r.conditionsPath ?? "" : `${r.latestApplicationDate ?? ""}|${r.sunsetDate ?? ""}`;
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** New and changed entries since the last pull, as items. Pure: the pull and the tests share it. */
export function echaChanges(list: EchaList, rows: EchaRow[], cursor: EchaCursor, at: number): { items: RawItem[]; cursor: EchaCursor } {
  const L = ECHA_LISTS[list], first = !cursor.seen;
  const seen: Record<string, string> = {};
  for (const r of rows) seen[keyOf(list, r)] = sigOf(list, r);
  const items: RawItem[] = [];
  if (list === "candidate") {
    // one item per day of inclusion; the first pull shows only the latest day
    const fresh = rows.filter(r => !cursor.seen?.[keyOf(list, r)]);
    const byDay = new Map<string, EchaRow[]>();
    for (const r of first ? rows : fresh) { const d = r.dateOfInclusion ?? "?"; byDay.set(d, [...(byDay.get(d) ?? []), r]); }
    const days = [...byDay.keys()].sort((a, b) => (echaDate(b) ?? 0) - (echaDate(a) ?? 0));
    for (const d of first ? days.slice(0, 1) : days) {
      const rs = byDay.get(d)!, when = echaDate(d) ?? at, n = rs.length;
      items.push({
        ext_id: `candidate:${d}:${rs.map(r => r.rmlId).sort().join(",")}`, url: L.page,
        title: `Candidate List: ${n === 1 ? nameOf(rs[0]) : `${n} substances`} added (${fmtDay(when)})`, author: "ECHA",
        summary: rs.map(r => `${nameOf(r)}: ${(r.reasonForInclusion ?? []).join("; ")}`).join(" · ").slice(0, 600),
        body: [`ECHA added ${n === 1 ? "this substance" : `these ${n} substances`} to the Candidate List of substances of very high concern on ${fmtDay(when)}. From that day, an article with more than 0.1 % by weight of it needs information for customers (REACH Article 33) and a SCIP notification (Waste Framework Directive).`, "",
          ...rs.flatMap(r => [`${nameOf(r)}${ids(r) ? ` (${ids(r)})` : ""}`, `Reason: ${(r.reasonForInclusion ?? []).join("; ") || "not given"}`, ...(r.decision?.[0]?.decisionPath ? [`Decision: ${r.decision[0].decisionPath}`] : []), ""])].join("\n").trim(),
        lang: "en", published_at: when, meta: { site: "chem.echa.europa.eu", echa: list },
      });
    }
  } else if (!first) {
    // restriction and authorisation lists: one item per pull with what was added and what changed
    const added = rows.filter(r => !(keyOf(list, r) in cursor.seen!));
    const changed = rows.filter(r => keyOf(list, r) in cursor.seen! && cursor.seen![keyOf(list, r)] !== sigOf(list, r));
    if (added.length || changed.length) {
      const line = (r: EchaRow) => list === "restriction"
        ? `Entry ${r.entryNumber}: ${nameOf(r)}${ids(r) ? ` (${ids(r)})` : ""}${r.conditionsPath ? `\nConditions: ${r.conditionsPath}` : ""}`
        : `Entry ${r.entryNumber}: ${nameOf(r)}${ids(r) ? ` (${ids(r)})` : ""}\nLatest application date ${r.latestApplicationDate ?? "not set"}, sunset date ${r.sunsetDate ?? "not set"}`;
      const what = [added.length ? `${added.length} added` : "", changed.length ? `${changed.length} amended` : ""].filter(Boolean).join(", ");
      const one = added.length + changed.length === 1 ? [...added, ...changed][0] : null;
      items.push({
        ext_id: `${list}:${at}`, url: L.page, author: "ECHA", lang: "en", published_at: at, meta: { site: "chem.echa.europa.eu", echa: list },
        title: `${L.name}: ${one ? `${added.length ? "new" : "amended"} entry ${one.entryNumber}, ${nameOf(one)}` : what}`,
        summary: [...added, ...changed].map(nameOf).join(" · ").slice(0, 600),
        body: [...(added.length ? ["Added:", ...added.map(line), ""] : []), ...(changed.length ? ["Amended:", ...changed.map(line)] : [])].join("\n").trim(),
      });
    }
  }
  return { items, cursor: { seen } };
}

export const echa: Connector = {
  kind: "echa", label: "ECHA",
  async discover() { throw new Error("Pick a list in the ECHA picker."); },
  async pull(_src, config: { list: EchaList }, cursor: EchaCursor) {
    if (!(config.list in ECHA_LISTS)) throw new Error("Unknown ECHA list.");
    return echaChanges(config.list, await echaRows(config.list), cursor, Date.now());
  },
};

/* ---------- Have your say: the Commission's consultations ---------- */
const HYS = "https://ec.europa.eu/info/law/better-regulation";
export const STAGES: Record<string, string> = {
  INIT_PLANNED: "Planned initiative", PLANNING_WORKFLOW: "Call for evidence", OPC_LAUNCHED: "Public consultation",
  ISC_WORKFLOW: "Draft act", ADOPTION_WORKFLOW: "Commission proposal", OPEN_FOR_FEEDBACK: "Open for feedback",
};
const ACTS: Record<string, string> = {
  REG_DEL: "delegated regulation", REG_IMPL: "implementing regulation", DEC_DEL: "delegated decision", DEC_IMPL: "implementing decision",
  PROP_REG: "proposal for a regulation", PROP_DIR: "proposal for a directive", REG: "regulation", DIR: "directive", COM: "communication",
};
export type Initiative = {
  id: number; shortTitle: string; reference?: string; foreseenActType?: string; snippet?: string; topics?: { label: string }[];
  currentStatuses?: { frontEndStage?: string; receivingFeedbackStatus?: string; feedbackStartDate?: string | null; feedbackEndDate?: string | null; isCurrent?: boolean }[];
};
type HysCursor = { seen?: string[] };

/** "2026/10/21 15:51:35" in Brussels time to epoch ms, or null. */
export function brussels(s: string | null | undefined): number | null {
  const m = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s ?? "");
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const local = new Date(new Date(asUtc).toLocaleString("en-US", { timeZone: "Europe/Brussels" })).getTime();
  const utcView = new Date(new Date(asUtc).toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return asUtc - (local - utcView);
}
export const initiativeUrl = (id: number) => `${HYS}/have-your-say/initiatives/${id}_en`;

export async function searchInitiatives(q: string): Promise<Initiative[]> {
  const out: Initiative[] = [];
  for (let page = 0; page < 4; page++) {
    const j = await getJson(`${HYS}/brpapi/searchInitiatives?text=${encodeURIComponent(q)}&size=50&page=${page}&language=EN`);
    const p = j.initiativeResultDtoPage ?? {};
    out.push(...(p.content ?? []).map((x: any) => ({ ...x, id: Math.round(Number(x.id)) })));
    if (page + 1 >= (p.totalPages ?? 1)) break;
  }
  return out;
}
const current = (i: Initiative) => i.currentStatuses?.find(s => s.isCurrent) ?? i.currentStatuses?.[0];
export const openNow = (list: Initiative[]) => list.filter(i => current(i)?.receivingFeedbackStatus === "OPEN");

/** Feedback periods that opened since the last pull, as items. Pure: the pull and the tests share it. */
export function consultationChanges(list: Initiative[], cursor: HysCursor): { items: RawItem[]; cursor: HysCursor } {
  const seen = new Set(cursor.seen ?? []);
  const items: RawItem[] = [];
  for (const i of openNow(list)) {
    const s = current(i)!, key = `${i.id}:${s.frontEndStage}:${s.feedbackStartDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = i.shortTitle.replace(/\s+/g, " ").trim();
    const stage = STAGES[s.frontEndStage ?? ""] ?? "Feedback", start = brussels(s.feedbackStartDate), end = brussels(s.feedbackEndDate);
    const until = end ? new Date(end).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Brussels" }) : null;
    const act = ACTS[i.foreseenActType ?? ""] ?? (i.foreseenActType ? i.foreseenActType.toLowerCase().replace(/_/g, " ") : null);
    items.push({
      ext_id: key, url: initiativeUrl(i.id), title: `${name} (${stage.toLowerCase()}${until ? `, feedback until ${until}` : ""})`, author: "European Commission",
      summary: `${stage}${act ? ` on a ${act}` : ""}. Feedback is open${until ? ` until ${until}` : ""}.`,
      body: [`${stage}${act ? ` on a ${act}` : ""}: ${name}.`, `Feedback is open${until ? ` until ${until}` : ""}. Anyone can comment on the Have your say page.`,
        i.topics?.length ? `Topics: ${i.topics.map(t => t.label).join(", ")}.` : "", i.reference ? `Reference: ${i.reference}.` : "",
        i.snippet ? `\nWhere it matches: ${stripTags(i.snippet).replace(/\s+/g, " ").trim()}` : ""].filter(Boolean).join("\n"),
      lang: "en", published_at: start ?? Date.now(), meta: { site: "ec.europa.eu", deadline: end ?? undefined },
    });
  }
  return { items, cursor: { seen: [...seen].slice(-2000) } };
}

export const consult: Connector = {
  kind: "consult", label: "EU consultations",
  async discover() { throw new Error("Type a keyword in the EU consultations picker."); },
  async pull(_src, config: { q: string }, cursor: HysCursor) { return consultationChanges(await searchInitiatives(config.q), cursor); },
};
