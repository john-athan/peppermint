// Installing peppermint as an app. The browser's install offer is kept for the button in Palate; iPhone and iPad have no
// offer, so they get the share-menu steps instead; inside the installed app nothing is offered.
import { app } from "./state.svelte";

let installEvent: any = null;
const standalone = matchMedia("(display-mode: standalone)").matches || (navigator as any).standalone === true;
app.install = standalone ? "installed" : /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) ? "ios" : null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; app.install = "prompt"; });
addEventListener("appinstalled", () => { installEvent = null; app.install = "installed"; });
export async function installApp() {
  if (!installEvent) return false;
  installEvent.prompt();
  const r = await installEvent.userChoice.catch(() => null);
  installEvent = null;
  if (r?.outcome === "accepted") app.install = "installed"; else app.install = null;
  return r?.outcome === "accepted";
}
