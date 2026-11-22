// Claude, served by one of two backends behind the same two functions (tagItems, streamLens):
//  api: the Messages API over plain fetch with ANTHROPIC_API_KEY. Haiku 5.5 tags, Sonnet 5.5 steeps.
//  cli: Claude Code in headless mode (`claude -p`), billed to the logged-in subscription. Used when no key is set.
// The subscription's OAuth token never goes into the API client; the CLI is the supported way to script it.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOODS, MOTIF_NAMES, normalizeEmblem, type EmblemSpec } from "../shared/emblem";

// Haiku tags every item and does the small faithful jobs; Sonnet writes everything a reader reads as Claude's prose.
// A blind comparison on 2026-11-20 (26 pairs, Opus as judge) found Haiku as good only where the answer copies or
// classifies: translating, reading the agent's one-line request, naming what research still misses. In briefs,
// scripts, the briefing and Studio it got facts wrong that Sonnet got right.
export const SMALL_MODEL = "claude-haiku-5-5";
export const LENS_MODEL = "claude-sonnet-5-5";
export type Model = typeof SMALL_MODEL | typeof LENS_MODEL;
/** Which model writes a lens. */
export const lensModel = (lens: string): Model => lens === "translate" ? SMALL_MODEL : LENS_MODEL;
/** Sonnet falls back on the server when it declines; Haiku has no server-side fallback, so it sends neither. */
const fallback = (model: Model) => model === LENS_MODEL ? { body: { fallbacks: "default" }, betas: ["server-side-fallback-2026-07-01"] } : { body: {}, betas: [] as string[] };

export type Backend = "api" | "cli" | "none";
let cliPath: string | null | undefined;
export function backend(): Backend {
  const force = process.env.PEPPERMINT_LLM;
  if (force === "off") return "none";
  if (force !== "cli" && (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)) return "api";
  if (force === "api") return "none";
  // on the server there is no interactive login: Claude Code counts only once its subscription token is set
  if (process.env.PEPPERMINT_CLI_NEEDS_TOKEN === "1" && !process.env.CLAUDE_CODE_OAUTH_TOKEN) return "none";
  if (cliPath === undefined) cliPath = process.env.PEPPERMINT_CLAUDE_BIN || Bun.which("claude");
  return cliPath ? "cli" : "none";
}
export const hasLLM = () => backend() !== "none";

// ---- Messages API ----
// Plain fetch, no SDK: two calls (one JSON answer, one stream) do not need one. Like the SDK it retries twice on
// 408, 409, 429 and 5xx (honouring retry-after) and gives each attempt 120 s.
const API_TIMEOUT = 120_000, API_RETRIES = 2;
async function messages(body: object, betas: string[] = [], signal?: AbortSignal): Promise<Response> {
  const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
  else if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`;
  if (betas.length) headers["anthropic-beta"] = betas.join(",");
  for (let attempt = 0; ; attempt++) {
    const t = AbortSignal.timeout(API_TIMEOUT);
    let r: Response | null = null, err: unknown = null;
    try { r = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, t]) : t }); }
    catch (e) { if (signal?.aborted) throw e; err = e; }
    if (r?.ok) return r;
    const retry = !r || r.status === 408 || r.status === 409 || r.status === 429 || r.status >= 500;
    if (!retry || attempt >= API_RETRIES) {
      if (!r) throw err;
      const detail = await r.text().catch(() => "");
      let msg = detail; try { msg = JSON.parse(detail)?.error?.message ?? detail; } catch {}
      throw new Error(`Claude API ${r.status}: ${String(msg).slice(0, 200)}`);
    }
    const after = Number(r?.headers.get("retry-after"));
    await Bun.sleep(after > 0 && after <= 60 ? after * 1000 : 500 * 2 ** attempt + Math.random() * 250);
  }
}

/** Text deltas from a streamed Messages API response (server-sent events). Throws on an error event or a refusal. */
async function* sseText(r: Response): AsyncGenerator<string> {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, end); buf = buf.slice(end + 2);
      const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      let ev: any; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") yield ev.delta.text;
      else if (ev.type === "message_delta" && ev.delta?.stop_reason === "refusal") throw new Error("refused");
      else if (ev.type === "error") throw new Error(`Claude API: ${ev.error?.message ?? "stream error"}`);
    }
  }
}

export const TOPICS = [
  "AI", "Programming", "Web development", "Databases", "Security", "Infrastructure", "Open source", "Hardware",
  "Startups", "Business", "Economy", "Politics", "Local politics", "Law", "Science", "Space", "Health", "Climate",
  "Energy", "Transport", "Traffic", "Housing", "Education", "Culture", "Food", "Weather", "Football", "Sports",
  "Crime", "Celebrities", "Crypto", "Careers", "History", "Design", "Privacy",
] as const;

const TAG_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["lang", "title_en", "summary_en", "topics", "people", "orgs", "places", "atoms", "opinion", "emblem"],
  properties: {
    lang: { type: "string", description: "ISO 639-1 code of the item's language" },
    title_en: { type: "string", description: "Plain English headline, no clickbait, max 90 characters" },
    summary_en: { type: "string", description: "One or two sentences in English: what happened" },
    topics: { type: "array", items: { type: "string", enum: [...TOPICS] }, description: "1 to 3 topics" },
    people: { type: "array", items: { type: "string" } },
    orgs: { type: "array", items: { type: "string" } },
    places: { type: "array", items: { type: "string" }, description: "Cities, districts, lines, venues; most specific first" },
    atoms: {
      type: "array", description: "3 to 6 facts from the text, each standing alone",
      items: { type: "object", additionalProperties: false, required: ["kind", "text"], properties: {
        kind: { type: "string", enum: ["what", "when", "where", "who", "why", "number", "quote", "claim", "action"] },
        text: { type: "string", description: "Short, in English" } } },
    },
    opinion: { type: "boolean", description: "True when the item is mainly opinion or self-promotion" },
    // the drawn seal a card shows when the story has no picture (shared/emblem.ts): the tagger picks the meaning, the
    // client draws the rest, so this costs a few tokens
    emblem: {
      type: "object", additionalProperties: false, required: ["motif", "mood", "word"],
      description: "A seal that stands in for a photo: the motif the story is about, a colour mood and a word around the ring",
      properties: {
        motif: { type: "string", enum: MOTIF_NAMES, description: "The one picture closest to the heart of the story, not to its section" },
        mood: { type: "string", enum: [...MOODS], description: "sun: money, energy, sport, food; mint: nature, growth, code; lilac: politics, culture, AI; sky: science, travel, weather; rose: health, crime, alarm; stone: law, security, business" },
        word: { type: "string", description: "At most 18 characters printed around the seal: the name, place or figure the story is about, in its original spelling; empty when nothing fits" },
      },
    },
  },
};

export type Tags = { lang: string; title_en: string; summary_en: string; topics: string[]; people: string[]; orgs: string[]; places: string[]; atoms: { kind: string; text: string }[]; opinion: boolean; emblem?: EmblemSpec | null; by?: string };

const TAG_SYSTEM = `You tag items for a personal news reader. Read the item and return the JSON described by the schema.
Facts only from the text. Keep proper names in their original spelling. Prefer specific places (a district or a U-Bahn line) over a whole city.
Mark atoms that are unverified assertions as kind "claim".`;

type TagIn = { title: string; summary?: string | null; body?: string | null; source: string };
const itemText = (it: TagIn, body: number) => `Source: ${it.source}\nTitle: ${it.title}\n\n${it.summary ?? ""}\n\n${(it.body ?? "").slice(0, body)}`;

/** The tag schema and instructions for one reader: the built-in topics plus the reader's own (server/topics.ts). */
function tagSpec(own: string[]) {
  if (!own.length) return { schema: TAG_SCHEMA, system: TAG_SYSTEM, allowed: TOPIC_SET };
  const all = [...TOPICS, ...own];
  return {
    schema: { ...TAG_SCHEMA, properties: { ...TAG_SCHEMA.properties, topics: { ...TAG_SCHEMA.properties.topics, items: { type: "string", enum: all } } } },
    system: `${TAG_SYSTEM}\nThe reader also follows topics of their own: ${own.join(", ")}. Whenever an item is about one of them, tag it with that topic, ahead of the general ones.`,
    allowed: new Set<string>(all),
  };
}

/** Tags a batch of one reader's items. The API backend sends one request per item (cached system prompt); the CLI
 *  backend sends the whole batch in one call. `own` are the reader's own topics, offered next to the built-in ones. */
export async function tagItems(items: TagIn[], own: string[] = []): Promise<(Tags | null)[]> {
  const spec = tagSpec(own);
  if (backend() === "cli") {
    const schema = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: {
      ...spec.schema, required: ["i", ...TAG_SCHEMA.required], properties: { i: { type: "integer", description: "Index of the item" }, ...spec.schema.properties } } } } };
    const prompt = `Tag each of the ${items.length} items below. Return one entry per item with its index i.\n\n` +
      items.map((it, i) => `<item i="${i}">\n${itemText(it, 2500)}\n</item>`).join("\n\n");
    const out = await cliJSON(prompt, spec.system, SMALL_MODEL, schema);
    const res: (Tags | null)[] = items.map(() => null);
    for (const t of (out?.items ?? []) as any[]) if (Number.isInteger(t?.i) && t.i >= 0 && t.i < items.length && validTags(t, spec.allowed)) { const { i, ...rest } = t; res[i] = { ...rest, emblem: normalizeEmblem(rest.emblem), by: SMALL_MODEL }; }
    return res;
  }
  return Promise.all(items.map(async it => {
    const r: any = await (await messages({
      model: SMALL_MODEL, max_tokens: 2000,
      system: [{ type: "text", text: spec.system, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: { type: "json_schema", schema: spec.schema } },
      messages: [{ role: "user", content: itemText(it, 6000) }],
    })).json();
    if (r.stop_reason === "refusal") throw new Error("refused");
    const block = r.content?.find((b: any) => b.type === "text");
    const t = JSON.parse(block.text);
    return validTags(t, spec.allowed) ? { ...t, emblem: normalizeEmblem(t.emblem), by: SMALL_MODEL } as Tags : null;
  }));
}

const TOPIC_SET = new Set<string>(TOPICS);
const strs = (x: unknown) => Array.isArray(x) && x.every(v => typeof v === "string");
/** The CLI's structured output is validated by the CLI; this re-checks the shape before anything reaches the database. */
export function validTags(t: any, allowed: Set<string> = TOPIC_SET): t is Tags {
  return !!t && typeof t.lang === "string" && typeof t.title_en === "string" && typeof t.summary_en === "string" &&
    strs(t.topics) && t.topics.every((x: string) => allowed.has(x)) && strs(t.people) && strs(t.orgs) && strs(t.places) &&
    Array.isArray(t.atoms) && t.atoms.every((a: any) => a && typeof a.kind === "string" && typeof a.text === "string") && typeof t.opinion === "boolean";
}

export type LensReq = { lens: "brief" | "tldr" | "translate" | "digest" | "audio" | "video" | "discussion" | "update"; lang: "en" | "de"; level: 1 | 2 | 3 };
export const LENSES = ["brief", "tldr", "translate", "digest", "audio", "video", "discussion", "update"] as const;
const LEVELS = ["", "Simple: short sentences, everyday words, explain any term.", "Standard: clear and direct, for an informed reader.", "Expert: dense, precise, keep the technical terms and numbers."];
const LANG = { en: "English", de: "German" };
const LENS_RULES: Record<string, string> = {
  update: "The reader follows this story. Say what is new since they last looked, using only the new reports and comparing with what they already knew: one to three sentences, lead with the change itself (what happened, decided, revealed or corrected), then why it matters to them. Do not repeat what they already knew. No preamble.",
  tldr: "Write a TL;DR for this one reader: one to three sentences. Lead with what in the story touches what they care about (their interests are below), then the core of what happened. Leave out what they would not care about. When public comments are given below, end with one more sentence on what the discussion says (the main view or the sharpest disagreement); without comments, do not mention a discussion. No preamble.",
  discussion: "Summarize what people say about this story, from the public comments given below: 3 to 6 short lines, each on its own line, or a short paragraph, in the reader's language. Cover the main opinions, the strongest disagreement, notable expert or first-hand comments with the commenter's handle, and anything the comments add to or correct about the article. Quote sparingly. Never invent anything that is not in the comments. No preamble.",
  translate: "Translate the original text faithfully. Keep paragraph breaks and the text's own structure markers exactly: lines starting with ## or ### stay headings, lines starting with - stay list items, **bold** stays bold. No commentary.",
  digest: "Retell the whole article for this reader, the way the reader likes to read: keep every fact, name, number, date and place that matters, drop filler, repetition and promotion, at most half the original length. Where the original has sections or lists (lines starting with ##, ### or -), keep that structure with the same markers; otherwise write short paragraphs separated by blank lines. No preamble, no commentary.",
  brief: "Write a brief for the reader's feed: three to five short sentences, at most 110 words. What happened, the one detail or number that matters, and why it matters to this reader. Write it the way the reader likes to read. No preamble, no headline, no sign-off.",
  audio: "Write a spoken script for one narrator, at most 90 seconds and shorter when there is less to say: written for the ear, short sentences, numbers as words where they read better, no symbols, no lists, no stage directions. Start with the news itself and with what touches this reader. End with what to watch next only when the material names it.",
  video: `Write a storyboard for a vertical short video of 30 to 45 seconds with 5 to 7 scenes. One scene per line, exactly \`Caption | Narration | Visual\`. Caption: at most seven words shown large on screen. Narration: one or two short spoken sentences. Visual: one JSON object on the same line saying what the scene shows, chosen only from the material given:
{"stat": "385×", "label": "less compute"}: one striking number stated in the text, with a short label
{"chart": {"title": "...", "unit": "...", "data": {"A": 1, "B": 2}}}: three or more comparable numbers from the text (chart format as usual)
{"figure": 2}: the article's figure with that number from the Figures list, only when its caption shows what the scene says
{"quote": "exact words from the text", "by": "Name"}: a strong quote, word for word
{"person": "Name"}: a person or place from the Portraits list, when the scene is about them
{"compare": [["Label", "value"], ["Label", "value"]]}: two or three values side by side
{"picture": true}: the story's own photo (only when the material says there is one)
The caption adds to the visual and does not repeat it (a stat scene's caption does not restate the number). Open with the strongest visual. Vary the kinds; avoid the same kind twice in a row unless nothing else fits. Never invent numbers, quotes, figures or people. No other text, no numbering.`,
};

// Charts: Claude adds them where the material holds numbers worth seeing side by side, in the JSON the reader draws
// (shared/chart.ts). "hero" marks a chart that says the story better than any picture; it then leads the story.
// The article's own figures may come along as pictures: the numbers printed in a benchmark table or chart count as
// material, so a launch post whose comparisons live in images still gets its charts.
export const CHART_RULE = `Charts: wherever the material gives at least three comparable numbers, add a chart right after the paragraph or list it belongs to: at most one per section and at most six in all, each showing something different. Comparable means values of the same kind on the same scale: different things measured alike (models, countries, products, parts of a price), a before and after, a series over time, or one subject's scores on several tests that all count in percent (then say so in the subtitle). One chart has one unit: a score in points never stands on a percent axis. When the material compares several things on the same tests (a benchmark table with a column per product, say), keep the comparison: x is the tests, one series per compared thing, null where no value is given, and "highlight" the story's subject; never chart only the subject's column of such a table. A long table becomes one chart per group of related rows, placed in the section about that group. Each chart is a fenced block:
\`\`\`chart
{"title": "Short title", "unit": "min", "data": {"Label A": 22.4, "Label B": 9.6}, "source": "site name"}
\`\`\`
For several series put "x" and "series" at the top level instead of "data": {"title": "...", "x": ["2023", "2024"], "series": {"Name": [1, 2], "Other": [3, 4]}}. A value may be a range [low, high]. Optional keys: "type" (bar, column, line, area, stacked), "subtitle", "format" (percent, duration in seconds, currency with "unit": "€"), "highlight" (the one label the story is about), "hero": true (only when the chart is the core finding of the story). Use only numbers stated in the text or printed in an attached figure (a value label, a table cell), converted consistently (e.g. 22m21s is 22.35 min); never read a value off a bar's height, never estimate or invent. A chart built from a figure names the article's site as source and may hold all the rows that figure prints. No chart when the numbers are not comparable. Write the JSON on its own lines, valid and compact.`;

/** A picture handed to Claude with the prompt (JPEG or PNG, at most 1568 px wide). */
export type Pic = { mime: string; bytes: Uint8Array };

export async function* streamLens(req: LensReq, story: { title: string; atoms: string; text: string; sources: string; extra?: string }, palateNote: string, images: Pic[] = []): AsyncGenerator<string> {
  const system = `You rewrite news for one reader in the app peppermint. Plain prose, no markdown of your own (a translation or a retelling keeps the markers the text already has; chart blocks follow their own rule), no emoji. Never invent facts; use only the material given.
When the article itself could not be read, write from what stands in for it: another report as that report's facts, a discussion as the opinions of commenters ("commenters on Hacker News say ..."). Never mention that the article could not be read; the app shows that next to your text.
When the material has nothing to write about (only a headline, a login, cookie or error page, boilerplate), answer exactly @thin and nothing else. Never describe the material, what it lacks or how you work.
The length follows the substance: when the material is thin (a teaser, a one-line description), write less, even a single sentence, instead of filling the space, and never invent things to watch for.
What the reader cares about: ${palateNote}`;
  const charts = req.lens === "digest" ? `\n\n${CHART_RULE}` : req.lens === "brief" ? `\n\n${CHART_RULE}\nFor a brief: at most one chart, and only when it is the story's core finding, then always with "hero": true, after the sentences.` : "";
  const user = `${LENS_RULES[req.lens]}${charts}\nLanguage: ${LANG[req.lang]}. Level: ${LEVELS[req.level]}\n\nSources: ${story.sources}\nTitle: ${story.title}\n\nFacts:\n${story.atoms}\n\n${story.extra ? `${story.extra}\n\n` : ""}Text:\n${story.text.slice(0, 12000)}`;
  // reading numbers out of figures is worth a little more thought than a plain retelling
  yield* streamText(system, user, { effort: req.lens === "video" || images.length ? "medium" : "low", images, model: lensModel(req.lens) });
}

/** One streamed answer (Sonnet unless `model` says otherwise), on whichever backend is configured. The stable system prompt goes first so it caches. */
export async function* streamText(system: string, user: string, { effort = "low", maxTokens = 4000, images = [], model = LENS_MODEL }: { effort?: "low" | "medium" | "high"; maxTokens?: number; images?: Pic[]; model?: Model } = {}): AsyncGenerator<string> {
  if (backend() === "cli") { yield* cliStream(user, system, model, effort, images); return; }
  const ac = new AbortController(), fb = fallback(model);
  try {
    const r = await messages({
      model, max_tokens: maxTokens, stream: true, ...fb.body,
      output_config: { effort },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: withImages(user, images) }],
    }, fb.betas, ac.signal);
    yield* sseText(r);
  } finally { ac.abort(); }
}

/** The pictures first, then the text that refers to them; a plain string when there are none. */
function withImages(text: string, images: Pic[]) {
  if (!images.length) return text;
  return [...images.map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: Buffer.from(i.bytes).toString("base64") } })), { type: "text", text }];
}

/** One structured answer (JSON matching `schema`), from Sonnet unless `model` says otherwise, on whichever backend is configured. The agent plans,
 *  writes dossiers and reads the palate with it. Material from the web goes in `user`, wrapped as data. `background` work
 *  (judging the day's stories) runs in the CLI's tagging lane, so a reader never waits behind it. */
export async function askJSON<T = any>(system: string, user: string, schema: object, { effort = "low", model = LENS_MODEL, background = false }: { effort?: "low" | "medium" | "high"; model?: Model; background?: boolean } = {}): Promise<T> {
  if (backend() === "cli") return cliJSON(user, system, model, schema, background ? "tag" : "read", effort);
  const fb = fallback(model);
  const r: any = await (await messages({
    model, max_tokens: 8000, ...fb.body,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    output_config: { effort, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: user }],
  }, fb.betas)).json();
  if (r.stop_reason === "refusal") throw new Error("refused");
  if (r.stop_reason === "max_tokens") throw new Error("The answer ran too long.");
  const block = r.content?.find((b: any) => b.type === "text");
  return JSON.parse(block?.text ?? "null");
}

// ---- Claude Code headless ----
// Each call is one `claude -p` process: no tools, no MCP servers, no settings, hooks or CLAUDE.md, no saved session.
// It runs in an empty directory so nothing on disk becomes context. At most two per lane run at once (fewer on a small
// server: PEPPERMINT_CLI_CONCURRENCY and PEPPERMINT_CLI_TAG_CONCURRENCY).
const CLI_DIR = join(tmpdir(), "peppermint-claude");
// Two lanes: reading (lenses, previews, suggestions) never waits behind background tagging.
const lanes = { read: { free: Number(process.env.PEPPERMINT_CLI_CONCURRENCY ?? 2), queue: [] as (() => void)[] }, tag: { free: Number(process.env.PEPPERMINT_CLI_TAG_CONCURRENCY ?? 2), queue: [] as (() => void)[] } };
async function slot<T>(lane: keyof typeof lanes, f: () => Promise<T>): Promise<T> {
  const l = lanes[lane];
  if (l.free <= 0) await new Promise<void>(r => l.queue.push(r)); else l.free--;
  try { return await f(); } finally { const n = l.queue.shift(); if (n) n(); else l.free++; }
}
export let cliLimit: { status: string; resetsAt?: number; utilization?: number } | null = null;

function cliArgs(system: string, model: string, extra: string[]) {
  mkdirSync(CLI_DIR, { recursive: true });
  return [cliPath!, "-p", "--model", model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
    "--system-prompt", system, ...extra];
}
function spawnCli(args: string[], prompt: string, signal?: AbortSignal) {
  const env = { ...process.env }; delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  const p = Bun.spawn(args, { cwd: CLI_DIR, env, stdin: new TextEncoder().encode(prompt), stdout: "pipe", stderr: "pipe" });
  const kill = () => { try { p.kill(); } catch {} };
  signal?.addEventListener("abort", kill, { once: true });
  const timer = setTimeout(kill, 180_000);
  p.exited.finally(() => clearTimeout(timer));
  return p;
}
function noteLimit(ev: any) {
  if (ev?.type !== "rate_limit_event") return;
  const r = ev.rate_limit_info ?? {}; const w = Object.values(r.unifiedWindows ?? {})[0] as any;
  cliLimit = { status: r.status, resetsAt: r.resetsAt, utilization: w?.utilization };
}
function cliError(out: any, stderr: string) {
  const msg = out?.result || out?.error || stderr.trim().split("\n").pop() || "Claude Code failed";
  return new Error(/log ?in|auth|credential/i.test(msg) ? `Claude Code is not logged in on the server (${String(msg).slice(0, 120)})` : String(msg).slice(0, 200));
}

async function cliJSON(prompt: string, system: string, model: string, schema: object, lane: keyof typeof lanes = "tag", effort = "low"): Promise<any> {
  return slot(lane, async () => {
    const p = spawnCli(cliArgs(system, model, ["--effort", effort, "--json-schema", JSON.stringify(schema), "--output-format", "json"]), prompt);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    let out: any = null; try { out = JSON.parse(stdout); } catch {}
    if (!out || out.is_error || out.subtype !== "success") throw cliError(out, stderr);
    return out.structured_output ?? JSON.parse(out.result);
  });
}

async function* cliStream(prompt: string, system: string, model: string, effort: string, images: Pic[] = []): AsyncGenerator<string> {
  const ac = new AbortController();
  let release!: () => void; const held = new Promise<void>(r => (release = r));
  const started = new Promise<void>(go => slot("read", () => { go(); return held; }));
  await started;
  try {
    // pictures reach the CLI only as a stream-json user message on stdin
    const input = images.length ? ["--input-format", "stream-json"] : [];
    const stdin = images.length ? `${JSON.stringify({ type: "user", message: { role: "user", content: withImages(prompt, images) } })}\n` : prompt;
    const p = spawnCli(cliArgs(system, model, ["--effort", effort, ...input, "--output-format", "stream-json", "--verbose", "--include-partial-messages"]), stdin, ac.signal);
    const errText = new Response(p.stderr).text();
    const dec = new TextDecoder(); let buf = "", result: any = null, any = false;
    for await (const chunk of p.stdout as any as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev: any; try { ev = JSON.parse(line); } catch { continue; }
        noteLimit(ev);
        if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta") { any = true; yield ev.event.delta.text; }
        else if (ev.type === "result") result = ev;
      }
    }
    await p.exited;
    if (!result || result.is_error || result.subtype !== "success") throw cliError(result, await errText);
    if (!any && result.result) yield result.result;
  } finally { ac.abort(); release(); }
}
