// Thin fetch layer. Errors carry the server's own sentence so the UI can show it as is.
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, { ...rest, headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) }, body: json !== undefined ? JSON.stringify(json) : rest.body, credentials: "same-origin" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  return data as T;
}
/** A file from our own server (a photo to blur before it goes public). */
export async function getBlob(path: string): Promise<Blob> {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) throw new ApiError(r.status, `Could not load ${path} (${r.status}).`);
  return r.blob();
}
/** A request whose answer is a long stream nobody reads: resolves once the server is done. */
export const drain = (path: string) => fetch(path, { credentials: "same-origin" }).then(r => r.text());
/** A fire-and-forget POST that survives the page closing (signals sent on the way out). */
export const beacon = (path: string, json: unknown) => { fetch(path, { method: "POST", keepalive: true, credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(json) }).catch(() => {}); };
/** EventSource with parsed handlers. `tap` sees every frame raw (type, id, data), for views that show the wire itself. */
export function sse(url: string, on: Record<string, (d: any) => void>, tap?: (type: string, id: string, data: string) => void): () => void {
  const es = new EventSource(url);
  // a stream that ended on its own (or was closed by the caller) can still get the browser's queued transport error;
  // it must not replace the server's own message with "dropped"
  let ended = false;
  // done and error are always heard: a stream nobody closes is reopened by the browser and replayed from the start
  const types = new Set([...Object.keys(on), "done", "error", ...(tap ? ["open", "delta"] : [])]);
  for (const ev of types) es.addEventListener(ev, (e: MessageEvent) => {
    if (ev === "error" && !e.data) return; // a transport error, handled by onerror below
    tap?.(ev, e.lastEventId, e.data);
    let d: any = {}; try { d = JSON.parse(e.data); } catch {}
    on[ev]?.(d);
    if (ev === "done" || ev === "error" || ev === "edition") { ended = true; es.close(); }
  });
  es.onerror = () => { if (!ended && es.readyState === EventSource.CLOSED) on.error?.({ code: "network", message: "The connection dropped." }); };
  return () => { ended = true; es.close(); };
}

/**
 * Keeps a set of stories on this device: asks the server what they need (/api/offline) and fetches each piece once,
 * four at a time; the service worker stores the answers. Pictures already kept are not fetched again.
 */
export async function keepOffline(scope: "list" | "harvest", progress?: (done: number, total: number) => void): Promise<{ stories: number; failed: number }> {
  const m = await api<{ stories: number; urls: string[] }>(`/api/offline?scope=${scope}`);
  const data = typeof caches !== "undefined" ? await caches.open("pm-data") : null;
  let done = 0, failed = 0, next = 0;
  const one = async (u: string) => {
    if (u.startsWith("/api/media/") && data && await data.match(u)) return;
    const r = await fetch(u, { credentials: "same-origin" }).catch(() => null);
    if (!r?.ok) { failed++; return; }
    // without a service worker in charge (first visit), store it here; otherwise the worker keeps it on the way through
    if (data && !navigator.serviceWorker?.controller) await data.put(u, r).catch(() => {}); else await r.arrayBuffer();
  };
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < m.urls.length) { await one(m.urls[next++]); progress?.(++done, m.urls.length); } }));
  return { stories: m.stories, failed };
}

/** One byte range of a file (the natural voice downloads in chunks, so a dropped connection resumes). */
export async function getRange(path: string, start: number, end: number): Promise<{ blob: Blob; type: string }> {
  const r = await fetch(path, { credentials: "same-origin", headers: { range: `bytes=${start}-${end}` } });
  if (r.status !== 206 && r.status !== 200) throw new ApiError(r.status, `Download failed (${r.status}).`);
  // a 206 must be the piece asked for (a cache on the way once answered every range with the same piece)
  const cr = /^bytes (\d+)-(\d+)\//.exec(r.headers.get("content-range") ?? "");
  if (r.status === 206 && (!cr || Number(cr[1]) !== start || Number(cr[2]) !== end)) throw new ApiError(502, "The download got the wrong piece.");
  const blob = await r.blob();
  // a server that ignores Range sends everything: cut out the part asked for
  const piece = r.status === 200 ? blob.slice(start, end + 1) : blob;
  if (piece.size !== end - start + 1) throw new ApiError(502, "The download got a piece of the wrong size.");
  return { blob: piece, type: r.headers.get("content-type") ?? "application/octet-stream" };
}
