import { mount } from "svelte";
import App from "./App.svelte";
import { app, go } from "./lib/state.svelte";
import { installMotionTokens } from "./lib/motion";
import { installKeys } from "./lib/keys";
import { keepOffline, api } from "./lib/api";
import { probe, natural, warm, download, onWifi } from "./lib/voice.svelte";
installMotionTokens();
installKeys();

const boot = JSON.parse(document.getElementById("boot")?.textContent || "{}");
Object.assign(app, { auth: !!boot.auth, setup: !!boot.setup, llm: !!boot.llm, lang: boot.lang === "de" ? "de" : "en", sources: boot.sources ?? 0, edition: boot.edition ?? null, updates: boot.updates ?? [] });
app.llmServer = app.llm;
// offline: Claude and harvesting wait; what this device kept stays readable. Back online, the reading list is kept fresh.
function connection() { app.online = navigator.onLine; app.llm = app.llmServer && app.online; if (app.online) keepList(); }
addEventListener("online", connection); addEventListener("offline", connection); connection();
/** The reading list is always on the device: refreshed a few seconds after start, at most every 15 minutes. */
function keepList(force = false) {
  let last = 0; try { last = Number(localStorage.getItem("pm-kept-list")) || 0; } catch {}
  if (!app.auth || (!force && Date.now() - last < 15 * 60_000)) return;
  setTimeout(() => keepOffline("list").then(() => { try { localStorage.setItem("pm-kept-list", String(Date.now())); } catch {} }).catch(() => {}), force ? 0 : 4000);
}
addEventListener("pm-saved", () => keepList(true));
// the natural voice: where it stands on this device; a download that waits for Wi-Fi starts when Wi-Fi comes
probe().then(() => { if (natural.status === "ready") setTimeout(warm, 3000); wifiCheck(); });
function wifiCheck() { if (natural.wifiWait && natural.status === "absent" && onWifi()) download(); }
(navigator as any).connection?.addEventListener?.("change", wifiCheck);
mount(App, { target: document.getElementById("app")! });
if ("serviceWorker" in navigator && location.protocol === "https:" || location.hostname === "localhost") navigator.serviceWorker?.register("/sw.js").catch(() => {});
// a tapped notification opens its page in the app that is already open
navigator.serviceWorker?.addEventListener("message", e => { if (e.data?.type === "go" && typeof e.data.url === "string" && e.data.url.startsWith("/")) go(e.data.url); });

import "./lib/install";
// for debugging with tools/cdp.ts: the live state, navigation and the API, on a local server only
if (location.hostname === "localhost") Object.assign(window, { __pm: { app, go, api } });
