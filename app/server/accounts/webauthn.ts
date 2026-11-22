// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// WebAuthn by hand: registration and login verified with WebCrypto, no library. Pure functions, no database.
// Registration reads the attestation object (a small CBOR reader below) and stores the COSE key. Attestation
// statements are ignored ("none" is what we ask for): a passkey is trusted because whoever made it held a link or a
// session when it was created, not because of the authenticator model.

export const b64u = {
  enc: (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url"),
  dec: (s: string) => new Uint8Array(Buffer.from(s, "base64url")),
};
export async function sha256(d: Uint8Array | string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", typeof d === "string" ? new TextEncoder().encode(d) : d));
}
export const sha256hex = async (d: Uint8Array | string) => Buffer.from(await sha256(d)).toString("hex");
export const randomToken = (bytes = 32) => b64u.enc(crypto.getRandomValues(new Uint8Array(bytes)));
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A refusal with an HTTP status. `key` names the sentence in messages.ts, so the caller can say it in its language. */
export class AuthError extends Error { constructor(public status: number, public key: string) { super(key); } }

/* ---------- minimal CBOR (maps, arrays, ints, byte and text strings, bool, null) ---------- */
export function cborDecode(buf: Uint8Array, start = 0): { value: unknown; end: number } {
  let i = start;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const need = (n: number) => { if (i + n > buf.length) throw new Error("cbor: truncated"); };
  const arg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) { need(1); return buf[i++]; }
    if (info === 25) { need(2); const v = dv.getUint16(i); i += 2; return v; }
    if (info === 26) { need(4); const v = dv.getUint32(i); i += 4; return v; }
    throw new Error("cbor: unsupported length");
  };
  const item = (depth: number): unknown => {
    if (depth > 8 || i >= buf.length) throw new Error("cbor: bad data");
    const b = buf[i++], major = b >> 5, info = b & 31;
    if (major === 0) return arg(info);
    if (major === 1) return -1 - arg(info);
    if (major === 2 || major === 3) {
      const n = arg(info); need(n);
      const s = buf.slice(i, i + n); i += n;
      return major === 2 ? s : new TextDecoder().decode(s);
    }
    if (major === 4) { const n = arg(info); const a: unknown[] = []; for (let k = 0; k < n; k++) a.push(item(depth + 1)); return a; }
    if (major === 5) { const n = arg(info); const m = new Map<unknown, unknown>(); for (let k = 0; k < n; k++) { const key = item(depth + 1); m.set(key, item(depth + 1)); } return m; }
    if (major === 7) return info === 20 ? false : info === 21 ? true : null;
    throw new Error("cbor: unsupported type");
  };
  return { value: item(0), end: i };
}

/** ES256 (-7) and RS256 (-257), nothing else. */
const ALGS = new Set([-7, -257]);

/** A stored public key to something WebCrypto verifies with. New keys are COSE (a CBOR map, first byte 0xa0 to 0xbf);
 *  keys from before this module may be SPKI (DER, first byte 0x30), which the browser's getPublicKey() handed over. */
export async function importPublicKey(stored: Uint8Array, alg: number): Promise<CryptoKey> {
  if (!ALGS.has(alg)) throw new AuthError(400, "keyType");
  const params = alg === -7 ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  if (stored[0] === 0x30) return crypto.subtle.importKey("spki", stored, params, false, ["verify"]);
  const m = cborDecode(stored).value as Map<number, any>;
  if (!(m instanceof Map) || m.get(3) !== alg) throw new AuthError(400, "keyType");
  if (alg === -7 && m.get(1) === 2 && m.get(-1) === 1 && m.get(-2) instanceof Uint8Array && m.get(-3) instanceof Uint8Array) {
    return crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: b64u.enc(m.get(-2)), y: b64u.enc(m.get(-3)), ext: true }, params, false, ["verify"]);
  }
  if (alg === -257 && m.get(1) === 3 && m.get(-1) instanceof Uint8Array && m.get(-2) instanceof Uint8Array) {
    return crypto.subtle.importKey("jwk", { kty: "RSA", alg: "RS256", n: b64u.enc(m.get(-1)), e: b64u.enc(m.get(-2)), ext: true }, params, false, ["verify"]);
  }
  throw new AuthError(400, "keyType");
}

/** ECDSA signatures arrive DER encoded; WebCrypto wants raw r||s. */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("bad signature");
  let i = 2; if (der[1] & 0x80) i += der[1] & 0x7f;
  const read = () => {
    if (der[i++] !== 0x02) throw new Error("bad signature");
    const len = der[i++]; let v = der.slice(i, i + len); i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("bad signature");
    const out = new Uint8Array(32); out.set(v, 32 - v.length); return out;
  };
  const r = read(), s = read(); const raw = new Uint8Array(64); raw.set(r); raw.set(s, 32); return raw;
}

export type Rp = { id: string; origin: string };
const UP = 0x01, UV = 0x04, AT = 0x40;

function clientData(json: unknown, type: string, rp: Rp): { challenge: string; hash: Promise<Uint8Array> } {
  if (typeof json !== "string") throw new AuthError(400, "badCredential");
  let cd: any;
  try { cd = JSON.parse(new TextDecoder().decode(b64u.dec(json))); } catch { throw new AuthError(400, "badCredential"); }
  if (cd?.type !== type || typeof cd.challenge !== "string") throw new AuthError(400, "badCredential");
  if (cd.origin !== rp.origin || cd.crossOrigin === true) throw new AuthError(400, "wrongOrigin");
  return { challenge: cd.challenge, hash: sha256(b64u.dec(json)) };
}
async function authData(ad: Uint8Array, rp: Rp) {
  if (ad.length < 37) throw new AuthError(400, "badCredential");
  if (!eq(ad.slice(0, 32), await sha256(rp.id))) throw new AuthError(400, "wrongRp");
  const flags = ad[32];
  if (!(flags & UP)) throw new AuthError(400, "notConfirmed");
  if (!(flags & UV)) throw new AuthError(401, "needsUv");
  return { flags, signCount: new DataView(ad.buffer, ad.byteOffset + 33, 4).getUint32(0) };
}

/** Checks a registration (navigator.credentials.create, sent as the standard JSON form). `take` receives the
 *  challenge and must throw unless it was issued for this ceremony; it is called before anything else is trusted. */
export async function verifyRegistration<T>(cred: any, rp: Rp, take: (challenge: string) => T) {
  const r = cred?.response;
  const cd = clientData(r?.clientDataJSON, "webauthn.create", rp);
  const ceremony = take(cd.challenge);
  if (typeof r.attestationObject !== "string") throw new AuthError(400, "badCredential");
  let ad: Uint8Array;
  try {
    const att = cborDecode(b64u.dec(r.attestationObject)).value as Map<string, any>;
    ad = att instanceof Map ? att.get("authData") : null as any;
  } catch { throw new AuthError(400, "badCredential"); }
  if (!(ad instanceof Uint8Array)) throw new AuthError(400, "badCredential");
  const h = await authData(ad, rp);
  if (!(h.flags & AT) || ad.length < 55) throw new AuthError(400, "badCredential");
  const idLen = (ad[53] << 8) | ad[54];
  if (idLen < 16 || idLen > 1023 || ad.length < 55 + idLen) throw new AuthError(400, "badCredential");
  const credId = b64u.enc(ad.slice(55, 55 + idLen));
  if (cred.id !== credId) throw new AuthError(400, "badCredential");
  let publicKey: Uint8Array, alg: number;
  try {
    const start = 55 + idLen;
    publicKey = ad.slice(start, cborDecode(ad, start).end);
    alg = (cborDecode(publicKey).value as Map<number, number>).get(3)!;
  } catch { throw new AuthError(400, "badCredential"); }
  await importPublicKey(publicKey, alg); // proves the key parses and is one of the two accepted algorithms
  return { ceremony, credId, publicKey, alg, signCount: h.signCount };
}

export type StoredKey = { public_key: Uint8Array; alg: number; sign_count: number };

/** Checks a login (navigator.credentials.get). `lookup` finds the stored key for the credential id, or null. */
export async function verifyAssertion<K extends StoredKey>(cred: any, rp: Rp, take: (challenge: string) => unknown, lookup: (credId: string) => K | null) {
  const r = cred?.response;
  const cd = clientData(r?.clientDataJSON, "webauthn.get", rp);
  take(cd.challenge);
  const row = typeof cred?.id === "string" ? lookup(cred.id) : null;
  if (!row) throw new AuthError(401, "unknownPasskey");
  if (typeof r.authenticatorData !== "string" || typeof r.signature !== "string") throw new AuthError(400, "badCredential");
  const adBytes = b64u.dec(r.authenticatorData);
  const h = await authData(adBytes, rp);
  const signed = new Uint8Array([...adBytes, ...(await cd.hash)]);
  const key = await importPublicKey(new Uint8Array(row.public_key), row.alg);
  const sig = b64u.dec(r.signature);
  let ok = false;
  try {
    ok = row.alg === -7 ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), signed)
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, signed);
  } catch { ok = false; }
  if (!ok) throw new AuthError(401, "badSignature");
  // many synced passkeys always report 0; a counter that moves must move forward
  if ((h.signCount !== 0 || row.sign_count !== 0) && h.signCount <= row.sign_count) throw new AuthError(401, "cloned");
  return { row, signCount: h.signCount };
}
