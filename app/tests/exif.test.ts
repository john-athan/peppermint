import { expect, test } from "bun:test";
import { readExif } from "../shared/exif";

type Ent = { tag: number; type: number; count: number; data: number[] };

function jpeg(le: boolean, o: { lat: number[][]; latRef: string; lng: number[][]; lngRef: string; withApp0?: boolean; noExif?: boolean }): ArrayBuffer {
  const w16 = (n: number) => (le ? [n & 255, n >> 8] : [n >> 8, n & 255]);
  const w32 = (n: number) => (le ? [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255] : [(n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255]);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0)).concat(0);
  const rats = (r: number[][]) => r.flatMap(([a, b]) => [...w32(a), ...w32(b)]);
  const dt = ascii("2026:11:20 08:14:03");

  // layout: header 8, IFD0 (3 entries) at 8, Exif IFD, GPS IFD, then data area
  const ifdSize = (n: number) => 2 + n * 12 + 4;
  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(3);
  const gpsAt = exifAt + ifdSize(1);
  let dataAt = gpsAt + ifdSize(4);
  const blobs: number[] = [];
  const place = (bytes: number[]) => {
    const off = dataAt + blobs.length;
    blobs.push(...bytes);
    return off;
  };
  const entry = (e: Ent, inline: boolean) => {
    const head = [...w16(e.tag), ...w16(e.type), ...w32(e.count)];
    if (inline) return [...head, ...e.data, ...Array(4 - e.data.length).fill(0)];
    return [...head, ...w32(place(e.data))];
  };
  const ifd = (es: number[][]) => [...w16(es.length), ...es.flat(), ...w32(0)];

  const dtOff = place(dt);
  const latOff = place(rats(o.lat));
  const lngOff = place(rats(o.lng));
  const ifd0 = ifd([
    entry({ tag: 0x0112, type: 3, count: 1, data: w16(6) }, true),
    [...w16(0x8769), ...w16(4), ...w32(1), ...w32(exifAt)],
    [...w16(0x8825), ...w16(4), ...w32(1), ...w32(gpsAt)],
  ]);
  const exif = ifd([[...w16(0x9003), ...w16(2), ...w32(dt.length), ...w32(dtOff)]]);
  const gps = ifd([
    entry({ tag: 1, type: 2, count: 2, data: ascii(o.latRef) }, true),
    [...w16(2), ...w16(5), ...w32(3), ...w32(latOff)],
    entry({ tag: 3, type: 2, count: 2, data: ascii(o.lngRef) }, true),
    [...w16(4), ...w16(5), ...w32(3), ...w32(lngOff)],
  ]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(0x2a), ...w32(8), ...ifd0, ...exif, ...gps, ...blobs];
  const payload = [...ascii("Exif"), 0, ...tiff];
  const seg = (m: number, p: number[]) => [0xff, m, (p.length + 2) >> 8, (p.length + 2) & 255, ...p];
  const bytes = [
    0xff, 0xd8,
    ...(o.withApp0 ? seg(0xe0, [...ascii("JFIF"), 1, 1, 0, 0, 1, 0, 1, 0, 0]) : []),
    ...(o.noExif ? [] : seg(0xe1, payload.slice(0, 5).concat([0], tiff))),
    0xff, 0xda, 0, 2, 0xff, 0xd9,
  ];
  return new Uint8Array(bytes).buffer;
}

const munich = { lat: [[48, 1], [8, 1], [1464, 100]], latRef: "N", lng: [[11, 1], [34, 1], [318, 10]], lngRef: "E" };

for (const le of [true, false]) {
  test(`Munich, ${le ? "little" : "big"} endian`, () => {
    const m = readExif(jpeg(le, munich));
    expect(m.lat!).toBeCloseTo(48.1374, 4);
    expect(Math.abs(m.lat! - 48.1374)).toBeLessThan(1e-5);
    expect(Math.abs(m.lng! - 11.5755)).toBeLessThan(1e-5);
    expect(m.orientation).toBe(6);
    expect(m.takenAt).toBe(Date.UTC(2026, 10, 20, 8, 14, 3));
  });
}

test("south and west are negative", () => {
  const m = readExif(jpeg(true, { ...munich, latRef: "S", lngRef: "W" }));
  expect(m.lat!).toBeLessThan(-48.13);
  expect(m.lng!).toBeLessThan(-11.57);
});

test("APP0 before APP1 is skipped", () => {
  const m = readExif(jpeg(false, { ...munich, withApp0: true }));
  expect(m.orientation).toBe(6);
  expect(m.lat).not.toBeNull();
});

test("zero denominator gives null coordinates", () => {
  const m = readExif(jpeg(true, { ...munich, lat: [[48, 0], [7, 1], [1, 1]] }));
  expect(m.lat).toBeNull();
  expect(m.orientation).toBe(6);
});

test("both zero is null", () => {
  const z = [[0, 1], [0, 1], [0, 1]];
  const m = readExif(jpeg(true, { lat: z, latRef: "N", lng: z, lngRef: "E" }));
  expect(m.lat).toBeNull();
  expect(m.lng).toBeNull();
});

const nulls = { lat: null, lng: null, takenAt: null, orientation: null };

test("JPEG without APP1", () => {
  expect(readExif(jpeg(true, { ...munich, noExif: true }))).toEqual(nulls);
});

test("random bytes and empty input", () => {
  const r = new Uint8Array(500);
  for (let i = 0; i < r.length; i++) r[i] = (i * 73 + 11) & 255;
  expect(readExif(r.buffer)).toEqual(nulls);
  expect(readExif(new ArrayBuffer(0))).toEqual(nulls);
});

test("truncated files never throw", () => {
  const full = jpeg(true, munich);
  for (let n = 0; n < full.byteLength; n += 7) {
    const m = readExif(full.slice(0, n));
    expect(m).toBeDefined();
  }
  expect(readExif(full.slice(0, 40))).toEqual(nulls);
});

test("corrupted bytes never throw", () => {
  const full = new Uint8Array(jpeg(true, munich));
  for (let i = 20; i < full.length; i++) {
    const c = full.slice();
    c[i] = 0xff;
    expect(readExif(c.buffer)).toBeDefined();
  }
});
