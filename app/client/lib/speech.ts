// Speaking, shared by Listen and the reader's audio and video. peppermint speaks only with the natural voice (Kokoro on
// this device's graphics chip, lib/voice.svelte.ts). The browser's own speech voices are not used at all: they sounded
// unusable. Without the natural voice a player says what is needed (components/VoiceNeeded.svelte) instead of playing.
import { canSpeak, pauseNatural, resumeNatural, sayNatural } from "./voice.svelte";

export const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch {} },
};
/** Finished sentences; while text still streams the unfinished tail is left out. */
export function sentences(text: string, streaming = false): string[] {
  const ss = (text.match(/[^.!?…]+[.!?…]+["“”»«)]*|[^.!?…]+$/g) ?? []).map(s => s.trim()).filter(Boolean);
  if (streaming && ss.length && !/[.!?…]["“”»«)]*$/.test(ss[ss.length - 1])) ss.pop();
  return ss;
}
export const rate = () => Number(store.get("pm-rate") ?? 1) || 1;

/**
 * Speaks one line with the natural voice, making the next lines (`upcoming`) meanwhile, and calls `onend` when it is
 * done. `onfail` runs when the line cannot be spoken (no natural voice here, or it failed on this line).
 * `silent: true` (video, whose captions carry the words) waits as long as reading the line would take instead.
 */
export function say(text: string, lang: string, onend: () => void, upcoming: string[] = [], { silent = false, onfail }: { silent?: boolean; onfail?: () => void } = {}): () => void {
  const wait = () => { const t = setTimeout(onend, Math.max(1500, ((text.match(/\S+/g)?.length ?? 1) / 2.55) * 1000 / rate())); return () => clearTimeout(t); };
  if (canSpeak(lang)) {
    let cancel = () => {};
    cancel = sayNatural(text, rate(), onend, upcoming, () => { if (silent) cancel = wait(); else onfail?.(); });
    return () => cancel();
  }
  if (silent) return wait();
  onfail?.();
  return () => {};
}
export const pauseSpeech = () => pauseNatural();
export const resumeSpeech = () => resumeNatural();
