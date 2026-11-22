// The natural voice: Kokoro-82M on the device's GPU (WebGPU), in a worker so reading and scrolling stay smooth.
// Messages in:  { type: "load" }  then  { type: "say", id, text, voice }
// Messages out: { type: "ready", ms } | { type: "audio", id, samples: Float32Array, rate } | { type: "error", id?, message }
// Every file comes from /voice/ on this origin; the service worker serves them from the "pm-voice" cache when they
// were downloaded, so this works offline.
// How speech-like a clip is: the median spectral flatness of its louder frames. Speech sits around 0.3 to 0.5, noise
// (a model that computes garbage on this GPU) near 1.0. Measured here so a broken clip is never played.
function flatness(x) {
  const N = 1024, half = N / 2, re = new Float64Array(N), im = new Float64Array(N), out = [];
  for (let start = 0; start + N <= x.length && out.length < 60; start += N) {
    let e = 0;
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); re[i] = x[start + i] * w; im[i] = 0; e += re[i] * re[i]; }
    if (e / N < 1e-6) continue; // silence says nothing about quality
    for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= N; len <<= 1) {
      const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < N; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
    let lg = 0, ar = 0;
    for (let k = 1; k < half; k++) { const m = Math.hypot(re[k], im[k]) + 1e-9; lg += Math.log(m); ar += m; }
    out.push(Math.exp(lg / (half - 1)) / (ar / (half - 1)));
  }
  out.sort((a, b) => a - b);
  return out.length ? out[out.length >> 1] : 0;
}
let adapter = "";
let tts = null, loading = null, base = self.location.origin + "/voice/";

async function load() {
  if (tts) return tts;
  if (!loading) loading = (async () => {
    const t0 = performance.now();
    const ad = self.navigator.gpu ? await self.navigator.gpu.requestAdapter() : null;
    if (!ad) throw new Error("This device has no WebGPU.");
    const i = ad.info ?? {};
    adapter = [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(" ") || "unknown";
    // the versioned base (lib/voice.svelte.ts sends it): every file of the voice comes from there
    self.PM_VOICE = base;
    const { KokoroTTS, env } = await import(base + "kokoro.web.js");
    env.wasmPaths = base + "ort/";
    tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "fp32", device: "webgpu" });
    self.postMessage({ type: "ready", ms: Math.round(performance.now() - t0) });
    return tts;
  })().catch(e => { loading = null; throw e; });
  return loading;
}

// one sentence at a time, in order: the GPU does one thing well, not five at once
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  if (data.type === "load") { if (data.base) base = data.base; load().catch(e => self.postMessage({ type: "error", message: String(e?.message ?? e) })); return; }
  if (data.type === "say") {
    queue = queue.then(async () => {
      try {
        const t = await load();
        const t0 = performance.now();
        const audio = await t.generate(data.text, { voice: data.voice || "af_heart" });
        const samples = audio.audio;
        let peak = 0; for (let k = 0; k < samples.length; k++) { const v = Math.abs(samples[k]); if (v > peak || v !== v) peak = v !== v ? Infinity : v; }
        const check = { flatness: +flatness(samples).toFixed(3), peak: +peak.toFixed(3), ms: Math.round(performance.now() - t0), sec: +(samples.length / audio.sampling_rate).toFixed(2), adapter };
        self.postMessage({ type: "audio", id: data.id, samples, rate: audio.sampling_rate, check }, [samples.buffer]);
      } catch (e) {
        self.postMessage({ type: "error", id: data.id, message: String(e?.message ?? e) });
      }
    });
  }
};
