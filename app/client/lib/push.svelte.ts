// Notifications on this device: a push subscription made with the server's public key and handed to it. On an
// iPhone this works only once peppermint is on the home screen; elsewhere the browser asks once.
import { api } from "./api";

export const push = $state({ supported: false, on: false, denied: false, devices: 0 });
const ready = () => navigator.serviceWorker?.ready;
const b64 = (s: string) => { const p = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)); return Uint8Array.from(p, c => c.charCodeAt(0)); };

export async function checkPush() {
  push.supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  push.denied = push.supported && Notification.permission === "denied";
  if (!push.supported) return push;
  const reg = await ready(); const sub = await reg?.pushManager.getSubscription();
  push.on = !!sub && Notification.permission === "granted";
  return push;
}
export async function enablePush(): Promise<string> {
  await checkPush();
  if (!push.supported) return /iPhone|iPad/.test(navigator.userAgent) ? "Add peppermint to your home screen first (Share › Add to Home Screen); iPhones allow notifications only there. Until then you get an email." : "This browser cannot show notifications. You get an email instead.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { push.denied = perm === "denied"; return "Notifications are blocked for peppermint. Allow them in the browser's site settings."; }
  const { key } = await api<{ key: string }>("/api/push/key");
  const reg = await ready();
  const sub = await reg!.pushManager.getSubscription() ?? await reg!.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
  const label = /iPhone/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android phone" : /Mac/.test(navigator.userAgent) ? "Mac" : "This device";
  const r = await api<{ devices: number }>("/api/push/subscribe", { method: "POST", json: { sub: sub.toJSON(), label } });
  push.on = true; push.devices = r.devices;
  return "Notifications are on for this device.";
}
export async function disablePush() {
  const reg = await ready(); const sub = await reg?.pushManager.getSubscription();
  if (sub) { await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
  push.on = false;
}
