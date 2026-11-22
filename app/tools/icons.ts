// Renders the PNG app icons from the mark (shared/logo.mjs) with headless Chrome: run after changing the logo.
//   bun tools/icons.ts      writes client/icons/*.png, which the build copies next to the manifest
import { writeFileSync } from "node:fs";
import { iconSvg } from "../shared/logo.mjs";
import { launch } from "./cdp";
const OUT = new URL("../client/icons/", import.meta.url).pathname;
const svg = iconSvg();
// "any": the round mark on transparent; maskable and Apple: a full square in the disc colour, the mark inside the safe zone
const jobs: [string, number, string][] = [
  ["icon-192.png", 192, `<body style="margin:0;background:transparent">${svg.replace("<svg", '<svg width="192" height="192"')}</body>`],
  ["icon-512.png", 512, `<body style="margin:0;background:transparent">${svg.replace("<svg", '<svg width="512" height="512"')}</body>`],
  ["icon-maskable-512.png", 512, `<body style="margin:0;background:#d3f3df;display:grid;place-items:center;height:512px">${svg.replace("<svg", '<svg width="380" height="380"')}</body>`],
  ["apple-touch-icon.png", 180, `<body style="margin:0;background:#d3f3df;display:grid;place-items:center;height:180px">${svg.replace("<svg", '<svg width="150" height="150"')}</body>`],
];
for (const [file, size, html] of jobs) {
  const b = await launch({ width: size, height: size });
  await b.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await b.goto("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html><html>${html}</html>`));
  await b.wait(200);
  const r = await b.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: size, height: size, scale: 1 } });
  writeFileSync(OUT + file, Buffer.from(r.data, "base64"));
  console.log(file, size);
  b.close();
}
process.exit(0);
