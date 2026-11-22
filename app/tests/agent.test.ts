// The agent's checked parts: search ranks and finds parts of words, palate changes are validated, applied with what
// they replaced and undone exactly, previews leave nothing behind, quotes must be in the text, and agent stories stay
// out of the scored edition.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PEPPERMINT_LLM = "off";
import { test, expect, beforeAll } from "bun:test";
const { db, now } = await import("../server/db");
const { searchStories } = await import("../server/search");
const agent = await import("../server/agent");
const { buildEdition } = await import("../server/palate");

const O = 461;
let src = 0;
const story = (title: string, body: string, tags: object = {}, at = now()) => {
  const st = (db.query("INSERT INTO stories (owner_id, title, title_en, keys, tags, first_at, last_at) VALUES (?, ?, ?, '[]', ?, ?, ?) RETURNING id").get(O, title, title, JSON.stringify({ topics: ["Transport"], ...tags }), at, at) as any).id;
  const it = (db.query("INSERT INTO items (owner_id, source_id, ext_id, title, body, published_at, fetched_at, story_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id").get(O, src, `e${st}`, title, body, at, at, st) as any).id;
  db.query("UPDATE items SET tagged = 1, tags = ? WHERE id = ?").run(JSON.stringify({ topics: ["Transport"], ...tags }), it);
  return st as number;
};

let tram = 0, body = 0, flea = 0, old = 0;
beforeAll(() => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'me', ?), (462, 'other', ?)").run(O, now(), now());
  src = (db.query("INSERT INTO sources (owner_id, kind, name, created_at) VALUES (?, 'merkur', 'merkur.de', ?) RETURNING id").get(O, now()) as any).id;
  tram = story("Tram line 23 extended to Schwabing", "The city council voted on Tuesday.", { people: ["Dieter Reiter"] });
  body = story("City council meets", "A long debate about the tram network and buses.");
  flea = story("Großer Flohmarkt in Giesing", "Am Samstag auf dem Platz.");
  old = story("Tram history", "Trams in Munich since 1876.", {}, now() - 40 * 86400_000);
});

test("search: a title match ranks above a match deep in the text, and the last word works as a prefix", () => {
  const hits = searchStories(O, "tram");
  expect(hits[0].story_id).toBe(tram);
  expect(hits.map(h => h.story_id)).toContain(body);
  expect(searchStories(O, "schwab").map(h => h.story_id)).toEqual([tram]);
  expect(searchStories(O, "reiter").map(h => h.story_id)).toEqual([tram]);
  expect(hits[0].snippet).toContain("\u0002");
});

test("search: a fresh story beats an equally good old one", () => {
  const ids = searchStories(O, "tram").map(h => h.story_id);
  expect(ids.indexOf(tram)).toBeLessThan(ids.indexOf(old));
});

test("search: parts of words are found through the trigram index", () => {
  expect(searchStories(O, "markt").map(h => h.story_id)).toEqual([flea]);
  expect(searchStories(462, "markt")).toEqual([]);
  expect(searchStories(O, "  ")).toEqual([]);
});

test("palate changes from the model are checked before anything is written", () => {
  const c = agent.cleanChanges(O, [{ kind: "topic", name: "energy", weight: 9 }, { kind: "topic", name: "Knitting", weight: 1 }, { kind: "source", name: "nowhere", weight: 1 }, { kind: "bogus", name: "x", weight: 1 }, { kind: "source", name: "MERKUR.DE", weight: -1 }],
    [{ action: "never", kind: "topic", value: "football" }, { action: "delete", kind: "topic", value: "AI" }, { action: "mute", kind: "word", value: "  Promi " }]);
  expect(c).toEqual([
    { type: "weight", kind: "topic", name: "Energy", weight: 3 },
    { type: "weight", kind: "source", name: "merkur.de", weight: -1 },
    { type: "rule", action: "never", kind: "topic", value: "Football" },
    { type: "rule", action: "mute", kind: "word", value: "Promi" },
  ]);
});

test("a command applies at once and undo restores exactly what was there", async () => {
  db.query("INSERT INTO affinities (owner_id, kind, name, weight, manual, updated_at) VALUES (?, 'topic', 'Energy', 0.5, 0, ?)").run(O, now());
  db.query("INSERT INTO rules (owner_id, action, kind, value, created_at) VALUES (?, 'mute', 'topic', 'Football', ?)").run(O, now());
  const changes = agent.cleanChanges(O, [{ kind: "topic", name: "Energy", weight: 2 }, { kind: "place", name: "Giesing", weight: 1 }], [{ action: "never", kind: "topic", value: "Football" }]);
  const before = JSON.stringify([db.query("SELECT * FROM affinities WHERE owner_id = ? ORDER BY kind, name").all(O), db.query("SELECT action, kind, value FROM rules WHERE owner_id = ?").all(O)]);
  const pv = agent.preview(O, changes);
  expect(JSON.stringify([db.query("SELECT * FROM affinities WHERE owner_id = ? ORDER BY kind, name").all(O), db.query("SELECT action, kind, value FROM rules WHERE owner_id = ?").all(O)])).toBe(before);
  expect(pv).toHaveProperty("in");
  const p = (db.query("INSERT INTO proposals (owner_id, origin, said, changes, created_at) VALUES (?, 'command', 'x', ?, ?) RETURNING id").get(O, JSON.stringify(changes), now()) as any).id;
  const applied = agent.applyProposal(O, p);
  expect(applied.status).toBe("applied");
  expect(db.query("SELECT weight FROM affinities WHERE owner_id = ? AND name = 'Energy'").get(O)).toEqual({ weight: 2 });
  expect(db.query("SELECT action FROM rules WHERE owner_id = ? AND value = 'Football'").get(O)).toEqual({ action: "never" });
  expect(() => agent.applyProposal(O, p)).toThrow("already decided");
  agent.undoProposal(O, p);
  expect(db.query("SELECT weight FROM affinities WHERE owner_id = ? AND name = 'Energy'").get(O)).toEqual({ weight: 0.5 });
  expect(db.query("SELECT 1 FROM affinities WHERE owner_id = ? AND name = 'Giesing'").get(O)).toBeNull();
  expect(db.query("SELECT action FROM rules WHERE owner_id = ? AND value = 'Football'").get(O)).toEqual({ action: "mute" });
  expect(agent.agentLog(O).map(x => x.status)).toEqual(["undone"]);
  expect((db.query("SELECT count(*) AS n FROM signals WHERE owner_id = ? AND kind = 'agent'").get(O) as any).n).toBe(2);
});

test("an answer keeps only the quotes that are really in the text", () => {
  const text = "The council voted on Tuesday to extend tram line 23 to Schwabing by 2028.";
  const a = 'It goes to Schwabing.[1] It costs a billion.[2]\n---\n[1] "extend tram line 23 to Schwabing" (merkur.de)\n[2] "costs one billion euros" (merkur.de)';
  expect(agent.verifiedAnswer(a, text)).toBe('It goes to Schwabing.[1] It costs a billion.[2]\n---\n[1] "extend tram line 23 to Schwabing" (merkur.de)');
  expect(agent.verifiedAnswer("No markers here.", text)).toBe("No markers here.");
});

test("a link is found inside what you typed", () => {
  expect(agent.linkIn("what does this say about cost https://example.com/a/b?x=1).")).toBe("https://example.com/a/b?x=1");
  expect(agent.linkIn("more about energy")).toBeNull();
});

test("dossier and probe stories never enter the scored edition", () => {
  const d = story("Rail strike dossier", "Everything about the rail strike.", { topics: ["Transport"] });
  db.query("INSERT INTO affinities (owner_id, kind, name, weight, manual, updated_at) VALUES (?, 'topic', 'Transport', 3, 1, ?) ON CONFLICT DO UPDATE SET weight = 3").run(O, now());
  db.query("INSERT INTO tasks (owner_id, kind, input, title, status, story_id, created_at, updated_at) VALUES (?, 'dossier', 'q', 't', 'done', ?, ?, ?)").run(O, d, now(), now());
  const ed = buildEdition(O);
  // all fixture stories share one topic, so the two-per-topic limit decides which make it in; what matters is that
  // a normal story is considered (in the edition or the cut) and the dossier is not considered at all
  const considered = (db.query("SELECT story_id FROM edition_items WHERE edition_id = ? UNION SELECT story_id FROM edition_cut WHERE edition_id = ?").all(ed.id, ed.id) as any[]).map(r => r.story_id);
  expect(considered).toContain(tram);
  expect(considered).not.toContain(d);
});

test("without Claude the agent says so, and only links work", async () => {
  await expect(agent.interpret(O, "more about energy", { kind: "today" })).rejects.toThrow("needs Claude");
  await expect(agent.interpret(O, "   ", { kind: "today" })).rejects.toThrow("Type a question");
});

test("following a dossier follows its story: new reports count as news since you last read, and unfollowing ends both", async () => {
  const { isFollowing, newSince, updates } = await import("../server/follow");
  const d = story("Heat pump subsidy", "What the subsidy pays for.", {}, now() - 3600_000);
  const t = (db.query("INSERT INTO tasks (owner_id, kind, input, title, status, story_id, result, created_at, updated_at) VALUES (?, 'dossier', 'q', 't', 'done', ?, '{}', ?, ?) RETURNING id").get(O, d, now(), now()) as any).id;
  expect(agent.dossierOf(O, d)).toBe(t);
  agent.follow(O, t, true);
  expect(isFollowing(O, d)).toBe(true);
  expect(agent.taskOf(agent.getTask(O, t)!).result.follow_until).toBeGreaterThan(now());
  // a refresh files a report after you last looked: it leads Today as an update and the dossier says what is new
  db.query("INSERT INTO items (owner_id, source_id, ext_id, title, body, published_at, fetched_at, story_id) VALUES (?, ?, 'hp2', 'Subsidy doubled', 'x', ?, ?, ?)").run(O, src, now(), now() + 1000, d);
  expect(newSince(O, d).map(r => r.title)).toEqual(["Subsidy doubled"]);
  expect(updates(O).map(u => u.storyId)).toContain(d);
  agent.follow(O, t, false);
  expect(isFollowing(O, d)).toBe(false);
  expect(agent.taskOf(agent.getTask(O, t)!).result.follow_until).toBeNull();
});

test("the same agency report on two sites is one article in a dossier", () => {
  expect(agent.sameTitle("WDH: Bahn saniert Strecke Berlin-Hannover - 14 Monate Sperrung")).toBe(agent.sameTitle("Bahn saniert Strecke Berlin-Hannover, 14 Monate Sperrung"));
  expect(agent.sameTitle("Bahn saniert Strecke Berlin-Hannover")).not.toBe(agent.sameTitle("Bahn saniert Strecke Köln-Hagen"));
});

test("an agency text under another headline is the same text; a different report on the same subject is not", () => {
  const dpa = "Berlin (dpa) Die Generalsanierung wichtiger Bahnstrecken wird nach Angaben von Bahnchefin Evelyn Palla länger dauern als geplant. Statt vier Korridoren pro Jahr seien künftig zwei, manchmal drei realistisch, sagte Palla am Mittwoch in Berlin. Das überarbeitete Konzept werde derzeit mit dem Verkehrsministerium abgestimmt.";
  const copy = "Berlin & Brandenburg " + dpa + " Mehr zum Thema lesen Sie hier.";
  const other = "Die Bahn sperrt die Strecke zwischen Berlin und Hannover für vierzehn Monate. Fernzüge fahren über Magdeburg und Braunschweig und brauchen achtzig Minuten länger. Für den Güterverkehr gibt es eine zweite Umleitung über Halle, die selbst saniert wird.";
  expect(agent.sameText(agent.shingles(dpa), agent.shingles(copy))).toBe(true);
  expect(agent.sameText(agent.shingles(dpa), agent.shingles(other))).toBe(false);
});

test("Research lists topics with news first, then running ones, then the newest; dismissed ones are gone", () => {
  const mk = (title: string, status: string, at: number) => {
    const sid = story(title, "x");
    return { sid, id: (db.query("INSERT INTO tasks (owner_id, kind, input, title, status, steps, result, story_id, created_at, updated_at) VALUES (?, 'dossier', 'q', ?, ?, '[{\"label\":\"Reading 8 articles\",\"done\":false}]', '{}', ?, ?, ?) RETURNING id").get(O, title, status, sid, at, at) as any).id };
  };
  const old = mk("Old topic", "done", now() - 9000), fresh = mk("Fresh topic", "done", now() - 1000), busy = mk("Busy topic", "running", now() - 5000), news = mk("Topic with news", "done", now() - 20000), gone = mk("Gone topic", "dismissed", now());
  const list = agent.topics(O, () => null, sid => (sid === news.sid ? 2 : 0), () => false).filter(t => [old, fresh, busy, news, gone].some(x => x.id === t.id));
  expect(list.map(t => t.title)).toEqual(["Topic with news", "Busy topic", "Fresh topic", "Old topic"]);
  expect(list[1].step).toBe("Reading 8 articles");
});

test("what flies in from a story keeps only short text and pictures from our copies or https", () => {
  const f = agent.startedFrom({ title: "  KI im Job  ", image: "javascript:alert(1)", chips: [{ name: "München", img: "/api/media/ab12.webp?w=160" }, { name: "APA", img: "http://x.test/a.png" }, { name: "" }] }, "fallback");
  expect(f).toEqual({ title: "KI im Job", image: null, chips: [{ name: "München", img: "/api/media/ab12.webp?w=160" }, { name: "APA", img: null }] });
});
