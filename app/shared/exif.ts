// Reads place, time and orientation from a JPEG's EXIF block, before the browser
// downscales the photo and drops all metadata. JPEG only, standard JS only, never throws.
// takenAt is the camera's local time read as written and treated as UTC.

export type PhotoMeta = { lat: number | null; lng: number | null; takenAt: number | null; orientation: number | null };

const MAX_ENTRIES = 500;
const SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

type Entry = { type: number; count: number; at: number };

export function readExif(buf: ArrayBuffer): PhotoMeta {
  const out: PhotoMeta = { lat: null, lng: null, takenAt: null, orientation: null };
  try {
    parse(buf, out);
  } catch {
    return { lat: null, lng: null, takenAt: null, orientation: null };
  }
  return out;
}

function parse(buf: ArrayBuffer, out: PhotoMeta): void {
  const v = new DataView(buf);
  const n = v.byteLength;
  if (n < 4 || v.getUint16(0) !== 0xffd8) return;
  let p = 2;
  while (p + 4 <= n) {
    if (v.getUint8(p) !== 0xff) return;
    const marker = v.getUint8(p + 1);
    if (marker === 0xff) { p++; continue; }
    if (marker === 0xda || marker === 0xd9) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) { p += 2; continue; }
    const len = v.getUint16(p + 2);
    if (len < 2) return;
    const start = p + 4;
    const end = p + 2 + len;
    if (end > n) return;
    if (marker === 0xe1 && end - start >= 6 && v.getUint32(start) === 0x45786966 && v.getUint16(start + 4) === 0) {
      tiff(v, start + 6, end, out);
      return;
    }
    p = end;
  }
}

function tiff(v: DataView, base: number, end: number, out: PhotoMeta): void {
  if (base + 8 > end) return;
  const o = v.getUint16(base);
  const le = o === 0x4949;
  if (!le && o !== 0x4d4d) return;
  if (v.getUint16(base + 2, le) !== 0x002a) return;
  const ok = (a: number, len: number) => a >= base && a + len <= end;
  const u16 = (a: number) => (ok(a, 2) ? v.getUint16(a, le) : null);
  const u32 = (a: number) => (ok(a, 4) ? v.getUint32(a, le) : null);

  const ifd = (off: number): Map<number, Entry> => {
    const m = new Map<number, Entry>();
    const a = base + off;
    const cnt = u16(a);
    if (cnt === null) return m;
    for (let i = 0; i < Math.min(cnt, MAX_ENTRIES); i++) {
      const e = a + 2 + i * 12;
      if (!ok(e, 12)) break;
      const tag = v.getUint16(e, le);
      const type = v.getUint16(e + 2, le);
      const count = v.getUint32(e + 4, le);
      const size = SIZES[type];
      if (!size) continue;
      const total = size * count;
      if (!Number.isFinite(total) || total > end - base) continue;
      const at = total <= 4 ? e + 8 : base + v.getUint32(e + 8, le);
      if (!ok(at, total)) continue;
      m.set(tag, { type, count, at });
    }
    return m;
  };
  const short = (e?: Entry) => (e && e.type === 3 && e.count >= 1 ? v.getUint16(e.at, le) : null);
  const long = (e?: Entry) => (e && e.type === 4 && e.count === 1 ? v.getUint32(e.at, le) : null);
  const ascii = (e?: Entry) => {
    if (!e || e.type !== 2) return null;
    let s = "";
    for (let i = 0; i < e.count; i++) {
      const c = v.getUint8(e.at + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };
  const rats = (e?: Entry): number | null => {
    if (!e || e.type !== 5 || e.count !== 3) return null;
    const r: number[] = [];
    for (let i = 0; i < 3; i++) {
      const num = v.getUint32(e.at + i * 8, le);
      const den = v.getUint32(e.at + i * 8 + 4, le);
      if (den === 0) return null;
      r.push(num / den);
    }
    return r[0] + r[1] / 60 + r[2] / 3600;
  };

  const first = u32(base + 4);
  if (first === null) return;
  const i0 = ifd(first);
  const ori = short(i0.get(0x0112));
  if (ori !== null && ori >= 1 && ori <= 8) out.orientation = ori;

  let dt: string | null = null;
  const exifOff = long(i0.get(0x8769));
  if (exifOff !== null) dt = ascii(ifd(exifOff).get(0x9003));
  if (!dt) dt = ascii(i0.get(0x0132));
  const mt = dt && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dt);
  if (mt) {
    const t = Date.UTC(+mt[1], +mt[2] - 1, +mt[3], +mt[4], +mt[5], +mt[6]);
    if (Number.isFinite(t)) out.takenAt = t;
  }

  const gpsOff = long(i0.get(0x8825));
  if (gpsOff !== null) {
    const g = ifd(gpsOff);
    let lat = rats(g.get(2));
    let lng = rats(g.get(4));
    const latRef = ascii(g.get(1));
    const lngRef = ascii(g.get(3));
    if (lat !== null && lng !== null && latRef && lngRef) {
      if (latRef[0] === "S") lat = -lat;
      if (lngRef[0] === "W") lng = -lng;
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)) {
        out.lat = lat;
        out.lng = lng;
      }
    }
  }
}
