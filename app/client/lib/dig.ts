// Digging into a sentence: where the reader tapped (or what they selected), as text and as a DOM range to mark it with.
/** The sentence under the point (x, y) inside `el`, or the selected words when the reader selected some inside it. */
export function sentenceAt(el: HTMLElement, x: number, y: number, lang: string): { text: string; range: Range } | null {
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount && el.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0).cloneRange(), text = sel.toString().replace(/\s+/g, " ").trim();
    return text.length > 2 ? { text: text.slice(0, 600), range } : null;
  }
  const d = document as any;
  const pos = d.caretPositionFromPoint?.(x, y), r = pos ? null : d.caretRangeFromPoint?.(x, y);
  const node: Node | null = pos?.offsetNode ?? r?.startContainer ?? null, off: number = pos?.offset ?? r?.startOffset ?? 0;
  if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
  // the element's text as one string, with where each text node starts in it
  const nodes: { n: Text; at: number }[] = [];
  let full = "", at = -1;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    if (n === node) at = full.length + off;
    nodes.push({ n, at: full.length }); full += n.data;
  }
  if (at < 0) return null;
  let start = 0, end = full.length;
  for (const s of new Intl.Segmenter(lang, { granularity: "sentence" }).segment(full)) {
    if (at >= s.index && at < s.index + s.segment.length) { start = s.index; end = s.index + s.segment.length; break; }
  }
  const text = full.slice(start, end).replace(/\s+/g, " ").trim();
  if (text.length < 3) return null;
  const point = (i: number): [Text, number] => { const k = nodes.findLast(x => x.at <= i) ?? nodes[0]; return [k.n, Math.min(i - k.at, k.n.data.length)]; };
  const range = document.createRange();
  range.setStart(...point(start)); range.setEnd(...point(end));
  return { text: text.slice(0, 600), range };
}

/** Marks the sentence being dug into (the CSS Custom Highlight API: no change to the DOM); null clears it. */
export function markSentence(range: Range | null) {
  const h = (CSS as any).highlights, H = (globalThis as any).Highlight;
  if (!h || !H) return;
  if (range) h.set("dig", new H(range)); else h.delete("dig");
}
