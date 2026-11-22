// Vendors the browser build of kokoro-js (the natural voice) into vendor/kokoro.web.js, so peppermint needs no npm
// package for it. Run with the path of a kokoro-js 1.2.1 package (npm pack kokoro-js@1.2.1, then untar):
//   bun tools/vendor-kokoro.ts /path/to/package/dist/kokoro.web.js
// The bundle contains transformers.js 3.5.1, the onnxruntime-web glue and the phonemizer (espeak-ng as wasm). Four
// patches keep every download on our own origin (server/voice.ts serves and verifies the files):
//  1. the model host: huggingface.co becomes /voice/hf/ on this origin
//  2. the voice files: same, the bundle builds their URL itself
//  3. the onnxruntime wasm: jsdelivr becomes /voice/ort/
//  4. transformers.js keeps no second copy in its own cache: the service worker's "pm-voice" cache already holds them
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

const src = process.argv[2];
if (!src) { console.error("usage: bun tools/vendor-kokoro.ts <kokoro.web.js>"); process.exit(1); }
let s = readFileSync(src, "utf8");
const patch = (from: string, to: string) => {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.error(`expected exactly one "${from.slice(0, 60)}", found ${n}: is this kokoro-js 1.2.1?`); process.exit(1); }
  s = s.replace(from, to);
};
// self.PM_VOICE is the versioned base the worker sets (e.g. https://host/voice/v2/); a new version means new URLs, so no
// cache on the way (Cloudflare) can hand back an older copy
const BASE = '(self.PM_VOICE||self.location.origin+"/voice/")';
patch('remoteHost:"https://huggingface.co/"', `remoteHost:${BASE}+"hf/"`);
patch("`https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${e}.bin`", "`${" + BASE + "}hf/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/${e}.bin`");
patch("`https://cdn.jsdelivr.net/npm/@huggingface/transformers@${n.env.version}/dist/`", '`${' + BASE + '}ort/`');
patch("useBrowserCache:o,", "useBrowserCache:!1,");
const head = `// kokoro-js 1.2.1 (Apache-2.0, https://github.com/hexgrad/kokoro), browser build with transformers.js 3.5.1 (Apache-2.0),
// onnxruntime-web 1.22.0-dev.20250409 (MIT) and phonemizer with espeak-ng (GPL-3.0). Vendored and patched by
// tools/vendor-kokoro.ts so that every file is fetched from this origin. Do not edit by hand.
`;
mkdirSync("vendor", { recursive: true });
writeFileSync("vendor/kokoro.web.js", head + s);
console.log("vendor/kokoro.web.js", (head + s).length, "bytes, sha256", createHash("sha256").update(head + s).digest("hex"));
