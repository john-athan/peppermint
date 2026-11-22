// Live smoke check of the account-free connectors: discover and pull once against the real internet. Run: bun tools/smoke-sources.ts
process.env.PEPPERMINT_DB = ":memory:";
const { CONNECTORS } = await import("../server/connectors");
const { configFor } = await import("../server/connectors/more");

const cases: { kind: string; input: string; also?: string }[] = [
  { kind: "bluesky", input: "https://bsky.app/profile/bsky.app" },
  { kind: "mastodon", input: "@Gargron@mastodon.social" },
  { kind: "github", input: "https://github.com/oven-sh/bun" },
  { kind: "arxiv", input: "https://arxiv.org/list/cs.CL/recent" },
  { kind: "watch", input: "https://www.tagesschau.de/" },
];
const row = (kind: string, s: string) => console.log(`${kind.padEnd(9)} ${s}`);
async function pullOnce(kind: string, config: any) {
  const c = CONNECTORS[kind];
  const first = await c.pull!({ id: 0, owner_id: 0, kind, name: "", config: "{}", cursor: "{}", cadence_min: 60, trust: 1 }, config, {});
  return first;
}
for (const t of cases) {
  try {
    const d = await CONNECTORS[t.kind].discover(t.input);
    const { config } = await configFor(t.kind, d.config);
    const p = await pullOnce(t.kind, config);
    row(t.kind, `discover ok "${d.name}" | pull ${p.items.length} items | sample: ${p.items[0]?.title?.slice(0, 80) ?? "(none, expected for watch baseline)"}`);
    if (t.kind === "watch") {
      const again = await CONNECTORS.watch.pull!({} as any, config, p.cursor);
      row(t.kind, `second pull ${again.items.length} items (page text unchanged or changed)`);
    }
  } catch (e) { row(t.kind, `ERROR ${(e as Error).message}`); }
  if (t.kind === "github") await Bun.sleep(3500); // arXiv asks for one request every 3 seconds
}
try {
  const p = await pullOnce("topic", { q: "München", lang: "de" });
  row("topic", `pull ${p.items.length} items | sample: ${p.items[0]?.title?.slice(0, 80)} | body chars: ${p.items[0]?.body?.length}`);
  const en = await pullOnce("topic", { q: "open source AI", lang: "en" });
  row("topic", `en pull ${en.items.length} items | sample: ${en.items[0]?.title?.slice(0, 80)}`);
} catch (e) { row("topic", `ERROR ${(e as Error).message}`); }
