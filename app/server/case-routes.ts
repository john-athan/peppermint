// HTTP routes for investigations, the editor's desk, the writer's voice and profile, and push notifications.
// main.ts hands its route() here; every route is owner-scoped like the rest of /api.
import { db, json, now, setting, setSetting } from "./db";
import * as inv from "./investigate";
import * as desk from "./desk";
import { getDraft } from "./studio";
import { devices, notify, publicKey, subscribe, unsubscribe } from "./notify";
import { send, validAddress } from "./mail";
import { jmapConfigured, repliesSince, replyAddress } from "./jmap";
import type { CaseContact } from "../shared/types";

type Ctx = { req: Request; url: URL; owner: number | null; params: Record<string, string> };
type Route = (method: string, path: string, h: (c: Ctx) => Response | Promise<Response>, open?: boolean) => void;
const J = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (e: unknown) => e instanceof inv.CaseError || e instanceof desk.DeskError ? J({ error: e.message }, e.status) : J({ error: `That did not work: ${String((e as Error)?.message ?? e).slice(0, 200)}` }, 502);
const body = async (req: Request) => { try { const j = await req.json(); return (j && typeof j === "object" && !Array.isArray(j) ? j : {}) as any; } catch { return {}; } };
const wrap = (f: (c: Ctx & { owner: number }) => unknown | Promise<unknown>) => async (c: Ctx) => { try { const r = await f(c as Ctx & { owner: number }); return r instanceof Response ? r : J(r); } catch (e) { return fail(e); } };

/** Width and height from a JPEG's frame header; null when the bytes are no JPEG. */
export function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
    i += 2 + len;
  }
  return null;
}

export function caseRoutes(route: Route, origin: string) {
  /* investigations */
  route("GET", "/api/cases", wrap(({ owner }) => ({ cases: inv.listCases(owner), devices: devices(owner) })));
  route("GET", "/api/cases/today", wrap(({ owner }) => ({ cases: inv.todayCases(owner) })));
  route("POST", "/api/cases", wrap(async ({ req, owner }) => {
    let f: FormData; try { f = await req.formData(); } catch { throw new inv.CaseError(400, "Send the photos as a form."); }
    const photos: inv.NewPhoto[] = [];
    const taken = f.getAll("taken_at").map(Number);
    for (const [i, x] of f.getAll("photo").entries()) {
      if (!(x instanceof Blob)) continue;
      if (x.size > 4_000_000) throw new inv.CaseError(413, "A photo is larger than 4 MB.");
      const bytes = new Uint8Array(await x.arrayBuffer());
      const size = jpegSize(bytes); if (!size) throw new inv.CaseError(400, "Photos must be JPEG.");
      photos.push({ bytes, mime: "image/jpeg", ...size, taken_at: Number.isFinite(taken[i]) && taken[i] > 0 ? taken[i] : null });
    }
    const n = (k: string) => { const v = Number(f.get(k)); return f.get(k) != null && f.get(k) !== "" && Number.isFinite(v) ? v : null; };
    const lat = n("lat"), lng = n("lng");
    return { case: inv.createCase(owner, { note: String(f.get("note") ?? ""), since: String(f.get("since") ?? "") || null,
      lat: lat != null && Math.abs(lat) <= 90 ? lat : null, lng: lng != null && Math.abs(lng) <= 180 ? lng : null, photos }) };
  }));
  route("GET", "/api/place", wrap(async ({ url }) => {
    const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new inv.CaseError(400, "No valid location.");
    return { place: await inv.reverseGeocode(lat, lng) };
  }));
  route("GET", "/api/cases/:id", wrap(({ owner, params }) => ({ case: inv.getCase(owner, Number(params.id)), devices: devices(owner), mailbox: jmapConfigured() })));
  route("POST", "/api/cases/:id/answer", wrap(async ({ req, owner, params }) => { const b = await body(req); return { case: inv.answer(owner, Number(params.id), String(b.qid ?? ""), String(b.answer ?? "")) }; }));
  route("POST", "/api/cases/:id/angle", wrap(async ({ req, owner, params }) => ({ case: inv.pickAngle(owner, Number(params.id), String((await body(req)).pick ?? "")) })));
  route("POST", "/api/cases/:id/anyway", wrap(async ({ req, owner, params }) => ({ case: inv.writeAnyway(owner, Number(params.id), !!(await body(req)).short) })));
  route("POST", "/api/cases/:id/retry", wrap(({ owner, params }) => ({ case: inv.retry(owner, Number(params.id)) })));
  route("POST", "/api/cases/:id/drop", wrap(({ owner, params }) => inv.drop(owner, Number(params.id))));
  route("POST", "/api/cases/:id/watch", wrap(({ owner, params }) => ({ case: inv.watch(owner, Number(params.id)) })));
  route("PUT", "/api/cases/:id/contacts/:cid", wrap(async ({ req, owner, params }) => { inv.setContact(owner, Number(params.id), params.cid, await body(req)); return { case: inv.getCase(owner, Number(params.id)) }; }));
  route("POST", "/api/cases/:id/contacts/:cid/send", wrap(async ({ req, owner, params }) => {
    const id = Number(params.id);
    const { c, cs } = inv.setContact(owner, id, params.cid, await body(req));
    if (!validAddress(c.to)) throw new inv.CaseError(400, "Add the address to send the question to.");
    if (c.sent_at) throw new inv.CaseError(409, "This question was sent already.");
    const prof = desk.profile(owner);
    const token = `case-${id}-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const replyTo = replyAddress(token) ?? (prof.email || undefined);
    const from = process.env.PEPPERMINT_MAIL_FROM ?? `peppermint@${new URL(origin).hostname.split(".").slice(-2).join(".")}`;
    const sig = [prof.name, prof.email].filter(Boolean).join("\n");
    const text = `${c.question}${sig ? `\n\n${sig}` : ""}`;
    if (process.env.PEPPERMINT_NO_MAIL !== "1")
      await send({ from, fromName: prof.name ? `${prof.name} via peppermint` : undefined, replyTo, to: c.to, subject: c.subject || "Eine Frage", text,
        html: `<div style="font:15px/1.55 system-ui,sans-serif;white-space:pre-wrap">${text.replace(/[&<>]/g, x => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[x]!)}</div>` });
    const next = cs.map((x: CaseContact) => x.id === c.id ? { ...x, sent_at: now(), token } : x);
    db.query("UPDATE investigations SET contacts = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(next), now(), id);
    // the address is remembered for the next question to the same office
    setSetting(owner, "contacts", { ...setting<Record<string, string>>(owner, "contacts", {}), [c.name.toLowerCase()]: c.to });
    return { case: inv.getCase(owner, id), replies: !!replyAddress(token) && jmapConfigured() };
  }));
  route("POST", "/api/cases/:id/reply", wrap(async ({ req, owner, params }) => { const b = await body(req); return { case: await inv.addReply(owner, Number(params.id), b.cid ? String(b.cid) : null, String(b.text ?? "")) }; }));
  route("POST", "/api/cases/:id/update/apply", wrap(({ owner, params }) => inv.applyUpdate(owner, Number(params.id))));
  route("POST", "/api/cases/:id/update/skip", wrap(({ owner, params }) => inv.skipUpdate(owner, Number(params.id))));

  /* photos */
  route("GET", "/api/photos/:id", ({ url, owner, params }) => {
    const p = desk.photo(owner!, Number(params.id), url.searchParams.get("v") === "public" ? "public" : "orig");
    return p ? new Response(p.bytes, { headers: { "content-type": p.mime, "cache-control": "private, max-age=300" } }) : J({ error: "Photo not found." }, 404);
  });
  route("PATCH", "/api/photos/:id", wrap(async ({ req, owner, params }) => { desk.patchPhoto(owner, Number(params.id), await body(req)); return { ok: true }; }));
  route("PUT", "/api/photos/:id/public", wrap(async ({ req, owner, params }) => { desk.setPublicPhoto(owner, Number(params.id), new Uint8Array(await req.arrayBuffer())); return { ok: true }; }));

  /* the desk around a draft */
  route("GET", "/api/drafts/:id/desk", wrap(({ owner, params }) => {
    const d = getDraft(owner, Number(params.id)); if (!d) throw new desk.DeskError(404, "Draft not found.");
    const c = d.investigation_id ? (() => { try { return inv.getCase(owner, d.investigation_id!); } catch { return null; } })() : null;
    const ph = d.meta?.photo ? c?.photos.find(p => p.id === d.meta!.photo) ?? (() => { const r = db.query("SELECT id, w, h, faces, blur, alt, caption, focal, taken_at, public_bytes IS NOT NULL AS pub FROM photos WHERE id = ? AND owner_id = ?").get(d.meta!.photo, owner) as any; return r ? { id: r.id, w: r.w, h: r.h, faces: json(r.faces, []), blur: !!r.blur, alt: r.alt, caption: r.caption, focal: json(r.focal, { x: .5, y: .5 }), public: !!r.pub, taken_at: r.taken_at } : null; })() : null;
    const prof = desk.profile(owner);
    return { checks: desk.checks(owner, d), versions: desk.versions(owner, d.id), stats: desk.stats(owner, d.id), readers: desk.readerNotes(owner, d.id), corrections: desk.corrections(owner, d.id),
      profile: prof, missing: desk.imprintMissing(prof), photo: ph, case: c ? { id: c.id, title: c.title, evidence: c.evidence, contacts: c.contacts, angles: c.angles, angle: c.angle, update: c.update, place: c.place, photos: c.photos } : null,
      url: d.slug && prof.handle ? `${origin}/@${prof.handle}/${d.slug}` : null, devices: devices(owner) };
  }));
  route("POST", "/api/drafts/:id/versions/:vid/restore", wrap(({ owner, params }) => desk.restore(owner, Number(params.id), Number(params.vid))));
  route("POST", "/api/drafts/:id/rewrite", wrap(async ({ req, owner, params }) => desk.rewrite(owner, Number(params.id), String((await body(req)).how ?? ""))));
  route("POST", "/api/drafts/:id/ask", wrap(async ({ req, owner, params }) => desk.askDraft(owner, Number(params.id), String((await body(req)).q ?? ""))));
  route("POST", "/api/drafts/:id/question", wrap(async ({ req, owner, params }) => desk.asQuestion(owner, Number(params.id), String((await body(req)).block ?? ""))));
  route("POST", "/api/drafts/:id/weave", wrap(async ({ req, owner, params }) => { const b = await body(req); return desk.weave(owner, Number(params.id), Number(b.ev), b.after ? String(b.after) : null); }));
  route("PATCH", "/api/drafts/:id/meta", wrap(async ({ req, owner, params }) => desk.patchMeta(owner, Number(params.id), await body(req))));
  route("POST", "/api/drafts/:id/publish", wrap(async ({ req, owner, params }) => { const b = await body(req); return desk.publish(owner, Number(params.id), { at: Number(b.at) || null, origin }); }));
  route("POST", "/api/drafts/:id/unpublish", wrap(({ owner, params }) => desk.unpublish(owner, Number(params.id))));
  route("POST", "/api/drafts/:id/preview-link", wrap(({ owner, params }) => desk.previewLink(owner, Number(params.id), origin)));
  route("POST", "/api/drafts/:id/corrections", wrap(async ({ req, owner, params }) => { const b = await body(req); return { corrections: desk.addCorrection(owner, Number(params.id), String(b.text ?? ""), Number(b.note) || undefined) }; }));
  route("POST", "/api/reader-notes/:id/done", wrap(({ owner, params }) => { desk.doneNote(owner, Number(params.id)); return { ok: true }; }));

  /* voice and profile */
  route("GET", "/api/writer", wrap(({ owner }) => ({ voice: desk.voice(owner), profile: desk.profile(owner), published: (db.query("SELECT count(*) AS n FROM drafts WHERE owner_id = ? AND status = 'published'").get(owner) as { n: number }).n, origin })));
  route("PUT", "/api/writer", wrap(async ({ req, owner }) => ({ voice: desk.setVoice(owner, await body(req)) })));
  route("POST", "/api/writer/learn", wrap(async ({ owner }) => ({ voice: await desk.learnVoice(owner) })));
  route("POST", "/api/writer/try", wrap(async ({ req, owner }) => desk.tryVoice(owner, String((await body(req)).text ?? ""))));
  route("PUT", "/api/profile", wrap(async ({ req, owner }) => { const p = desk.setProfile(owner, await body(req)); return { profile: p, missing: desk.imprintMissing(p) }; }));

  /* push */
  route("GET", "/api/push/key", wrap(async ({ owner }) => ({ key: await publicKey(), devices: devices(owner) })));
  route("POST", "/api/push/subscribe", wrap(async ({ req, owner }) => { const b = await body(req); subscribe(owner, b.sub, String(b.label ?? "This device")); return { devices: devices(owner) }; }));
  route("POST", "/api/push/unsubscribe", wrap(async ({ req, owner }) => { unsubscribe(owner, String((await body(req)).endpoint ?? "")); return { devices: devices(owner) }; }));
  route("POST", "/api/push/test", wrap(async ({ owner }) => ({ via: await notify(owner, { title: "Notifications are on", body: "peppermint tells you here when a piece is ready.", url: "/studio", tag: "test" }) })));
}

/** The scheduler's part for investigations: resume and watch cases, publish what is due, read answers by mail. */
let lastMail = 0;
export async function caseTick(owners: number[], origin: string) {
  for (const o of owners) await inv.caseTick(o).catch(e => console.error("cases", (e as Error).message));
  await desk.publishDue(origin).catch(() => {});
  if (jmapConfigured() && Date.now() - lastMail > 5 * 60_000) {
    const since = lastMail || Date.now() - 3 * 86400_000; lastMail = Date.now();
    try {
      for (const r of await repliesSince(since - 60_000)) {
        const m = /^case-(\d+)-/.exec(r.token); if (!m) continue;
        const row = db.query("SELECT owner_id, contacts FROM investigations WHERE id = ?").get(Number(m[1])) as { owner_id: number; contacts: string } | null;
        if (!row) continue;
        const c = json<(CaseContact & { token?: string })[]>(row.contacts, []).find(x => x.token === r.token);
        if (!c || c.replied_at) continue;
        await inv.addReply(row.owner_id, Number(m[1]), c.id, r.text, r.fromName ?? r.from);
      }
    } catch (e) { console.error("replies", (e as Error).message); }
  }
}
