// The natural voice's files: only the listed ones, only for signed-in devices, byte ranges for resumable downloads,
// and a file whose checksum does not match is never kept or served.
process.env.PEPPERMINT_DB = ":memory:";
process.env.PEPPERMINT_NO_SCHEDULER = "1";
process.env.PORT = "0";
process.env.PEPPERMINT_ORIGIN = "http://localhost:4317";
process.env.PEPPERMINT_LLM = "off";
import { test, expect } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { db, now } = await import("../server/db");
const auth = await import("../server/auth");
const { server } = await import("../server/main");
const voice = await import("../server/voice");
const BASE = `http://localhost:${server.port}`;
db.query("INSERT INTO users (id, name, created_at) VALUES (1301, 'v', ?)").run(now());
const me = await auth.createSession(1301);
const get = (path: string, headers: Record<string, string> = {}) => fetch(BASE + path, { headers: { cookie: `__Host-peppermint=${me}`, ...headers } });

test("the manifest lists the bundle, the runtime and the fp32 model (fp16 makes noise on WebGPU), about 350 MB in all", async () => {
  const m = await (await get("/api/voice")).json();
  expect(m.voice).toBe("af_heart");
  const paths = m.files.map((f: any) => f.path);
  expect(paths).toContain("hf/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx");
  expect(paths.some((p: string) => p.includes("fp16"))).toBe(false);
  expect(m.version).toContain("fp32");
  expect(m.base).toBe("/voice/v2/");
  expect(m.bytes).toBeGreaterThan(340e6);
});

test("signed out gets nothing; unknown paths are not fetched upstream", async () => {
  expect((await fetch(BASE + "/voice/kokoro.web.js")).status).toBe(401);
  expect((await get("/voice/hf/evil/model.onnx")).status).toBe(404);
  expect((await get("/voice/hf%2F..%2F..%2Fdb.sqlite")).status).toBe(404);
});

test("byte ranges: the bundle in two pieces adds up to the whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pm-voice-")), p = join(dir, "kokoro.web.js");
  writeFileSync(p, "0123456789abcdef");
  voice.setVoiceBundle(p);
  const a = await get("/voice/kokoro.web.js", { range: "bytes=0-9" }), b = await get("/voice/kokoro.web.js", { range: "bytes=10-" });
  expect(a.status).toBe(206); expect(a.headers.get("content-range")).toBe("bytes 0-9/16");
  expect((await a.text()) + (await b.text())).toBe("0123456789abcdef");
  expect((await get("/voice/kokoro.web.js", { range: "bytes=99-" })).status).toBe(416);
  expect(a.headers.get("content-type")).toContain("javascript");
  // shared caches (Cloudflare) must not keep or compress these, and a versioned path serves the same file
  expect(a.headers.get("cache-control")).toContain("private");
  expect(a.headers.get("cache-control")).toContain("no-transform");
  expect(await (await get("/voice/v2/kokoro.web.js")).text()).toBe("0123456789abcdef");
});

test("a file whose checksum does not match is refused and not kept", async () => {
  const fake = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(44)) });
  const key = "hf/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json";
  const real = voice.VOICE_FILES[key].url;
  voice.VOICE_FILES[key].url = `http://localhost:${fake.port}/config.json`;
  try {
    await expect(voice.ensure(key)).rejects.toThrow("checksum mismatch");
    expect((await get(`/voice/${key}`)).status).toBe(502);
  } finally { voice.VOICE_FILES[key].url = real; fake.stop(true); }
});
