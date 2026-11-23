// Several accounts in one browser (server/auth.ts, keyring): who is signed in here besides the one in front, and
// switching between them. A switch reloads the app, so nothing of one account stays on screen for the next.
import { api } from "./api";

export type Here = { current: { id: number; name: string } | null; others: { id: number; name: string }[] };
let pending: Promise<Here> | null = null;
/** The accounts signed in on this browser; asked once per page load, however many buttons show it. */
export const accountsHere = (fresh = false) => (fresh || !pending ? (pending = api<Here>("/api/auth/accounts")) : pending);

/** The data this browser kept for offline reading belongs to the account that read it. */
async function forget() { try { await caches.delete("pm-data"); } catch {} }

export async function switchTo(id: number) {
  await api("/api/auth/switch", { method: "POST", json: { id } });
  await forget(); location.replace("/");
}
/** The account in front steps back (still signed in), and the sign-in page takes the next passkey. */
export async function addAccount() {
  await api("/api/auth/add", { method: "POST", json: {} });
  await forget(); location.replace("/");
}
/** Signs out the account in front; another one signed in here comes forward. */
export async function signOutHere() {
  try { await api("/api/auth/logout", { method: "POST", json: {} }); } catch {}
  await forget(); location.replace("/");
}
export const initials = (n: string) => n.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "·";
