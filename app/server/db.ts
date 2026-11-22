// One SQLite file holds everything. Every row carries owner_id so more accounts can be switched on later.
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { migrateAccounts, tableExists } from "./accounts/schema";

export const DB_PATH = process.env.PEPPERMINT_DB ?? "data/peppermint.db";
if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH, { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

// the names a story's tags carry, as one line of words for the search index
const names = (col: string) => { const t = `CASE WHEN json_valid(${col}) THEN ${col} ELSE '{}' END`; return `(SELECT coalesce(group_concat(value, ' '), '') FROM (${["topics", "people", "orgs", "places"].map(k => `SELECT value FROM json_each(${t}, '$.${k}')`).join(" UNION ALL ")}))`; };
const MIGRATIONS: string[] = [
  `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
   CREATE TABLE passkeys (
     id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
     public_key BLOB NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0,
     label TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER) STRICT;
   CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
   CREATE TABLE device_tokens (token_hash TEXT PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER) STRICT;

   CREATE TABLE sources (
     id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
     kind TEXT NOT NULL, name TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
     cadence_min INTEGER NOT NULL DEFAULT 60, trust INTEGER NOT NULL DEFAULT 1,
     enabled INTEGER NOT NULL DEFAULT 1, cursor TEXT NOT NULL DEFAULT '{}',
     last_pull_at INTEGER, last_ok_at INTEGER, last_error TEXT, created_at INTEGER NOT NULL) STRICT;

   CREATE TABLE items (
     id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
     ext_id TEXT NOT NULL, url TEXT, title TEXT NOT NULL, author TEXT, lang TEXT,
     summary TEXT, body TEXT, meta TEXT NOT NULL DEFAULT '{}',
     published_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
     tagged INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '{}', story_id INTEGER,
     UNIQUE (source_id, ext_id)) STRICT;
   CREATE INDEX items_story ON items(story_id);
   CREATE INDEX items_untagged ON items(tagged) WHERE tagged = 0;
   CREATE VIRTUAL TABLE items_fts USING fts5(title, summary, content='items', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
   CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN INSERT INTO items_fts(rowid, title, summary) VALUES (new.id, new.title, coalesce(new.summary, '')); END;
   CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, coalesce(old.summary, '')); END;
   CREATE TRIGGER items_au AFTER UPDATE OF title, summary ON items BEGIN
     INSERT INTO items_fts(items_fts, rowid, title, summary) VALUES ('delete', old.id, old.title, coalesce(old.summary, ''));
     INSERT INTO items_fts(rowid, title, summary) VALUES (new.id, new.title, coalesce(new.summary, '')); END;

   CREATE TABLE stories (
     id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, title TEXT NOT NULL, title_en TEXT,
     lang TEXT, keys TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '{}',
     first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, item_count INTEGER NOT NULL DEFAULT 1) STRICT;
   CREATE INDEX stories_last ON stories(owner_id, last_at);

   CREATE TABLE editions (
     id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, slot TEXT NOT NULL, day TEXT NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, considered INTEGER NOT NULL DEFAULT 0,
     cut TEXT NOT NULL DEFAULT '{}', UNIQUE(owner_id, day, slot)) STRICT;
   CREATE TABLE edition_items (
     edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE, story_id INTEGER NOT NULL REFERENCES stories(id),
     rank INTEGER NOT NULL, score REAL NOT NULL, reasons TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
     added_at INTEGER NOT NULL, PRIMARY KEY (edition_id, story_id)) STRICT;
   CREATE TABLE edition_cut (
     edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE, story_id INTEGER NOT NULL REFERENCES stories(id),
     reason TEXT NOT NULL, score REAL NOT NULL, PRIMARY KEY (edition_id, story_id)) STRICT;

   CREATE TABLE affinities (owner_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, weight REAL NOT NULL DEFAULT 0,
     manual INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (owner_id, kind, name)) STRICT;
   CREATE TABLE rules (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, action TEXT NOT NULL CHECK (action IN ('always','boost','mute','never')),
     kind TEXT NOT NULL, value TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner_id, kind, value)) STRICT;
   CREATE TABLE signals (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, story_id INTEGER, kind TEXT NOT NULL, value REAL NOT NULL DEFAULT 0,
     meta TEXT NOT NULL DEFAULT '{}', at INTEGER NOT NULL) STRICT;
   CREATE INDEX signals_at ON signals(owner_id, at);

   CREATE TABLE lens_cache (story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE, lens TEXT NOT NULL, lang TEXT NOT NULL, level INTEGER NOT NULL,
     text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, model TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (story_id, lens, lang, level)) STRICT;
   CREATE TABLE settings (owner_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (owner_id, key)) STRICT;`,
  // 2: Listen (the edition as a spoken script) and Studio (drafts)
  `CREATE TABLE episodes (edition_id INTEGER NOT NULL REFERENCES editions(id) ON DELETE CASCADE, lang TEXT NOT NULL, sig TEXT NOT NULL,
     script TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (edition_id, lang)) STRICT;
   CREATE TABLE drafts (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL DEFAULT '',
     blocks TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, published_at INTEGER) STRICT;
   CREATE INDEX drafts_owner ON drafts(owner_id, updated_at);`,
  // 3: copies of LinkedIn images (their links expire within days); bytes stay NULL until fetched
  `CREATE TABLE media (key TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, url TEXT NOT NULL, mime TEXT, bytes BLOB,
     created_at INTEGER NOT NULL, fetched_at INTEGER) STRICT;
   CREATE INDEX media_age ON media(created_at);`,
  // 4: stories the owner pinned to the top of Today, across harvests until unpinned
  `CREATE TABLE pins (owner_id INTEGER NOT NULL, story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE, at INTEGER NOT NULL,
     PRIMARY KEY (owner_id, story_id)) STRICT;
   CREATE INDEX signals_story ON signals(owner_id, story_id, kind);`,
  // 5: pictures beyond LinkedIn: sizes of each copy, failed fetches, source logos, and portraits of people and places
  `ALTER TABLE media ADD COLUMN w INTEGER;
   ALTER TABLE media ADD COLUMN h INTEGER;
   ALTER TABLE media ADD COLUMN failed_at INTEGER;
   CREATE TABLE icons (owner_id INTEGER NOT NULL, host TEXT NOT NULL, url TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY (owner_id, host)) STRICT;
   CREATE TABLE entities (name TEXT NOT NULL, lang TEXT NOT NULL, url TEXT, page TEXT, checked_at INTEGER NOT NULL, PRIMARY KEY (name, lang)) STRICT;`,
  // 6: LinkedIn capture removed: its sources, posts, image copies and the extension's device tokens go
  `CREATE TEMP TABLE li_stories AS SELECT DISTINCT story_id AS id FROM items WHERE story_id IS NOT NULL AND source_id IN (SELECT id FROM sources WHERE kind = 'linkedin');
   DELETE FROM items WHERE source_id IN (SELECT id FROM sources WHERE kind = 'linkedin');
   DELETE FROM li_stories WHERE id IN (SELECT story_id FROM items WHERE story_id IS NOT NULL);
   DELETE FROM lens_cache WHERE story_id IN (SELECT id FROM li_stories);
   DELETE FROM edition_items WHERE story_id IN (SELECT id FROM li_stories);
   DELETE FROM edition_cut WHERE story_id IN (SELECT id FROM li_stories);
   DELETE FROM pins WHERE story_id IN (SELECT id FROM li_stories);
   DELETE FROM signals WHERE story_id IN (SELECT id FROM li_stories);
   DELETE FROM stories WHERE id IN (SELECT id FROM li_stories);
   DROP TABLE li_stories;
   DELETE FROM sources WHERE kind = 'linkedin';
   DELETE FROM media WHERE url LIKE 'https://media.licdn.com/%';
   DROP TABLE device_tokens;`,
  // 7: smaller copies of each picture, made on first request per width
  `CREATE TABLE media_variants (key TEXT NOT NULL, w INTEGER NOT NULL, mime TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (key, w)) STRICT;`,
  // 8: the one-line Wikipedia description of a person or place ("German politician"), shown with their portrait
  `ALTER TABLE entities ADD COLUMN description TEXT;`,
  // 9: the agent. A task is what one request became (a dossier, a probe, an explanation, a shared link); a proposal is
  // a palate change, applied at once when you said it, offered when the agent inferred it, undoable either way with
  // the values it replaced; an ask is a question about one story with its answer.
  `CREATE TABLE tasks (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
     kind TEXT NOT NULL CHECK (kind IN ('dossier','probe','explain','link')), input TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error','dismissed')),
     steps TEXT NOT NULL DEFAULT '[]', result TEXT NOT NULL DEFAULT '{}', story_id INTEGER, error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
   CREATE INDEX tasks_owner ON tasks(owner_id, updated_at);
   CREATE INDEX tasks_story ON tasks(story_id);
   CREATE TABLE proposals (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
     origin TEXT NOT NULL CHECK (origin IN ('command','inference')), said TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
     changes TEXT NOT NULL, before TEXT NOT NULL DEFAULT '[]', preview TEXT NOT NULL DEFAULT '{}',
     status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','applied','dismissed','undone')),
     created_at INTEGER NOT NULL, decided_at INTEGER) STRICT;
   CREATE INDEX proposals_owner ON proposals(owner_id, status);
   CREATE TABLE asks (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
     q TEXT NOT NULL, lang TEXT NOT NULL, answer TEXT, model TEXT, created_at INTEGER NOT NULL) STRICT;
   CREATE INDEX asks_story ON asks(owner_id, story_id);`,
  // 10: search over everything you follow. The old index held title and summary; the new one adds the article text and
  // the names from the tags (topics, people, orgs, places), ranked title > names > summary > text with bm25. A second,
  // trigram index over title and names finds parts of words ("markt" in "Flohmarkt"), which unicode61 cannot.
  `DROP TRIGGER items_ai; DROP TRIGGER items_ad; DROP TRIGGER items_au; DROP TABLE items_fts;
   CREATE VIRTUAL TABLE search USING fts5(title, names, summary, body, tokenize='unicode61 remove_diacritics 2');
   CREATE VIRTUAL TABLE search_tri USING fts5(title, names, tokenize='trigram remove_diacritics 1');
   CREATE TRIGGER search_ai AFTER INSERT ON items BEGIN
     INSERT INTO search(rowid, title, names, summary, body) VALUES (new.id, new.title, '', coalesce(new.summary, ''), coalesce(new.body, ''));
     INSERT INTO search_tri(rowid, title, names) VALUES (new.id, new.title, ''); END;
   CREATE TRIGGER search_ad AFTER DELETE ON items BEGIN
     DELETE FROM search WHERE rowid = old.id; DELETE FROM search_tri WHERE rowid = old.id; END;
   CREATE TRIGGER search_au AFTER UPDATE OF title, summary, body, tags ON items BEGIN
     DELETE FROM search WHERE rowid = old.id; DELETE FROM search_tri WHERE rowid = old.id;
     INSERT INTO search(rowid, title, names, summary, body) VALUES (new.id, new.title, ${names("new.tags")}, coalesce(new.summary, ''), coalesce(new.body, ''));
     INSERT INTO search_tri(rowid, title, names) VALUES (new.id, new.title, ${names("new.tags")}); END;
   INSERT INTO search(rowid, title, names, summary, body) SELECT i.id, i.title, ${names("i.tags")}, coalesce(i.summary, ''), coalesce(i.body, '') FROM items i;
   INSERT INTO search_tri(rowid, title, names) SELECT rowid, title, names FROM search;`,
  // what people say about a story: the public discussion per place (Hacker News, Bluesky, ...), kept comments as JSON; source 'none' marks "looked, found nothing"
  `CREATE TABLE discussions (story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE, source TEXT NOT NULL, url TEXT NOT NULL, fetched_at INTEGER NOT NULL,
     comments_json TEXT NOT NULL DEFAULT '[]', count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (story_id, source, url)) STRICT;`,
  // followed stories: "via" says whether you chose to follow or saving did; seen_at is when you last looked
  `CREATE TABLE follows (owner_id INTEGER NOT NULL, story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE, via TEXT NOT NULL DEFAULT 'follow',
     at INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (owner_id, story_id)) STRICT;
   INSERT OR IGNORE INTO follows (owner_id, story_id, via, at, seen_at) SELECT owner_id, story_id, 'save', at, at FROM pins;`,
  // the morning briefing: one per day, the stories it was written from (number in the text, story, picture), and
  // whether the email went out or what the mail server said
  `CREATE TABLE briefings (owner_id INTEGER NOT NULL, day TEXT NOT NULL, text TEXT NOT NULL, stories TEXT NOT NULL, created_at INTEGER NOT NULL,
     sent_at INTEGER, error TEXT, PRIMARY KEY (owner_id, day)) STRICT;`,
  // a followed dossier is followed like any story, so its news gets an update card and "since you last read"
  `INSERT OR IGNORE INTO follows (owner_id, story_id, via, at, seen_at)
     SELECT owner_id, story_id, 'follow', updated_at, updated_at FROM tasks
     WHERE kind = 'dossier' AND story_id IS NOT NULL AND status != 'dismissed' AND json_extract(result, '$.follow_until') > unixepoch() * 1000;`,
  // stories whose source was removed kept showing with no source and a 1970 date; those without reports go
  // (an agent's dossier or probe has none by design and stays)
  `CREATE TEMP TABLE orphan_stories AS SELECT id FROM stories
     WHERE id NOT IN (SELECT story_id FROM items WHERE story_id IS NOT NULL) AND id NOT IN (SELECT story_id FROM tasks WHERE story_id IS NOT NULL);
   DELETE FROM edition_items WHERE story_id IN (SELECT id FROM orphan_stories);
   DELETE FROM edition_cut WHERE story_id IN (SELECT id FROM orphan_stories);
   DELETE FROM signals WHERE story_id IN (SELECT id FROM orphan_stories);
   DELETE FROM stories WHERE id IN (SELECT id FROM orphan_stories);
   DROP TABLE orphan_stories;`,
  // a source added from "Sources for you" is on trial until then; an edition marks the stories it slotted in for you
  // to try ('trial': from a source on trial, 'different': outside your usual subjects)
  `ALTER TABLE sources ADD COLUMN trial_until INTEGER;
   ALTER TABLE edition_items ADD COLUMN slot TEXT;`,
  // texts that open with "the article could not be read" are written again without it; the Reader shows it as a pill
  `DELETE FROM lens_cache WHERE text LIKE '%could not be read%' OR text LIKE '%konnte nicht gelesen werden%' OR text LIKE '%nicht gelesen werden konnte%';`,
  // Claude's order of the day's stories for the reader (server/judge.ts): rank 1 is the most interesting of "of"
  // stories it kept; rank NULL means it left the story out. "at" is the run that judged it last.
  `CREATE TABLE judged (owner_id INTEGER NOT NULL, story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
     rank INTEGER, of INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (owner_id, story_id)) STRICT;`,
  // investigations: a photo and a note become a researched piece. A case has its evidence (each thing it knows, with
  // where it comes from) and its photos (the private original, and the public copy with faces blurred, made in the
  // browser). A draft from a case carries its meta (other headlines, editor notes, the photo, decisions before
  // publishing) and, once published, a slug on the writer's public page; versions, corrections, what readers send
  // back, daily read counts, subscribers by mail and push subscriptions go with it.
  `CREATE TABLE investigations (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id),
     title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', since TEXT, lang TEXT NOT NULL DEFAULT 'de',
     status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ready','quiet','error','dropped')), stage TEXT,
     steps TEXT NOT NULL DEFAULT '[]', place TEXT NOT NULL DEFAULT '{}', seen TEXT NOT NULL DEFAULT '{}', plan TEXT NOT NULL DEFAULT '{}',
     questions TEXT NOT NULL DEFAULT '[]', contacts TEXT NOT NULL DEFAULT '[]', angles TEXT NOT NULL DEFAULT '[]', angle TEXT, angle_deadline INTEGER,
     verdict TEXT NOT NULL DEFAULT 'null', draft_id INTEGER, pending TEXT, watch_until INTEGER, watched_at INTEGER, error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
   CREATE INDEX investigations_owner ON investigations(owner_id, status, updated_at);
   CREATE TABLE evidence (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, investigation_id INTEGER NOT NULL REFERENCES investigations(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('photo','note','answer','web','wiki','harvest','reply','tip')), title TEXT NOT NULL, site TEXT NOT NULL DEFAULT '',
     url TEXT, quote TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', at INTEGER, fresh INTEGER NOT NULL DEFAULT 0, same INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL) STRICT;
   CREATE INDEX evidence_case ON evidence(investigation_id);
   CREATE TABLE photos (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, investigation_id INTEGER REFERENCES investigations(id) ON DELETE CASCADE,
     mime TEXT NOT NULL, bytes BLOB NOT NULL, w INTEGER NOT NULL, h INTEGER NOT NULL, public_bytes BLOB, faces TEXT NOT NULL DEFAULT '[]',
     blur INTEGER NOT NULL DEFAULT 1, alt TEXT NOT NULL DEFAULT '', caption TEXT NOT NULL DEFAULT '', focal TEXT NOT NULL DEFAULT '{"x":0.5,"y":0.5}',
     taken_at INTEGER, created_at INTEGER NOT NULL) STRICT;
   CREATE INDEX photos_case ON photos(investigation_id);
   ALTER TABLE drafts ADD COLUMN investigation_id INTEGER;
   ALTER TABLE drafts ADD COLUMN slug TEXT;
   ALTER TABLE drafts ADD COLUMN publish_at INTEGER;
   ALTER TABLE drafts ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
   CREATE UNIQUE INDEX drafts_slug ON drafts(owner_id, slug) WHERE slug IS NOT NULL;
   CREATE TABLE draft_versions (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, owner_id INTEGER NOT NULL,
     by TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', blocks TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
   CREATE INDEX draft_versions_draft ON draft_versions(draft_id, id);
   CREATE TABLE corrections (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, owner_id INTEGER NOT NULL,
     kind TEXT NOT NULL DEFAULT 'correction', text TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
   CREATE TABLE reader_notes (id INTEGER PRIMARY KEY, draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, owner_id INTEGER NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('tip','fix')), text TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL) STRICT;
   CREATE TABLE page_stats (draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE, day TEXT NOT NULL, reads INTEGER NOT NULL DEFAULT 0,
     finishes INTEGER NOT NULL DEFAULT 0, shares INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (draft_id, day)) STRICT;
   CREATE TABLE subscribers (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, email TEXT NOT NULL, token TEXT NOT NULL, confirmed_at INTEGER,
     created_at INTEGER NOT NULL, UNIQUE (owner_id, email)) STRICT;
   CREATE TABLE push_subs (endpoint TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL) STRICT;`,
  // 20: digging into one sentence of a story (is it true, the data behind it, who said it, explained, a question), kept
  // so the same sentence asked again replays instead of searching and writing again
  `CREATE TABLE digs (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id), story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
     kind TEXT NOT NULL, sentence TEXT NOT NULL, q TEXT NOT NULL DEFAULT '', lang TEXT NOT NULL, answer TEXT NOT NULL, model TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
   CREATE INDEX digs_story ON digs(owner_id, story_id);`,
  // 21: keyword filters per source (server/filter.ts): {"any": [...], "none": [...]}, applied before items are stored
  `ALTER TABLE sources ADD COLUMN filter TEXT NOT NULL DEFAULT '{}';`,
];

db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
const cur = (db.query("SELECT v FROM schema_version").get() as { v: number } | null)?.v ?? 0;
for (let i = cur; i < MIGRATIONS.length; i++) {
  db.transaction(() => {
    db.exec(MIGRATIONS[i]);
    db.exec("DELETE FROM schema_version");
    db.query("INSERT INTO schema_version (v) VALUES (?)").run(i + 1);
  })();
}

// accounts (server/accounts, docs/accounts.md): passkeys, sessions and links in the module's auth_* tables, roles on
// `users`. A database from before the module moves its passkeys over once (they are SPKI keys, which the module still
// reads); the old sessions go, because the cookie changed its name and everyone signs in once more with their passkey.
migrateAccounts(db, "users");
if (tableExists(db, "passkeys")) db.transaction(() => {
  db.exec(`INSERT INTO auth_passkey (id, account_id, public_key, alg, sign_count, name, created_at, last_used_at)
      SELECT id, owner_id, public_key, alg, sign_count, coalesce(nullif(label, ''), 'Passkey'), created_at, last_used_at FROM passkeys;
    DROP TABLE sessions; DROP TABLE passkeys;
    UPDATE users SET role = 'admin' WHERE id = (SELECT min(account_id) FROM auth_passkey) AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');`);
})();

export const now = () => Date.now();
/** Stories the agent made (dossiers, probes): they stay out of the scored edition, the feed and clustering. */
export const AGENT_STORIES = "SELECT story_id FROM tasks WHERE story_id IS NOT NULL AND kind IN ('dossier', 'probe')";
export const json = <T>(s: string | null | undefined, fallback: T): T => { try { return s ? JSON.parse(s) as T : fallback; } catch { return fallback; } };

export function setting<T>(owner: number, key: string, fallback: T): T {
  const r = db.query("SELECT value FROM settings WHERE owner_id = ? AND key = ?").get(owner, key) as { value: string } | null;
  return r ? json(r.value, fallback) : fallback;
}
export function setSetting(owner: number, key: string, value: unknown) {
  db.query("INSERT INTO settings (owner_id, key, value) VALUES (?, ?, ?) ON CONFLICT(owner_id, key) DO UPDATE SET value = excluded.value").run(owner, key, JSON.stringify(value));
}

/** Daily copy of the whole database (VACUUM INTO is a consistent snapshot while the app keeps writing). Keeps the last 7. */
export function backupIfDue(dir = process.env.PEPPERMINT_BACKUPS ?? join(dirname(DB_PATH), "backups"), keep = 7) {
  if (DB_PATH === ":memory:") return null;
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(dir).filter(f => /^peppermint-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  const last = files.at(-1);
  if (last && Date.now() - statSync(join(dir, last)).mtimeMs < 23 * 3600_000) return null;
  const path = join(dir, `peppermint-${new Date().toISOString().slice(0, 10)}.db`);
  rmSync(path, { force: true });
  db.query("VACUUM INTO ?").run(path);
  for (const f of [...files.filter(f => join(dir, f) !== path), path.split("/").pop()!].slice(0, -keep)) rmSync(join(dir, f), { force: true });
  return path;
}
