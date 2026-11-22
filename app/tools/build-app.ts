// The build every Bun + Svelte app here shares. oss-kit owns this file: change it in
// oss-kit/templates/shared/bun-app/tools/, never in a copy. An app's own build.ts keeps only what is its own
// (its workers, style tokens, generated marks, manifest) and calls buildApp() with it; deploy/README.md says how.
//
// What it does: Svelte compiled through a small Bun plugin, one hashed bundle and one hashed stylesheet, the
// service worker with its version and precache list filled in, the manifest, the icons, brotli and gzip variants
// of every text asset, and dist/manifest.json, which tells the server what to serve with which content type.
import { compile, compileModule } from "svelte/compiler";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { brotliCompressSync, gzipSync, constants } from "node:zlib";

export type Icon = { src: string; sizes: string; type: string; purpose: string };
export type Ctx = {
  root: string; out: string; dev: boolean;
  /** Every file the server may serve, by path under dist/, with its content type. Add to it from `after`. */
  files: Record<string, string>;
  /** Writes `<path>.br` and `<path>.gz` next to a file under dist/ that is already written. */
  compress(path: string): void;
};
export type Config = {
  /** The app's folder (pass import.meta.dir from build.ts). */
  root: string;
  /** Runs before the client bundle. Bundles or copies a worker into dist/assets/ (anything there that is not the
   *  main bundle or the stylesheet is served as it is) and returns the compile-time constants for it. */
  prepare?: (c: Ctx) => Promise<Record<string, string>> | Record<string, string>;
  /** The whole stylesheet, unminified: the app's tokens, then client/app.css. */
  css: () => string;
  /** icon.svg's content. */
  icon: string;
  /** More SVG marks from client/icons/, copied to the dist root and precached next to icon.svg. */
  marks?: string[];
  /** The manifest, given the icons found in client/icons/ (PNG ones that exist, plus icon.svg). */
  manifest: (icons: Icon[]) => object;
  /** More paths for the service worker to precache, after the bundle, stylesheet, icon.svg and marks. */
  precache?: string[];
  /** Files that get .br and .gz variants. Default: text assets and wasm; PNGs do not shrink. */
  compress?: RegExp;
  /** Runs after the compression, before dist/manifest.json is written: copy vendored files in, add to c.files. */
  after?: (c: Ctx) => Promise<void> | void;
};

const PNG_ICONS = ["icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
const MIME: Record<string, string> = {
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
  wasm: "application/wasm", json: "application/json", svg: "image/svg+xml", png: "image/png", webmanifest: "application/manifest+json",
};
export const mime = (f: string) => MIME[f.split(".").pop()!] ?? "application/octet-stream";

const svelte = (dev: boolean): import("bun").BunPlugin => ({
  name: "svelte",
  setup(b) {
    b.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const r = compile(await Bun.file(path).text(), { filename: basename(path), generate: "client", css: "injected", dev });
      return { contents: r.js.code, loader: "js" };
    });
    b.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const ts = new Bun.Transpiler({ loader: "ts" }).transformSync(await Bun.file(path).text());
      return { contents: compileModule(ts, { filename: basename(path), generate: "client", dev }).js.code, loader: "js" };
    });
  },
});

export async function buildApp(cfg: Config) {
  const root = cfg.root, out = join(root, "dist");
  const dev = process.argv.includes("--dev");
  const compressible = cfg.compress ?? /\.(js|css|svg|webmanifest|wasm)$/;
  rmSync(out, { recursive: true, force: true }); mkdirSync(join(out, "assets"), { recursive: true });
  const files: Record<string, string> = {};
  const compress = (path: string) => {
    const buf = readFileSync(join(out, path));
    writeFileSync(join(out, path + ".br"), brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: dev ? 4 : 11 } }));
    writeFileSync(join(out, path + ".gz"), gzipSync(buf, { level: 9 }));
  };
  const ctx: Ctx = { root, out, dev, files, compress };

  const t0 = performance.now();
  const define = cfg.prepare ? await cfg.prepare(ctx) : {};
  const res = await Bun.build({ define, entrypoints: [join(root, "client/main.ts")], outdir: join(out, "assets"), naming: "[name]-[hash].[ext]", minify: !dev, sourcemap: dev ? "inline" : "none", target: "browser", plugins: [svelte(dev)], conditions: ["browser"] });
  if (!res.success) { console.error(res.logs); process.exit(1); }

  const css = cfg.css();
  const cssMin = dev ? css : css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,>])\s*/g, "$1").replace(/;}/g, "}");
  const cssName = `app-${Bun.hash(cssMin).toString(36)}.css`;
  writeFileSync(join(out, "assets", cssName), cssMin);
  const js = readdirSync(join(out, "assets")).find(f => f.startsWith("main-") && f.endsWith(".js"))!;
  // every other file the bundler or `prepare` wrote (chunks, worker bundles, wasm next to them) is served as it is
  const extra = readdirSync(join(out, "assets")).filter(f => f !== js && f !== cssName && !f.endsWith(".map"));

  writeFileSync(join(out, "icon.svg"), cfg.icon);
  const marks = cfg.marks ?? [];
  for (const f of marks) writeFileSync(join(out, f), readFileSync(join(root, "client/icons", f)));
  const png = PNG_ICONS.filter(f => existsSync(join(root, "client/icons", f)));
  for (const f of png) writeFileSync(join(out, f), readFileSync(join(root, "client/icons", f)));
  const icons: Icon[] = [
    ...png.filter(f => f !== "apple-touch-icon.png").map(f => ({ src: `/${f}`, sizes: f.includes("192") ? "192x192" : "512x512", type: "image/png", purpose: f.includes("maskable") ? "maskable" : "any" })),
    { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
  ];
  writeFileSync(join(out, "manifest.webmanifest"), JSON.stringify(cfg.manifest(icons)));

  // the service worker's cache name is a hash of the two bundles, so a new build is a new cache
  const precache = [`/assets/${js}`, `/assets/${cssName}`, "/icon.svg", ...marks.map(f => `/${f}`), ...(cfg.precache ?? [])];
  writeFileSync(join(out, "sw.js"), readFileSync(join(root, "client/sw.js"), "utf8").replace("__VERSION__", Bun.hash(js + cssName).toString(36)).replace("__ASSETS__", JSON.stringify(precache)));
  writeFileSync(join(out, "index.html"), readFileSync(join(root, "client/index.html"), "utf8").replaceAll("__CSS__", `/assets/${cssName}`).replaceAll("__JS__", `/assets/${js}`));

  Object.assign(files, {
    [`assets/${js}`]: mime(js), [`assets/${cssName}`]: mime(cssName), ...Object.fromEntries(extra.map(f => [`assets/${f}`, mime(f)])),
    "icon.svg": mime("x.svg"), ...Object.fromEntries(marks.map(f => [f, mime(f)])), ...Object.fromEntries(png.map(f => [f, mime(f)])),
    "manifest.webmanifest": mime("x.webmanifest"), "sw.js": mime("sw.js"),
  });
  for (const f of Object.keys(files)) if (compressible.test(f)) compress(f);
  if (cfg.after) await cfg.after(ctx);
  writeFileSync(join(out, "manifest.json"), JSON.stringify({ files }));
  const size = (f: string) => (readFileSync(join(out, f + ".br")).length / 1024).toFixed(1) + " KB br";
  console.log(`built in ${Math.round(performance.now() - t0)} ms, js ${size(`assets/${js}`)}, css ${size(`assets/${cssName}`)}`);
}
