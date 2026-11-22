// Live smoke test for the discussion fetchers (not part of `bun test`: it needs the internet).
// Usage: bun tools/smoke-discussion.ts
// Each check picks a current example from the source itself, runs the real fetcher and prints counts and one comment.
process.env.PEPPERMINT_DB ??= ":memory:";
const D = await import("../server/discussion");
const { get } = await import("../server/connectors/util");
const J = async (u: string) => JSON.parse((await get(u, { timeout: 15_000, headers: { accept: "application/json" } })).text);

let bad = 0;
const show = (name: string, t: Awaited<ReturnType<typeof D.fetchHnItem>>, extra = "") => {
  if (!t) { bad++; console.log(`FAIL ${name}: no discussion found ${extra}`); return; }
  const c = t.comments.find(c => c.depth === 0 && c.text.length > 40) ?? t.comments[0];
  console.log(`ok   ${name}: ${t.count} comments in the thread, ${t.comments.length} kept, ${t.comments.filter(c => c.depth).length} replies ${extra}\n       ${t.url}\n       sample: ${c.by}: ${c.text.replace(/\s+/g, " ").slice(0, 160)}`);
};
const step = async (name: string, f: () => Promise<void>) => { try { await f(); } catch (e: any) { bad++; console.log(`FAIL ${name}: ${e?.message ?? e}`); } };

await step("Hacker News item", async () => {
  const top = (await J("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30")).hits.sort((a: any, b: any) => b.num_comments - a.num_comments)[0];
  show(`Hacker News story "${String(top.title).slice(0, 50)}"`, await D.fetchHnItem(top.objectID));
  await step("HN by article URL", async () => {
    const found = await D.findHn(top.url);
    console.log(`ok   HN lookup by URL ${top.url}: ${found.length} matching thread(s) ${JSON.stringify(found)}`);
    if (!found.length) throw new Error("the story's own URL did not find it");
    show("  thread found by URL", await D.fetchHnItem(found[0].id));
  });
});

await step("Lobsters by article URL", async () => {
  const s = (await J("https://lobste.rs/hottest.json")).filter((s: any) => s.url && s.comment_count > 3)[0];
  if (!s) throw new Error("no hot story with a URL");
  show(`Lobsters "${String(s.title).slice(0, 50)}"`, await D.fetchLobsters(s.url));
});

await step("Bluesky replies", async () => {
  const feed = await J("https://public.api.bsky.app/xrpc/app.bsky.feed.getFeed?feed=at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot&limit=30");
  const p = feed.feed.map((x: any) => x.post).sort((a: any, b: any) => (b.replyCount ?? 0) - (a.replyCount ?? 0))[0];
  show(`Bluesky post by @${p.author.handle}`, await D.fetchBluesky(p.uri));
});

await step("Mastodon replies", async () => {
  const trends = await J("https://mastodon.social/api/v1/trends/statuses?limit=40");
  // the id in a post's own link is the one its home instance knows, which is what the connector stores
  const cands = trends.filter((s: any) => D.mastodonStatus(s.url)).sort((a: any, b: any) => b.replies_count - a.replies_count);
  let t = null, used = "";
  for (const s of cands.slice(0, 6)) { used = s.url; try { t = await D.fetchMastodon(s.url); } catch {} if (t) break; }
  show(`Mastodon status ${used}`, t);
});

await step("YouTube comments", async () => {
  show("YouTube dQw4w9WgXcQ", await D.fetchYoutube("dQw4w9WgXcQ"));
});

console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
