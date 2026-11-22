// ECHA's obligation lists and the Commission's consultations: what a pull turns into items, with fixtures shaped like
// the real answers of chem.echa.europa.eu and the Have your say search (fetched 2026-11-22).
import { expect, test } from "bun:test";
import { brussels, consultationChanges, echaChanges, echaDate, initiativeUrl, type EchaRow, type Initiative } from "../server/connectors/official";

const cand = (rmlId: string, name: string, date: string): EchaRow => ({ rmlId, substanceName: [name], ecNumber: ["203-777-6"], casNumber: ["-"], dateOfInclusion: date, reasonForInclusion: ["Toxic for reproduction (Article 57c)"], decision: [{ decisionPath: `https://chem.echa.europa.eu/d/${rmlId}.pdf` }] });

test("echaDate reads ECHA's day format and nothing else", () => {
  expect(echaDate("04-Feb-2026")).toBe(Date.UTC(2026, 1, 4, 12));
  expect(echaDate("4-feb-2026")).toBe(Date.UTC(2026, 1, 4, 12));
  expect(echaDate("2026-02-04")).toBeNull();
  expect(echaDate(undefined)).toBeNull();
});

test("Candidate List: the first pull shows the latest day only; later pulls one item per new day", () => {
  const rows = [cand("1", "n-hexane", "04-Feb-2026"), cand("2", "bisphenol AF", "04-Feb-2026"), cand("3", "old one", "10-Jun-2025")];
  const first = echaChanges("candidate", rows, {}, 0);
  expect(first.items.map(i => i.title)).toEqual(["Candidate List: 2 substances added (4 February 2026)"]);
  expect(first.items[0].body).toContain("n-hexane (EC 203-777-6)");
  expect(first.items[0].body).not.toContain("CAS"); // "-" is no number
  expect(first.items[0].published_at).toBe(Date.UTC(2026, 1, 4, 12));
  expect(echaChanges("candidate", rows, first.cursor, 0).items).toEqual([]); // nothing new
  const later = echaChanges("candidate", [...rows, cand("4", "lead dioxide", "15-Jul-2026")], first.cursor, 0);
  expect(later.items.map(i => i.title)).toEqual(["Candidate List: lead dioxide added (15 July 2026)"]);
  expect(later.items[0].ext_id).not.toBe(first.items[0].ext_id);
});

test("restrictions: the first pull is the baseline; then new and amended entries make one item", () => {
  const r = (entry: string, name: string, path: string): EchaRow => ({ rmlId: `x${entry}`, substanceName: [name], entryNumber: entry, conditionsPath: path });
  const base = [r("01", "PCTs", "https://eur-lex/a"), r("79", "PFHxA", "https://eur-lex/b")];
  const first = echaChanges("restriction", base, {}, 1);
  expect(first.items).toEqual([]);
  const next = echaChanges("restriction", [r("01", "PCTs", "https://eur-lex/a2"), base[1], r("80", "Lead in PVC", "https://eur-lex/c")], first.cursor, 5);
  expect(next.items.length).toBe(1);
  expect(next.items[0].title).toBe("REACH restrictions: 1 added, 1 amended");
  expect(next.items[0].body).toMatch(/^Added:\nEntry 80: Lead in PVC[\s\S]*Amended:\nEntry 01: PCTs\nConditions: https:\/\/eur-lex\/a2$/);
  const one = echaChanges("authorisation", [{ rmlId: "y", substanceName: ["DEHP"], entryNumber: "04", sunsetDate: "21-Feb-2015" }], { seen: {} }, 9);
  expect(one.items[0].title).toBe("REACH Authorisation List: new entry 04, DEHP");
});

test("brussels reads the consultation dates in Brussels time, summer and winter", () => {
  expect(brussels("2026/11/24 23:59:59")).toBe(Date.parse("2026-11-24T22:59:59Z"));
  expect(brussels("2026/07/01 12:00:00")).toBe(Date.parse("2026-07-01T10:00:00Z"));
  expect(brussels(null)).toBeNull();
});

const ini = (id: number, stage: string, status: string, start: string | null, end: string | null, title = "Biobased feedstock in plastic packaging"): Initiative => ({
  id, shortTitle: title, reference: "Ares(2026)1", foreseenActType: "REG_DEL", snippet: 'rules on <span class="highlight">packaging</span>',
  topics: [{ label: "Environment" }], currentStatuses: [{ frontEndStage: stage, receivingFeedbackStatus: status, feedbackStartDate: start, feedbackEndDate: end, isCurrent: true }],
});

test("consultations: an item for each feedback period that opens, once; closed and planned ones are skipped", () => {
  const list = [ini(19498, "OPC_LAUNCHED", "OPEN", "2026/10/21 15:51:35", "2027/01/13 23:59:59"), ini(12263, "ADOPTION_WORKFLOW", "CLOSED", "2022/12/01 12:27:22", "2023/04/24 23:59:59"), ini(16638, "INIT_PLANNED", "DISABLED", "2026/02/03 13:32:00", null)];
  const a = consultationChanges(list, {});
  expect(a.items.length).toBe(1);
  expect(a.items[0]).toMatchObject({
    url: initiativeUrl(19498), title: "Biobased feedstock in plastic packaging (public consultation, feedback until 13 January 2027)",
    summary: "Public consultation on a delegated regulation. Feedback is open until 13 January 2027.", published_at: brussels("2026/10/21 15:51:35"),
  });
  expect(a.items[0].body).toContain("Where it matches: rules on packaging");
  expect(consultationChanges(list, a.cursor).items).toEqual([]);
  // the same initiative opening its next stage is news again
  const next = consultationChanges([ini(19498, "ISC_WORKFLOW", "OPEN", "2027/03/01 10:00:00", "2027/03/29 23:59:59")], a.cursor);
  expect(next.items.map(i => i.title)).toEqual(["Biobased feedstock in plastic packaging (draft act, feedback until 29 March 2027)"]);
});
