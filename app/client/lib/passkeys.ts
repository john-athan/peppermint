// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// Passkeys in the browser, for the accounts module's API: registration and login with the server's JSON options
// (base64url), no library. Requests go through the app's own lib/api.ts.
import { api } from "./api";
import type { AccountLinkPreview } from "../../shared/accounts";

const dec = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const enc = (b: ArrayBuffer | null | undefined) => b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : undefined;
const post = <T = any>(path: string, json: unknown = {}) => api<T>(path, { method: "POST", json });

export const passkeysSupported = () => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;

/** The token of a link (`/setup#<token>`). It lives in the fragment, which no server and no log sees; this takes it
 *  and clears the address bar, so it does not stay in the history either. */
export function takeLinkToken(): string {
  const t = location.hash.slice(1);
  if (t) history.replaceState(null, "", location.pathname + location.search);
  return t;
}

/** What a link will do, before the passkey prompt. Throws the server's sentence when it is expired or used. */
export const previewLink = (token: string) => post<AccountLinkPreview>("/api/auth/link", { token });

/** A name for a new passkey that tells the devices apart in the list ("iPhone", "Mac", ...). */
export function deviceLabel(): string {
  const u = navigator.userAgent;
  if (/iPhone/.test(u)) return "iPhone";
  if (/iPad/.test(u) || (/Macintosh/.test(u) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(u)) return "Android";
  if (/Macintosh/.test(u)) return "Mac";
  if (/Windows/.test(u)) return "Windows";
  if (/Linux/.test(u)) return "Linux";
  return "Passkey";
}

const MESSAGES = {
  de: {
    NotAllowedError: "Die Passkey-Abfrage wurde abgebrochen, oder dieses Gerät hat keinen passenden Passkey. Versuche es noch einmal.",
    InvalidStateError: "Dieses Gerät hat schon einen Passkey für dieses Konto.",
    SecurityError: "Passkeys gehen nur über die echte Adresse, mit https.",
    NotSupportedError: "Dieser Browser kann hier keinen Passkey anlegen.",
    AbortError: "Die Passkey-Abfrage wurde abgebrochen.",
    fallback: "Das hat nicht geklappt.",
  },
  en: {
    NotAllowedError: "The passkey prompt was closed, or this device has no matching passkey. Try again.",
    InvalidStateError: "This device already has a passkey for this account.",
    SecurityError: "Passkeys only work on the real address, over https.",
    NotSupportedError: "This browser cannot make a passkey here.",
    AbortError: "The passkey prompt was cancelled.",
    fallback: "That did not work.",
  },
};
/** A browser's passkey error as a sentence for the person; the server's own sentence passes through. */
export function passkeyMessage(e: any, lang: "de" | "en"): string {
  const m = MESSAGES[lang] as Record<string, string>;
  return (e?.name && e.name !== "Error" && e.name !== "ApiError" && m[e.name]) || e?.message || m.fallback;
}

/** Makes a passkey. With a link token for the person the link was made for; without, for whoever is signed in. */
export async function register(name: string, token?: string): Promise<void> {
  const o = await post("/api/auth/register/options", token ? { token } : {});
  const cred = (await navigator.credentials.create({ publicKey: {
    ...o, challenge: dec(o.challenge), user: { ...o.user, id: dec(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ ...c, id: dec(c.id) })),
  } })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAttestationResponse;
  const response = { clientDataJSON: enc(r.clientDataJSON), attestationObject: enc(r.attestationObject), transports: r.getTransports?.() ?? [] };
  await post("/api/auth/register/verify", { credential: { id: cred.id, rawId: enc(cred.rawId), type: cred.type, response }, name });
}

export async function login(): Promise<void> {
  const o = await post("/api/auth/login/options");
  const cred = (await navigator.credentials.get({ publicKey: {
    ...o, challenge: dec(o.challenge), allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({ ...c, id: dec(c.id) })),
  } })) as PublicKeyCredential;
  const r = cred.response as AuthenticatorAssertionResponse;
  const response = { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: enc(r.userHandle) };
  await post("/api/auth/login/verify", { credential: { id: cred.id, rawId: enc(cred.rawId), type: cred.type, response } });
}

export const logout = () => post("/api/auth/logout");
