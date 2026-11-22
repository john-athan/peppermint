// Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy.
//
// A software passkey for tests: makes registration and login responses as a browser would send them (ES256 or RS256,
// COSE in the attestation, DER signatures), and can break any part of them on request.
const head = (major: number, n: number): number[] => n < 24 ? [major << 5 | n] : n < 256 ? [major << 5 | 24, n] : [major << 5 | 25, n >> 8, n & 255];
function cbor(v: any): Uint8Array {
  const out: number[] = [];
  const w = (x: any) => {
    if (typeof x === "number") out.push(...(x >= 0 ? head(0, x) : head(1, -1 - x)));
    else if (typeof x === "string") { const b = new TextEncoder().encode(x); out.push(...head(3, b.length), ...b); }
    else if (x instanceof Uint8Array) out.push(...head(2, x.length), ...x);
    else if (x instanceof Map) { out.push(...head(5, x.size)); for (const [k, val] of x) { w(k); w(val); } }
    else throw new Error("cbor: unsupported");
  };
  w(v); return new Uint8Array(out);
}
const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const sha = async (d: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));
const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
function rawToDer(raw: Uint8Array) {
  const int = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let v = b.slice(i); if (v[0] & 0x80) v = cat(new Uint8Array([0]), v); return cat(new Uint8Array([2, v.length]), v); };
  const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return cat(new Uint8Array([0x30, body.length]), body);
}
export class Key {
  count = 0;
  constructor(public alg: -7 | -257, public pair: CryptoKeyPair, public raw: Uint8Array, public origin: string) {}
  /** A new key for the site at `origin` (its host name is the rp id). */
  static async make(alg: -7 | -257 = -7, origin = "https://app.test") {
    const pair = alg === -7
      ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair
      : await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return new Key(alg, pair, crypto.getRandomValues(new Uint8Array(16)), origin);
  }
  get id() { return b64u(this.raw); }
  async cose() {
    const j = await crypto.subtle.exportKey("jwk", this.pair.publicKey);
    return this.alg === -7 ? cbor(new Map<number, any>([[1, 2], [3, -7], [-1, 1], [-2, unb64u(j.x!)], [-3, unb64u(j.y!)]]))
      : cbor(new Map<number, any>([[1, 3], [3, -257], [-1, unb64u(j.n!)], [-2, unb64u(j.e!)]]));
  }
  spki = async () => new Uint8Array(await crypto.subtle.exportKey("spki", this.pair.publicKey));
  private fc(flags: number) { const c = new Uint8Array(5); c[0] = flags; new DataView(c.buffer).setUint32(1, this.count); return c; }
  async create(o: any, x: { flags?: number; rpId?: string; origin?: string } = {}) {
    const cd = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: o.challenge, origin: x.origin ?? this.origin, crossOrigin: false }));
    const ad = cat(await sha(new TextEncoder().encode(x.rpId ?? new URL(this.origin).hostname)), this.fc(x.flags ?? 0x45), new Uint8Array(16), new Uint8Array([0, this.raw.length]), this.raw, await this.cose());
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(cd), attestationObject: b64u(cbor(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", ad]]))) } };
  }
  async get(o: any, x: { flags?: number; origin?: string; count?: number; signWith?: CryptoKey } = {}) {
    this.count = x.count ?? this.count + 1;
    const cd = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: o.challenge, origin: x.origin ?? this.origin, crossOrigin: false }));
    const ad = cat(await sha(new TextEncoder().encode(new URL(this.origin).hostname)), this.fc(x.flags ?? 0x05));
    const sig = new Uint8Array(await crypto.subtle.sign(this.alg === -7 ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, x.signWith ?? this.pair.privateKey, cat(ad, await sha(cd))));
    return { id: this.id, rawId: this.id, type: "public-key", response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(this.alg === -7 ? rawToDer(sig) : sig) } };
  }
}

