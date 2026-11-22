// End-to-end walk through the real app in headless Chrome: passkey setup, sources, harvest, every page.
// Usage: bun tools/e2e.ts <outdir> [base]
import { launch } from "./cdp";
const OUT = process.argv[2] ?? "/tmp/pm-shots";
const BASE = process.argv[3] ?? "http://localhost:4317";
await Bun.write(OUT + "/.keep", "");
const fails: string[] = [];
const check = (ok: unknown, msg: string) => { if (!ok) { fails.push(msg); console.log("FAIL", msg); } else console.log("ok  ", msg); };

const b = await launch({ width: 390, height: 844, mobile: true });
await b.send("WebAuthn.enable");
await b.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const until = async (expr: string, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await b.eval(expr).catch(() => false)) return true; await b.wait(150); } return false; };
const shot = async (name: string) => { await b.wait(250); await b.shot(`${OUT}/${name}.png`); };

// 1. setup with passkey
await b.goto(BASE + "/setup#devsetup");
await until("!!document.querySelector('.primary')");
await shot("01-setup");
await b.click(".primary");
check(await until("location.pathname === '/' && !!document.querySelector('.nav')", 15000), "passkey created and signed in");
await until("!document.querySelector('.splash')", 4000);
await shot("02-today-empty");

// 2. add sources through the picker
for (const kind of ["hackernews", "merkur"]) {
  await b.eval("history.pushState(null,'','/sources/add'); dispatchEvent(new PopStateEvent('popstate'))");
  await until("!!document.querySelector('.kinds')"); await b.wait(500);
  const idx = kind === "hackernews" ? 0 : 1;
  await b.click(`.kinds .kind:nth-child(${idx + 1})`);
  const found = await until("!!document.querySelector('.detected .primary')", 20000);
  check(found, `${kind} discovered`);
  if (!found) { await shot("fail-" + kind); console.log(await b.eval("location.pathname + ' :: ' + document.querySelector('main')?.innerText.slice(0, 300)")); }
  if (kind === "merkur") await shot("03-add-merkur");
  await b.click(".detected .primary");
  check(await until("location.pathname === '/sources'", 5000), `${kind} added`);
}
// any site with a feed: paste its link on the add page
await b.eval("history.pushState(null,'','/sources/add'); dispatchEvent(new PopStateEvent('popstate'))");
await until("!!document.querySelector('.kinds')"); await b.wait(400);
await b.eval("(() => { const dt = new DataTransfer(); dt.setData('text', 'https://jvns.ca'); dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt })); })()");
check(await until("document.querySelector('.detected b')?.textContent.includes('Julia')", 20000), "feed found from a pasted site link");
await shot("03b-add-feed");
await b.click(".detected .primary");
check(await until("location.pathname === '/sources'", 5000), "feed source added");
await shot("04-sources");
check(await until("fetch('/api/edition').then(r=>r.json()).then(j=>!!j.edition && j.edition.cards.length > 0)", 120000), "first harvest built an edition with cards");

// 3. today
await b.eval("history.pushState(null,'','/'); dispatchEvent(new PopStateEvent('popstate'))");
await b.goto(BASE + "/");
await until("document.querySelectorAll('.card').length > 0");
await shot("05-today");
const n = await b.eval<number>("document.querySelectorAll('.card').length");
check(n > 0, `today shows ${n} cards`);

// the brief: Claude writes it into the card in your language
check(await until("document.querySelector('.card .body p')?.textContent.length > 20", 20000), "card shows a brief");
check(await b.eval("!document.querySelector('.card .lens-row, .card .why')"), "no lens buttons or score line on cards");
await shot("06-card-brief");

// ⋯: why you see this, and tune
await b.click(".card .card-acts .act:nth-child(3)");
check(await until("!!document.querySelector('.sheet .feat')"), "why-and-tune sheet opens with the score");
await shot("07-tune");
await b.click(".sheet .primary");
check(await until("!document.querySelector('.sheet') && !!document.querySelector('.toast')"), "tune saved with toast");

// cut back peek and rescue
const hasBelow = await b.eval<boolean>("!!document.querySelector('details.below')");
if (hasBelow) {
  await b.click("details.below summary");
  check(await until("document.querySelectorAll('.peek .pi').length > 0", 5000), "cut-back list loads");
  await shot("08-cut");
  // cards scrolled past on the way down count as viewed and leave on refresh, so look for the rescued story itself
  const rid = await b.eval<number>("fetch('/api/edition/cut').then(r => r.json()).then(j => j.items[0].id)");
  await b.click(".peek .pi button");
  check(await until(`!!document.querySelector('.card h2 a[href="/story/${rid}"]')`, 5000), "rescue adds the story to Today");
}

// 4. reader
await b.goto(BASE + "/");
await until("document.querySelectorAll('.card').length > 0");
await b.click(".card h2 a");
check(await until("location.pathname.startsWith('/story/') && document.querySelector('.tldr p')?.textContent.length > 10", 15000), "reader opens with the TL;DR in your style");
check(await b.eval("['Original', 'Audio', 'Video'].every(n => [...document.querySelectorAll('.read-acts .ghost')].some(x => (x.textContent.trim() || x.getAttribute('aria-label')) === n))"), "reader offers original, audio and video");
// scrolling on brings the whole story in your style under the TL;DR; the stub's retelling carries a chart
await b.eval("scrollTo(0, document.body.scrollHeight)");
check(await until("[...document.querySelectorAll('.stream > p')].some(p => p.textContent.length > 20)", 15000), "scrolling on brings the retelling");
await shot("09-reader");
await b.click(".appbar .icon-btn");
check(await until("!!document.querySelector('.sheet .seg')"), "reader settings sheet opens");
await shot("10-reader-menu");
await b.eval("document.querySelector('.sheet .seg button[aria-pressed=\"true\"]').click()");
check(await until("!document.querySelector('.sheet')", 2000), "choosing in the reading menu closes it");
check(await until("!!document.querySelector('.pm-chart svg path')", 15000), "the retelling draws its chart");
await b.eval("document.querySelector('.pm-chart').scrollIntoView({ block: 'center' })");
const bar = JSON.parse(await b.eval("JSON.stringify((() => { const r = document.querySelector('.pm-chart .hit').getBoundingClientRect(); return { x: r.x + 20, y: r.y + r.height / 2 }; })())"));
await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: bar.x, y: bar.y });
check(await until("(document.querySelector('.ch-tip')?.textContent ?? '').length > 0", 2000), "hovering a bar shows its value");
await shot("11b-reader-chart");
// digging: a tap on a sentence of the TL;DR opens the panel under it; "Is it true?" answers with a verdict and quotes
await b.eval("scrollTo(0, 0)");
const at = JSON.parse(await b.eval("JSON.stringify((() => { const p = document.querySelector('.tldr p'); p.scrollIntoView({ block: 'center' }); const r = p.getBoundingClientRect(); return { x: r.x + 12, y: r.y + 10 }; })())"));
for (const type of ["mousePressed", "mouseReleased"]) await b.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
check(await until("!!document.querySelector('.tldr .dig .dig-acts')", 3000), "a tap on a sentence opens the dig panel");
await b.eval("[...document.querySelectorAll('.dig-acts button')].find(x => x.textContent.trim() === 'Is it true?').click()");
check(await until("!!document.querySelector('.dig .verdict') && (document.querySelector('.dig .ask-a')?.textContent ?? '').length > 10", 20000), "Is it true? answers with a verdict");
await shot("11c-reader-dig");
await b.eval("document.querySelector('.dig-acts .icon-btn').click()");
check(await until("!document.querySelector('.dig')", 2000), "the dig panel closes");
// Original: the article as published; a second tap goes back to your style
await b.eval("document.querySelector('.read-acts [aria-label=Original]').click()");
check(await until("document.querySelector('.read-acts [aria-label=Original]').getAttribute('aria-pressed') === 'true' && !document.querySelector('.tldr') && (document.querySelector('.stream')?.textContent ?? '').length > 20", 10000), "Original shows the article as published");
await b.eval("document.querySelector('.read-acts [aria-label=Original]').click()");
check(await until("!!document.querySelector('.tldr p')", 15000), "a second tap goes back to your style");

// 4b. the agent: search while typing, a command with Undo, and a question to one story
await b.goto(BASE + "/");
await until("document.querySelectorAll('.card').length > 0");
const word = await b.eval<string>("document.querySelector('.card h2 a').textContent.split(/\\s+/).map(w => w.replace(/[^\\p{L}\\p{N}]/gu, '')).find(w => w.length > 3) ?? ''");
await b.click(".ask input"); await b.type(word);
check(await until("document.querySelectorAll('.ask-hit').length > 0", 5000), `typing "${word}" in the ask bar lists matching stories`);
await shot("27-ask-search");
await b.key("Escape");
check(await until("!document.querySelector('.ask-hit') && document.querySelector('.ask input').value === ''", 2000), "Escape clears the ask bar");
await b.type("never show me football"); await b.key("Enter");
check(await until("[...document.querySelectorAll('.toast button')].some(x => x.textContent === 'Undo')", 30000), "a command is applied with an Undo toast");
await shot("28-agent-command");
await b.eval("[...document.querySelectorAll('.toast button')].find(x => x.textContent === 'Undo').click()");
check(await until("(document.querySelector('.toast')?.textContent ?? '').includes('Undone')", 10000), "Undo takes it back");
await b.click(".card h2 a");
await until("location.pathname.startsWith('/story/') && document.querySelector('.stream p')?.textContent.length > 10", 10000);
check(await until("!!document.querySelector('.ask-dock .ask input')", 3000), "every story has its own ask bar");
await b.click(".ask-dock .ask input"); await b.type("What does the text say?"); await b.key("Enter");
check(await until("(document.querySelector('.ask-a')?.textContent ?? '').length > 10", 60000), "the answer streams in under the question");
check(await until("(document.querySelector('.stream p')?.textContent ?? '').length > 10", 1000), "the article stays while the answer is under it");
await shot("29-reader-ask");
// what people say: a story with stored comments shows the section, with Claude's (stub) summary and the comments as plain text
{
  const sid = Number(await b.eval("location.pathname.split('/')[2]"));
  const { Database } = await import("bun:sqlite");
  const d = new Database(process.env.PEPPERMINT_DB ?? "data/peppermint.db");
  const comments = [{ id: "e1", by: "alice", at: Date.now() - 3600_000, text: "First paragraph.\n\n<script>alert(1)</script> second paragraph", likes: null, depth: 0 }, { id: "e2", by: "bob", at: Date.now() - 1800_000, text: "A reply.", likes: null, depth: 1 }];
  d.query("INSERT OR REPLACE INTO discussions (story_id, source, url, fetched_at, comments_json, count) VALUES (?, 'hn', 'https://news.ycombinator.com/item?id=1', ?, ?, 2)").run(sid, Date.now(), JSON.stringify(comments));
  d.close();
  await b.goto(BASE + `/story/${sid}`);
  check(await until("document.querySelector('.disc h2')?.textContent === 'What people say' && !!document.querySelector('.disc .where a[href*=\"ycombinator\"]')", 15000), "story with comments shows What people say with a link to the thread");
  check(await until("/Stub: most commenters/.test(document.querySelector('.disc')?.textContent ?? '')", 15000), "discussion summary streams in");
  await b.eval("document.querySelector('.disc summary').click()");
  check(await b.eval("document.querySelectorAll('.disc .cmts li').length >= 2 && !document.querySelector('.disc .cmts script')"), "top comments list as plain text");
  await shot("11d-reader-discussion");
}

// 5. palate
await b.goto(BASE + "/palate");
check(await until("document.querySelectorAll('.bub').length > 0", 5000), "palate map has bubbles");
await shot("12-palate");
await b.click(".scale button:nth-child(7)");
check(await until("!!document.querySelector('.toast')"), "weight change confirmed");
await b.click(".rchip.add");
check(await until("document.querySelectorAll('.sheet .opt').length > 0"), "rule sheet lists values");
await shot("13-rule");
await b.click(".sheet .primary");
check(await until("!document.querySelector('.sheet') && document.querySelectorAll('.rchip:not(.add)').length > 0"), "rule added");
const duel = await b.eval<boolean>("!!document.querySelector('.duel button')");
if (duel) { await b.click(".duel button"); check(await until("!!document.querySelector('.duel .win')"), "duel pick registers"); }

// 6. sources sheet, soon pages
await b.goto(BASE + "/sources");
await until("document.querySelectorAll('.srow').length > 0");
await b.click(".srow");
check(await until("!!document.querySelector('.sheet')"), "source sheet opens");
await shot("14-source-sheet");
await b.key("Escape");
// 6b. listen: the edition as a script, read by the browser's voices
await b.goto(BASE + "/listen");
check(await until("document.querySelectorAll('.chap').length > 2 && !document.querySelector('.chap.skeleton')", 120000), "listen shows chapters");
check(await until("document.querySelectorAll('.transcript p').length > 3 && !document.querySelector('.sse-badge.live')", 180000), "episode script finished");
const voices = await b.eval<number>("speechSynthesis.getVoices().length");
console.log("      voices in this browser:", voices);
if (voices) { await b.click(".controls .play"); check(await until("document.querySelector('.controls .play')?.getAttribute('aria-label') === 'Pause'", 3000), "play starts"); await b.click(".controls .play"); }
else check(await until("!!document.querySelector('.listen .notice')", 3000), "no-voice notice shown");
await b.click(".chap:nth-child(3)"); await b.wait(300);
check(await b.eval<boolean>("document.querySelector('.chap:nth-child(3)').classList.contains('on')"), "chapter jump moves the playhead");
await shot("15-listen");
await b.click(".appbar .icon-btn");
check(await until("!!document.querySelector('.sheet .seg')"), "voice sheet opens");
await shot("15b-listen-voices"); await b.key("Escape");
await b.click(".controls .play"); await b.wait(200); await b.click(".controls .play");

// 6c. studio: draft from a story, write, quote, suggestion, preview, publish
await b.goto(BASE + "/studio");
check(await until("document.querySelectorAll('.from-story button').length > 0", 5000), "studio offers stories to start from");
await shot("16a-studio-list");
await b.click(".from-story button");
check(await until("location.pathname.startsWith('/studio/') && document.querySelectorAll('.doc [data-blk]').length >= 2", 5000), "draft created from a story");
const blocks0 = await b.eval<number>("document.querySelectorAll('.doc [data-blk]').length");
await b.eval("(() => { const els = document.querySelectorAll('.doc [data-blk]'); els[els.length - 1].focus(); })()");
await b.type("This matters to anyone who reads the news on a phone.");
check(await until("document.querySelector('.studio-top').textContent.includes('saved')", 4000), "typing autosaves");
check(await until("document.querySelector('.lp-body')?.textContent.length > 40 && !document.querySelector('.lp-body .caret')", 120000), "LinkedIn preview steeps the draft");
await b.click(".add-row .addblk:nth-child(3)");
check(await until("document.querySelector('.suggestion')?.textContent.length > 20 && !document.querySelector('.suggestion .caret') && !document.querySelector('.ghost-err')", 90000), "suggestion streams as a ghost");
await shot("16b-studio-ghost");
await b.click(".ghost-actions .primary");
check(await until(`document.querySelectorAll('.doc [data-blk]').length === ${blocks0 + 1}`, 3000), "accepting the ghost adds a paragraph");
await b.click(".add-row .addblk:nth-child(2)");
check(await until("document.querySelectorAll('.sheet .atom').length > 0", 5000), "quote picker lists facts");
await shot("16c-studio-quote");
await b.click(".sheet .atom");
check(await until(`document.querySelectorAll('.doc [data-blk]').length === ${blocks0 + 2}`, 3000), "picked fact lands as a quote");
await b.click(".add-row .addblk:nth-child(1)"); await b.type("/");
check(await until("!!document.querySelector('.slash')", 2000), "slash opens the block menu");
await shot("16d-studio-slash");
await b.key("Enter");
check(await until("!document.querySelector('.slash') && document.querySelector('.doc .blk.h:focus')?.textContent === ''", 2000), "slash menu turns the block into a heading");
await b.type("A second section");
// a chart block from the slash menu: the example JSON is drawn at once, and a typo shows a plain reason
await b.click(".add-row .addblk:nth-child(1)"); await b.type("/");
await until("!!document.querySelector('.slash')", 2000);
await b.eval("[...document.querySelectorAll('.slash button')].find(x => x.textContent.endsWith('Chart')).click()");
check(await until("!!document.querySelector('.chart-blk .pm-chart svg path') && !!document.querySelector('.chart-blk textarea')", 3000), "slash menu inserts a chart that draws");
await b.eval("{ const t = document.querySelector('.chart-blk textarea'); t.value = t.value.replace('42', '4x2'); t.dispatchEvent(new Event('input', { bubbles: true })) }");
check(await until("(document.querySelector('.chart-blk .chart-error')?.textContent ?? '').includes('JSON')", 2000), "broken chart JSON shows why");
await b.eval("{ const t = document.querySelector('.chart-blk textarea'); t.value = t.value.replace('4x2', '42'); t.dispatchEvent(new Event('input', { bubbles: true })) }");
check(await until("!document.querySelector('.chart-blk .chart-error') && !!document.querySelector('.chart-blk .pm-chart')", 2000), "fixed JSON draws again");
await shot("16d2-studio-chart");
await b.click(".seg button:nth-child(2)");
check(await until("document.querySelector('.lp-body')?.textContent.length > 20 && !document.querySelector('.lp-body .caret')", 120000), "TL;DR preview steeps");
await shot("16e-studio");
const path = await b.eval<string>("location.pathname");
await b.wait(1200);
await b.goto(BASE + path);
check(await until("[...document.querySelectorAll('.doc [data-blk]')].some(e => e.textContent.includes('A second section'))", 5000), "draft survives a reload");
await b.click(".appbar .icon-btn");
check(await until("!!document.querySelector('.sheet .pub-actions')", 3000), "publish sheet opens");
await shot("16f-studio-publish");
await b.click(".sheet .ghost.full");
check(await until("document.querySelector('.studio-top').textContent.includes('Published')", 3000), "marked as published");

// 7. pull to harvest (touch drag)
await b.goto(BASE + "/");
await until("document.querySelectorAll('.card').length > 0");
await b.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 200, y: 200 }] });
for (let i = 1; i <= 12; i++) await b.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 200 + i * 16 }] });
await shot("16-pull");
await b.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
check(await until("!!document.querySelector('.ptr.busy')", 2000), "pull starts a harvest");
check(await until("!document.querySelector('.ptr.busy') && !!document.querySelector('.toast')", 90000), "harvest finishes with a toast");

// 8. dark mode + desktop
await b.theme(true);
await b.goto(BASE + "/"); await until("document.querySelectorAll('.card').length > 0"); await shot("17-today-dark");
await b.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await b.send("Emulation.setTouchEmulationEnabled", { enabled: false });
await b.goto(BASE + "/"); await until("document.querySelectorAll('.card').length > 0"); await shot("18-desk-today-dark");
await b.theme(false);
await b.goto(BASE + "/"); await until("document.querySelectorAll('.card').length > 0"); await shot("19-desk-today");
await b.click(".card h2 a"); await until("document.querySelector('.stream p')?.textContent.length > 10", 8000); await shot("20-desk-reader");
await b.goto(BASE + "/palate"); await until("document.querySelectorAll('.bub').length > 0"); await shot("21-desk-palate");
await b.goto(BASE + "/sources"); await until("document.querySelectorAll('.srow').length > 0"); await shot("22-desk-sources");
await b.goto(BASE + "/sources/add"); await until("!!document.querySelector('.kinds')"); await shot("23-desk-add");
await b.goto(BASE + "/listen"); await until("document.querySelectorAll('.transcript p').length > 3", 20000); await shot("24-desk-listen");
await b.goto(BASE + path); await until("document.querySelector('.lp-body')?.textContent.length > 20", 60000); await shot("25-desk-studio");
await b.theme(true); await b.goto(BASE + path); await until("document.querySelector('.lp-body')?.textContent.length > 20", 60000); await shot("26-desk-studio-dark"); await b.theme(false);

// horizontal overflow check on every page at phone width
await b.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: true });
for (const p of ["/", "/palate", "/sources", "/sources/add", "/listen", "/studio", path]) {
  await b.goto(BASE + p); await b.wait(600);
  const w = await b.eval<number>("document.documentElement.scrollWidth");
  check(w <= 360, `no horizontal scroll on ${p} at 360px (${w})`);
}

const perf = await b.eval<any>("(() => { const n = performance.getEntriesByType('navigation')[0]; const p = performance.getEntriesByName('first-contentful-paint')[0]; return { ttfb: Math.round(n.responseStart - n.requestStart), dcl: Math.round(n.domContentLoadedEventEnd), fcp: p ? Math.round(p.startTime) : null }; })()");
console.log("perf", JSON.stringify(perf));
const errs = b.logs.filter(l => /error|exception/i.test(l));
console.log(errs.length ? "console:\n" + errs.join("\n") : "console clean");
console.log(fails.length ? `${fails.length} FAILED` : "ALL PASSED");
b.close();
