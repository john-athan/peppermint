// Minimal Chrome DevTools Protocol driver for visual checks and click-through tests. No dependencies.
// Used by tools/e2e.ts; run directly it is an interactive browser for debugging (see the end of this file).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Always muted: tests play speech, and a headless browser would otherwise play it through the speakers.
 * `gpu: true` keeps the graphics chip and turns on WebGPU (for the natural voice); otherwise rendering is software only. */
export async function launch({ width = 1280, height = 900, mobile = false, gpu = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pm-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--mute-audio", ...(gpu ? ["--enable-unsafe-webgpu"] : ["--disable-gpu"]), "--hide-scrollbars", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl: string = await new Promise((res, rej) => {
    let buf = "";
    proc.stderr!.on("data", d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    setTimeout(() => rej(new Error("chrome did not start")), 10000);
  });
  const port = new URL(wsUrl).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as any[];
  const page = targets.find(t => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener("open", r, { once: true }));
  let id = 0; const pending = new Map<number, (v: any) => void>(); const listeners: ((m: any) => void)[] = [];
  const logs: string[] = [];
  ws.addEventListener("message", e => {
    const m = JSON.parse(String(e.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
    else listeners.forEach(l => l(m));
  });
  const send = (method: string, params: any = {}) => new Promise<any>((res, rej) => {
    const i = ++id; pending.set(i, m => m.error ? rej(new Error(method + ": " + m.error.message)) : res(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  listeners.push(m => {
    if (m.method === "Runtime.consoleAPICalled") logs.push(`[${m.params.type}] ` + m.params.args.map((a: any) => a.value ?? a.description).join(" "));
    if (m.method === "Runtime.exceptionThrown") logs.push("[exception] " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") logs.push("[log] " + m.params.entry.text + " " + (m.params.entry.url || ""));
  });
  await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await send("Emulation.setTouchEmulationEnabled", { enabled: true });
  const api = {
    send, logs,
    async goto(url: string) {
      const loaded = new Promise(r => { const l = (m: any) => { if (m.method === "Page.loadEventFired") { listeners.splice(listeners.indexOf(l), 1); r(null); } }; listeners.push(l); });
      await send("Page.navigate", { url }); await loaded;
    },
    async eval<T = any>(expr: string): Promise<T> {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async click(sel: string) {
      const box = await api.eval<any>(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2}; })()`);
      if (!box) throw new Error("no element " + sel);
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    },
    async drag(x: number, y1: number, y2: number) {
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: y1, button: "left", clickCount: 1 });
      for (let i = 1; i <= 10; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y1 + (y2 - y1) * i / 10, button: "left", buttons: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: y2, button: "left", clickCount: 1 });
    },
    async type(text: string) { await send("Input.insertText", { text }); },
    async key(key: string) { for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key }); },
    async theme(dark: boolean) { await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] }); },
    async reducedMotion() { await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); },
    async shot(path: string, full = false) {
      const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: full });
      await Bun.write(path, Buffer.from(r.data, "base64"));
    },
    wait: (ms: number) => new Promise(r => setTimeout(r, ms)),
    close() { ws.close(); proc.kill(); },
  };
  return api;
}

// Interactive mode: one Chrome stays open, short commands drive it from the shell.
//   bun tools/cdp.ts serve [--phone] [--port 4318]      start Chrome (with a virtual passkey) and listen on localhost
//   bun tools/cdp.ts go <url|/path>   eval <js>   click <css>   type <text>   key <Enter>   text [css]
//   bun tools/cdp.ts shot [file] [full]   logs   size <w> <h> [phone]   theme dark|light   overflow   send <Method> [json]   stop
// In the page, `__pm` (localhost only) holds the app state, `go` and `api`.
if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (n: string) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
  const PORT = Number(flag("--port") ?? process.env.CDP_PORT ?? 4318);
  if (cmd === "serve") {
    const phone = args.includes("--phone");
    const b = await launch(phone ? { width: 390, height: 844, mobile: true } : {});
    await b.send("WebAuthn.enable");
    await b.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    let base = "http://localhost:4317";
    const size = async (w: number, h: number, mobile: boolean) => {
      await b.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
      await b.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
    };
    const run: Record<string, (a: string[]) => Promise<unknown>> = {
      go: async ([u]) => { const url = /^https?:/.test(u) ? u : base + u; base = new URL(url).origin; await b.goto(url); await b.wait(400); return url; },
      eval: ([e]) => b.eval(e),
      click: async ([s]) => { await b.click(s); await b.wait(300); return "ok"; },
      type: async ([t]) => { await b.type(t); return "ok"; },
      key: async ([k]) => { await b.key(k); return "ok"; },
      text: ([s]) => b.eval(`document.querySelector(${JSON.stringify(s || "main")})?.innerText ?? null`),
      shot: async ([f, full]) => { const p = f || join(tmpdir(), `pm-shot-${Date.now()}.png`); await b.shot(p, full === "full"); return p; },
      logs: async () => b.logs.splice(0).join("\n") || "(no logs)",
      size: async ([w, h, m]) => { await size(Number(w), Number(h), m === "phone"); return "ok"; },
      theme: async ([t]) => { await b.theme(t === "dark"); return "ok"; },
      // elements wider than the viewport: the usual cause of a page that scrolls sideways on a phone
      overflow: () => b.eval(`(() => { const w = document.documentElement.clientWidth; const out = [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > w + 1 && getComputedStyle(e).position !== 'fixed').filter(e => !e.closest('[style*=overflow],.scroll')).slice(0, 15).map(e => e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').join('.') : '') + ' ' + Math.round(e.getBoundingClientRect().right)); return { viewport: w, page: document.documentElement.scrollWidth, wide: out }; })()`),
      // any DevTools method, e.g. send Network.emulateNetworkConditions '{"offline":true,"latency":0,"downloadThroughput":-1,"uploadThroughput":-1}'
      send: ([m, p]) => b.send(m, p ? JSON.parse(p) : {}),
      stop: async () => { setTimeout(() => { b.close(); process.exit(0); }, 50); return "stopped"; },
    };
    Bun.serve({ port: PORT, hostname: "127.0.0.1", async fetch(req) {
      const { cmd, args } = await req.json() as { cmd: string; args: string[] };
      try { return Response.json({ ok: true, out: await (run[cmd] ?? (async () => { throw new Error("unknown command " + cmd); }))(args) }); }
      catch (e) { return Response.json({ ok: false, out: String((e as Error).message) }); }
    } });
    console.log(`cdp listening on 127.0.0.1:${PORT}`);
  } else if (cmd) {
    const r = await fetch(`http://127.0.0.1:${PORT}`, { method: "POST", body: JSON.stringify({ cmd, args }) }).then(r => r.json()).catch(() => ({ ok: false, out: "no browser: run `bun tools/cdp.ts serve` first" })) as { ok: boolean; out: unknown };
    console.log(typeof r.out === "string" ? r.out : JSON.stringify(r.out, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
}
