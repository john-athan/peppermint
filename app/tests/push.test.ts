// Web Push: the RFC 8291 test vector, an encrypt/decrypt round trip, the VAPID JWT signature, and sendPush headers.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
import { test, expect } from "bun:test";
const { encrypt, vapidAuth, vapidKeys, sendPush } = await import("../server/push");

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const cat = (...p: Uint8Array[]) => Buffer.concat(p) as unknown as Uint8Array;
const te = new TextEncoder();
const hmac = async (k: Uint8Array, d: Uint8Array) =>
  new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", k, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), d));

test("RFC 8291 appendix A vector", async () => {
  const pub = unb64u("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
  const privateKey = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)),
  }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const out = await encrypt(te.encode("When I grow up, I want to be a watermelon"),
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", "BTBZMqHH6r4Tts7J_aSIgg",
    { salt: unb64u("DGv6ra1nlYgDCS1FRnbzlw"), senderKeys: { publicKey: pub, privateKey } });
  expect(b64u(out)).toBe("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN");
});

test("round trip: the receiver decrypts what encrypt made", async () => {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const ua = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const msg = "Zürich: Zug fällt aus " + "x".repeat(200);
  const body = await encrypt(te.encode(msg), b64u(ua), b64u(auth));
  const salt = body.slice(0, 16), idlen = body[20], asPub = body.slice(21, 21 + idlen), rec = body.slice(21 + idlen);
  expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
  expect(idlen).toBe(65);
  const asKey = await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, kp.privateKey, 256));
  const ikm = await hmac(await hmac(auth, ecdh), cat(te.encode("WebPush: info\0"), ua, asPub, Uint8Array.of(1)));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode("Content-Encoding: aes128gcm\0"), Uint8Array.of(1)))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode("Content-Encoding: nonce\0"), Uint8Array.of(1)))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, rec));
  expect(plain[plain.length - 1]).toBe(2);
  expect(new TextDecoder().decode(plain.slice(0, -1))).toBe(msg);
});

test("vapidAuth makes a verifiable ES256 JWT", async () => {
  const now = Math.floor(Date.now() / 1000);
  const h = await vapidAuth("https://push.example.com/send/abc123", "mailto:a@example.com", now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h)!;
  expect(m).not.toBeNull();
  const [, hd, cl, sg, k] = m;
  expect(JSON.parse(Buffer.from(hd, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(cl, "base64url").toString());
  expect(claims.aud).toBe("https://push.example.com");
  expect(claims.exp).toBe(now + 43200);
  expect(claims.sub).toBe("mailto:a@example.com");
  expect(k).toBe((await vapidKeys()).publicKey);
  expect(unb64u(k).length).toBe(65);
  const pub = await crypto.subtle.importKey("raw", unb64u(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  expect(unb64u(sg).length).toBe(64);
  expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(sg), te.encode(`${hd}.${cl}`))).toBe(true);
});

test("sendPush posts the encrypted body with the right headers and flags a gone subscription", async () => {
  const seen: Headers[] = [], sizes: number[] = [];
  let n = 0;
  const srv = Bun.serve({ port: 0, async fetch(req) { seen.push(req.headers); sizes.push((await req.arrayBuffer()).byteLength); return new Response(null, { status: ++n === 1 ? 201 : 410 }); } });
  try {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    const sub = { endpoint: `http://localhost:${srv.port}/push/x`, keys: { p256dh: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))), auth: b64u(crypto.getRandomValues(new Uint8Array(16))) } };
    const a = await sendPush(sub, { title: "Hi" }, { topic: "t1", urgency: "high", ttl: 60 });
    expect(a).toEqual({ ok: true, status: 201, gone: false });
    const h = seen[0];
    expect(h.get("content-encoding")).toBe("aes128gcm");
    expect(h.get("content-type")).toBe("application/octet-stream");
    expect(h.get("ttl")).toBe("60");
    expect(h.get("urgency")).toBe("high");
    expect(h.get("topic")).toBe("t1");
    expect(h.get("authorization")).toMatch(/^vapid t=.+, k=.+$/);
    expect(sizes[0]).toBeGreaterThan(86);
    const b = await sendPush(sub, { title: "Hi" });
    expect(b).toEqual({ ok: false, status: 410, gone: true });
    expect(seen[1].get("ttl")).toBe("86400");
    expect(seen[1].get("urgency")).toBe("normal");
    expect(seen[1].get("topic")).toBeNull();
  } finally { srv.stop(true); }
  expect(await sendPush({ endpoint: "http://localhost:1/none", keys: { p256dh: "x", auth: "y" } }, {})).toEqual({ ok: false, status: 0, gone: false });
});
