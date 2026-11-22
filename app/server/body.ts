// A body read that cannot grow past a limit. Content-Length is only a hint (absent on chunked bodies, and a client
// can lie), so the bytes are counted as they arrive and the read stops the moment the limit is crossed.
export class TooLarge extends Error {}

export async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new TooLarge();
  if (!req.body) return new Uint8Array();
  const parts: Uint8Array[] = []; let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => {}); throw new TooLarge(); }
    parts.push(value);
  }
  const out = new Uint8Array(size); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** The request's fields, JSON or form, or `{}` when the body is unreadable. Throws TooLarge past `max`. */
export async function readFields(req: Request, max: number): Promise<Record<string, any>> {
  const bytes = await readBytes(req, max);
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("json")) { const v = JSON.parse(new TextDecoder().decode(bytes)); return v && typeof v === "object" ? v : {}; }
    return Object.fromEntries(await new Response(bytes, { headers: { "content-type": type } }).formData());
  } catch { return {}; }
}
