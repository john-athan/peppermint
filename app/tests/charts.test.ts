// Charts written as JSON: parsing and its error messages, number formats in both languages, axis ticks, charts inside
// lens text (also while still streaming), the hero chart on a card, and chart blocks in Studio drafts.
process.env.PEPPERMINT_DB = ":memory:";
import { test, expect } from "bun:test";
import { normalize, format, formatValue, ticks, splitCharts, heroChart, withoutCharts, describe as describeChart, MAX_SERIES } from "../shared/chart";
import { blocks } from "../client/lib/lens";

const ok = (s: unknown) => { const r = normalize(s); if ("error" in r) throw new Error(r.error); return r.chart; };

test("one series from a label-to-number map; bars by default; highlight and hero kept", () => {
  const c = ok('{"title": "Minutes per fix", "unit": "min", "data": {"Carbon": 22.35, "Opus": 9.55}, "highlight": "Carbon", "hero": true}');
  expect(c).toMatchObject({ type: "bar", labels: ["Carbon", "Opus"], highlight: "Carbon", hero: true, unit: "min", format: "number" });
  expect(c.series).toEqual([{ name: "Minutes per fix", values: [22.35, 9.55], slot: 0 }]);
});

test("several series over years become a line; ranges are kept; unknown highlight is dropped", () => {
  const c = ok({ x: [2021, 2022, 2023, 2024], series: { Carbon: [1, 2, [3, 4], null], Opus: ["5", 6, 7, 8] }, highlight: "Nobody" });
  expect(c.type).toBe("line");
  expect(c.series[0].values).toEqual([1, 2, [3, 4], null]);
  expect(c.series[1].values).toEqual([5, 6, 7, 8]);
  expect(c.highlight).toBeNull();
});

test("several series written inside data draw like top-level ones, with a missing cell left empty", () => {
  const r = normalize({ title: "Coding", data: { x: ["A", "B"], series: { Neon: [65.4, 46.2], Sol: [null, 43.8] } } }) as any;
  expect(r.chart.labels).toEqual(["A", "B"]);
  expect(r.chart.series.map((s: any) => s.values)).toEqual([[65.4, 46.2], [null, 43.8]]);
});

test("past six series the smallest fold into Other, so no seventh colour appears", () => {
  const series = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`S${i}`, [i + 1, i + 1]]));
  const c = ok({ x: ["a", "b"], series, type: "column" });
  expect(c.series.length).toBe(MAX_SERIES);
  expect(c.series.at(-1)).toMatchObject({ name: "Other", slot: -1, values: [6, 6] });
  expect(c.series.slice(0, -1).every((s, i) => s.slot === i)).toBe(true);
});

test("a writer gets a plain reason when the JSON is not a chart", () => {
  expect(normalize("{ nope")).toMatchObject({ error: expect.stringContaining("Not valid JSON") });
  expect(normalize("[1,2]")).toMatchObject({ error: expect.stringContaining("JSON object") });
  expect(normalize({ series: { a: [1] } })).toMatchObject({ error: expect.stringContaining("\"x\"") });
  expect(normalize({ data: { a: "lots" } })).toMatchObject({ error: expect.stringContaining("No numbers") });
});

test("numbers read the way each language writes them", () => {
  const pct = ok({ data: { a: 16.5 }, unit: "%" }), eur = ok({ data: { a: 1 }, unit: "€" }), dur = ok({ data: { a: 1 }, format: "duration" }), km = ok({ data: { a: 1 }, unit: "km" });
  expect(format(pct, 16.5, "en")).toBe("16.5%");
  expect(format(pct, 16.5, "de")).toBe("16,5 %");
  expect(format(eur, 4200000, "de", true)).toContain("€");
  expect(format(dur, 1341, "en")).toBe("22 min 21 s");
  expect(format(km, 12345, "de")).toBe("12.345 km");
  const whole = ok({ data: { a: [16, 30] }, unit: "%" });
  expect(formatValue(whole, [16, 30], "en")).toBe("16 to 30%");
  expect(formatValue(whole, [16, 30], "de")).toBe("16 bis 30\u202f%");
  // one rounding per chart: 22.0 stands next to 9.5, never 22 next to 9.55
  const mixed = ok({ data: { a: 22, b: 9.5 }, unit: "min" });
  expect([format(mixed, 22, "en"), format(mixed, 9.5, "en")]).toEqual(["22.0\u00a0min", "9.5\u00a0min"]);
});

test("axis ticks are round and cover the data from zero", () => {
  expect(ticks(0, 22.35)).toEqual([0, 5, 10, 15, 20, 25]);
  expect(ticks(0, 9200, 4)).toEqual([0, 2500, 5000, 7500, 10000]);
  expect(ticks(-3, 7, 5)[0]).toBeLessThanOrEqual(-3);
});

test("charts inside lens text: complete ones parse, an unfinished one waits, prose around them stays", () => {
  const text = "Lead.\n\n```chart\n{\"data\": {\"A\": 1, \"B\": 2}, \"hero\": true}\n```\n\n## More\n\nTail.\n\n```chart\n{\"data\": {\"A\":";
  expect(splitCharts(text).open).toBe(true);
  const b = blocks("digest", text);
  expect(b.map(x => x.t)).toEqual(["p", "chart", "h", "p", "chart-wait"]);
  expect(heroChart(text)?.labels).toEqual(["A", "B"]);
  expect(withoutCharts(text)).toBe("Lead.\n\n## More\n\nTail.");
  expect(blocks("digest", "```chart\nnot json\n```")[0]).toMatchObject({ t: "chart", chart: null, error: expect.stringContaining("JSON") });
});

test("the description names every value for screen readers", () => {
  expect(describeChart(ok({ title: "Fix time", unit: "min", data: { Carbon: 22, Opus: 9.5 } }), "en")).toBe("Bar chart: Fix time. Carbon 22.0\u00a0min; Opus 9.5\u00a0min.");
});

test("a brief's hero chart reaches the card; Studio keeps chart blocks", async () => {
  const { db, now } = await import("../server/db");
  db.query("INSERT INTO users (id, name, created_at) VALUES (701, 'me', ?)").run(now());
  const src = (db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (701, 701, 'feed', 'kernel.dev', ?) RETURNING id").get(now()) as any).id;
  const st = (db.query("INSERT INTO stories (id, owner_id, title, keys, tags, first_at, last_at) VALUES (701, 701, 'Why is Gemini 4 Carbon so slow', '[]', '{}', ?, ?) RETURNING id").get(now(), now()) as any).id;
  db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, tagged, story_id) VALUES (701, ?, 'k1', 'Why is Gemini 4 Carbon so slow', ?, ?, 1, ?)").run(src, now(), now(), st);
  db.query("INSERT INTO lens_cache (story_id, lens, lang, level, text, done, created_at) VALUES (?, 'brief', 'en', 2, ?, 1, ?)").run(st, "Carbon takes twice as long.\n\n```chart\n{\"data\": {\"Carbon\": 22.35, \"Opus\": 9.55}, \"hero\": true}\n```", now());
  const { cleanBlocks } = await import("../server/studio");
  expect(cleanBlocks(701, [{ id: "c1", type: "chart", text: "{\"data\":{\"a\":1}}" }, { id: "x", type: "script", text: "no" }]).map(b => b.type)).toEqual(["chart"]);
  process.env.PORT = "0"; process.env.PEPPERMINT_NO_SCHEDULER = "1"; process.env.PEPPERMINT_LLM = "off"; process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
  const auth = await import("../server/auth"); const { server } = await import("../server/main");
  const cookie = `__Host-peppermint=${await auth.createSession(701)}`;
  const s = await (await fetch(`http://localhost:${server.port}/api/stories/${st}`, { headers: { cookie } })).json();
  expect(s.brief).toBe("Carbon takes twice as long.");
  expect(s.chart).toMatchObject({ hero: true, labels: ["Carbon", "Opus"] });
});
