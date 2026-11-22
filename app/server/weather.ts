// The weather at home for the mark's sky: one Open-Meteo request at most every 15 minutes, shared by everyone.
// Only the WMO weather code is kept; sun and moon are computed on the device (shared/sky.mjs).
import { HOME } from "../shared/sky.mjs";

const URL = `https://api.open-meteo.com/v1/forecast?latitude=${HOME.lat}&longitude=${HOME.lng}&current=weather_code`;
let cache: { code: number; at: number } | null = null;
let pending: Promise<void> | null = null;

/** The current WMO weather code at home, or null when it could not be fetched (the mark then shows a clear sky). */
export async function weatherCode(): Promise<number | null> {
  if (!cache || Date.now() - cache.at > 15 * 6e4) {
    pending ??= (async () => {
      try {
        const r = await fetch(URL, { signal: AbortSignal.timeout(5000) });
        const code = Number((await r.json())?.current?.weather_code);
        if (r.ok && Number.isInteger(code)) cache = { code, at: Date.now() };
      } catch {} finally { pending = null; }
    })();
    await pending;
  }
  return cache?.code ?? null;
}
