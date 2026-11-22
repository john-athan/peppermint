// House rules for the client, checked on every `bun test`: each thing is defined once, and pages use the shared
// pieces instead of rebuilding them. A failure names the file and the shared piece to use instead.
// The inventory of shared pieces is in ../CLAUDE.md.
import { test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP = join(import.meta.dir, "..");
const CLIENT = join(APP, "client");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const rel = (p: string) => relative(APP, p);
const files = (dir: string, ext: RegExp) => walk(dir).filter(p => ext.test(p) && !p.endsWith(".gen.ts"));
const svelte = files(CLIENT, /\.svelte$/);
const clientCode = files(CLIENT, /\.(svelte|ts)$/);
const css = readFileSync(join(CLIENT, "app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every line in `paths` matching `re`, as "file:line  text", minus the files allowed to do it. */
function hits(paths: string[], re: RegExp, allowed: string[] = []) {
  const out: string[] = [];
  for (const p of paths) {
    if (allowed.includes(rel(p))) continue;
    readFileSync(p, "utf8").split("\n").forEach((l, i) => { if (re.test(l)) out.push(`${rel(p)}:${i + 1}  ${l.trim().slice(0, 120)}`); });
  }
  return out;
}

test("app.css: every top-level selector has one rule (add to it, do not start a second one)", () => {
  const count = new Map<string, number>();
  let depth = 0, sel = "";
  for (const ch of css) {
    if (ch === "{") { if (depth === 0 && !sel.trim().startsWith("@")) count.set(sel.trim(), (count.get(sel.trim()) ?? 0) + 1); depth++; sel = ""; }
    else if (ch === "}") { depth--; sel = ""; }
    else if (depth === 0) sel += ch;
  }
  expect([...count].filter(([, n]) => n > 1).map(([s, n]) => `${s} (${n}×)`)).toEqual([]);
});

test("app.css: button size and shape live only in the button block (.primary/.ghost/.link-btn, .sm, .full)", () => {
  const BASE = new Set([".primary, .ghost", ".primary.full", ".primary.sm, .ghost.sm", ".primary.sm svg, .ghost.sm svg", ".primary svg, .ghost svg", ".link-btn"]);
  const SIZE = /(^|;)\s*(padding|min-height|height|border-radius|font-size|font)\s*:/;
  const bad: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (!/\.(primary|ghost|link-btn)(?![\w-])/.test(sel) || BASE.has(sel)) continue;
    if (SIZE.test(m[2])) bad.push(sel);
  }
  expect(bad).toEqual([]);
});

test("app.css: colours are tokens; a hex value only appears where a --custom-property is declared", () => {
  const bad = css.split(/[;{}]/).map(d => d.trim()).filter(d => /#[0-9a-f]{3,8}\b/i.test(d) && !d.startsWith("--"));
  expect(bad).toEqual([]);
});

test("client code: no hex colours (use a token from app.css)", () => {
  expect(hits(clientCode, /["'`(\s:]#[0-9a-f]{3,8}\b/i)).toEqual([]);
});

test("svelte: no style=\"…\" (use a class or a utility in app.css; style:prop={value} is fine for computed values)", () => {
  expect(hits(svelte, /\sstyle="/)).toEqual([]);
});

test("in-app links use <Link>, not an <a> with preventDefault and go()", () => {
  expect(hits(svelte, /<a\b[^>]*onclick=\{[^}]*preventDefault\(\);[^}]*\bgo\(/)).toEqual([]);
});

test("requests go through lib/api.ts (api, sse, drain, beacon)", () => {
  expect(hits(clientCode, /\bfetch\(/, ["client/lib/api.ts", "client/sw.js"])).toEqual([]);
});

test("loading states use <Skeleton> and <Loading>", () => {
  expect(hits(svelte, /class="steeping/, ["client/components/Skeleton.svelte"])).toEqual([]);
  expect(hits(svelte, /<Mark cls="loading/, ["client/components/Loading.svelte", "client/components/Toast.svelte"])).toEqual([]);
});

test("icons come from lib/icons.ts; only components that draw data write their own <svg>", () => {
  expect(hits(svelte, /<svg\b/, ["client/components/Chart.svelte", "client/pages/Sources.svelte"])).toEqual([]);
});

test("the shapes in shared/types.ts are declared nowhere else", () => {
  const shared = readFileSync(join(APP, "shared/types.ts"), "utf8");
  const names = [...shared.matchAll(/^export type (\w+)/gm)].map(m => m[1]);
  expect(names.length).toBeGreaterThan(0);
  const code = [...clientCode, ...files(join(APP, "server"), /\.ts$/), ...files(join(APP, "shared"), /\.ts$/).filter(p => !p.endsWith("types.ts"))];
  expect(hits(code, new RegExp(`^\\s*(export\\s+)?(type|interface)\\s+(${names.join("|")})\\b`))).toEqual([]);
});
