// One generation, many readers. A text is produced once per key, streamed over SSE while it is written,
// shared with every reader who asks meanwhile, then saved and replayed from the cache.
// Event ids are chunk indexes, so a reader that drops off resumes with Last-Event-ID.
import { hasLLM, LENS_MODEL } from "./llm";

/** Besides text, a producer may say what it is doing (`status`, sent to every reader, the newest to one who joins late)
 *  or add to the closing event (`end`, e.g. `{ material: "none" }` when there was nothing to write about). */
export type Note = { status?: string; end?: Record<string, unknown> };
type Live = { chunks: string[]; done: boolean; error?: string; status?: string; end?: Record<string, unknown>; waiters: Set<() => void> };
const live = new Map<string, Live>();
const enc = new TextEncoder();
export const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" };

export type SteepOpts = {
  key: string;
  open?: Record<string, unknown>;
  cached?: () => { text: string; model: string } | null;
  produce: () => AsyncIterable<string | Note>;
  save?: (text: string, model: string) => void;
  /** the model that writes it, saved with the text (Sonnet unless the producer uses another) */
  model?: string;
  /** set when the text can be made without a model (a local fallback); otherwise no LLM means an error event */
  needsLLM?: boolean;
  lastEventId: number;
  signal: AbortSignal;
};

export function steep(o: SteepOpts): ReadableStream {
  const send = (c: ReadableStreamDefaultController, event: string, data: unknown, id?: number) =>
    c.enqueue(enc.encode(`${id !== undefined ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return new ReadableStream({
    async start(c) {
      const close = () => { try { c.close(); } catch {} };
      send(c, "open", o.open ?? {});
      const hit = o.cached?.();
      if (hit) {
        // replay in word-sized chunks so the reader still sees it pour
        const chunks = hit.text.match(/\s*\S+\s*/g) ?? [];
        for (let i = o.lastEventId + 1; i < chunks.length; i += 3) { if (o.signal.aborted) return; send(c, "delta", { t: chunks.slice(i, i + 3).join("") }, i + 2); if (i % 30 === 0) await Bun.sleep(1); }
        send(c, "done", { cached: true, model: hit.model }); return close();
      }
      if (o.needsLLM !== false && !hasLLM()) { send(c, "error", { code: "no_llm", message: "Steeping needs Claude on the server: set ANTHROPIC_API_KEY, or install and log in Claude Code." }); return close(); }
      let l = live.get(o.key);
      if (!l) {
        const L: Live = { chunks: [], done: false, waiters: new Set() }; live.set(o.key, L); l = L;
        (async () => {
          try {
            for await (const t of o.produce()) {
              if (typeof t === "string") L.chunks.push(t);
              else { if (t.status) L.status = t.status; if (t.end) L.end = { ...L.end, ...t.end }; }
              L.waiters.forEach(w => w());
            }
            // nothing written (the material was empty) is not a text to replay
            const text = L.chunks.join("");
            if (text.trim()) o.save?.(text, hasLLM() ? o.model ?? LENS_MODEL : "local");
          } catch (e) { L.error = String((e as Error).message ?? e).slice(0, 200); }
          // a finished text stays a while for reconnecting readers; a failure goes at once, so the next try asks Claude again
          L.done = true; L.waiters.forEach(w => w()); if (L.error) live.delete(o.key); else setTimeout(() => live.delete(o.key), 30_000);
        })();
      }
      let i = o.lastEventId + 1, said: string | undefined;
      while (!o.signal.aborted) {
        if (l.status !== said && !l.done) { said = l.status; send(c, "status", { text: said }); }
        while (i < l.chunks.length) { send(c, "delta", { t: l.chunks[i] }, i); i++; }
        if (l.done) break;
        await new Promise<void>(r => { const w = () => { l!.waiters.delete(w); r(); }; l!.waiters.add(w); o.signal.addEventListener("abort", w, { once: true }); });
      }
      if (l.error) send(c, "error", { code: "llm", message: l.error }); else send(c, "done", { cached: false, model: hasLLM() ? o.model ?? LENS_MODEL : "local", ...l.end });
      close();
    },
  });
}

/** For keys whose input can change (a draft), drop a finished generation so the next ask makes a new one. */
export const forget = (key: string) => { const l = live.get(key); if (l?.done) live.delete(key); };
