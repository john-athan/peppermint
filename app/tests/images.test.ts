// Pictures: sizes read from file headers, which picture a story gets (and which it never gets), logo links on a page,
// the photo credit from an article, the address guard on copies, and the cached portraits of people and places.
process.env.PEPPERMINT_DB = ":memory:";
import { test, expect, beforeAll } from "bun:test";
const { db, now, setSetting } = await import("../server/db");
const { imageSize, mediaKey, remember, fetchMedia } = await import("../server/media");
const { storyImage, iconLinks, entitiesFor } = await import("../server/images");
const { extract } = await import("../server/connectors/util");

const png = (w: number, h: number) => { const b = new Uint8Array(33); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);

test("sizes come from the file header", () => {
  expect(imageSize(png(1200, 675))).toEqual({ w: 1200, h: 675 });
  expect(imageSize(jpeg(1000, 1490))).toEqual({ w: 1000, h: 1490 });
  expect(imageSize(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 64, 0, 32, 0, 0]))).toEqual({ w: 64, h: 32 });
  expect(imageSize(new Uint8Array([0, 0, 1, 0, 2, 0, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 48, 48]))).toEqual({ w: 48, h: 48 });
  expect(imageSize(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
});

const OWNER = 401;
let src = 0, n = 0;
const fetched = (url: string, w: number, h: number) => {
  remember(OWNER, url);
  db.query("UPDATE media SET bytes = ?, mime = 'image/jpeg', w = ?, h = ? WHERE key = ?").run(jpeg(w, h), w, h, mediaKey(OWNER, url));
};
const item = (meta: object, kind = "merkur") => ({ meta: JSON.stringify(meta), kind, source_id: src });
const addItem = (image: string) => db.query("INSERT INTO items (owner_id, source_id, ext_id, title, published_at, fetched_at, meta) VALUES (?, ?, ?, 't', ?, ?, ?)").run(OWNER, src, `x${n++}`, now(), now(), JSON.stringify({ image }));

beforeAll(() => {
  db.query("INSERT INTO users (id, name, created_at) VALUES (?, 'me', ?)").run(OWNER, now());
  src = (db.query("INSERT INTO sources (id, owner_id, kind, name, created_at) VALUES (401, ?, 'merkur', 'merkur.de', ?) RETURNING id").get(OWNER, now()) as any).id;
  fetched("https://www.merkur.de/a/photo.jpg", 1200, 675);
  fetched("https://consumerrights.wiki/logo.png", 135, 135);
  fetched("https://calif.io/poster.jpg", 1000, 1490);
  fetched("https://art.example/show.jpg", 600, 600);
  fetched("https://site.example/share-card.jpg", 1200, 630);
  for (let i = 0; i < 3; i++) addItem("https://site.example/share-card.jpg");
});

test("a wide news photo runs across the card, with the credit from the article", () => {
  const im = storyImage(OWNER, [item({ image: "https://www.merkur.de/a/photo.jpg", credit: "© Peter Kneffel/dpa" })]);
  expect(im).toMatchObject({ shape: "wide", w: 1200, h: 675, credit: "© Peter Kneffel/dpa" });
  expect(im!.src).toBe(`/api/media/${mediaKey(OWNER, "https://www.merkur.de/a/photo.jpg")}`);
});

test("square artwork sits beside the text, a portrait poster waits for the reader, a 135 px file is dropped", () => {
  expect(storyImage(OWNER, [item({ image: "https://art.example/show.jpg" }, "podcast")])?.shape).toBe("square");
  expect(storyImage(OWNER, [item({ image: "https://calif.io/poster.jpg" }, "hackernews")])?.shape).toBe("tall");
  expect(storyImage(OWNER, [item({ image: "https://consumerrights.wiki/logo.png" }, "hackernews")])).toBeNull();
});

test("the same picture on three items of one source is a logo or stock card, never a story picture", () => {
  expect(storyImage(OWNER, [item({ image: "https://site.example/share-card.jpg" })])).toBeNull();
});

test("a picture not fetched yet is offered as pending (fetched on first view), a failed one is skipped, the switch turns pictures off", () => {
  const im = storyImage(OWNER, [item({ image: "https://www.merkur.de/a/not-yet.jpg" })]);
  expect(im).toMatchObject({ shape: "wide", pending: true, src: `/api/media/${mediaKey(OWNER, "https://www.merkur.de/a/not-yet.jpg")}` });
  expect(db.query("SELECT 1 AS ok FROM media WHERE key = ?").get(mediaKey(OWNER, "https://www.merkur.de/a/not-yet.jpg"))).toEqual({ ok: 1 });
  db.query("UPDATE media SET failed_at = ? WHERE key = ?").run(now(), mediaKey(OWNER, "https://www.merkur.de/a/not-yet.jpg"));
  expect(storyImage(OWNER, [item({ image: "https://www.merkur.de/a/not-yet.jpg" }), item({ image: "https://www.merkur.de/a/photo.jpg" })])?.w).toBe(1200);
  setSetting(OWNER, "images", false);
  expect(storyImage(OWNER, [item({ image: "https://www.merkur.de/a/photo.jpg" })])).toBeNull();
  setSetting(OWNER, "images", true);
});

test("logo links: largest declared first, unquoted attributes read, SVG skipped, favicon.ico last", () => {
  const html = `<link rel=apple-touch-icon-precomposed sizes=144x144 href=/icons/144.png><link rel="icon" sizes="16x16" href="/16.png">
    <link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="shortcut icon" href="https://cdn.example/fav.png" sizes="64x64">`;
  expect(iconLinks(html, "https://www.merkur.de/x")).toEqual(["https://www.merkur.de/icons/144.png", "https://cdn.example/fav.png", "https://www.merkur.de/16.png", "https://www.merkur.de/favicon.ico"]);
});

test("the article's share picture and its photo credit are read while extracting the text", async () => {
  const html = `<html lang=de><head><meta property=og:image content="/assets/images/funkturm.jpg"></head><body><article>
    <figure><img src=x><figcaption class=id-StoryElement-image-caption>40 Meter hoher Funkturm am Weitsee. ©&nbsp;Hauser</figcaption></figure>
    <p>${"Bayerns Mobilfunk wächst dynamisch. ".repeat(12)}</p></article></body></html>`;
  const r = await extract(html, { base: "https://www.merkur.de/bayern/a.html" });
  expect(r.image).toBe("https://www.merkur.de/assets/images/funkturm.jpg");
  expect(r.credit).toBe("© Hauser");
  expect(r.text).not.toContain("Funkturm am Weitsee");
});

test("copies are fetched with the address guard: a picture link into the server's own network is refused", async () => {
  expect(remember(OWNER, "http://127.0.0.1/admin.png")).toBeNull(); // https only
  remember(OWNER, "https://127.0.0.1/admin.png");
  expect(await fetchMedia(mediaKey(OWNER, "https://127.0.0.1/admin.png"))).toBeNull();
  expect((db.query("SELECT failed_at FROM media WHERE key = ?").get(mediaKey(OWNER, "https://127.0.0.1/admin.png")) as any).failed_at).toBeGreaterThan(0);
});

test("people and places come from the cache with a local copy; companies get a letter", async () => {
  db.query("INSERT INTO entities (name, lang, url, page, checked_at) VALUES ('Markus Söder', 'de', 'https://upload.wikimedia.org/s/330px-Soeder.jpg', 'https://de.wikipedia.org/wiki/Markus_S%C3%B6der', ?), ('München', 'de', NULL, NULL, ?), ('München', 'en', 'https://upload.wikimedia.org/m/330px-Muc.png', NULL, ?)").run(now(), now(), now());
  const e = await entitiesFor(OWNER, { people: ["Markus Söder"], places: ["München"], orgs: ["Nvidia"] }, "de", 0);
  expect(e.map(x => [x.name, x.kind, !!x.img])).toEqual([["Markus Söder", "person", true], ["München", "place", true], ["Nvidia", "org", false]]);
  expect(e[0].img).toBe(`/api/media/${mediaKey(OWNER, "https://upload.wikimedia.org/s/330px-Soeder.jpg")}`);
});
