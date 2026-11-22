// The natural voice: Kokoro-82M on this device's GPU (voice "af_heart", the one the podcasts use), English only.
//  - Nothing downloads by itself: the first time you listen in English, a sheet asks (it says when you are on mobile
//    data, and can wait for Wi-Fi). About 350 MB, once; the files stay in the "pm-voice" cache and work offline.
//  - The download goes in 8 MB pieces kept in their own cache, so a dropped connection or a closed tab resumes.
//  - Speaking: sentences are made a few ahead in a worker (voice-worker.js) and played through one <audio>, so the
//    lock screen and headset buttons work. There is no other voice: without WebGPU, or for German, players say so.
import { api, beacon, getRange } from "./api";
import { store } from "./speech";
declare const __VOICE_WORKER__: string;

export type VoiceStatus = "unknown" | "unsupported" | "absent" | "downloading" | "ready" | "error";
// phase: what the natural voice is doing right now ("loading" onto the GPU, "making" the next sentence), for the players
// mb: the download size the server announces; update: an older copy is on this device and a new one is needed
export const natural = $state({ status: "unknown" as VoiceStatus, done: 0, total: 0, error: "", wifiWait: false, offer: false,
  phase: "" as "" | "loading" | "making", mb: 350, update: false });

const CACHE = "pm-voice", PARTS = "pm-voice-parts", CHUNK = 8 * 1024 * 1024;
type Manifest = { version?: string; base?: string; voice: string; files: { path: string; size: number }[]; bytes: number };
const baseOf = (m: Manifest | null) => m?.base ?? "/voice/";
const saved = (): Manifest | null => { try { return JSON.parse(store.get("pm-voice-manifest") ?? "null"); } catch { return null; } };

/** Mobile data, as far as the browser tells (Android Chrome does; iPhones do not). */
export const onCellular = () => (navigator as any).connection?.type === "cellular";
export const onWifi = () => ["wifi", "ethernet"].includes((navigator as any).connection?.type);

/** Works out where the voice stands: no GPU, not downloaded, or ready. */
export async function probe() {
  natural.wifiWait = store.get("pm-voice-wifi") === "1";
  try {
    const gpu = (navigator as any).gpu;
    if (!gpu || !(await gpu.requestAdapter())) { natural.status = "unsupported"; return; }
  } catch { natural.status = "unsupported"; return; }
  if (natural.status === "downloading") return;
  // the server says what the current voice files are; an older copy here is replaced only after asking again
  const cur = navigator.onLine ? await api<Manifest>("/api/voice").catch(() => null) : null;
  if (cur) natural.mb = Math.round(cur.bytes / 1e6);
  const old = saved();
  if (cur && old && old.version !== cur.version) {
    natural.update = true; stopNatural(); worker?.terminate(); worker = null; ready = null; loaded = false;
    await caches.delete(CACHE).catch(() => {}); await caches.delete(PARTS).catch(() => {}); store.set("pm-voice-manifest", "");
    natural.status = "absent"; return;
  }
  const m = saved();
  if (m && typeof caches !== "undefined") {
    const c = await caches.open(CACHE);
    const have = await Promise.all(m.files.map(f => c.match(`${baseOf(m)}${f.path}`)));
    if (have.every(Boolean)) { natural.status = "ready"; return; }
  }
  natural.status = "absent";
}

/** Downloads every file once, in pieces; resumes where it stopped. */
export async function download() {
  if (natural.status === "downloading" || natural.status === "unsupported") return;
  natural.status = "downloading"; natural.error = ""; natural.offer = false;
  store.set("pm-voice-wifi", "0"); natural.wifiWait = false;
  try {
    (navigator as any).storage?.persist?.().catch(() => {});
    const m = await api<Manifest>("/api/voice");
    natural.total = m.bytes; natural.done = 0;
    const c = await caches.open(CACHE), parts = await caches.open(PARTS);
    for (const f of m.files) {
      const url = `${baseOf(m)}${f.path}`;
      if (await c.match(url)) { natural.done += f.size; continue; }
      const pieces: Blob[] = []; let type = "";
      for (let i = 0, start = 0; start < f.size; i++, start += CHUNK) {
        const key = `${url}?part=${i}`, end = Math.min(f.size, start + CHUNK) - 1;
        let hit = await parts.match(key);
        if (!hit) {
          let got: { blob: Blob; type: string } | null = null;
          for (let attempt = 0; !got; attempt++) {
            try { got = await getRange(url, start, end); }
            catch (e) { if (attempt >= 4) throw e; await new Promise(r => setTimeout(r, 1500 * 2 ** attempt)); }
          }
          await parts.put(key, new Response(got.blob, { headers: { "content-type": got.type } }));
          hit = await parts.match(key);
        }
        type ||= hit!.headers.get("content-type") ?? "application/octet-stream";
        pieces.push(await hit!.blob());
        natural.done += end - start + 1;
      }
      const whole = new Blob(pieces, { type });
      // pieces that do not add up are thrown away, so "Try again" fetches them fresh instead of reusing them
      if (whole.size !== f.size) { for (let i = 0; i * CHUNK < f.size; i++) await parts.delete(`${url}?part=${i}`); throw new Error(`${f.path.split("/").pop()} arrived incomplete.`); }
      await c.put(url, new Response(whole, { headers: { "content-type": type, "content-length": String(f.size) } }));
      for (let i = 0; i * CHUNK < f.size; i++) await parts.delete(`${url}?part=${i}`);
    }
    store.set("pm-voice-manifest", JSON.stringify(m));
    natural.status = "ready"; natural.update = false;
    warm();
  } catch (e: any) {
    natural.status = "error"; natural.error = e?.message ?? "The download stopped.";
  }
}

/** Removes the voice from this device (and frees the space). */
export async function remove() {
  stopNatural(); worker?.terminate(); worker = null; ready = null; loaded = false;
  await caches.delete(CACHE); await caches.delete(PARTS);
  store.set("pm-voice-manifest", ""); store.set("pm-voice-wifi", "0");
  natural.status = "absent"; natural.done = 0;
}

/** Wait for Wi-Fi: the download starts by itself on the next Wi-Fi connection (main.ts listens). */
export function whenWifi() { store.set("pm-voice-wifi", "1"); natural.wifiWait = true; natural.offer = false; }
export function decline() { store.set("pm-voice-declined", "1"); natural.offer = false; }

/** Called when someone starts listening in English: offers the download once (never on its own). */
export function offer(lang: string) {
  if (lang === "en" && natural.status === "absent" && !natural.wifiWait && (natural.update || store.get("pm-voice-declined") !== "1")) natural.offer = true;
}

/** The natural voice speaks this language now. */
/** The natural voice can speak this language here and now (English only: Kokoro has no German). */
export const canSpeak = (lang: string) => lang === "en" && natural.status === "ready";

// ---- making and playing speech ----
let worker: Worker | null = null, ready: Promise<void> | null = null, seq = 0, loaded = false, noisy = 0, reported = 0;
/** What the voice produced on this device (quality, speed, graphics chip), to the server log: the first clips of a
 *  session and every noisy one. Nothing personal: no text, only numbers and the browser's name. */
function report(c: Record<string, unknown>) {
  if (!c.noise && reported >= 3) return;
  reported++;
  beacon("/api/voice/report", { ...c, ua: navigator.userAgent.slice(0, 160) });
}
const waiting = new Map<number, { ok: (u: string) => void; no: (e: Error) => void }>();
const made = new Map<string, Promise<string>>();

function startWorker(): Promise<void> {
  if (ready) return ready;
  // the worker's file name carries a hash of its content (build.ts), so no cache can hand out an older worker
  worker = new Worker(typeof __VOICE_WORKER__ !== "undefined" ? __VOICE_WORKER__ : "/voice-worker.js", { type: "module" });
  ready = new Promise((ok, no) => {
    worker!.onmessage = ({ data }) => {
      if (data.type === "ready") { loaded = true; ok(); }
      else if (data.type === "audio") {
        const w = waiting.get(data.id); waiting.delete(data.id);
        // the worker measured the clip: noise (a model computing garbage on this GPU) is never played
        const c = data.check ?? {}, noise = !(c.peak > 0.01 && c.peak < 50) || c.flatness > 0.7;
        report({ ...c, noise });
        if (!noise) { w?.ok(URL.createObjectURL(wav(data.samples, data.rate))); return; }
        w?.no(new Error("noise"));
        if (++noisy >= 2) {
          natural.status = "error";
          natural.error = "On this device the graphics chip made noise instead of speech, so the device voice reads instead.";
        }
      }
      else if (data.type === "error") {
        if (data.id == null) { no(new Error(data.message)); return; }
        const w = waiting.get(data.id); waiting.delete(data.id); w?.no(new Error(data.message));
      }
    };
    worker!.onerror = e => no(new Error(e.message || "The voice could not start."));
    worker!.postMessage({ type: "load", base: location.origin + baseOf(saved()) });
  });
  ready.catch(e => { natural.status = "error"; natural.error = e.message; worker?.terminate(); worker = null; ready = null; loaded = false; });
  return ready;
}
/** Loads the model onto the GPU ahead of time, so the first sentence does not wait for it. */
export const warm = () => { if (natural.status === "ready") startWorker().catch(() => {}); };

/** One sentence as a playable audio URL; made once, kept for the last 60 sentences. */
export function speech(text: string): Promise<string> {
  let p = made.get(text);
  if (!p) {
    p = startWorker().then(() => new Promise<string>((ok, no) => { const id = ++seq; waiting.set(id, { ok, no }); worker!.postMessage({ type: "say", id, text, voice: saved()?.voice ?? "af_heart" }); }));
    made.set(text, p);
    p.catch(() => made.delete(text));
    if (made.size > 60) { const [old, op] = made.entries().next().value!; made.delete(old); op.then(u => URL.revokeObjectURL(u), () => {}); }
  }
  return p;
}

let audio: HTMLAudioElement | null = null, live = 0;
/** Speaks one sentence with the natural voice, making the next ones meanwhile. Resolves to a cancel function. */
export function sayNatural(text: string, rate: number, onend: () => void, upcoming: string[] = [], onfail?: () => void): () => void {
  const my = ++live;
  audio ??= new Audio();
  audio.pause();
  // nothing to hear yet: the model is still loading onto the GPU, or this sentence is still being made
  natural.phase = ready && loaded ? "making" : "loading";
  speech(text).then(url => {
    if (my !== live) return;
    upcoming.slice(0, 3).forEach(t => { speech(t).catch(() => {}); });
    audio!.src = url; audio!.playbackRate = rate; (audio as any).preservesPitch = true;
    // "Playing" only once sound actually comes out
    natural.phase = "making";
    audio!.onplaying = () => { if (my === live) natural.phase = ""; };
    audio!.onended = () => { if (my === live) onend(); };
    audio!.play().catch(() => { if (my === live) onfail?.(); });
  }, () => { if (my === live) { natural.phase = ""; onfail?.(); } });
  return () => { if (my === live) { live++; natural.phase = ""; audio?.pause(); } };
}
export function stopNatural() { live++; natural.phase = ""; audio?.pause(); }
export const pauseNatural = () => { if (audio && !audio.paused) { audio.pause(); return true; } return false; };
export const resumeNatural = () => { if (audio && audio.paused && audio.src && !audio.ended) { audio.play().catch(() => {}); return true; } return false; };

/** 16-bit PCM WAV from the model's float samples. */
function wav(samples: Float32Array, rate: number): Blob {
  const b = new ArrayBuffer(44 + samples.length * 2), v = new DataView(b);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([b], { type: "audio/wav" });
}
