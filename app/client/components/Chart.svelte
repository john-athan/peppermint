<script lang="ts">
  // A chart from a few lines of JSON (shared/chart.ts has the format). Bars, columns, lines, areas and stacked bars,
  // drawn as SVG with the dataviz rules: thin marks with 4px rounded data ends, a 2px surface gap between touching
  // fills, hairline recessive grid, selective direct labels, a legend for two or more series (click to hide, Alt- or
  // double-click to isolate), hover and keyboard tooltips (a snapping crosshair on lines), a table view, PNG export.
  // `compact` is the card version: no controls, no tooltips (a tap opens the story), direct labels only.
  import { type Chart, type Value, describe, format, formatValue, hi, lo, ticks } from "../../shared/chart";

  let { chart, lang = "en", compact = false }: { chart: Chart; lang?: string; compact?: boolean } = $props();

  let W = $state(0), hidden = $state<string[]>([]), sorted = $state(false), table = $state(false), range = $state(0);
  let active = $state<number | null>(null), activeSeries = $state<number | null>(null), tip = $state<{ x: number; y: number } | null>(null);
  let fig: HTMLElement | undefined = $state(), svgEl: SVGSVGElement | undefined = $state();
  $effect(() => { sorted = chart.sort; hidden = []; range = 0; });

  // ---- text measurement (tick and value labels decide margins) ----
  let ctx: CanvasRenderingContext2D | null = null;
  const tw = (s: string, size = 12, weight = 600) => {
    ctx ??= document.createElement("canvas").getContext("2d");
    if (!ctx) return s.length * size * 0.56;
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    return ctx.measureText(s).width;
  };
  const fmt = (v: number, compactAxis = false) => format(chart, v, lang, compactAxis);
  const fv = (v: Value) => formatValue(chart, v, lang);

  // ---- what is shown: visible series, label order, time range ----
  const lineLike = $derived(chart.type === "line" || chart.type === "area");
  const visible = $derived(chart.series.filter(s => !hidden.includes(s.name)));
  const ranges = $derived(lineLike && chart.labels.length > 12 ? [0, 12, chart.labels.length > 24 ? 24 : 0].filter((n, i) => i === 0 || (n && n < chart.labels.length)) : []);
  const idx = $derived.by(() => {
    let ix = chart.labels.map((_, i) => i);
    if (lineLike && range) ix = ix.slice(-range);
    if (sorted && !lineLike && chart.type !== "column") {
      const score = (i: number) => visible.reduce((a, s) => a + (hi(s.values[i]) ?? 0), 0);
      ix = [...ix].sort((a, b) => score(b) - score(a));
    }
    return ix;
  });
  const color = (slot: number, label?: string, seriesName?: string) => {
    if (chart.highlight) {
      const on = chart.series.length === 1 ? label === chart.highlight : seriesName === chart.highlight;
      if (!on) return "var(--c-dim)";
      return chart.series.length === 1 ? "var(--c1)" : slot < 0 ? "var(--c-other)" : `var(--c${slot + 1})`;
    }
    return slot < 0 ? "var(--c-other)" : `var(--c${slot + 1})`;
  };
  // text set inside a coloured fill: white, or near-black on the light hues (yellow, orange)
  const ink = (slot: number) => slot === 1 || slot === 3 ? "var(--c-on-light)" : "white";

  // ---- rounded data ends: square at the baseline, 4px round at the value; both ends round for a floating range ----
  function hbar(x0: number, x1: number, y: number, h: number, floating = false) {
    const l = Math.min(x0, x1), r = Math.max(x0, x1), w = Math.max(0, r - l), rr = Math.min(4, w / 2, h / 2);
    const right = floating || x1 >= x0, left = floating || x1 < x0;
    const rl = left ? rr : 0, rrr = right ? rr : 0;
    return `M${l + rl},${y} H${r - rrr} ${rrr ? `Q${r},${y} ${r},${y + rrr}` : ""} V${y + h - rrr} ${rrr ? `Q${r},${y + h} ${r - rrr},${y + h}` : ""} H${l + rl} ${rl ? `Q${l},${y + h} ${l},${y + h - rl}` : ""} V${y + rl} ${rl ? `Q${l},${y} ${l + rl},${y}` : ""} Z`;
  }
  function vbar(y0: number, y1: number, x: number, w: number, floating = false) {
    const t = Math.min(y0, y1), b = Math.max(y0, y1), h = Math.max(0, b - t), rr = Math.min(4, h / 2, w / 2);
    const top = floating || y1 <= y0, bot = floating || y1 > y0;
    const rt = top ? rr : 0, rb = bot ? rr : 0;
    return `M${x},${t + rt} ${rt ? `Q${x},${t} ${x + rt},${t}` : ""} H${x + w - rt} ${rt ? `Q${x + w},${t} ${x + w},${t + rt}` : ""} V${b - rb} ${rb ? `Q${x + w},${b} ${x + w - rb},${b}` : ""} H${x + rb} ${rb ? `Q${x},${b} ${x},${b - rb}` : ""} Z`;
  }

  // ---- layouts ----
  type Mark = { d: string; fill: string; i: number; s: number; label?: { x: number; y: number; text: string; anchor: string; inside?: string } };
  type Hit = { x: number; y: number; w: number; h: number; i: number; s: number | null };
  type Tick = { pos: number; text: string };

  const L = $derived.by(() => {
    const w = Math.max(240, W || 600), n = idx.length, ns = visible.length;
    const all = visible.flatMap(s => idx.map(i => s.values[i]));
    const marks: Mark[] = [], hits: Hit[] = [], cats: { x: number; y: number; text: string; anchor: string; w?: number }[] = [];
    let height = 0, grid: Tick[] = [], axis: "x" | "y" | null = null, plot = { x: 0, y: 0, w: 0, h: 0 };
    const lines: { d: string; area?: string; band?: string; color: string; s: number; pts: (number | null)[]; end?: { x: number; y: number; text: string; name: string } }[] = [];
    const xs: number[] = [];

    if (chart.type === "bar" || chart.type === "stacked") {
      const stacked = chart.type === "stacked" && ns > 1;
      const totals = idx.map(i => stacked ? visible.reduce((a, s) => a + Math.max(0, hi(s.values[i]) ?? 0), 0) : 0);
      const vmax = Math.max(0, ...(stacked ? totals : all.map(v => hi(v) ?? 0)));
      const vmin = stacked ? 0 : Math.min(0, ...all.map(v => lo(v) ?? 0));
      // a value label at every bar tip only while bars stay few; grouped bars beyond that rely on the axis and tooltips
      const labelEach = stacked || ns === 1 || n * ns <= 12;
      const valTexts = stacked ? totals.map(t => fmt(t)) : labelEach ? visible.flatMap(s => idx.map(i => fv(s.values[i]))) : [];
      const room = Math.max(0, ...valTexts.map(t => tw(t, compact ? 11 : 12))) + 8;
      const leftRoom = vmin < 0 && labelEach ? room : 0;
      const bt = compact ? (ns === 1 || stacked ? 12 : 7) : ns === 1 || stacked ? 20 : ns <= 3 ? 10 : 7;
      const labelH = compact ? 15 : 19, rowGap = compact ? 7 : 12;
      const barsH = stacked ? bt : ns * bt + (ns - 1) * 2;
      const rowH = labelH + barsH + rowGap;
      plot = { x: leftRoom, y: 2, w: w - leftRoom - (labelEach ? room : 6), h: n * rowH };
      const sx = (v: number) => plot.x + ((v - vmin) / (vmax - vmin || 1)) * plot.w;
      idx.forEach((i, k) => {
        const y0 = plot.y + k * rowH;
        cats.push({ x: 0, y: y0 + labelH - (compact ? 4 : 6), text: chart.labels[i], anchor: "start", w: w - 4 });
        hits.push({ x: 0, y: y0, w, h: rowH, i, s: null });
        if (stacked) {
          let acc = 0;
          const segs = visible.map(s => ({ s, v: Math.max(0, hi(s.values[i]) ?? 0) })).filter(x => x.v > 0);
          segs.forEach(({ s, v }, j) => {
            const a = sx(acc), b = sx(acc + v); acc += v;
            const gapL = j > 0 ? 1 : 0, gapR = j < segs.length - 1 ? 1 : 0;
            const isLast = j === segs.length - 1;
            // only the outer end of the stack is rounded; inner segments meet at a 2px surface gap
            const d = isLast ? hbar(a + gapL, b, y0 + labelH, bt) : `M${a + gapL},${y0 + labelH} H${b - gapR} V${y0 + labelH + bt} H${a + gapL} Z`;
            const text = fv(v), fits = !compact && tw(text, 11) + 12 <= b - a - gapL - gapR;
            marks.push({ d, fill: color(s.slot, chart.labels[i], s.name), i, s: chart.series.indexOf(s), label: fits ? { x: a + gapL + 6, y: y0 + labelH + bt / 2 + 4, text, anchor: "start", inside: ink(s.slot) } : undefined });
            hits.push({ x: a, y: y0 + labelH - 2, w: b - a, h: bt + 4, i, s: chart.series.indexOf(s) });
          });
          marks.push({ d: "", fill: "none", i, s: -1, label: { x: sx(totals[k]) + 6, y: y0 + labelH + bt / 2 + 4, text: fmt(totals[k]), anchor: "start" } });
        } else {
          visible.forEach((s, j) => {
            const v = s.values[i]; if (v == null) return;
            const by = y0 + labelH + j * (bt + 2), range2 = Array.isArray(v);
            const a = range2 ? sx(v[0]) : sx(0), b = sx(range2 ? v[1] : v);
            const neg = !range2 && v < 0;
            marks.push({ d: hbar(a, b, by, bt, range2), fill: color(s.slot, chart.labels[i], s.name), i, s: chart.series.indexOf(s),
              label: labelEach ? { x: neg ? b - 6 : Math.max(a, b) + 6, y: by + bt / 2 + 4, text: fv(v), anchor: neg ? "end" : "start" } : undefined });
            if (ns > 1) hits.push({ x: 0, y: by - 1, w, h: bt + 2, i, s: chart.series.indexOf(s) });
          });
        }
      });
      // floating ranges need a scale to be read against, as do grouped bars without their own labels
      const floating = all.some(v => Array.isArray(v));
      if (!labelEach || floating) { grid = ticks(vmin, vmax, Math.max(2, Math.floor(plot.w / 90))).map(t => ({ pos: sx(t), text: fmt(t, true) })); axis = "x"; }
      height = plot.y + plot.h + (axis ? 22 : 0);
    } else {
      // columns, lines, areas: a value axis on the left, labels along the bottom
      const vmax = Math.max(0, ...all.map(v => hi(v) ?? 0)), vmin = Math.min(...(chart.type === "column" ? [0] : []), ...all.map(v => lo(v) ?? Infinity).filter(Number.isFinite));
      const H = compact ? 150 : Math.round(Math.min(340, Math.max(220, w * 0.48)));
      const tk = ticks(Number.isFinite(vmin) ? Math.min(vmin, chart.type === "column" ? 0 : vmin) : 0, vmax, compact ? 3 : 5);
      const yAxisW = Math.max(...tk.map(t => tw(fmt(t, true), 11, 500))) + 10;
      const maxCat = Math.max(...idx.map(i => tw(chart.labels[i], 11, 500)));
      plot = { x: yAxisW, y: 10, w: w - yAxisW - (lineLike && ns <= 4 && !compact ? 8 : 6), h: H - 10 - (compact ? 18 : 26) };
      const y0v = tk[0], y1v = tk[tk.length - 1];
      const sy = (v: number) => plot.y + plot.h - ((v - y0v) / (y1v - y0v || 1)) * plot.h;
      grid = tk.map(t => ({ pos: sy(t), text: fmt(t, true) })); axis = "y";
      if (chart.type === "column") {
        const band = plot.w / n, cw = Math.min(24, (band * 0.62 - (ns - 1) * 2) / ns), gw = ns * cw + (ns - 1) * 2;
        const labelCaps = ns === 1 && n <= 14;
        idx.forEach((i, k) => {
          const cx = plot.x + band * k + band / 2;
          xs.push(cx);
          hits.push({ x: plot.x + band * k, y: plot.y, w: band, h: plot.h, i, s: null });
          visible.forEach((s, j) => {
            const v = s.values[i]; if (v == null) return;
            const x = cx - gw / 2 + j * (cw + 2), r2 = Array.isArray(v);
            const a = r2 ? sy(v[0]) : sy(0), b = sy(r2 ? v[1] : v);
            const text = fv(v);
            marks.push({ d: vbar(a, b, x, cw, r2), fill: color(s.slot, chart.labels[i], s.name), i, s: chart.series.indexOf(s),
              label: labelCaps && tw(text, 11) <= band - 2 ? { x: x + cw / 2, y: Math.min(a, b) - 6, text, anchor: "middle" } : undefined });
          });
        });
      } else {
        const step = n > 1 ? plot.w / (n - 1) : 0;
        idx.forEach((i, k) => xs.push(plot.x + k * step));
        visible.forEach(s => {
          let d = "", band = "", up: string[] = [], down: string[] = [], pen = false;
          const pts: (number | null)[] = [];
          idx.forEach((i, k) => {
            const v = s.values[i];
            if (v == null) { pen = false; pts.push(null); return; }
            const mid = Array.isArray(v) ? (v[0] + v[1]) / 2 : v;
            pts.push(sy(mid));
            d += `${pen ? "L" : "M"}${xs[k].toFixed(1)},${sy(mid).toFixed(1)} `; pen = true;
            if (Array.isArray(v)) { up.push(`${xs[k].toFixed(1)},${sy(v[1]).toFixed(1)}`); down.unshift(`${xs[k].toFixed(1)},${sy(v[0]).toFixed(1)}`); }
          });
          if (up.length > 1) band = `M${up.join(" L")} L${down.join(" L")} Z`;
          const lastK = [...idx.keys()].reverse().find(k => s.values[idx[k]] != null);
          const area = chart.type === "area" && lastK != null ? `${d} L${xs[lastK].toFixed(1)},${sy(Math.max(y0v, 0)).toFixed(1)} L${xs[idx.findIndex(i => s.values[i] != null)].toFixed(1)},${sy(Math.max(y0v, 0)).toFixed(1)} Z` : undefined;
          const lv = lastK != null ? s.values[idx[lastK]] : null;
          lines.push({ d, area, band: band || undefined, color: color(s.slot, undefined, s.name), s: chart.series.indexOf(s), pts,
            end: lastK != null && lv != null ? { x: xs[lastK], y: sy(Array.isArray(lv) ? (lv[0] + lv[1]) / 2 : lv), text: fv(lv), name: s.name } : undefined });
        });
        hits.push({ x: plot.x - step / 2, y: plot.y, w: plot.w + step, h: plot.h, i: -1, s: null });
      }
      // along the bottom: every label that fits, the last one always
      const per = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plot.w / (Math.min(maxCat, 120) + 14)))));
      idx.forEach((i, k) => { if (k % per === 0 || k === n - 1) cats.push({ x: xs[k], y: plot.y + plot.h + 17, text: chart.labels[i], anchor: n === 1 ? "middle" : k === 0 && lineLike ? "start" : k === n - 1 && lineLike ? "end" : "middle", w: chart.type === "column" ? plot.w / n * per : 120 }); });
      // a later label that would overlap the last one is dropped
      for (let k = cats.length - 2; k >= 0; k--) if (cats[k + 1].x - cats[k].x < Math.min(tw(cats[k].text, 11, 500), 120) / 2 + Math.min(tw(cats[k + 1].text, 11, 500), 120) / 2 + 8) cats.splice(k, 1);
      height = H;
    }
    // direct end labels on lines (up to four series) unless they would collide; otherwise the legend carries identity
    const ends = lines.map(l => l.end).filter(Boolean) as { x: number; y: number; text: string; name: string }[];
    const sortedY = ends.map(e => e.y).sort((a, b) => a - b);
    const endLabels = lineLike && ends.length <= 4 && sortedY.every((y, k) => k === 0 || y - sortedY[k - 1] >= 15);
    return { w, height, marks, hits, cats, grid, axis, plot, lines, xs, endLabels };
  });

  // ---- interaction ----
  const hitAt = (e: PointerEvent) => { if (!svgEl) return null; const r = svgEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function move(e: PointerEvent, h: Hit) {
    if (compact) return;
    const p = hitAt(e); if (!p) return;
    if (h.i === -1) {
      // lines: the crosshair snaps to the nearest label position
      let best = 0; L.xs.forEach((x, k) => { if (Math.abs(x - p.x) < Math.abs(L.xs[best] - p.x)) best = k; });
      active = idx[best]; activeSeries = null; tip = { x: L.xs[best], y: p.y };
    } else { active = h.i; activeSeries = h.s; tip = { x: p.x, y: p.y }; }
  }
  const leave = () => { active = null; activeSeries = null; tip = null; };
  function key(e: KeyboardEvent) {
    const fwd = ["ArrowRight", "ArrowDown"].includes(e.key), back = ["ArrowLeft", "ArrowUp"].includes(e.key);
    if (e.key === "Escape") { leave(); return; }
    if (!fwd && !back) return;
    e.preventDefault();
    const k = active == null ? (fwd ? 0 : idx.length - 1) : Math.max(0, Math.min(idx.length - 1, idx.indexOf(active) + (fwd ? 1 : -1)));
    active = idx[k]; activeSeries = null;
    tip = lineLike || chart.type === "column" ? { x: L.xs[k], y: L.plot.y + 10 } : { x: L.w / 2, y: (L.hits.find(h => h.i === active)?.y ?? 0) + 30 };
  }
  function toggle(name: string, e: MouseEvent) {
    const isolate = e.altKey || e.detail === 2;
    if (isolate) hidden = chart.series.map(s => s.name).filter(n => n !== name);
    else hidden = hidden.includes(name) ? hidden.filter(n => n !== name) : [...hidden, name];
    if (hidden.length >= chart.series.length) hidden = [];
  }
  const tipRows = $derived(active == null ? [] : (activeSeries != null ? [chart.series[activeSeries]] : visible).map(s => ({ s, v: s.values[active!] })));
  const tipPos = $derived.by(() => {
    if (!tip || !fig) return null;
    const left = Math.max(4, Math.min(L.w - 190, tip.x + 14));
    // above the pointer, so the mark it describes stays visible
    return { left, top: tip.y - 10 };
  });

  // ---- PNG export: the SVG with its colours resolved, drawn twice the size on a canvas, with title and source ----
  async function savePng() {
    if (!svgEl || !fig) return;
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    const src = svgEl.querySelectorAll("*"), dst = clone.querySelectorAll("*");
    src.forEach((el, k) => { const cs = getComputedStyle(el); const d = dst[k] as SVGElement; for (const p of ["fill", "stroke", "opacity", "font-size", "font-weight", "font-family", "stroke-width"]) d.style.setProperty(p, cs.getPropertyValue(p)); d.style.animation = "none"; d.style.transform = "none"; });
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const cs = getComputedStyle(fig), bg = cs.getPropertyValue("--surface").trim() || "white", inkC = cs.getPropertyValue("--ink").trim() || "black", mut = cs.getPropertyValue("--muted").trim() || "dimgray";
    const head = chart.title ? 40 + (chart.subtitle ? 20 : 0) : 12, foot = chart.source ? 30 : 12, pad = 20, scale = 2;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
    await img.decode();
    const c = document.createElement("canvas"); c.width = (L.w + pad * 2) * scale; c.height = (L.height + head + foot) * scale;
    const g = c.getContext("2d")!; g.scale(scale, scale);
    g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = inkC; g.font = "700 17px system-ui, sans-serif"; if (chart.title) g.fillText(chart.title, pad, 28);
    g.fillStyle = mut; g.font = "500 13px system-ui, sans-serif"; if (chart.subtitle) g.fillText(chart.subtitle, pad, 48);
    g.drawImage(img, pad, head, L.w, L.height);
    if (chart.source) { g.font = "500 11px system-ui, sans-serif"; g.fillText(`${lang === "de" ? "Quelle" : "Source"}: ${chart.source} · peppermint`, pad, head + L.height + 20); }
    c.toBlob(b => { if (!b) return; const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${(chart.title || "chart").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60)}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }, "image/png");
  }
  const T = $derived(lang === "de" ? { table: "Tabelle", chart: "Diagramm", png: "Bild", sort: "Sortiert", all: "Alle", last: "Letzte", src: "Quelle" } : { table: "Table", chart: "Chart", png: "Image", sort: "Sorted", all: "All", last: "Last", src: "Source" });
  const keyShape = $derived(lineLike ? "line" : "rect");
</script>

<figure class="pm-chart" class:compact bind:this={fig} aria-label={describe(chart, lang)}>
  {#if !compact && (chart.title || chart.subtitle)}
    <figcaption class="ch-head">{#if chart.title}<b>{chart.title}</b>{/if}{#if chart.subtitle}<span>{chart.subtitle}</span>{/if}</figcaption>
  {/if}
  {#if !compact}
    <div class="ch-controls">
      {#if chart.series.length > 1}
        <div class="ch-legend" role="group" aria-label={lang === "de" ? "Reihen ein- und ausblenden" : "Show or hide series"}>
          {#each chart.series as s}
            <button type="button" aria-pressed={!hidden.includes(s.name)} title={lang === "de" ? "Klicken: ein/aus · Doppelklick: nur diese" : "Click: show/hide · double-click: only this"} onclick={(e) => toggle(s.name, e)}>
              <i class="key {keyShape}" style:--k={color(s.slot, undefined, s.name)}></i>{s.name}
            </button>
          {/each}
        </div>
      {/if}
      <div class="ch-tools">
        {#each ranges as r}<button type="button" aria-pressed={range === r} onclick={() => (range = r)}>{r ? `${T.last} ${r}` : T.all}</button>{/each}
        {#if !lineLike && chart.type !== "column" && chart.labels.length > 2}<button type="button" aria-pressed={sorted} onclick={() => (sorted = !sorted)}>{T.sort}</button>{/if}
        <button type="button" aria-pressed={table} onclick={() => (table = !table)}>{table ? T.chart : T.table}</button>
        <button type="button" onclick={savePng} aria-label={lang === "de" ? "Als Bild speichern" : "Save as image"}>{T.png}</button>
      </div>
    </div>
  {/if}

  {#if table && !compact}
    <div class="ch-table-wrap">
      <table class="ch-table">
        <thead><tr><th scope="col"></th>{#each chart.series as s}<th scope="col">{chart.series.length > 1 ? s.name : chart.unit || (lang === "de" ? "Wert" : "Value")}</th>{/each}</tr></thead>
        <tbody>{#each chart.labels as l, i}<tr><th scope="row">{l}</th>{#each chart.series as s}<td>{fv(s.values[i])}</td>{/each}</tr>{/each}</tbody>
      </table>
    </div>
  {:else}
    <div class="ch-plot" bind:clientWidth={W} role="application" aria-roledescription={lang === "de" ? "Diagramm" : "chart"} aria-label={describe(chart, lang)}
      tabindex={compact ? -1 : 0} onkeydown={key} onpointerleave={leave} onblur={leave}>
      {#if W}
        <svg bind:this={svgEl} width={L.w} height={L.height} viewBox="0 0 {L.w} {L.height}" role="img" aria-hidden="true">
          {#if L.axis === "y"}
            {#each L.grid as g}<line class="grid" x1={L.plot.x} x2={L.plot.x + L.plot.w} y1={g.pos} y2={g.pos} /><text class="tick" x={L.plot.x - 8} y={g.pos + 4} text-anchor="end">{g.text}</text>{/each}
          {:else if L.axis === "x"}
            {#each L.grid as g}<line class="grid" x1={g.pos} x2={g.pos} y1={L.plot.y} y2={L.plot.y + L.plot.h} /><text class="tick" x={g.pos} y={L.plot.y + L.plot.h + 15} text-anchor="middle">{g.text}</text>{/each}
          {/if}
          {#each L.cats as c}<text class="cat" x={c.x} y={c.y} text-anchor={c.anchor}>{c.text.length > 40 && compact ? c.text.slice(0, 38) + "…" : c.text}</text>{/each}
          {#if active != null && (L.xs.length && (lineLike || chart.type === "column"))}
            {@const k = idx.indexOf(active)}
            {#if k >= 0 && lineLike}<line class="crosshair" x1={L.xs[k]} x2={L.xs[k]} y1={L.plot.y} y2={L.plot.y + L.plot.h} />{/if}
          {/if}
          <g class="marks" class:grow-x={chart.type === "bar" || chart.type === "stacked"} class:grow-y={chart.type === "column"}>
            {#each L.marks as m}
              {#if m.d}<path d={m.d} fill={m.fill} class:dim={active != null && (m.i !== active || (activeSeries != null && m.s !== activeSeries))} class:lift={active === m.i && (activeSeries == null || m.s === activeSeries)} />{/if}
            {/each}
          </g>
          {#each L.lines as l}
            {#if l.band}<path class="band" d={l.band} fill={l.color} />{/if}
            {#if l.area}<path class="area" d={l.area} fill={l.color} />{/if}
            <path class="line draw" d={l.d} stroke={l.color} pathLength="1" />
            {#if l.end}<circle class="dot" cx={l.end.x} cy={l.end.y} r="4" fill={l.color} />{/if}
          {/each}
          {#if active != null && lineLike}
            {@const k = idx.indexOf(active)}
            {#each L.lines as l}{#if k >= 0 && l.pts[k] != null}<circle class="dot" cx={L.xs[k]} cy={l.pts[k]} r="4.5" fill={l.color} />{/if}{/each}
          {/if}
          {#each L.marks as m}{#if m.label}<text class="val" class:inside={!!m.label.inside} style:fill={m.label.inside} x={m.label.x} y={m.label.y} text-anchor={m.label.anchor}>{m.label.text}</text>{/if}{/each}
          {#if L.endLabels}{#each L.lines as l}{#if l.end}
            <text class="val end" x={l.end.x - 8} y={l.end.y - 10} text-anchor="end">{chart.series.length > 1 && !compact ? `${l.end.name} ` : ""}{l.end.text}</text>
          {/if}{/each}{/if}
          {#if !compact}{#each L.hits as h}<rect class="hit" x={h.x} y={h.y} width={Math.max(0, h.w)} height={Math.max(0, h.h)} onpointermove={(e) => move(e, h)} onpointerdown={(e) => move(e, h)} />{/each}{/if}
        </svg>
        {#if tipPos && active != null && tipRows.length && !compact}
          <div class="ch-tip" style:left="{tipPos.left}px" style:top="{tipPos.top}px" role="status">
            <div class="ch-tip-h">{chart.labels[active]}</div>
            {#each tipRows as r}<div class="ch-tip-r"><i class="key {keyShape}" style:--k={color(r.s.slot, chart.labels[active], r.s.name)}></i><b>{fv(r.v)}</b>{#if chart.series.length > 1}<span>{r.s.name}</span>{/if}</div>{/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}
  {#if !compact && (chart.source || chart.note)}
    <div class="ch-foot">{#if chart.note}<span>{chart.note}</span>{/if}{#if chart.source}<span>{T.src}: {chart.source}</span>{/if}</div>
  {/if}
</figure>

