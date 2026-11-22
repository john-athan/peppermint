// Emblems for stories without a picture: every topic has one, the tagger's choice is checked, one seed always draws
// the same seal and different seeds draw different ones, and the markup stays well formed, themed and small.
process.env.PEPPERMINT_DB = ":memory:";
import { test, expect } from "bun:test";
import { emblemFor, emblemSvg, normalizeEmblem, MOTIFS, TOPIC_EMBLEM, MOODS } from "../shared/emblem";
import { TOPICS } from "../server/llm";

/** Open and close tags balance, ignoring self-closing ones. */
function balanced(svg: string) {
  const stack: string[] = [];
  for (const m of svg.matchAll(/<(\/?)([a-zA-Z]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue;
    if (!m[1]) stack.push(m[2]); else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

test("every topic the tagger knows has a motif that exists and a mood", () => {
  for (const t of TOPICS) {
    expect(TOPIC_EMBLEM[t]).toBeDefined();
    expect(MOTIFS[TOPIC_EMBLEM[t][0]]).toBeDefined();
    expect(MOODS).toContain(TOPIC_EMBLEM[t][1]);
  }
});

test("the tagger's emblem is checked; anything off falls back to the topic, then to the sprig", () => {
  expect(normalizeEmblem({ motif: "bolt", mood: "sun", word: "  Ørsted   AG " })).toEqual({ motif: "bolt", mood: "sun", word: "Ørsted AG" });
  expect(normalizeEmblem({ motif: "unicorn", mood: "sun", word: "" })).toBeNull();
  expect(normalizeEmblem({ motif: "bolt", mood: "neon" })).toEqual({ motif: "bolt", mood: "mint", word: "" });
  expect(emblemFor({ emblem: { motif: "nope" } as any, topics: ["Energy"], places: ["Garching"] })).toEqual({ motif: "bolt", mood: "sun", word: "Garching" });
  expect(emblemFor({ topics: ["Unknown", "Law"] })).toEqual({ motif: "scales", mood: "stone", word: "Law" });
  expect(emblemFor({})).toEqual({ motif: "sprig", mood: "mint", word: "" });
});

test("one seed draws the same emblem; other seeds draw other ones", () => {
  const spec = { motif: "train", mood: "sky" as const, word: "U6" };
  expect(emblemSvg(spec, 42)).toBe(emblemSvg(spec, 42));
  const drawn = new Set(Array.from({ length: 30 }, (_, i) => emblemSvg(spec, i)));
  expect(drawn.size).toBe(30);
});

test("the markup is well formed, uses theme colours only, escapes the word and stays small", () => {
  for (const motif of Object.keys(MOTIFS)) for (const o of [{}, { wide: true }, { small: true }]) for (const seed of [1, 2, 3, 4]) {
    const svg = emblemSvg({ motif, mood: "mint", word: `<b>"${motif}"</b> & co` }, `${seed}${motif}`, o);
    expect(balanced(svg)).toBe(true);
    expect(/#[0-9a-f]{3,8}\b/i.test(svg.replace(/href="#\w+"|url\(#\w+\)/g, ""))).toBe(false);
    expect(svg).not.toContain("<b>");
    expect(svg).not.toMatch(/NaN|undefined|Infinity/);
    expect(svg.length).toBeLessThan(32_000);
  }
  // a thumbnail has no lettering
  expect(emblemSvg({ motif: "bolt", mood: "sun", word: "Ørsted" }, 1, { small: true })).not.toContain("<text");
  expect(emblemSvg({ motif: "bolt", mood: "sun", word: "Ørsted" }, 1)).toContain("ØRSTED");
});
