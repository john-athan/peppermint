// The sky every mark shows: the time of day from the clock (sun times and moon computed on the device), the weather
// at home from the server. Every <Mark> reads the same markup, so it is built once per change, not per mark.
import { untrack } from "svelte";
import { api } from "./api";
import { skyState, skySvg } from "../../shared/sky.mjs";

const st = $state({ now: Date.now(), code: null as number | null });
const view = $derived(skyState(st.now, st.code));
const key = $derived(`${view.tod} ${view.wx} ${view.moon}`);
// rebuilt only when what is drawn changes (the clock ticks every minute), so marks do not re-render for nothing
const markup = $derived.by(() => { key; return untrack(() => skySvg(view)); });

/** The sky layers for the mark: `back` behind the sprig, `front` over it. */
export const sky = () => markup;

let started = false;
/** Keeps the sky current: the clock each minute, the weather every 20 minutes while the app is in view. */
export function startSky() {
  if (started) return; started = true;
  let last = 0;
  const weather = () => {
    if (document.hidden || Date.now() - last < 20 * 6e4) return;
    last = Date.now();
    api<{ code: number | null }>("/api/sky").then(r => { st.code = r.code; }).catch(() => { last = 0; });
  };
  weather();
  setInterval(() => { st.now = Date.now(); weather(); }, 6e4);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { st.now = Date.now(); weather(); } });
}
