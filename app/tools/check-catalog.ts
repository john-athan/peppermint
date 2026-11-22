// Fetches every catalog feed and parses it; prints failures. Run: bun tools/check-catalog.ts
import { CATALOG } from "../server/connectors/catalog";
import { get, parseFeed, pool } from "../server/connectors/util";
const all = CATALOG.flatMap(g => g.entries.map(e => ({ g: g.id, ...e })));
const res = await pool(all, 6, async e => {
  try { const f = parseFeed((await get(e.feed, { guard: true, timeout: 12_000 })).text); return f.entries.length ? `ok   ${f.entries.length}` : "FAIL empty"; }
  catch (x) { return `FAIL ${(x as Error).message.slice(0, 80)}`; }
});
all.forEach((e, i) => console.log(res[i] ?? "FAIL", e.g.padEnd(9), e.name.padEnd(26), e.feed));
