// Photos for an investigation, prepared on the device: where and when they were taken is read first (shared/exif.ts),
// then each is drawn upright onto a canvas at most 1568 px wide (what Claude reads at full detail) and saved as JPEG,
// which drops every bit of metadata. The public copy is made here too, from the private one: every face and plate
// Claude found is covered by a coarse mosaic that is smoothed out, so nothing behind it can be recovered.
import { readExif } from "../../shared/exif";
import type { Box } from "../../shared/types";
import { getBlob } from "./api";

export type Prepared = { blob: Blob; w: number; h: number; url: string; takenAt: number | null; lat: number | null; lng: number | null };
const MAX = 1568;

const toBlob = (c: HTMLCanvasElement, q = 0.86) => new Promise<Blob>((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("This browser could not save the photo.")), "image/jpeg", q));
async function bitmap(src: Blob) {
  try { return await createImageBitmap(src, { imageOrientation: "from-image" } as ImageBitmapOptions); }
  catch { throw new Error("This photo format cannot be read here. Take a new photo or pick a JPEG."); }
}

export async function prepare(file: File): Promise<Prepared> {
  const meta = readExif(await file.slice(0, 512 * 1024).arrayBuffer());
  const bmp = await bitmap(file);
  const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const blob = await toBlob(c);
  // a photo's own clock is local time written as if UTC; the file's date is the next best thing
  const takenAt = meta.takenAt ? meta.takenAt + new Date(meta.takenAt).getTimezoneOffset() * 60_000 : file.lastModified || null;
  return { blob, w: c.width, h: c.height, url: URL.createObjectURL(blob), takenAt, lat: meta.lat, lng: meta.lng };
}

/** The public copy: the given boxes hidden under a smoothed mosaic, nothing else changed. */
export async function blurred(src: string, boxes: Box[]): Promise<Blob> {
  const blob = await getBlob(src);
  const bmp = await bitmap(blob);
  const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
  const g = c.getContext("2d")!; g.drawImage(bmp, 0, 0);
  for (const b of boxes) {
    const x = Math.round(b.x * c.width), y = Math.round(b.y * c.height), w = Math.max(4, Math.round(b.w * c.width)), h = Math.max(4, Math.round(b.h * c.height));
    // down to a handful of cells, then back up smoothed: a face becomes a soft patch of its own colours
    const cells = document.createElement("canvas"); cells.width = Math.max(2, Math.round(w / 22)); cells.height = Math.max(2, Math.round(h / 22));
    const cg = cells.getContext("2d")!; cg.imageSmoothingEnabled = true; cg.drawImage(c, x, y, w, h, 0, 0, cells.width, cells.height);
    g.save(); g.beginPath(); g.roundRect(x, y, w, h, Math.min(w, h) / 3); g.clip();
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(cells, 0, 0, cells.width, cells.height, x, y, w, h);
    g.restore();
  }
  bmp.close?.();
  return toBlob(c, 0.88);
}

/** Where a crop of the given shape sits on a photo, centred on the focal point as far as the edges allow (fractions). */
export function crop(w: number, h: number, ratio: number, focal: { x: number; y: number }) {
  const cw = Math.min(1, (h * ratio) / w), ch = Math.min(1, w / ratio / h);
  return { x: Math.max(0, Math.min(1 - cw, focal.x - cw / 2)), y: Math.max(0, Math.min(1 - ch, focal.y - ch / 2)), w: cw, h: ch };
}

/** Where the phone is, if the person allows it; null after a few seconds or on refusal. */
export function here(timeout = 6000): Promise<{ lat: number; lng: number } | null> {
  if (!("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise(res => {
    const t = setTimeout(() => res(null), timeout + 500);
    navigator.geolocation.getCurrentPosition(p => { clearTimeout(t); res({ lat: p.coords.latitude, lng: p.coords.longitude }); }, () => { clearTimeout(t); res(null); }, { enableHighAccuracy: true, timeout, maximumAge: 120_000 });
  });
}
