// The creator picker: find a podcast or a YouTube channel by name, without an account or an API key.
// Podcasts come from Apple's public podcast directory (each entry names the show's RSS feed). YouTube channels come from
// the public channel search page, or from a pasted channel link or @handle; every channel has a public feed.
import { get } from "./util";

export type Creator = { kind: "podcast" | "youtube"; name: string; by: string; image: string | null; feed: string; note?: string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
// YouTube shows a cookie consent page to European visitors without this cookie; it means "consent: essential only"
const YT = { "user-agent": UA, cookie: "SOCS=CAI", "accept-language": "en" };
const ytFeed = (id: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

export async function searchPodcasts(q: string): Promise<Creator[]> {
  const url = `https://itunes.apple.com/search?media=podcast&entity=podcast&limit=12&term=${encodeURIComponent(q)}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Apple's podcast directory answered ${r.status}.`);
  const d = await r.json() as { results?: any[] };
  return (d.results ?? []).filter(x => typeof x.feedUrl === "string" && /^https?:\/\//.test(x.feedUrl)).map(x => ({
    kind: "podcast" as const, name: String(x.collectionName ?? "").slice(0, 80), by: String(x.artistName ?? "").slice(0, 80),
    image: x.artworkUrl600 ?? x.artworkUrl100 ?? null, feed: x.feedUrl, note: [x.primaryGenreName, x.trackCount ? `${x.trackCount} episodes` : ""].filter(Boolean).join(" · "),
  }));
}

/** ytInitialData is the JSON the YouTube page renders from; channel results sit in channelRenderer objects. */
function initialData(html: string): any {
  const m = /var ytInitialData = (\{[\s\S]*?\});<\/script>/.exec(html) ?? /window\["ytInitialData"\] = (\{[\s\S]*?\});/.exec(html);
  try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
}
const text = (t: any) => t?.simpleText ?? (Array.isArray(t?.runs) ? t.runs.map((r: any) => r.text).join("") : "");
function channels(node: any, out: any[] = []): any[] {
  if (!node || typeof node !== "object") return out;
  if (node.channelRenderer) { out.push(node.channelRenderer); return out; }
  for (const k in node) channels(node[k], out);
  return out;
}
const thumb = (t: any) => { const u = t?.thumbnails?.slice(-1)[0]?.url; return u ? (u.startsWith("//") ? "https:" + u : u) : null; };

/** A channel link, a youtube.com/@handle, or a bare @handle: read the channel page for its id. */
export async function resolveYouTube(input: string): Promise<Creator | null> {
  const s = input.trim();
  let url: string | null = null;
  if (/^@[\w.-]{2,}$/.test(s)) url = `https://www.youtube.com/${s}`;
  else if (/^(https?:\/\/)?(www\.|m\.)?youtube\.com\//i.test(s)) url = (/^https?:/i.test(s) ? s : `https://${s}`).replace("//m.", "//www.");
  if (!url) return null;
  const direct = /\/channel\/(UC[\w-]{22})/.exec(url)?.[1];
  // a channel page is over 3 MB of script; the id sits in it somewhere
  const page = await get(url, { guard: true, timeout: 10_000, headers: YT, maxBytes: 8_000_000 });
  const id = direct ?? /"externalId":"(UC[\w-]{22})"/.exec(page.text)?.[1] ?? /feeds\/videos\.xml\?channel_id=(UC[\w-]{22})/.exec(page.text)?.[1] ?? /"channelId":"(UC[\w-]{22})"/.exec(page.text)?.[1];
  if (!id) return null;
  const meta = initialData(page.text)?.metadata?.channelMetadataRenderer;
  const name = meta?.title ?? /<meta property="og:title" content="([^"]+)"/.exec(page.text)?.[1] ?? "YouTube channel";
  const image = meta?.avatar?.thumbnails?.[0]?.url ?? /<meta property="og:image" content="([^"]+)"/.exec(page.text)?.[1] ?? null;
  return { kind: "youtube", name: name.slice(0, 80), by: "YouTube", image, feed: ytFeed(id), note: meta?.vanityChannelUrl?.split("/").pop() ?? "" };
}

export async function searchYouTube(q: string): Promise<Creator[]> {
  const one = await resolveYouTube(q);
  if (one) return [one];
  // sp=EgIQAg%3D%3D filters the results to channels
  const page = await get(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAg%253D%253D`, { guard: true, timeout: 10_000, headers: YT });
  const found = channels(initialData(page.text));
  if (!found.length && /consent\.youtube\.com|Sign in to confirm/.test(page.text)) throw new Error("YouTube asked for a sign-in from this server. Paste the channel link or @handle instead.");
  return found.filter(c => /^UC[\w-]{22}$/.test(c.channelId ?? "")).slice(0, 12).map(c => ({
    kind: "youtube" as const, name: text(c.title).slice(0, 80), by: "YouTube", image: thumb(c.thumbnail), feed: ytFeed(c.channelId),
    note: [text(c.subscriberCountText), text(c.videoCountText)].filter(Boolean).join(" · "),
  }));
}
