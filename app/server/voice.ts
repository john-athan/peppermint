// The natural voice (Kokoro-82M on the reader's GPU) needs about 350 MB of files: the model, the onnxruntime wasm, a
// few voices and the vendored kokoro bundle. Devices fetch them only from here. The first request of a file downloads it
// once from a pinned upstream URL, checks its SHA-256 and keeps it next to the database; later requests are served
// from disk with Range support (the client downloads in chunks, so a dropped mobile connection resumes).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DB_PATH } from "./db";

const HF = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/";
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0-dev.20250409-89f8206ba4/dist/";
const M = "hf/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/";
// devices fetch /voice/<rev>/<path>: a new rev gives new URLs, so a cache on the way (Cloudflare kept byte ranges of
// the first copy and handed the same piece back for every range) can never serve an old answer again
export const VOICE_REV = "v2";
type F = { url: string; size: number; sha256: string; type: string };
/** Every file a device may ask for, by its path under /voice/. Nothing else is fetched upstream. */
export const VOICE_FILES: Record<string, F> = {
  [`${M}config.json`]: { url: `${HF}config.json`, size: 44, sha256: "df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f", type: "application/json" },
  [`${M}tokenizer.json`]: { url: `${HF}tokenizer.json`, size: 3497, sha256: "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34", type: "application/json" },
  [`${M}tokenizer_config.json`]: { url: `${HF}tokenizer_config.json`, size: 113, sha256: "be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20", type: "application/json" },
  [`${M}onnx/model.onnx`]: { url: `${HF}onnx/model.onnx`, size: 325532232, sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb", type: "application/octet-stream" },
  [`${M}voices/af_heart.bin`]: { url: `${HF}voices/af_heart.bin`, size: 522240, sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b", type: "application/octet-stream" },
  ["ort/ort-wasm-simd-threaded.jsep.mjs"]: { url: `${ORT}ort-wasm-simd-threaded.jsep.mjs`, size: 44484, sha256: "08fb86ec433c78bfb032c5d84a68b8e8e5a8d81268fa39e24314179a5767a5b9", type: "text/javascript; charset=utf-8" },
  ["ort/ort-wasm-simd-threaded.jsep.wasm"]: { url: `${ORT}ort-wasm-simd-threaded.jsep.wasm`, size: 21596019, sha256: "c46655e8a94afc45338d4cb2b840475f88e5012d524509916e505079c00bfa39", type: "application/wasm" },
};
// the vendored bundle travels in dist/ (build.ts copies it there), set by main.ts
let BUNDLE = "";
export const setVoiceBundle = (path: string) => { BUNDLE = path; };

/** What a device downloads before the voice works offline: path, size; the bundle first, the model last. */
export function voiceManifest() {
  const files = [{ path: "kokoro.web.js", size: BUNDLE && existsSync(BUNDLE) ? statSync(BUNDLE).size : 0 }, ...Object.entries(VOICE_FILES).map(([path, f]) => ({ path, size: f.size }))];
  files.sort((a, b) => a.size - b.size);
  // fp32: the fp16 model makes noise on WebGPU (measured: spectral flatness 1.0, waveform correlation 0.33 with the
  // CPU reference), fp32 matches the CPU (0.998). A new version makes devices ask before replacing their copy.
  return { version: `kokoro-1939ad2-fp32-${VOICE_REV}`, base: `/voice/${VOICE_REV}/`, voice: "af_heart", files, bytes: files.reduce((a, f) => a + f.size, 0) };
}

const dir = () => join(DB_PATH === ":memory:" ? tmpdir() : dirname(DB_PATH), "voice");
const local = (path: string) => join(dir(), path.replace(/[^a-z0-9._-]+/gi, "_"));
const pending = new Map<string, Promise<string>>();

/** The file on disk, downloaded and verified on first use; concurrent requests wait for the same download. */
export function ensure(path: string): Promise<string> {
  const f = VOICE_FILES[path];
  if (!f) return Promise.reject(new Error("unknown"));
  const p = local(path);
  if (existsSync(p) && statSync(p).size === f.size) return Promise.resolve(p);
  if (!pending.has(path)) pending.set(path, (async () => {
    mkdirSync(dir(), { recursive: true });
    const res = await fetch(f.url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);
    // stream to a temporary file while hashing, so 160 MB never sit in memory
    const tmp = `${p}.part`, w = Bun.file(tmp).writer(), h = createHash("sha256");
    let n = 0;
    for await (const chunk of res.body) { h.update(chunk); w.write(chunk); n += chunk.length; }
    await w.end();
    if (n !== f.size || h.digest("hex") !== f.sha256) { try { unlinkSync(tmp); } catch {} throw new Error("checksum mismatch"); }
    renameSync(tmp, p);
    return p;
  })().finally(() => pending.delete(path)));
  return pending.get(path)!;
}

/** GET /voice/<path>: the vendored bundle or a verified file, immutable, with Range. */
export async function serveVoice(req: Request, path: string): Promise<Response> {
  // private: no shared cache (Cloudflare) keeps these; no-transform: nobody compresses them, so byte ranges stay exact
  const head = { "cache-control": "private, no-transform, max-age=31536000, immutable", "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
  path = path.replace(/^v\d+\//, "");
  let file: string, type: string;
  if (path === "kokoro.web.js") {
    if (!BUNDLE || !existsSync(BUNDLE)) return new Response("The voice bundle is missing on the server.", { status: 404 });
    file = BUNDLE; type = "text/javascript; charset=utf-8";
  } else {
    const f = VOICE_FILES[path];
    if (!f) return new Response("Not found.", { status: 404 });
    try { file = await ensure(path); } catch (e: any) { console.error("voice", path, e.message); return new Response("The voice files could not be fetched right now.", { status: 502 }); }
    type = f.type;
  }
  const b = Bun.file(file), size = b.size;
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range") ?? "");
  if (m) {
    const start = Number(m[1]), end = Math.min(size - 1, m[2] ? Number(m[2]) : size - 1);
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { ...head, "content-range": `bytes */${size}` } });
    return new Response(b.slice(start, end + 1), { status: 206, headers: { ...head, "content-type": type, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  return new Response(b, { headers: { ...head, "content-type": type, "content-length": String(size) } });
}
