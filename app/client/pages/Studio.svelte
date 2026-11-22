<script lang="ts">
  import Loading from "../components/Loading.svelte";
  import Link from "../components/Link.svelte";
  // Studio: write with the harvest beside you. Blocks are edited in place and saved as you type;
  // Claude streams a next paragraph on request and steeps the whole draft into other forms live.
  import { tick } from "svelte";
  import { app, go, toast } from "../lib/state.svelte";
  import { api, ApiError, sse } from "../lib/api";
  import { I } from "../lib/icons";
  import { ago } from "../lib/format";
  import { hasKeys } from "../lib/keys";
  import Fav from "../components/Fav.svelte";
  import Mark from "../components/Mark.svelte";
  import Sheet from "../components/Sheet.svelte";
  import ChartView from "../components/Chart.svelte";
  import { normalize } from "../../shared/chart";
  import PublishSheet from "../components/PublishSheet.svelte";
  import PhotoSheet from "../components/PhotoSheet.svelte";
  import AskBar from "../components/AskBar.svelte";
  import { openCapture } from "../lib/capture.svelte";
  import { blurred } from "../lib/photo";
  import type { Angle, Block, CaseContact, CasePhoto, CaseUpdate, Draft, DraftVersion, EditorNote, Evidence, PieceStats, Place, Profile, ReaderNote } from "../../shared/types";

  let { id = null }: { id?: number | null } = $props();
  type Pick = { story_id: number; title: string; source: string; kind: string; url: string | null; icon: string | null; atoms: { kind: string; text: string }[] };

  // ---- list ----
  let drafts = $state<{ id: number; title: string; words: number; status: string; updated_at: number; investigation_id: number | null; publish_at: number | null }[] | null>(null);
  let forms = $state<{ key: string; label: string }[]>([]);
  type CaseRow = { id: number; title: string; status: string; stage: string | null; steps: { label: string; done: boolean }[]; place: string; photo: number | null; found: number; open: number; draft_id: number | null; draft_status: string | null; update: boolean; angle_deadline: number | null; angles: number; updated_at: number };
  let cases = $state<CaseRow[]>([]);
  async function loadList() {
    const [r, c] = await Promise.all([api("/api/drafts"), api<{ cases: CaseRow[] }>("/api/cases").catch(() => ({ cases: [] }))]);
    drafts = r.drafts; forms = r.forms; cases = c.cases;
  }
  // a running case moves on while the list is open
  $effect(() => { if (id == null && cases.some(c => c.status === "running")) { const t = setTimeout(() => loadList().catch(() => {}), 3000); return () => clearTimeout(t); } });
  async function create(story_id?: number) {
    const d = await api("/api/drafts", { method: "POST", json: story_id ? { story_id } : {} });
    go(`/studio/${d.id}`);
  }
  async function remove(did: number) {
    const r = await api(`/api/drafts/${did}`, { method: "DELETE" }); drafts = r.drafts;
    toast("Draft deleted.");
  }

  // ---- editor ----
  let draft = $state<Draft | null>(null), missing = $state(""), saveState = $state<"saved" | "saving" | "unsaved" | "error">("saved");
  let focused = $state<string | null>(null);
  $effect(() => {
    const did = id;
    if (did == null) { draft = null; loadList().catch(() => {}); return; }
    draft = null; missing = ""; ghost = null; preview = ""; wire = [];
    desk = null; rail = "trace";
    api(`/api/drafts/${did}`).then(d => { draft = d; if (!forms.length) api("/api/drafts").then(r => (forms = r.forms)); if (!d.investigation_id) queueMicrotask(() => focusBlock(d.blocks.find((b: Block) => !b.text)?.id ?? d.blocks[0]?.id, true)); runPreview(); loadDesk(); })
      .catch(e => (missing = e.message));
    return () => { flush(); stopPv?.(); stopGhost?.(); };
  });

  let saveT: ReturnType<typeof setTimeout> | undefined, inflight: Promise<void> | null = null;
  function changed() { saveState = "unsaved"; clearTimeout(saveT); saveT = setTimeout(save, 700); }
  async function save() {
    if (!draft) return;
    if (inflight) await inflight;
    clearTimeout(saveT);
    const d = draft; saveState = "saving";
    inflight = (async () => {
      try {
        const r = await api(`/api/drafts/${d.id}`, { method: "PUT", json: { base: d.updated_at, blocks: d.blocks.map(b => ({ ...b })) } });
        if (draft?.id === r.id) { draft.updated_at = r.updated_at; draft.title = r.title; draft.status = r.status; }
        saveState = "saved"; schedulePreview(); deskSoon();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          const fresh = await api(`/api/drafts/${d.id}`); draft = fresh; saveState = "saved"; toast("This draft changed in another window. Showing the newer version.");
        } else saveState = "error";
      }
    })();
    await inflight; inflight = null;
  }
  async function flush() { if (saveState === "unsaved") await save(); }
  $effect(() => { const warn = (e: BeforeUnloadEvent) => { if (saveState === "unsaved" || saveState === "saving") e.preventDefault(); }; addEventListener("beforeunload", warn); return () => removeEventListener("beforeunload", warn); });

  const bid = () => Math.random().toString(36).slice(2, 10);
  const words = $derived(draft ? draft.blocks.reduce((n, b) => n + (b.type === "chart" ? 0 : b.text.match(/\S+/g)?.length ?? 0), 0) : 0);

  // ---- charts: a few lines of JSON, drawn live beside the writing ----
  const CHART_TEMPLATE = JSON.stringify({ title: "What the chart shows", unit: "%", data: { First: 42, Second: 27, Third: 18 }, source: "Where the numbers come from" }, null, 2);
  const chartOf = (b: Block) => normalize(b.text || "{}");
  function toChart(b: Block) { clearSlash(b); b.type = "chart"; if (!b.text.trim().startsWith("{")) b.text = CHART_TEMPLATE; changed(); requestAnimationFrame(() => (document.querySelector(`[data-chart="${b.id}"]`) as HTMLTextAreaElement | null)?.focus()); }
  async function chartFromNumbers(b: Block) {
    if (!draft) return;
    clearSlash(b); toast("Claude is reading the numbers in your draft…", { loading: true });
    try {
      await save();
      const r = await api(`/api/drafts/${draft.id}/chart`, { method: "POST", json: { after: prevId(b.id) ?? b.id } });
      if (!b.text.trim()) { b.type = "chart"; b.text = r.json; } else insertAfter(b.id, { id: bid(), type: "chart", text: r.json });
      changed(); toast("Chart drawn from your numbers. Edit the data below it.");
    } catch (e: any) { toast(e.message); }
  }

  // contenteditable stays the source of truth while typing; the block text follows it
  function editable(node: HTMLElement, b: Block) {
    node.textContent = b.text;
    return { update(nb: Block) { if (document.activeElement !== node && node.textContent !== nb.text) node.textContent = nb.text; } };
  }
  function onInput(b: Block, e: Event) {
    const el = e.currentTarget as HTMLElement; b.text = el.textContent ?? "";
    if (b.text === "/") { slashFor = b.id; slashSel = 0; } else if (slashFor === b.id && !b.text.startsWith("/")) slashFor = null;
    changed();
  }
  async function focusBlock(bid: string | undefined, end = false) {
    if (!bid) return;
    await tick();
    {
      const el = document.querySelector(`[data-blk="${bid}"]`) as HTMLElement | null; if (!el) return;
      el.focus();
      if (end) { const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = getSelection(); s?.removeAllRanges(); s?.addRange(r); }
    }
  }
  function caretAtEnd(el: HTMLElement) { const s = getSelection(); if (!s?.rangeCount) return false; const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setStart(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset); return r.toString().length === 0; }
  function caretAtStart(el: HTMLElement) { const s = getSelection(); if (!s?.rangeCount) return false; const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setEnd(s.getRangeAt(0).startContainer, s.getRangeAt(0).startOffset); return r.toString().length === 0; }
  function insertAfter(after: string | null, nb: Block) {
    if (!draft) return;
    const i = after ? draft.blocks.findIndex(b => b.id === after) : draft.blocks.length - 1;
    draft.blocks.splice(i + 1, 0, nb); changed(); focusBlock(nb.id, true);
  }
  function onKey(b: Block, e: KeyboardEvent) {
    const el = e.currentTarget as HTMLElement;
    if (slashFor === b.id && slashOpts.length) {
      if (e.key === "ArrowDown") { slashSel = (slashSel + 1) % slashOpts.length; e.preventDefault(); return; }
      if (e.key === "ArrowUp") { slashSel = (slashSel + slashOpts.length - 1) % slashOpts.length; e.preventDefault(); return; }
      if (e.key === "Enter") { e.preventDefault(); slashOpts[slashSel].run(b); return; }
      if (e.key === "Escape") { e.preventDefault(); slashFor = null; return; }
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "j") { e.preventDefault(); suggest(b.id); return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!caretAtEnd(el)) { // split the block at the caret
        const s = getSelection()!; const r = s.getRangeAt(0).cloneRange(); r.selectNodeContents(el); r.setStart(s.getRangeAt(0).endContainer, s.getRangeAt(0).endOffset);
        const tail = r.toString(); b.text = b.text.slice(0, b.text.length - tail.length); el.textContent = b.text;
        insertAfter(b.id, { id: bid(), type: b.type === "h" ? "p" : b.type, text: tail }); requestAnimationFrame(() => focusBlock(draft!.blocks[draft!.blocks.findIndex(x => x.id === b.id) + 1]?.id));
        return;
      }
      insertAfter(b.id, { id: bid(), type: "p", text: "" }); return;
    }
    if (e.key === "Backspace" && draft && caretAtStart(el) && getSelection()?.isCollapsed) {
      const i = draft.blocks.findIndex(x => x.id === b.id); if (i <= 0) return;
      e.preventDefault();
      const prev = draft.blocks[i - 1];
      if (prev.type === "q" || prev.type === "c") { if (!b.text) { draft.blocks.splice(i, 1); changed(); focusBlock(prev.id, true); } return; }
      const join = prev.text.length; prev.text += b.text; draft.blocks.splice(i, 1); changed();
      requestAnimationFrame(() => { const pe = document.querySelector(`[data-blk="${prev.id}"]`) as HTMLElement; if (!pe) return; pe.textContent = prev.text; pe.focus(); const t = pe.firstChild; if (t) { const r = document.createRange(); r.setStart(t, Math.min(join, t.textContent!.length)); r.collapse(true); getSelection()?.removeAllRanges(); getSelection()?.addRange(r); } });
    }
    if (e.key === "ArrowUp" && caretAtStart(el) && draft) { const i = draft.blocks.findIndex(x => x.id === b.id); if (i > 0) { e.preventDefault(); focusBlock(draft.blocks[i - 1].id, true); } }
    if (e.key === "ArrowDown" && caretAtEnd(el) && draft) { const i = draft.blocks.findIndex(x => x.id === b.id); if (i < draft.blocks.length - 1) { e.preventDefault(); focusBlock(draft.blocks[i + 1].id); } }
  }
  function move(b: Block, d: -1 | 1) {
    if (!draft) return; const i = draft.blocks.findIndex(x => x.id === b.id), j = i + d;
    if (j < 0 || j >= draft.blocks.length) return;
    [draft.blocks[i], draft.blocks[j]] = [draft.blocks[j], draft.blocks[i]]; changed(); focusBlock(b.id, true);
  }
  function del(b: Block) {
    if (!draft) return; const i = draft.blocks.findIndex(x => x.id === b.id);
    draft.blocks.splice(i, 1); if (!draft.blocks.length) draft.blocks.push({ id: bid(), type: "p", text: "" });
    changed(); focusBlock(draft.blocks[Math.max(0, i - 1)].id, true);
  }
  function retype(b: Block, t: Block["type"]) {
    b.type = t; if (t !== "q") delete b.cite; slashFor = null;
    if (b.text.startsWith("/")) { b.text = b.text.slice(1); const el = document.querySelector(`[data-blk="${b.id}"]`); if (el) el.textContent = b.text; }
    changed(); focusBlock(b.id, true);
  }

  // ---- slash menu ----
  let slashFor = $state<string | null>(null), slashSel = $state(0);
  const slashOpts = $derived([
    { k: "H", label: "Heading", run: (b: Block) => retype(b, "h") },
    { k: "¶", label: "Paragraph", run: (b: Block) => retype(b, "p") },
    { k: "❝", label: "Quote from harvest", run: (b: Block) => { clearSlash(b); openPicker(b.id); } },
    { k: "!", label: "Claim note", run: (b: Block) => retype(b, "c") },
    { k: "▦", label: "Chart", run: (b: Block) => toChart(b) },
    ...(app.llm ? [{ k: "▤", label: "Chart from my numbers", run: (b: Block) => chartFromNumbers(b) }] : []),
    { k: "✦", label: "Suggest next paragraph", run: (b: Block) => { clearSlash(b); suggest(prevId(b.id)); } },
  ]);
  function clearSlash(b: Block) { b.text = b.text.replace(/^\//, ""); const el = document.querySelector(`[data-blk="${b.id}"]`); if (el) el.textContent = b.text; slashFor = null; changed(); }
  const prevId = (bid: string) => { const i = draft!.blocks.findIndex(x => x.id === bid); return draft!.blocks[Math.max(0, i - 1)].id; };

  // ---- quote picker ----
  let pickOpen = $state(false), pickFor = $state<string | null>(null), q = $state(""), picks = $state<Pick[] | null>(null);
  let qT: ReturnType<typeof setTimeout> | undefined;
  function openPicker(after: string | null) { pickFor = after; pickOpen = true; search(); }
  function search() { clearTimeout(qT); qT = setTimeout(async () => { picks = (await api(`/api/atoms?q=${encodeURIComponent(q)}`)).stories; }, 160); }
  function pickAtom(p: Pick, a: { kind: string; text: string }) {
    if (!draft) return;
    const empty = pickFor ? draft.blocks.find(b => b.id === pickFor && !b.text && b.type === "p") : null;
    const nb: Block = a.kind === "claim" ? { id: bid(), type: "c", text: `${a.text.replace(/[\s.]*$/, ".")} Single source, not verified.` } : { id: bid(), type: "q", text: a.text, cite: { story_id: p.story_id, source: p.source, kind: p.kind, url: p.url, icon: p.icon } };
    if (empty) { const i = draft.blocks.indexOf(empty); draft.blocks[i] = nb; changed(); } else insertAfter(pickFor, nb);
    pickOpen = false; toast(a.kind === "claim" ? "Claim added, marked as unverified." : `Quote from ${p.source} added.`);
  }

  // ---- streams: suggestion (ghost) and preview, both shown raw on the wire ----
  let wire = $state<string[]>([]), events = $state(0);
  function sseTap(url: string, on: { delta: (t: string) => void; done?: () => void; error?: (d: any) => void }) {
    wire = [...wire.slice(-40), `GET ${url.replace(/^\/api/, "")}`];
    return sse(url, { delta: d => on.delta(d.t ?? ""), done: () => on.done?.(), error: d => on.error?.(d) },
      (type, id, data) => { events++; wire = [...wire.slice(-40), `${id ? `id:${id} ` : ""}${type} ${data}`]; });
  }

  let ghost = $state<{ after: string; text: string; nth: number; busy: boolean; error?: string } | null>(null), stopGhost: (() => void) | null = null;
  async function suggest(after: string, nth = 0) {
    if (!draft) return;
    await flush(); stopGhost?.();
    ghost = { after, text: "", nth, busy: true };
    stopGhost = sseTap(`/api/drafts/${draft.id}/suggest?after=${encodeURIComponent(after)}&nth=${nth}`, {
      delta: t => { if (ghost) ghost.text += t; },
      done: () => { if (ghost) ghost.busy = false; },
      error: d => { if (ghost) { ghost.busy = false; ghost.error = d.message; } },
    });
  }
  function acceptGhost() {
    if (!ghost || !draft) return;
    const g = ghost; stopGhost?.(); ghost = null;
    const at = draft.blocks.find(b => b.id === g.after);
    const next = draft.blocks[draft.blocks.findIndex(b => b.id === g.after) + 1];
    if (next && next.type === "p" && !next.text) { next.text = g.text.trim(); changed(); focusBlock(next.id, true); }
    else insertAfter(at?.id ?? null, { id: bid(), type: "p", text: g.text.trim() });
  }
  function onDocKey(e: KeyboardEvent) {
    if (!ghost || ghost.busy) return;
    if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); acceptGhost(); }
    if (e.key === "Escape") { e.preventDefault(); stopGhost?.(); ghost = null; }
  }

  let form = $state("linkedin"), preview = $state(""), pvBusy = $state(false), pvError = $state<{ code: string; message: string } | null>(null), stopPv: (() => void) | null = null;
  let pvT: ReturnType<typeof setTimeout> | undefined;
  function runPreview() {
    if (!draft) return; stopPv?.(); preview = ""; pvError = null;
    if (!words) { pvBusy = false; return; }
    pvBusy = true;
    stopPv = sseTap(`/api/drafts/${draft.id}/preview/${form}`, { delta: t => (preview += t), done: () => (pvBusy = false), error: d => { pvBusy = false; pvError = d; } });
  }
  function schedulePreview() { clearTimeout(pvT); pvT = setTimeout(runPreview, 1400); }
  const setForm = (f: string) => { form = f; runPreview(); };

  // ---- publish ----
  let pubOpen = $state(false);
  async function copyPreview() {
    try { await navigator.clipboard.writeText(preview.trim()); toast(`${forms.find(f => f.key === form)?.label} version copied.`); }
    catch { toast("Copying was blocked by the browser. Select the text in the preview instead."); }
  }
  async function share() {
    if (!(navigator as any).share) return copyPreview();
    try { await navigator.share({ title: draft?.title || "peppermint", text: preview.trim() }); } catch {}
  }
  async function markPublished(p: boolean) {
    if (!draft) return; await flush();
    const r = await api(`/api/drafts/${draft.id}`, { method: "PUT", json: { base: draft.updated_at, status: p ? "published" : "draft" } });
    draft.status = r.status; draft.updated_at = r.updated_at; draft.published_at = r.published_at; pubOpen = false;
    toast(p ? "Marked as published." : "Back to draft.");
  }
  // ---- the desk: checks, sources, notes, versions, photo, publishing, what came back ----
  type Desk = { checks: { key: string; ok: boolean; label: string; detail: string }[]; versions: DraftVersion[]; stats: PieceStats; readers: ReaderNote[];
    corrections: { id: number; kind: string; text: string; created_at: number }[]; profile: Profile; missing: string[]; photo: CasePhoto | null; url: string | null; devices: number;
    case: { id: number; title: string; evidence: Evidence[]; contacts: CaseContact[]; angles: Angle[]; angle: string | null; update: CaseUpdate | null; place: Place; photos: CasePhoto[] } | null };
  let desk = $state<Desk | null>(null), rail = $state<"trace" | "outline" | "versions" | "formats" | "live">("trace"), photoOpen = $state(false), publishOpen = $state(false);
  let working = $state<string | null>(null), showUpdate = $state(false), fixFor = $state<number | null>(null), fixText = $state("");
  let deskT: ReturnType<typeof setTimeout> | undefined;
  async function loadDesk() {
    if (!draft) return;
    try {
      desk = await api<Desk>(`/api/drafts/${draft.id}/desk`);
      if (desk.photo && !desk.photo.public) makePublic(desk.photo);
      if (draft.status === "published" && rail === "trace" && !draft.investigation_id) rail = "live";
      if (new URLSearchParams(location.search).has("update") && desk.case?.update) showUpdate = true;
    } catch {}
  }
  function deskSoon() { clearTimeout(deskT); deskT = setTimeout(loadDesk, 600); }
  // the public copy of the photo is made here, in the browser: faces blurred, metadata gone
  let making = false;
  async function makePublic(p: CasePhoto) {
    if (making) return; making = true;
    try { await api(`/api/photos/${p.id}/public`, { method: "PUT", body: await blurred(`/api/photos/${p.id}`, p.blur ? p.faces : []) }); p.public = true; deskSoon(); }
    catch (e) { console.warn("public photo", e); } finally { making = false; }
  }
  function adopt(d: Draft) { draft = d; for (const b of d.blocks) { const el = document.querySelector(`[data-blk="${b.id}"]`); if (el && el.textContent !== b.text && document.activeElement !== el) el.textContent = b.text; } deskSoon(); schedulePreview(); }
  async function act<T>(name: string, f: () => Promise<T>) { if (working) return; working = name; try { await flush(); return await f(); } catch (e) { toast((e as Error).message); } finally { working = null; } }
  const rewrite = (how: string) => act(how, async () => { adopt(await api(`/api/drafts/${draft!.id}/rewrite`, { method: "POST", json: { how } })); toast(({ shorter: "Shorter now. The old text is under Versions.", longer: "Longer now. The old text is under Versions.", plainer: "Plainer now. The old text is under Versions.", en: "In English now.", de: "Auf Deutsch." } as Record<string, string>)[how]); });
  const askDraft = (q: string) => act("ask", async () => { adopt(await api(`/api/drafts/${draft!.id}/ask`, { method: "POST", json: { q } })); });
  async function dropNote(n: EditorNote) {
    if (!draft) return;
    draft.meta = { ...draft.meta, notes: (draft.meta?.notes ?? []).filter(x => x.id !== n.id) };
    await api(`/api/drafts/${draft.id}/meta`, { method: "PATCH", json: { drop_notes: [n.id] } }).catch(() => {});
  }
  async function applyNote(n: EditorNote) {
    const b = draft?.blocks.find(x => x.id === n.block);
    if (b && n.fix !== null) {
      if (n.fix === "") del(b); else { b.text = n.fix; const el = document.querySelector(`[data-blk="${b.id}"]`); if (el) el.textContent = b.text; changed(); }
    }
    await dropNote(n);
  }
  function cycleHeadline() {
    const h = draft?.blocks.find(b => b.type === "h"); const list = draft?.meta?.headlines ?? []; if (!h || list.length < 2) return;
    h.text = list[(list.indexOf(h.text) + 1) % list.length]; const el = document.querySelector(`[data-blk="${h.id}"]`); if (el) el.textContent = h.text; changed();
  }
  async function claim(blockId: string, what: "cut" | "question") {
    const b = draft?.blocks.find(x => x.id === blockId); if (!b) return;
    if (what === "cut") { del(b); await save(); toast("Claim cut."); return; }
    await act("question", async () => { await save(); adopt(await api(`/api/drafts/${draft!.id}/question`, { method: "POST", json: { block: blockId } })); toast("Kept as an open question."); });
  }
  const weave = (ev: number) => act(`ev${ev}`, async () => { adopt(await api(`/api/drafts/${draft!.id}/weave`, { method: "POST", json: { ev, after: focused ?? draft!.blocks.at(-1)?.id } })); toast("Added from that source."); });
  const restore = (v: DraftVersion) => act(`v${v.id}`, async () => { adopt(await api(`/api/drafts/${draft!.id}/versions/${v.id}/restore`, { method: "POST" })); toast(`Back to "${v.label}". Where you were is a version too.`); });
  async function caseUpdate(apply: boolean) {
    if (!desk?.case) return;
    await act("update", async () => {
      await api(`/api/cases/${desk!.case!.id}/update/${apply ? "apply" : "skip"}`, { method: "POST" });
      showUpdate = false;
      if (apply) { adopt(await api(`/api/drafts/${draft!.id}`)); toast(draft?.status === "published" ? "Updated. The page shows a note that it changed." : "Updated."); } else { deskSoon(); toast("Skipped."); }
    });
  }
  async function correct(noteId: number | null) {
    await act("fix", async () => { const r = await api<{ corrections: Desk["corrections"] }>(`/api/drafts/${draft!.id}/corrections`, { method: "POST", json: { text: fixText, note: noteId } }); if (desk) desk.corrections = r.corrections; fixFor = null; fixText = ""; deskSoon(); toast("Correction noted on the page."); });
  }
  async function noteDone(n: ReaderNote) { await api(`/api/reader-notes/${n.id}/done`, { method: "POST" }).catch(() => {}); n.status = "done"; }
  const evBy = $derived(new Map((desk?.case?.evidence ?? []).map(e => [e.id, e])));
  const focusedBlock = $derived(draft?.blocks.find(b => b.id === focused) ?? null);
  const unused = $derived(desk?.case ? desk.case.evidence.filter(e => !["photo", "note", "answer"].includes(e.kind) && !draft?.blocks.some(b => b.ev?.includes(e.id))) : []);
  const notesFor = (bid: string) => (draft?.meta?.notes ?? []).filter(n => n.block === bid && n.kind === "edit");
  const answers = $derived((draft?.meta?.notes ?? []).filter(n => n.kind === "answer"));
  const openChecks = $derived(desk?.checks.filter(c => !c.ok && c.key !== "photo").length ?? 0);
  const asker = $derived(desk?.case?.contacts.find(c => !c.replied_at) ?? null);
  const angleLabel = $derived(desk?.case ? (desk.case.angles.find(a => a.key === (desk!.case!.angle ?? "a"))?.title ?? draft?.meta?.angle ?? "") : "");
  const lang = $derived(draft?.meta?.lang ?? "de");
  const when = (t: number) => new Date(t).toLocaleString("de-DE", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const sourced = $derived(draft ? draft.blocks.filter(b => b.type === "p" && b.text.trim()) : []);
  const backToList = (e: MouseEvent) => { e.preventDefault(); flush().then(() => go("/studio")); };
  const cards = $derived(app.edition?.cards.slice(0, 6) ?? []);
</script>

{#if id == null}
  <div class="page">
    <header class="appbar"><h1>Studio</h1><span class="sp"></span>
      <Link class="icon-btn" href="/studio/voice" aria-label="Your voice and your page">{@html I.quill}</Link>
      <button class="ghost sm nowrap" type="button" onclick={() => create()}>{@html I.plus}Draft</button>
      <button class="primary sm nowrap" type="button" onclick={() => openCapture()}>{@html I.camera}Investigate</button>
    </header>
    {#if cases.length}
      <div class="group-label">Investigations</div>
      <div class="case-list">
        {#each cases as c (c.id)}
          {@const at = c.steps.findIndex(s => !s.done)}
          <Link class="case-card {c.status}" href={c.status === "ready" && c.draft_id && !c.update ? `/studio/${c.draft_id}` : `/studio/case/${c.id}`} data-item>
            {#if c.photo}<img src="/api/photos/{c.photo}" alt="" />{:else}<span class="case-card-ph">{@html I.camera}</span>{/if}
            <span class="case-card-t">
              <small>{c.status === "running" ? (c.stage === "write" && c.angle_deadline && c.angle_deadline > Date.now() ? "Pick an angle" : "Investigating") : c.update ? "News for your piece" : c.status === "ready" ? (c.draft_status === "published" ? "Live" : "Ready to publish") : c.status === "quiet" ? "Not a story yet" : c.status === "error" ? "Stopped" : ""}{c.place ? ` · ${c.place}` : ""}</small>
              <b>{c.title || "New investigation"}</b>
              {#if c.status === "running"}
                <span class="case-bar" aria-label="{at < 0 ? c.steps.length : at} of {c.steps.length} steps"><i style:width="{(Math.max(0, at < 0 ? c.steps.length : at) + 0.5) / c.steps.length * 100}%"></i></span>
                <em>{c.steps[at]?.label ?? "Finishing"}{c.found ? ` · ${c.found} found` : ""}{c.open ? ` · ${c.open} ${c.open === 1 ? "question" : "questions"} for you` : ""}</em>
              {:else}<em>{ago(c.updated_at)}</em>{/if}
            </span>
          </Link>
        {/each}
      </div>
    {/if}
    {#if cards.length}
      <div class="group-label">Start from today's harvest</div>
      <div class="from-story">
        {#each cards as c (c.id)}
          <button type="button" data-item onclick={() => create(c.id)}><span class="stack">{#each c.sources.slice(0, 2) as s}<Fav kind={s.kind} name={s.name} size={18} src={s.icon} />{/each}</span><b>{c.title}</b><small>Headline, cited facts and claims ready</small></button>
        {/each}
      </div>
    {/if}
    <div class="group-label">Drafts</div>
    {#if drafts === null}
      <Loading />
    {:else if drafts.length}
      <div class="draft-list">
        {#each drafts as d (d.id)}
          <div class="draft-row">
            <Link href="/studio/{d.id}" data-item><b>{d.title}</b><small>{d.words} words · {ago(d.updated_at)}{d.status === "published" ? " · live" : d.publish_at ? " · scheduled" : ""}{d.investigation_id ? " · from an investigation" : ""}</small></Link>
            <button class="icon-btn" type="button" aria-label="Delete {d.title}" onclick={() => remove(d.id)}>{@html I.x}</button>
          </div>
        {/each}
      </div>
    {:else}
      <div class="empty"><Mark cls="anim" label="" /><b>No drafts yet</b><span>Investigate something you noticed, start from a story above, or with an empty page. Claude writes along when you ask.</span></div>
    {/if}
  </div>
{:else if missing}
  <div class="page"><div class="empty"><b>{app.online ? "Draft not found" : "Drafts need a connection"}</b><span>{missing}</span><button class="ghost" type="button" onclick={() => go("/studio")}>All drafts</button></div></div>
{:else if draft}
  <div class="page wide studio">
    <header class="appbar">
      <a class="back" href="/studio" onclick={backToList}>{@html I.back}Drafts</a><span class="sp"></span>
      {#if draft.status === "published"}<button class="case-pill ok" type="button" onclick={() => (rail = "live")}>{@html I.eye}Live</button>
      {:else if draft.publish_at}<span class="case-pill">{@html I.clock}{when(draft.publish_at)}</span>
      {:else if desk}<span class="case-pill" class:ok={!openChecks}>{openChecks ? `${openChecks} to decide` : "Ready"}</span>{/if}
      <button class="icon-btn" type="button" aria-label="Take it with you as a post" onclick={() => { pubOpen = true; if (!preview && !pvBusy) runPreview(); }}>{@html I.share}</button>
      <button class="primary sm" type="button" disabled={!desk} onclick={() => { flush(); publishOpen = true; }}>{draft.status === "published" ? "Published" : "Publish"}</button>
    </header>
    {#if desk?.case?.update}
      <div class="upd" role="region" aria-label="Update for your piece">
        <div class="upd-t"><b>{@html I.spark}Update for your piece</b><span>{desk.case.update.summary}</span>
          <small>{desk.case.update.add.length ? `+${desk.case.update.add.length} ${desk.case.update.add.length === 1 ? "paragraph" : "paragraphs"}` : ""}{desk.case.update.resolves.length ? ` · ${desk.case.update.resolves.length} claim now sourced` : ""}</small></div>
        {#if showUpdate}{#each desk.case.update.add as a}<p class="upd-add">{a.text}</p>{/each}{/if}
        <div class="upd-acts">
          <button class="ghost sm" type="button" onclick={() => (showUpdate = !showUpdate)}>{showUpdate ? "Hide change" : "See change"}</button>
          <button class="primary sm" type="button" disabled={!!working} onclick={() => caseUpdate(true)}>Update</button>
          <button class="link-btn" type="button" onclick={() => caseUpdate(false)}>Skip</button>
        </div>
      </div>
    {/if}
    <div class="studio-top">
      {#if ghost?.busy || pvBusy}<span class="sse-badge live"><i></i>Claude is writing</span>{/if}
      <span class="sse-badge">{words} words</span>
      <span class="sse-badge save-{saveState}">{draft.status === "published" ? "Published" : "Draft"} · {saveState === "saving" ? "saving" : saveState === "unsaved" ? "editing" : saveState === "error" ? "not saved" : "saved"}</span>
    </div>
    <div class="studio-grid">
      <div>
        <div class="doc" class:case-doc={!!draft.investigation_id} role="group" aria-label="Draft" onkeydown={onDocKey}>
          {#if desk?.photo}
            <button class="doc-hero" type="button" onclick={() => (photoOpen = true)} aria-label="Photo: blur, alt text, caption, crops">
              <img src="/api/photos/{desk.photo.id}{desk.photo.public ? "?v=public" : ""}" alt={desk.photo.alt} width={desk.photo.w} height={desk.photo.h} />
              <span class="doc-hero-tag">{@html I.check}{desk.photo.faces.length && desk.photo.blur ? `${desk.photo.faces.length} blurred` : "Ready"} · alt text {desk.photo.alt ? "✓" : "missing"}</span>
            </button>
          {/if}
          {#each draft.blocks as b, i (b.id)}
            <div class="blk-wrap" class:focus={focused === b.id}>
              {#if b.type === "chart"}
                {@const r = chartOf(b)}
                <div class="blk chart-blk">
                  {#if "chart" in r}<ChartView chart={r.chart} lang={app.lang} />{:else}<div class="chart-error" role="alert">{r.error}</div>{/if}
                  <label class="chart-json"><span>Chart data <small>JSON: "data" maps labels to numbers; "x" + "series" for several lines</small></span>
                    <textarea data-chart={b.id} rows={Math.min(16, b.text.split("\n").length + 1)} spellcheck="false" value={b.text} oninput={(e) => { b.text = e.currentTarget.value; changed(); }} onfocus={() => (focused = b.id)}
                      onblur={(e) => { try { const pretty = JSON.stringify(JSON.parse(b.text), null, 2); if (pretty !== b.text) { b.text = pretty; e.currentTarget.value = pretty; changed(); } } catch {} }}></textarea>
                  </label>
                </div>
              {:else if b.type === "q"}
                <div class="blk q"><div data-blk={b.id} contenteditable="true" spellcheck="true" role="textbox" aria-label="Quote" tabindex="0" use:editable={b} oninput={(e) => onInput(b, e)} onkeydown={(e) => onKey(b, e)} onfocus={() => (focused = b.id)}></div>
                  {#if b.cite}<div class="cite"><Fav kind={b.cite.kind} name={b.cite.source} size={16} src={b.cite.icon} />{b.cite.source} · from your harvest{#if b.cite.url}<a href={b.cite.url} target="_blank" rel="noopener" aria-label="Open source">{@html I.external}</a>{/if}</div>{/if}
                </div>
              {:else}
                {#if b.open}<span class="sup-dot s-open" title="An open question">?</span>{:else if b.ev?.length}<button class="sup-dot s-{b.support ?? "ok"}" type="button" aria-label="Sources of this paragraph" onclick={() => { focused = b.id; rail = "trace"; }}>{b.ev?.length ?? 0}</button>{/if}
                <div class="blk {b.type}" class:empty-blk={!b.text} data-ph={b.type === "h" ? "Headline" : b.type === "c" ? "What claim, and why is it unverified?" : i === draft.blocks.length - 1 ? hasKeys ? "Write, or type / for blocks. ⌘J asks Claude." : "Write, or type / for blocks." : ""} data-blk={b.id} contenteditable="true" spellcheck="true" role="textbox" aria-label={b.type === "h" ? "Heading" : b.type === "c" ? "Claim note" : "Paragraph"} tabindex="0" use:editable={b} oninput={(e) => onInput(b, e)} onkeydown={(e) => onKey(b, e)} onfocus={() => (focused = b.id)}></div>
              {/if}
              {#if b.type === "h" && i === 0 && (draft.meta?.headlines?.length ?? 0) > 1}
                <button class="link-btn hl-swap" type="button" onclick={cycleHeadline}>{@html I.swap}{draft.meta!.headlines!.length - 1} more headlines</button>
              {/if}
              {#if b.type === "c" && b.text.trim() && draft.investigation_id}
                <div class="claim-acts">
                  <span>Only {b.ev?.length ? "one weak source" : "an unconfirmed source"}.</span>
                  <button class="ghost sm" type="button" onclick={() => claim(b.id, "cut")}>Cut</button>
                  {#if asker && desk?.case}<Link class="ghost sm" href="/studio/case/{desk.case.id}">Ask {asker.name}</Link>{/if}
                  <button class="ghost sm" type="button" disabled={!!working} onclick={() => claim(b.id, "question")}>As a question</button>
                </div>
              {/if}
              {#each notesFor(b.id) as n (n.id)}
                <div class="ed-note"><b>Editor</b><span>{n.text}</span>{#if n.fix}<q>{n.fix}</q>{/if}
                  <span class="ed-acts"><button class="primary sm" type="button" onclick={() => applyNote(n)}>{n.fix === "" ? "Cut it" : "Apply"}</button><button class="ghost sm" type="button" onclick={() => dropNote(n)}>Keep mine</button></span></div>
              {/each}
              {#if focused === b.id}
                <div class="blk-tools" role="toolbar" aria-label="Block">
                  <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => suggest(b.id)} aria-label="Suggest a paragraph after this">{@html I.spark}</button>
                  <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => move(b, -1)} aria-label="Move up" disabled={i === 0}>{@html I.up}</button>
                  <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => move(b, 1)} aria-label="Move down" disabled={i === draft.blocks.length - 1}>{@html I.down}</button>
                  <button type="button" onmousedown={(e) => e.preventDefault()} onclick={() => del(b)} aria-label="Delete block">{@html I.x}</button>
                </div>
              {/if}
              {#if slashFor === b.id}
                <div class="slash" role="listbox" aria-label="Insert block">
                  {#each slashOpts as o, k}<button type="button" role="option" aria-selected={k === slashSel} onmousedown={(e) => e.preventDefault()} onclick={() => o.run(b)}><span>{o.k}</span>{o.label}</button>{/each}
                </div>
              {/if}
            </div>
            {#if ghost && ghost.after === b.id}
              <div class="ghost-wrap" aria-live="polite">
                <p class="blk p suggestion">{ghost.text}{#if ghost.busy}<span class="caret"></span>{/if}{#if ghost.error}<span class="ghost-err">{ghost.error}</span>{/if}</p>
                <div class="ghost-actions">
                  <button class="primary sm" type="button" disabled={ghost.busy || !ghost.text} onclick={acceptGhost}>Accept <kbd>Tab</kbd></button>
                  <button class="ghost sm" type="button" onclick={() => { stopGhost?.(); ghost = null; }}>Skip</button>
                  <button class="ghost sm" type="button" disabled={ghost.busy} onclick={() => suggest(ghost!.after, ghost!.nth + 1)}>Another</button>
                </div>
              </div>
            {/if}
          {/each}
          <div class="add-row">
            <button class="addblk" type="button" onclick={() => insertAfter(null, { id: bid(), type: "p", text: "" })}>+ Paragraph</button>
            <button class="addblk" type="button" onclick={() => openPicker(draft!.blocks[draft!.blocks.length - 1]?.id ?? null)}>{@html I.quote}Quote</button>
            <button class="addblk" type="button" onclick={() => suggest(draft!.blocks[draft!.blocks.length - 1].id)} disabled={!app.llm}>{@html I.spark}Suggest</button>
          </div>
        </div>
        <div class="doc-foot">
          {#each answers as n (n.id)}
            <div class="ed-note answer"><b>Editor</b><span>{n.text.split("\n").slice(1).join(" ")}</span><small>{n.text.split("\n")[0]}</small><span class="ed-acts"><button class="ghost sm" type="button" onclick={() => dropNote(n)}>Done</button></span></div>
          {/each}
          <p class="doc-meta">{#if angleLabel}<span>Angle: {angleLabel}</span>{/if}<span>{words} words</span><span>{lang.toUpperCase()}</span>{#if desk?.case}<span>{sourced.filter(b => b.ev?.length || b.open).length}/{sourced.length} sourced</span>{/if}</p>
          <div class="rw" role="group" aria-label="Rewrite the whole piece">
            {#each [["shorter", "Shorter"], ["longer", "Longer"], ["plainer", "Plainer"], [lang === "de" ? "en" : "de", lang === "de" ? "English" : "Deutsch"]] as [k, l]}
              <button class="chip-btn" type="button" disabled={!!working || !app.llm} onclick={() => rewrite(k)}>{working === k ? "Rewriting…" : l}</button>
            {/each}
          </div>
          <AskBar placeholder="Ask the draft…" busy={working === "ask"} onsubmit={askDraft} />
        </div>
      </div>
      <div class="desk-rail">
        <div class="seg rail-tabs" role="group" aria-label="Beside the piece">
          {#if desk?.case}<button type="button" aria-pressed={rail === "trace"} onclick={() => (rail = "trace")}>Sources</button>{/if}
          <button type="button" aria-pressed={rail === "outline"} onclick={() => (rail = "outline")}>Outline</button>
          <button type="button" aria-pressed={rail === "versions"} onclick={() => (rail = "versions")}>Versions</button>
          <button type="button" aria-pressed={rail === "formats" || (rail === "trace" && !desk?.case)} onclick={() => (rail = "formats")}>Formats</button>
          {#if draft.status === "published"}<button type="button" aria-pressed={rail === "live"} onclick={() => (rail = "live")}>Live</button>{/if}
        </div>
        {#if rail === "trace" && desk?.case}
          <div class="trace">
            {#if focusedBlock && focusedBlock.type !== "h"}
              <h4>{focusedBlock.ev?.length ? "This paragraph rests on" : "This paragraph cites nothing"}</h4>
              {#if focusedBlock.support}<div class="meter s-{focusedBlock.support}"><i></i><i></i><i></i><span>{({ strong: "Strong support", ok: "Supported", weak: "Weak support" } as Record<string, string>)[focusedBlock.support]}</span></div>{/if}
              {#each focusedBlock.ev ?? [] as id}
                {@const e = evBy.get(id)}
                {#if e}<div class="tr-ev"><small>{e.kind === "photo" || e.kind === "note" || e.kind === "answer" ? "You, on the spot" : e.site}{e.at ? ` · ${new Date(e.at).toLocaleDateString("de-DE")}` : ""}</small><b>{#if e.url}<a href={e.url} target="_blank" rel="noopener">{e.title}</a>{:else}{e.title}{/if}</b><span>{e.quote}</span></div>{/if}
              {/each}
            {:else}
              <h4>{sourced.filter(b => b.ev?.length || b.open).length} of {sourced.length} paragraphs have a source</h4>
              <p class="hint">Tap a paragraph, or its number in the margin, to see what it rests on.</p>
            {/if}
            {#if unused.length}
              <h4 class="mt-m">Not used yet</h4>
              {#each unused as e (e.id)}
                <div class="tr-ev unused"><small>{e.site}</small><b>{e.title}</b><span>{e.quote}</span><button class="ghost sm" type="button" disabled={!!working} onclick={() => weave(e.id)}>{working === `ev${e.id}` ? "Writing…" : focusedBlock ? "Use after this paragraph" : "Use"}</button></div>
              {/each}
            {/if}
            <Link class="link-btn mt-s" href="/studio/case/{desk.case.id}">Open the case file</Link>
          </div>
        {:else if rail === "outline"}
          <ol class="outline">
            {#each draft.blocks.filter(b => b.text.trim()) as b (b.id)}
              <li class="o-{b.type}"><button type="button" onclick={() => focusBlock(b.id)}><i class="s-{b.type === "c" ? "c" : b.support ?? (b.ev?.length ? "ok" : "none")}"></i>{b.text.slice(0, 80)}{b.text.length > 80 ? "…" : ""}</button></li>
            {/each}
          </ol>
          {#if desk?.case && desk.case.angles.length}
            <h4 class="rail-h">Angle</h4>
            <div class="rail-angles">{#each desk.case.angles as a}<Link class="ghost sm" href="/studio/case/{desk.case.id}#angles" aria-pressed={(desk.case.angle ?? "a") === a.key}>{a.key.toUpperCase()} · {a.title}</Link>{/each}</div>
          {/if}
        {:else if rail === "versions"}
          <ul class="versions">
            {#each desk?.versions ?? [] as v (v.id)}
              <li><i class="by-{v.by}">{v.by === "claude" ? "C" : v.by === "update" ? "U" : "Y"}</i><span><b>{v.label}</b><small>{ago(v.created_at)} · {v.words} words · {v.by === "claude" ? "Claude" : v.by === "update" ? "update" : "you"}</small></span><button class="ghost sm" type="button" disabled={!!working} onclick={() => restore(v)}>Go back</button></li>
            {:else}<li class="hint">Versions appear when Claude writes or changes the piece, and every quarter hour you edit.</li>{/each}
          </ul>
        {:else if rail === "live" && desk}
          <div class="desk-live">
            <div class="live-nums"><span><b>{desk.stats.reads.toLocaleString("de-DE")}</b>reads</span><span><b>{desk.stats.reads ? Math.round(desk.stats.finishes / desk.stats.reads * 100) : 0} %</b>read to the end</span><span><b>{desk.stats.shares}</b>shares</span><span><b>{desk.stats.subscribers}</b>subscribers</span></div>
            {#if desk.stats.days.length > 1}<div class="live-bars" aria-label="Reads per day">{#each desk.stats.days as d}<i style:height="{Math.max(4, d.reads / Math.max(...desk.stats.days.map(x => x.reads), 1) * 100)}%" title="{d.day}: {d.reads}"></i>{/each}</div>{/if}
            {#if desk.url}<a class="link-btn live-url" href={desk.url} target="_blank" rel="noopener">{@html I.external} {desk.url.replace(/^https?:\/\//, "")}</a>{/if}
            <h4 class="rail-h">From readers</h4>
            {#each desk.readers as n (n.id)}
              <div class="rn" class:done={n.status === "done"}><small>{n.kind === "fix" ? "Says there is a mistake" : "Tip"} · {ago(n.created_at)}{n.contact ? ` · ${n.contact}` : ""}</small><span>{n.text}</span>
                {#if n.status !== "done"}<span class="rn-acts">
                  {#if n.kind === "tip"}<button class="primary sm" type="button" onclick={() => { openCapture([], n.text); noteDone(n); }}>New case</button>{:else}<button class="primary sm" type="button" onclick={() => { fixFor = n.id; fixText = ""; }}>Correct it</button>{/if}
                  <button class="ghost sm" type="button" onclick={() => noteDone(n)}>Done</button></span>{/if}
                {#if fixFor === n.id}<div class="fix-box"><input type="text" bind:value={fixText} placeholder="What you corrected, for readers" /><button class="primary sm" type="button" disabled={fixText.trim().length < 5} onclick={() => correct(n.id)}>Note it</button></div>{/if}
              </div>
            {:else}<p class="hint">Tips and corrections from readers land here.</p>{/each}
            <h4 class="rail-h">Corrections <small>shown under the piece</small></h4>
            {#each desk.corrections as c (c.id)}<p class="corr"><b>{c.kind === "update" ? "Update" : "Correction"}</b> {c.text}<small>{ago(c.created_at)}</small></p>{/each}
            {#if fixFor === -1}<div class="fix-box"><input type="text" bind:value={fixText} placeholder="What you corrected, for readers" /><button class="primary sm" type="button" disabled={fixText.trim().length < 5} onclick={() => correct(null)}>Note it</button></div>
            {:else}<button class="link-btn" type="button" onclick={() => { fixFor = -1; fixText = ""; }}>+ Add a correction</button>{/if}
          </div>
        {:else}
        <div class="lens-preview">
          <div class="seg" role="group" aria-label="Preview as">{#each forms as f}<button type="button" aria-pressed={form === f.key} onclick={() => setForm(f.key)}>{f.label}</button>{/each}</div>
          {#if pvError}
            <div class="notice"><b>{pvError.code === "no_llm" ? "Previews are off" : "Could not steep the preview"}</b><span>{pvError.message}</span></div>
          {:else if !words}
            <div class="lp-body muted">Write a few lines and the preview steeps them into this form.</div>
          {:else}
            <div class="lp-body" aria-live="polite" aria-busy={pvBusy}>{preview}{#if pvBusy}<span class="caret"></span>{/if}</div>
          {/if}
        </div>
        <div class="group-label">Wire</div>
        <div class="wire" aria-label="Raw server-sent events">
          <div class="hdr">text/event-stream · {events} events</div>
          {#each wire.slice(-9) as w}<div>{#if w.startsWith("error")}<span>{w}</span>{:else}{w}{/if}</div>{/each}
        </div>
        {/if}
      </div>
    </div>
  </div>
{:else}
  <div class="page"><Loading /></div>
{/if}

<Sheet bind:open={pickOpen} label="Quote from your harvest">
  <h3>Quote from your harvest</h3>
  <p class="sub">Facts from your stories, with their source attached. Claims go in marked as unverified.</p>
  <input class="search" type="search" placeholder="Search your stories" bind:value={q} oninput={search} aria-label="Search your stories" />
  <div class="pick-list">
    {#if picks === null}<Loading />
    {:else}
      {#each picks as p (p.story_id)}
        <div class="pick-story">
          <div class="ps-hd"><Fav kind={p.kind} name={p.source} size={16} src={p.icon} /><b>{p.title}</b></div>
          {#each p.atoms as a}<button type="button" class="atom" class:claim={a.kind === "claim"} onclick={() => pickAtom(p, a)}><i>{a.kind}</i>{a.text}</button>{/each}
        </div>
      {:else}
        <p class="sub">{q ? "Nothing in your harvest matches." : "Your harvest has no facts yet. Harvest on Today first."}</p>
      {/each}
    {/if}
  </div>
</Sheet>

<Sheet bind:open={pubOpen} label="Publish">
  <h3>Publish</h3>
  <p class="sub">Take the {forms.find(f => f.key === form)?.label} version with you and post it yourself.</p>
  <div class="seg mt-m">{#each forms as f}<button type="button" aria-pressed={form === f.key} onclick={() => setForm(f.key)}>{f.label}</button>{/each}</div>
  <div class="lp-body pub-body">{preview || (pvBusy ? "" : pvError?.message ?? "Nothing to publish yet.")}{#if pvBusy}<span class="caret"></span>{/if}</div>
  <div class="pub-actions">
    <button class="primary" type="button" disabled={pvBusy || !preview} onclick={copyPreview}>{@html I.copy}Copy</button>
    <button class="ghost" type="button" disabled={pvBusy || !preview} onclick={share}>{@html I.share}Share</button>
  </div>
  {#if !draft?.investigation_id && !draft?.slug}<button class="ghost full mt-s" type="button" onclick={() => markPublished(draft?.status !== "published")}>{draft?.status === "published" ? "Mark as draft again" : "Mark as posted elsewhere"}</button>{/if}
</Sheet>
{#if draft && desk}
  <PublishSheet bind:open={publishOpen} {draft} desk={desk as any} photo={desk.photo ? `/api/photos/${desk.photo.id}?v=public` : null} onclaim={claim}
    onchanged={async (d?: Draft) => { if (d) adopt(d); else { const fresh = await api(`/api/drafts/${draft!.id}`); draft!.status = fresh.status; draft!.slug = fresh.slug; draft!.publish_at = fresh.publish_at; draft!.meta = fresh.meta; draft!.published_at = fresh.published_at; draft!.updated_at = fresh.updated_at; } await loadDesk(); }} />
  {#if desk.photo}<PhotoSheet bind:open={photoOpen} photo={desk.photo} draftId={draft.id} onchanged={loadDesk} />{/if}
{/if}
