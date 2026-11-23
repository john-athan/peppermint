// Material: how much a story has to read, wrappers unwrapped, Claude's "@thin" never reaching a reader, research
// status on the stream, and an unreadable story shown slim, ranked lower and not learned from when scrolled past.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PEPPERMINT_LLM = "off";
// The cache replay below runs in "cli" mode, which counts only when a claude binary is found. CI has none, and
// nothing here may call a model anyway: point it at a program that only fails.
process.env.PEPPERMINT_CLAUDE_BIN = "/usr/bin/false";
import { test, expect } from "bun:test";
const { db, now } = await import("../server/db");
const { grade, unwrap, storyGrade, storyUnreadable, markUnreadable, needsResearch } = await import("../server/material");
const { thinGuard } = await import("../server/lens");
const { steep } = await import("../server/steep");
const { scoreStories, applySignal } = await import("../server/palate");

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

test("grade: walls, thin, partial and full", () => {
  expect(grade("Software companies", "Software companies\nYou must log in to LiveJournal to continue reading this entry.")).toBe("walled");
  expect(grade("x", "Please enable JavaScript to view this page.")).toBe("walled");
  expect(grade("x", "Bitte melden Sie sich an, um weiterzulesen. Jetzt abonnieren.")).toBe("walled");
  // zeit.de sends servers to its consent page (/zustimmung) instead of the article
  expect(grade("Wirtschaftspodcast: Warum werden gerade so viele Start-ups gegründet?", "zeit.de mit Werbung Besuchen Sie zeit.de wie gewohnt mit Werbung und Tracking. Details zum Tracking finden Sie im Privacy Center. zeit.de pur Lesen Sie zeit.de werbefrei.")).toBe("walled");
  expect(grade("Title", "Title")).toBe("thin");
  expect(grade("x", words(40))).toBe("thin");
  expect(grade("x", words(120))).toBe("partial");
  expect(grade("x", words(400))).toBe("full");
  // a long article that mentions a captcha is still an article
  expect(grade("x", `${words(300)} the captcha was broken by researchers`)).toBe("full");
});

test("unwrap: archive copies, AMP and redirect links lead to the page itself", () => {
  expect(unwrap("https://web.archive.org/web/20250101000000/https://lateblt.livejournal.com/123.html")).toBe("https://lateblt.livejournal.com/123.html");
  expect(unwrap("https://web.archive.org/web/20250101000000id_/http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
  expect(unwrap("https://www.google.com/amp/s/example.com/story")).toBe("https://example.com/story");
  expect(unwrap("https://example-com.cdn.ampproject.org/c/s/example.com/story")).toBe("https://example.com/story");
  expect(unwrap("https://www.google.com/url?q=https://example.com/x&sa=D")).toBe("https://example.com/x");
  expect(unwrap("https://example.com/plain")).toBeNull();
  expect(unwrap("https://web.archive.org/web/2025/javascript:alert(1)")).toBeNull();
});

test("a discussion makes a headline readable enough for a brief; a podcast is always complete", () => {
  const it = { title: "T", summary: null, body: "Log in to continue", kind: "hackernews", meta: {} as any };
  expect(storyGrade([it])).toBe("walled");
  expect(storyGrade([{ ...it, meta: { discussion: "x".repeat(700) } }])).toBe("partial");
  expect(storyGrade([it, { title: "Ep", summary: null, body: null, kind: "podcast", meta: {} }])).toBe("full");
});

async function collect(src: AsyncIterable<string>) { const out: string[] = []; for await (const t of src) out.push(t); return out.join(""); }
async function* chunks(...xs: string[]) { for (const x of xs) yield x; }

test("@thin is held back and reported, however it is split; real text passes whole", async () => {
  let thin = 0;
  expect(await collect(thinGuard(chunks("@th", "in"), () => thin++))).toBe("");
  expect(await collect(thinGuard(chunks("  @thin\n"), () => thin++))).toBe("");
  expect(thin).toBe(2);
  expect(await collect(thinGuard(chunks("Th", "e rail strike ends."), () => thin++))).toBe("The rail strike ends.");
  expect(await collect(thinGuard(chunks("Ok"), () => thin++))).toBe("Ok");
  expect(thin).toBe(2);
});

test("the stream says what research is doing and closes with nothing saved when there was nothing to write", async () => {
  let saved = "";
  const s = steep({
    key: "t:research", lastEventId: -1, signal: new AbortController().signal, needsLLM: false,
    produce: async function* () { yield { status: "Reading the Hacker News discussion" }; await Bun.sleep(5); yield { end: { material: "none" } }; },
    save: t => { saved = t; },
  });
  const raw = await new Response(s).text();
  expect(raw).toContain("event: status\ndata: {\"text\":\"Reading the Hacker News discussion\"}");
  expect(raw).toMatch(/event: done\ndata: \{[^\n]*"material":"none"/);
  expect(saved).toBe("");
});

test("an unreadable story ranks lower, and scrolling past it teaches the palate nothing", () => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (471, 'me', ?)").run(now());
  const src = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (471, 'feed', 'blog', ?) RETURNING id").get(now()) as any).id;
  const mk = (title: string, body: string) => {
    const st = (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at) VALUES (471, ?, '[]', '{\"topics\":[\"Hardware\"]}', ?, ?) RETURNING *").get(title, now(), now()) as any);
    db.query("INSERT INTO items (owner_id, source_id, ext_id, title, body, published_at, fetched_at, tagged, story_id) VALUES (471, ?, ?, ?, ?, ?, ?, 1, ?)").run(src, title, title, body, now(), now(), st.id);
    return st;
  };
  const wall = mk("Walled", "Sign in to continue reading.");
  const fine = mk("Fine", words(300));
  expect(needsResearch(wall.id)).toBe(true);
  expect(needsResearch(fine.id)).toBe(false);
  markUnreadable(wall.id);
  expect(storyUnreadable(wall.id)).toBe(true);
  expect(needsResearch(wall.id)).toBe(false);
  const [a, b] = scoreStories(471, [wall, fine]);
  expect(a.reasons.some(r => r.label === "Only the headline could be read")).toBe(true);
  expect(a.score).toBeLessThan(b.score);
  applySignal(471, wall.id, "seen");
  expect(db.query("SELECT count(*) AS n FROM affinities WHERE owner_id = 471").get()).toEqual({ n: 0 });
  applySignal(471, fine.id, "seen");
  expect((db.query("SELECT count(*) AS n FROM affinities WHERE owner_id = 471").get() as any).n).toBeGreaterThan(0);
});

test("a brief is written only for a story with more to read than a card shows; a short one keeps its summary", async () => {
  const { briefWorthy, shortStory } = await import("../server/material");
  const { lensStream } = await import("../server/lens");
  db.query("INSERT INTO users (id, name, created_at) VALUES (851, 'b', ?)").run(now());
  const src = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (851, 'feed', 'SZ', ?) RETURNING id").get(now()) as any).id;
  const mk = (title: string, body: string, researched: boolean) => {
    const st = (db.query("INSERT INTO stories (owner_id, title, keys, tags, first_at, last_at) VALUES (851, ?, '[]', '{}', ?, ?) RETURNING id").get(title, now(), now()) as any).id;
    db.query("INSERT INTO items (owner_id, source_id, ext_id, title, body, published_at, fetched_at, tagged, story_id, meta) VALUES (851, ?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(src, `b${st}`, title, body, now(), now(), st, JSON.stringify(researched ? { researched: now() } : {}));
    // a padded brief written before stories were graded
    db.query("INSERT INTO lens_cache (story_id, lens, lang, level, text, done, model, created_at) VALUES (?, 'brief', 'en', 2, 'The source gives no details.', 1, 'x', ?)").run(st, now());
    return st as number;
  };
  const short = mk("Podcast: KI statt Kassierer?", `Ein Gespräch über KI an der Kasse. ${words(90)}`, true);
  const pending = mk("Headline only", "Headline only", false);
  const full = mk("Long report", words(400), true);
  expect([briefWorthy(short), shortStory(short)]).toEqual([false, true]);
  expect([briefWorthy(pending), shortStory(pending)]).toEqual([false, false]); // research may still find more
  expect([briefWorthy(full), shortStory(full)]).toEqual([true, false]);
  // the old padded brief is not replayed for the short story; the full story still gets its cached one
  const read = async (id: number) => {
    process.env.PEPPERMINT_LLM = "cli"; // let steep reach the cache; nothing here calls a model
    const r = lensStream(851, id, { lens: "brief", lang: "en", level: 2 }, -1, new AbortController().signal);
    let out = ""; for await (const c of r as any) out += new TextDecoder().decode(c);
    process.env.PEPPERMINT_LLM = "off";
    // the replay comes in word-sized deltas; the text is what they add up to, plus the closing event
    return [...out.matchAll(/event: delta\ndata: (.+)/g)].map(m => JSON.parse(m[1]).t).join("") + (/event: done\ndata: (.+)/.exec(out)?.[1] ?? "");
  };
  expect(await read(full)).toContain("The source gives no details.");
  const s = await read(short);
  expect(s).not.toContain("The source gives no details.");
  expect(s).toContain('"material":"short"');
});
