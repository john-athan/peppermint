// A piece as an Instagram carousel: five 4:5 slides drawn on a canvas (cover with the photo and headline, three
// sentences that carry the story, and where to read it), in peppermint's colours read from the page's tokens.
// Shared as image files where the system share sheet takes them, otherwise saved one by one.
import { getBlob } from "./api";

export type Slide = { blob: Blob; url: string };
const W = 1080, H = 1350, PAD = 92;
const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const SANS = '-apple-system, "SF Pro Rounded", system-ui, "Segoe UI", sans-serif';
const SERIF = '"Iowan Old Style", Charter, Georgia, serif';

function lines(g: CanvasRenderingContext2D, text: string, max: number) {
  const out: string[] = []; let cur = "";
  for (const w of text.split(/\s+/)) { const t = cur ? `${cur} ${w}` : w; if (g.measureText(t).width > max && cur) { out.push(cur); cur = w; } else cur = t; }
  if (cur) out.push(cur);
  return out;
}
/** The largest size from `sizes` at which the text fits in `rows` lines. */
function fit(g: CanvasRenderingContext2D, text: string, weight: number, family: string, sizes: number[], rows: number) {
  for (const s of sizes) { g.font = `${weight} ${s}px ${family}`; const l = lines(g, text, W - PAD * 2); if (l.length <= rows) return { size: s, l }; }
  const s = sizes.at(-1)!; g.font = `${weight} ${s}px ${family}`; return { size: s, l: lines(g, text, W - PAD * 2).slice(0, rows) };
}
const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("Could not draw the slides.")), "image/jpeg", 0.9));

export async function slides(p: { headline: string; sentences: string[]; photo: string | null; byline: string; url: string; place: string }): Promise<Slide[]> {
  const ink = token("--paper-ink") || "black", mint = token("--mint") || "green", soft = token("--mint-soft") || "white", paper = token("--surface") || "white", muted = token("--paper-muted") || "gray";
  const img = p.photo ? await createImageBitmap(await getBlob(p.photo)).catch(() => null) : null;
  const out: Slide[] = [];
  const page = async (draw: (g: CanvasRenderingContext2D) => void) => {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const g = c.getContext("2d")!; g.textBaseline = "alphabetic"; draw(g);
    const blob = await toBlob(c); out.push({ blob, url: URL.createObjectURL(blob) });
  };
  const n = 2 + p.sentences.length;
  const dots = (g: CanvasRenderingContext2D, i: number, on: string, off: string) => { for (let k = 0; k < n; k++) { g.fillStyle = k === i ? on : off; g.beginPath(); g.arc(W / 2 - (n - 1) * 14 + k * 28, H - 64, 7, 0, Math.PI * 2); g.fill(); } };
  // cover: the photo under a dark fall-off, the place, the headline
  await page(g => {
    g.fillStyle = ink; g.fillRect(0, 0, W, H);
    if (img) { const k = Math.max(W / img.width, H / img.height); g.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k); }
    const fall = g.createLinearGradient(0, H * 0.35, 0, H); fall.addColorStop(0, "rgba(0,0,0,0)"); fall.addColorStop(1, "rgba(0,0,0,0.82)"); g.fillStyle = fall; g.fillRect(0, 0, W, H);
    const t = fit(g, p.headline, 850, SANS, [84, 76, 68, 60, 54], 5);
    let y = H - 150 - (t.l.length - 1) * t.size * 1.08;
    g.font = `800 30px ${SANS}`; g.fillStyle = soft; g.fillText(p.place.toUpperCase(), PAD, y - t.size - 18);
    g.font = `850 ${t.size}px ${SANS}`; g.fillStyle = "white"; for (const l of t.l) { g.fillText(l, PAD, y); y += t.size * 1.08; }
    dots(g, 0, "white", "rgba(255,255,255,.4)");
  });
  // one sentence per slide, large, on paper
  for (const [i, s] of p.sentences.entries()) await page(g => {
    g.fillStyle = i % 2 ? soft : paper; g.fillRect(0, 0, W, H);
    const t = fit(g, s, 600, SERIF, [62, 56, 50, 46, 42], 11);
    // the sentence sits a little above the middle, the quote mark just over it
    let y = Math.max(400, (H - t.l.length * t.size * 1.32) / 2 + t.size * 0.6);
    g.font = `900 220px ${SERIF}`; g.fillStyle = mint; g.fillText("“", PAD - 12, y - t.size - 20);
    g.font = `600 ${t.size}px ${SERIF}`; g.fillStyle = ink; for (const l of t.l) { g.fillText(l, PAD, y); y += t.size * 1.32; }
    dots(g, i + 1, mint, muted);
  });
  // where to read it
  await page(g => {
    g.fillStyle = mint; g.fillRect(0, 0, W, H);
    g.font = `850 76px ${SANS}`; g.fillStyle = "white"; let y = 470; for (const l of lines(g, "Der ganze Text, mit allen Quellen:", W - PAD * 2)) { g.fillText(l, PAD, y); y += 86; }
    g.font = `700 44px ${SANS}`; for (const l of lines(g, p.url.replace(/^https?:\/\//, ""), W - PAD * 2)) { g.fillText(l, PAD, y + 40); y += 54; }
    g.font = `700 36px ${SANS}`; g.fillStyle = soft; g.fillText(p.byline, PAD, H - 140);
    dots(g, n - 1, "white", "rgba(255,255,255,.45)");
  });
  img?.close?.();
  return out;
}
