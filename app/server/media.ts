// Copies of the images peppermint shows: story pictures from feeds and article pages, source logos and portraits of
// people and places. Each image is fetched once, kept per owner and served from here, so the reader's browser never
// contacts the source or a tracker.
import { db, now } from "./db";
import { assertPublic } from "./connectors/util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_DAYS = 21;
const UA = "peppermint/1.0 (personal reader; +https://peppermint.kaleve.dev)";
// SVG is left out on purpose: served from our own origin it could carry script
const TYPES = /^image\/(jpeg|png|webp|gif|avif|x-icon|vnd\.microsoft\.icon)$/;

/** Stable per owner and image link. */
export const mediaKey = (owner: number, url: string) => Bun.hash(`${owner}:${url}`).toString(36);

/** Records the image so it can be fetched and served; returns its local path, or null for a link we do not copy
 *  (https only; it is fetched with the address guard). */
export function remember(owner: number, url: string): string | null {
  if (!/^https:\/\/[^\s]{4,1500}$/.test(url)) return null;
  const key = mediaKey(owner, url);
  // created_at doubles as "last wanted", which pruning reads
  db.query("INSERT INTO media (key, owner_id, url, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET created_at = excluded.created_at, url = CASE WHEN media.bytes IS NULL THEN excluded.url ELSE media.url END").run(key, owner, url, now());
  return `/api/media/${key}`;
}

/** Width and height from the file header (JPEG, PNG, GIF, WebP, ICO), without decoding the picture. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (b.length > 30 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const f = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (f === "VP8 ") return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
    if (f === "VP8L") { const x = v.getUint32(21, true); return { w: (x & 0x3fff) + 1, h: ((x >> 14) & 0x3fff) + 1 }; }
    if (f === "VP8X") return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
  }
  if (b.length > 6 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) {
    // ICO: the largest frame in the directory; 0 means 256
    let best = 0; for (let i = 0, n = v.getUint16(4, true); i < n && 6 + i * 16 + 1 < b.length; i++) best = Math.max(best, b[6 + i * 16] || 256);
    return best ? { w: best, h: best } : null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}

/** Fetches with the address guard on every redirect hop, so a feed cannot point the server at its own network. */
async function download(url: string): Promise<Response | null> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(at);
    const r = await fetch(at, { redirect: "manual", headers: { "user-agent": UA, accept: "image/*" }, signal: AbortSignal.timeout(15_000) });
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { at = new URL(loc, at).href; if (!at.startsWith("https://")) return null; continue; }
    return r;
  }
  return null;
}

type Row = { url: string; mime: string | null; bytes: Uint8Array | null; failed_at: number | null };
async function fetchOne(key: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const row = db.query("SELECT url, mime, bytes, failed_at FROM media WHERE key = ?").get(key) as Row | null;
  if (!row) return null;
  if (row.bytes) return { mime: row.mime ?? "image/jpeg", bytes: row.bytes };
  if (row.failed_at && row.failed_at > now() - 86400_000) return null;
  try {
    let r = await download(row.url);
    // YouTube has the large still only for videos uploaded in HD; the feed's own size always exists
    if (r?.status === 404 && /\/maxresdefault\.jpg$/.test(row.url)) r = await download(row.url.replace("maxresdefault", "hqdefault"));
    const mime = r?.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!r?.ok || !TYPES.test(mime) || Number(r.headers.get("content-length") ?? 0) > MAX_BYTES) throw new Error("not an image");
    const bytes = new Uint8Array(await r.arrayBuffer());
    const size = imageSize(bytes);
    if (bytes.length > MAX_BYTES || !size) throw new Error("not an image");
    db.query("UPDATE media SET mime = ?, bytes = ?, w = ?, h = ?, fetched_at = ?, failed_at = NULL WHERE key = ?").run(mime, bytes, size.w, size.h, now(), key);
    return { mime, bytes };
  } catch {
    db.query("UPDATE media SET failed_at = ? WHERE key = ?").run(now(), key);
    return null;
  }
}

/** Fetches what is still missing, a few at a time. */
export async function fetchPending(owner: number, limit = 80) {
  const keys = (db.query(`SELECT key FROM media WHERE owner_id = ? AND bytes IS NULL AND created_at > ? AND (failed_at IS NULL OR failed_at < ?)
    ORDER BY created_at DESC LIMIT ?`).all(owner, now() - 14 * 86400_000, now() - 86400_000, limit) as { key: string }[]).map(r => r.key);
  for (let i = 0; i < keys.length; i += 4) await Promise.all(keys.slice(i, i + 4).map(fetchOne));
}
export const fetchMedia = fetchOne;

/** Where a copy stands: its size once fetched, "failed" after a failed fetch (retried a day later), "pending" while it
 *  waits, null when it was never asked for. */
export function mediaState(key: string): { w: number; h: number } | "failed" | "pending" | null {
  const r = db.query("SELECT w, h, bytes IS NOT NULL AS ok, failed_at FROM media WHERE key = ?").get(key) as { w: number | null; h: number | null; ok: number; failed_at: number | null } | null;
  if (!r) return null;
  if (r.ok && r.w && r.h) return { w: r.w, h: r.h };
  return r.failed_at && r.failed_at > now() - 86400_000 ? "failed" : "pending";
}

/* ---------- smaller copies ----------
   Pages ask for /api/media/<key>?w=<width>; each width is made once (libvips on the server, sips on a Mac) and kept.
   Without either tool, or for icons and GIFs, the original is served. */
export const VARIANT_WIDTHS = [160, 320, 480, 800, 1200];
const VIPS = Bun.which("vipsthumbnail"), SIPS = process.platform === "darwin" ? Bun.which("sips") : null;
const TMP = join(tmpdir(), "peppermint-img");
let resizing = 0; const waiting: (() => void)[] = [];
async function oneAtATime<T>(f: () => Promise<T>): Promise<T> {
  if (resizing >= 2) await new Promise<void>(r => waiting.push(r)); else resizing++;
  try { return await f(); } finally { const n = waiting.shift(); if (n) n(); else resizing--; }
}
/** A smaller copy: WebP for pages (JPEG where only sips exists), or JPEG when `jpeg` is asked for (mail: Outlook shows no WebP). */
async function resize(bytes: Uint8Array, w: number, jpeg = false): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!VIPS && !SIPS) return null;
  const webp = !!VIPS && !jpeg;
  return oneAtATime(async () => {
    mkdirSync(TMP, { recursive: true });
    const id = crypto.randomUUID(), src = join(TMP, `${id}.in`), out = join(TMP, `${id}.${webp ? "webp" : "jpg"}`);
    try {
      writeFileSync(src, bytes);
      const args = VIPS ? [VIPS, src, "--size", `${w}x`, "-o", `${out}[Q=${webp ? 72 : 78},strip${webp ? "" : ",interlace"}]`] : [SIPS!, "--resampleWidth", String(w), "-s", "format", "jpeg", "-s", "formatOptions", "78", src, "--out", out];
      const p = Bun.spawn(args, { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => p.kill(), 20_000);
      const code = await p.exited; clearTimeout(timer);
      if (code !== 0) return null;
      const b = new Uint8Array(readFileSync(out));
      return b.length ? { mime: webp ? "image/webp" : "image/jpeg", bytes: b } : null;
    } catch { return null; } finally { rmSync(src, { force: true }); rmSync(out, { force: true }); }
  });
}
async function variant(key: string, w: number, orig: { mime: string; bytes: Uint8Array }): Promise<{ mime: string; bytes: Uint8Array }> {
  const info = mediaInfo(key);
  if (!info || info.w <= w || !/^image\/(jpeg|png|webp|avif)$/.test(orig.mime)) return orig;
  const have = db.query("SELECT mime, bytes FROM media_variants WHERE key = ? AND w = ?").get(key, w) as { mime: string; bytes: Uint8Array } | null;
  if (have) return have;
  const made = await resize(orig.bytes, w);
  // a "smaller" copy that is not actually smaller is not kept
  if (!made || made.bytes.length >= orig.bytes.length) return orig;
  db.query("INSERT OR REPLACE INTO media_variants (key, w, mime, bytes) VALUES (?, ?, ?, ?)").run(key, w, made.mime, made.bytes);
  return made;
}

/** Size of a fetched copy, or null while it is missing. */
export function mediaInfo(key: string): { w: number; h: number } | null {
  return db.query("SELECT w, h FROM media WHERE key = ? AND bytes IS NOT NULL AND w IS NOT NULL").get(key) as { w: number; h: number } | null;
}

export async function serveMedia(owner: number, key: string, width?: number): Promise<Response> {
  const own = db.query("SELECT 1 FROM media WHERE key = ? AND owner_id = ?").get(key, owner);
  const orig = own && await fetchOne(key);
  const w = width && VARIANT_WIDTHS.includes(width) ? width : 0;
  const m = orig && w ? await variant(key, w, orig) : orig;
  if (!m) return new Response("Image not available.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  return new Response(m.bytes, { headers: { "content-type": m.mime, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" } });
}

/** A picture for an email or for Claude: JPEG at most `w` pixels wide (twice the width it is shown at, for sharp
 *  phones), since Outlook shows no WebP; Claude reads figures at 1568. PNG and JPEG originals that are small enough go as they are; null when there is no usable copy. */
export async function mailPicture(owner: number, key: string, w = 1120): Promise<{ mime: string; bytes: Uint8Array } | null> {
  const own = db.query("SELECT 1 FROM media WHERE key = ? AND owner_id = ?").get(key, owner);
  const orig = own && await fetchOne(key);
  if (!orig || !/^image\/(jpeg|png|webp|avif)$/.test(orig.mime)) return null;
  const info = mediaInfo(key);
  if (info && info.w <= w && /^image\/(jpeg|png)$/.test(orig.mime)) return orig;
  return (await resize(orig.bytes, Math.min(w, info?.w ?? w), true)) ?? (/^image\/(jpeg|png)$/.test(orig.mime) ? orig : null);
}

export function pruneMedia() {
  const n = db.query("DELETE FROM media WHERE created_at < ?").run(now() - KEEP_DAYS * 86400_000).changes;
  db.query("DELETE FROM media_variants WHERE key NOT IN (SELECT key FROM media)").run();
  return n;
}
