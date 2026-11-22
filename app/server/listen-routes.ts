// What the Android app fetches with its device token (scope "listen", docs/android.md): the episodes worth having on
// the phone, one episode for the web player's "play in the app", and what has been heard. The edition read aloud is
// /api/listen in main.ts, the same stream the Listen page reads. main.ts hands its route() here.
import { db, json, now, setting, setSetting } from "./db";
import { episodeInput } from "./listen";
import { readingLang } from "./lens";

type Ctx = { req: Request; url: URL; owner: number | null; params: Record<string, string> };
type Route = (method: string, path: string, h: (c: Ctx) => Response | Promise<Response>, open?: boolean, scope?: string) => void;
const J = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** How far back a followed podcast's episodes count as new, and how many the phone is offered at most. */
export const FRESH_DAYS = 14, QUEUE_MAX = 30;
const HEARD_MAX = 2000;

export type Episode = { id: number; story_id: number | null; title: string; show: string; audio: string; duration: number | null; image: string | null; published_at: number; saved: boolean };

const SELECT = `SELECT i.id, i.story_id, i.title, i.published_at, i.meta, s.name AS show,
  i.story_id IN (SELECT story_id FROM pins WHERE owner_id = i.owner_id) AS saved
  FROM items i JOIN sources s ON s.id = i.source_id`;
const episode = (r: any): Episode => {
  const m = json<any>(r.meta, {});
  return { id: r.id, story_id: r.story_id, title: r.title, show: r.show, audio: m.audio, duration: m.duration ?? null, image: m.image ?? null, published_at: r.published_at, saved: !!r.saved };
};

export const heard = (owner: number) => new Set(setting<number[]>(owner, "listened", []));

/** Saved episodes first, then the newest of every podcast you follow, without the ones already heard. */
export function queue(owner: number): Episode[] {
  const done = heard(owner);
  const rows = db.query(`${SELECT} WHERE i.owner_id = ? AND json_extract(i.meta, '$.audio') IS NOT NULL
    AND ((s.kind = 'podcast' AND s.enabled = 1 AND i.published_at > ?) OR i.story_id IN (SELECT story_id FROM pins WHERE owner_id = ?))
    ORDER BY saved DESC, i.published_at DESC LIMIT ?`).all(owner, now() - FRESH_DAYS * 86_400_000, owner, QUEUE_MAX + done.size) as any[];
  return rows.map(episode).filter(e => !done.has(e.id)).slice(0, QUEUE_MAX);
}

export function oneEpisode(owner: number, id: number): Episode | null {
  const r = db.query(`${SELECT} WHERE i.owner_id = ? AND i.id = ? AND json_extract(i.meta, '$.audio') IS NOT NULL`).get(owner, id);
  return r ? episode(r) : null;
}

/** Marks an episode heard (or not). Only the newest HEARD_MAX are kept, which is far more than a queue ever offers. */
export function markHeard(owner: number, id: number, on = true) {
  const list = setting<number[]>(owner, "listened", []).filter(x => x !== id);
  if (on) list.push(id);
  setSetting(owner, "listened", list.slice(-HEARD_MAX));
}

export function listenRoutes(route: Route) {
  route("GET", "/api/listen/queue", ({ owner }) => {
    const name = (db.query("SELECT name FROM users WHERE id = ?").get(owner) as { name: string } | null)?.name ?? "";
    const inp = episodeInput(owner!);
    const lang = readingLang(owner!) === "de" ? "de" : "en";
    return J({
      name, lang,
      // the edition the phone reads aloud: it makes a new recording when id or sig changes
      edition: inp && inp.cards.length ? { id: inp.edition.id, day: inp.edition.day, slot: inp.edition.slot, sig: inp.sig, stories: inp.cards.length } : null,
      episodes: queue(owner!),
    });
  }, false, "listen");
  route("GET", "/api/listen/episodes/:id", ({ owner, params }) => {
    const e = oneEpisode(owner!, Number(params.id));
    return e ? J(e) : J({ error: "No such episode." }, 404);
  }, false, "listen");
  route("POST", "/api/listen/episodes/:id/heard", async ({ req, owner, params }) => {
    const id = Number(params.id);
    if (!oneEpisode(owner!, id)) return J({ error: "No such episode." }, 404);
    let on = true; try { on = (await req.json())?.heard !== false; } catch { /* no body: heard */ }
    markHeard(owner!, id, on);
    return J({ ok: true });
  }, false, "listen");
}

/** The Android app's signing key (~/.config/peppermint-android): Chrome opens peppermint full screen inside the app only
 *  when this file names it. A new key means a new fingerprint here. */
export const ASSETLINKS = JSON.stringify([{ relation: ["delegate_permission/common.handle_all_urls"], target: { namespace: "android_app", package_name: "dev.kaleve.peppermint",
  sha256_cert_fingerprints: ["3C:1D:FA:1A:3E:60:CD:9F:D2:1E:EC:3A:F6:D5:10:2C:05:17:83:36:BA:82:E5:7C:76:46:B3:9A:65:7D:19:96"] } }]);
