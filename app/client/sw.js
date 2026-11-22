// peppermint service worker.
//  - Hashed assets: cache-first (their names change with every build).
//  - The app shell: network-first, the last copy when offline, so the app opens without a connection.
//  - Reading data (Today, List, stories, original texts, lens texts Claude already wrote): network-first, and every
//    good answer is kept, so what you read or saved is there offline. Pictures: cache-first, a picture never changes.
//  The data cache outlives deploys (its name has no version); it keeps the newest entries up to a limit.
const V = "pm-__VERSION__";
const DATA = "pm-data";
const ASSETS = __ASSETS__;
const MAX_DATA = 2500;
const KEEP = [/^\/api\/edition$/, /^\/api\/briefing$/, /^\/api\/list$/, /^\/api\/stories\/\d+$/, /^\/api\/stories\/\d+\/original$/, /^\/api\/stories\/\d+\/lens\/[a-z]+$/];

self.addEventListener("install", e => { e.waitUntil(caches.open(V).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== DATA && !k.startsWith("pm-voice") && k !== "kokoro-voices").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

let puts = 0;
async function keep(req, res) {
  const c = await caches.open(DATA);
  await c.put(req, res);
  // now and then, drop the oldest entries (keys come back in insertion order)
  if (++puts % 50 === 0) { const ks = await c.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - MAX_DATA))) await c.delete(k); }
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  // the system share sheet posts here: photos wait in a cache for the capture sheet, a link goes on as before
  if (e.request.method === "POST" && u.origin === location.origin && u.pathname === "/share") { e.respondWith(shared(e.request)); return; }
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  if (u.pathname.startsWith("/assets/") || u.pathname === "/icon.svg") {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const copy = res.clone(); caches.open(V).then(c => c.put(e.request, copy)); return res; })));
    return;
  }
  // the natural voice's files: from the "pm-voice" cache once downloaded (lib/voice.svelte.ts); range requests (the
  // download itself) always go to the network
  if (u.pathname.startsWith("/voice/")) {
    if (e.request.headers.has("range")) return;
    e.respondWith(caches.match(u.pathname, { cacheName: "pm-voice" }).then(r => r || fetch(e.request)));
    return;
  }
  if (u.pathname.startsWith("/api/media/")) {
    // any stored width of the same picture is better than none when offline
    e.respondWith(caches.open(DATA).then(async c => (await c.match(e.request)) || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); e.waitUntil(keep(e.request, copy)); }
      return res;
    }).catch(async err => (await c.match(e.request, { ignoreSearch: true })) || Promise.reject(err))));
    return;
  }
  if (KEEP.some(re => re.test(u.pathname))) {
    e.respondWith(fetch(e.request).then(res => {
      // a lens is kept only when it finished (Claude was not halfway), everything else when it is a good answer
      const ok = res.ok && (res.headers.get("content-type") || "").match(/json|event-stream/);
      if (ok) {
        const copy = res.clone();
        e.waitUntil((async () => {
          if (u.pathname.includes("/lens/")) { const t = await copy.text(); if (!t.includes("event: done")) return; await keep(e.request, new Response(t, { headers: { "content-type": "text/event-stream" } })); }
          else await keep(e.request, copy);
        })());
      }
      return res;
    }).catch(async err => (await caches.match(e.request, { cacheName: DATA })) || offline(u)));
    return;
  }
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then(res => { const copy = res.clone(); caches.open(V).then(c => c.put("/", copy)); return res; }).catch(() => caches.match("/")));
  }
});

async function shared(req) {
  const f = await req.formData().catch(() => null);
  if (!f) return Response.redirect("/", 303);
  const files = f.getAll("photo").filter(x => x && typeof x === "object" && /^image\//.test(x.type)).slice(0, 4);
  if (files.length) {
    await caches.delete("pm-share");
    const c = await caches.open("pm-share");
    await Promise.all(files.map((x, i) => c.put(`/share-file/${i}`, new Response(x, { headers: { "content-type": x.type, "x-name": encodeURIComponent(x.name || `photo-${i + 1}.jpg`) } }))));
    const text = [f.get("title"), f.get("text")].filter(Boolean).join(" ").slice(0, 2000);
    return Response.redirect(`/share?photos=${files.length}${text ? `&text=${encodeURIComponent(text)}` : ""}`, 303);
  }
  const q = new URLSearchParams();
  for (const k of ["title", "text", "url"]) { const v = f.get(k); if (v) q.set(k, String(v)); }
  return Response.redirect(`/share?${q}`, 303);
}

// notifications: a piece is ready, someone answered, there is news for a piece. One that can publish has a button
// for it; it calls the same route as the app (the session cookie goes along) and says whether it worked.
self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "peppermint", body: e.data ? e.data.text() : "" }; }
  const actions = d.publish ? [{ action: "publish", title: "Publish" }, { action: "open", title: "Open" }] : [];
  e.waitUntil(self.registration.showNotification(d.title || "peppermint", { body: d.body || "", tag: d.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: d.url || "/", publish: d.publish || null }, actions }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const { url = "/", publish = null } = e.notification.data || {};
  if (e.action === "publish" && publish) {
    e.waitUntil(fetch(`/api/drafts/${publish}/publish`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" }).then(async r => {
      const j = await r.json().catch(() => ({}));
      if (r.ok) return self.registration.showNotification("Published", { body: (j.url || "").replace(/^https?:\/\//, ""), tag: `pub-${publish}`, icon: "/icon-192.png", data: { url: j.url || `/studio/${publish}` } });
      await self.registration.showNotification("Not published yet", { body: j.error || "Open the piece to see what is missing.", tag: `pub-${publish}`, icon: "/icon-192.png", data: { url: `/studio/${publish}` } });
    }).catch(() => openUrl(`/studio/${publish}`)));
    return;
  }
  e.waitUntil(openUrl(url));
});
async function openUrl(url) {
  const external = /^https?:/.test(url) && !url.startsWith(location.origin);
  if (external) return self.clients.openWindow(url);
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const c = all.find(x => "focus" in x);
  if (c) { c.postMessage({ type: "go", url: url.replace(location.origin, "") }); return c.focus(); }
  return self.clients.openWindow(url);
}

// what a request gets offline when nothing was kept: the same error shape the server uses
function offline(u) {
  const body = u.pathname.includes("/lens/") ? "event: error\ndata: {\"code\":\"offline\",\"message\":\"Offline. This was not saved on this device.\"}\n\n" : JSON.stringify({ error: "Offline. This was not saved on this device." });
  return new Response(body, { status: u.pathname.includes("/lens/") ? 200 : 503, headers: { "content-type": u.pathname.includes("/lens/") ? "text/event-stream" : "application/json", "x-pm-offline": "1" } });
}
