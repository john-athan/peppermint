// peppermint has one package: Svelte. Everything else is Bun, Node built-ins and the web platform.
// A new dependency is a decision for the owner, not a convenience: see CLAUDE.md at the repo root.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const ALLOWED = ["svelte"];

test("package.json lists only the allowed dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const all = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(k => Object.keys(pkg[k] ?? {}));
  expect(all.sort()).toEqual(ALLOWED);
});

test("source imports only allowed packages, bun:, node: and relative paths", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|mjs|js|svelte)$/.test(f)) files.push(p); } };
  for (const d of ["server", "client", "shared", "tools", "tests"]) walk(join(root, d));
  files.push(join(root, "build.ts"));
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/(?:^|[\s;])(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("bun:") || spec.startsWith("node:") || spec === "bun") continue;
      const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (!ALLOWED.includes(name)) bad.push(`${f.slice(root.length + 1)}: ${spec}`);
    }
  }
  expect(bad).toEqual([]);
});
