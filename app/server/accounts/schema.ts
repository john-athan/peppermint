// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// The module's tables. The account table itself belongs to the app (Monet's `owner`, peppermint's `users`): it must
// have `id INTEGER PRIMARY KEY`, `name TEXT NOT NULL` and `created_at INTEGER NOT NULL`; this adds `role`. Everything
// else is the module's own, prefixed `auth_`, with its own version counter so it never collides with the app's
// migrations. Call migrateAccounts() right after the app's own migrations, at every start: it is idempotent.
import type { Database } from "bun:sqlite";

const STEPS: ((t: string) => string)[] = [
  t => `ALTER TABLE ${t} ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
   CREATE TABLE auth_passkey (id TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE,
     public_key BLOB NOT NULL, alg INTEGER NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL,
     created_at INTEGER NOT NULL, last_used_at INTEGER) STRICT;
   CREATE INDEX auth_passkey_account ON auth_passkey(account_id);
   CREATE TABLE auth_device (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE,
     name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
     created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER) STRICT;
   CREATE INDEX auth_device_account ON auth_device(account_id);
   -- token hashes only: the cookie value never touches the disk
   CREATE TABLE auth_session (hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE,
     kind TEXT NOT NULL CHECK (kind IN ('browser', 'device')), device_id INTEGER REFERENCES auth_device(id) ON DELETE CASCADE,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, user_agent TEXT) STRICT;
   CREATE INDEX auth_session_account ON auth_session(account_id);
   CREATE TABLE auth_pairing (code_hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL, used_at INTEGER) STRICT;
   -- one-time links: join (first passkey), recover (replaces all passkeys), add (one more passkey)
   CREATE TABLE auth_link (hash TEXT PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES ${t}(id) ON DELETE CASCADE,
     purpose TEXT NOT NULL CHECK (purpose IN ('join', 'recover', 'add')), created_by INTEGER REFERENCES ${t}(id) ON DELETE SET NULL,
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER) STRICT;
   CREATE INDEX auth_link_account ON auth_link(account_id);`,
];

export function migrateAccounts(db: Database, table: string) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`accounts: bad table name ${table}`);
  db.exec("CREATE TABLE IF NOT EXISTS auth_schema (v INTEGER NOT NULL) STRICT");
  const cur = (db.query("SELECT v FROM auth_schema").get() as { v: number } | null)?.v ?? 0;
  for (let v = cur; v < STEPS.length; v++) {
    db.transaction(() => {
      db.exec(STEPS[v](table));
      db.exec("DELETE FROM auth_schema");
      db.query("INSERT INTO auth_schema (v) VALUES (?)").run(v + 1);
    })();
  }
}

export const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
