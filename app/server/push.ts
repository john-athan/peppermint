// Web Push by hand: RFC 8291 message encryption (aes128gcm, RFC 8188) and RFC 8292 VAPID, on WebCrypto and fetch only.
// The VAPID keypair is made on first use and kept in settings (owner 0, key "vapid"). sendPush never throws.
import { setting, setSetting } from "./db";

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };

const enc = new TextEncoder();
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const hmac = async (key: Uint8Array, data: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), data));

type Stored = { publicKey: string; privateJwk: JsonWebKey };
let vapid: { publicKey: string; key: CryptoKey } | null = null;

async function loadVapid() {
  if (vapid) return vapid;
  let s = setting<Stored | null>(0, "vapid", null);
  if (!s) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    s = { publicKey: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
    setSetting(0, "vapid", s);
  }
  const key = await crypto.subtle.importKey("jwk", s.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return (vapid = { publicKey: s.publicKey, key });
}

export async function vapidKeys(): Promise<{ publicKey: string }> {
  return { publicKey: (await loadVapid()).publicKey };
}

// RFC 8291: one aes128gcm record, header = salt(16) | rs(4) | idlen(1) | sender public key(65).
export async function encrypt(payload: Uint8Array, p256dh: string, auth: string,
  opts: { salt?: Uint8Array; senderKeys?: { publicKey: Uint8Array; privateKey: CryptoKey } } = {}): Promise<Uint8Array> {
  const ua = unb64u(p256dh);
  let sender = opts.senderKeys;
  if (!sender) {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    sender = { publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), privateKey: kp.privateKey };
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, sender.privateKey, 256));
  const prkKey = await hmac(unb64u(auth), ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode("WebPush: info\0"), ua, sender.publicKey, Uint8Array.of(1)));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(payload, Uint8Array.of(2))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return cat(salt, rs, Uint8Array.of(sender.publicKey.length), sender.publicKey, body);
}

// RFC 8292: `vapid t=<ES256 JWT>, k=<public key>`; WebCrypto already signs as raw r||s.
export async function vapidAuth(endpoint: string, subject: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const v = await loadVapid();
  const part = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const input = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, enc.encode(input)));
  return `vapid t=${input}.${b64u(sig)}, k=${v.publicKey}`;
}

export async function sendPush(sub: PushSub, payload: unknown,
  opts: { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string } = {}): Promise<{ ok: boolean; status: number; gone: boolean }> {
  try {
    const subject = process.env.PEPPERMINT_PUSH_CONTACT ?? process.env.PEPPERMINT_ORIGIN ?? "https://peppermint.kaleve.dev";
    const body = await encrypt(enc.encode(JSON.stringify(payload)), sub.keys.p256dh, sub.keys.auth);
    const headers: Record<string, string> = {
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 86400), Urgency: opts.urgency ?? "normal",
      Authorization: await vapidAuth(sub.endpoint, subject),
    };
    if (opts.topic) headers.Topic = opts.topic;
    const r = await fetch(sub.endpoint, { method: "POST", headers, body });
    return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch {
    return { ok: false, status: 0, gone: false };
  }
}
