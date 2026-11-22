// Inside the Android app (android/, a Trusted Web Activity) Chrome opens the first page with the app as referrer.
// The tab keeps that in sessionStorage, so the answer stays true after navigating and reloading.
const KEY = "peppermint-in-app";
export const inApp: boolean = (() => {
  try {
    if (document.referrer.startsWith("android-app://dev.kaleve.peppermint")) sessionStorage.setItem(KEY, "1");
    return sessionStorage.getItem(KEY) === "1";
  } catch { return false; }
})();
/** Links the app answers (android/app/src/main/AndroidManifest.xml). */
export const appLink = { pair: (code: string) => `peppermint://pair?code=${encodeURIComponent(code)}`, play: (episode: number) => `peppermint://play?episode=${episode}` };
