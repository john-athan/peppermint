# peppermint backend

This spec describes the server that turns many sources into one short, personal edition. It covers what is built, the rules every change follows, and the work still open (section 10).

## 1. Job

The backend does five things in a pipeline, and four more on request:

1. **Harvest:** pull items from sources (Hacker News, merkur.de, podcasts, YouTube channels, any site with an RSS, Atom or JSON feed).
2. **Atomize:** tag each item with language, English title, topics, people, orgs, places, facts, an opinion flag and an emblem (motif, mood, a word; `shared/emblem.ts` draws it on cards without a picture, and falls back to the topic when the tagger gave none).
3. **Cluster:** merge items about the same event into one story.
4. **Score:** rank stories against the palate (the user's taste model) and build an edition of about 12 stories per slot.
5. **Steep:** on demand, rewrite one story into a lens (TL;DR, the retelling in your style, translation) in the chosen language and level, streamed live.
6. **Listen:** write the edition as a spoken script; the browser's voices read it.
7. **Studio:** keep drafts, stream suggestions and previews of a draft in other forms.
8. **Search:** find stories in everything you follow while you type (FTS5, bm25, trigram fallback).
9. **Agent:** turn one typed line into something the app already shows (section 5, "The agent").

One process does all of it. A single user is the target, but every row carries `owner_id`, so a second user needs no schema change.

## 2. Architecture

```
            ┌──────────── one Bun process ─────────────────────────────┐
 sources    │ connectors ─▶ items ─▶ tag ─▶ cluster ─▶ stories          │
 HN API ───▶│   (pull)       │       (LLM or     │                      │
 merkur RSS▶│                │        lexicon)   ▼                      │
 feeds ───▶│                ▼                palate ─▶ editions        │──▶ PWA (Svelte)
 YouTube ──▶│             FTS5               (score)                   │    SSE + JSON
            │                                   │                      │
            │   lens · episode · draft ◀── request ◀─┘  caches         │
            │   (steep: one generation, SSE, shared by waiters)         │
            │ scheduler tick 60 s · auth (passkeys) · static assets     │
            └──────────────────────── SQLite (WAL) ────────────────────┘
```

| Module | File | Owns |
|---|---|---|
| HTTP and routing | `server/main.ts` | routes, CSP, asset serving, boot data, scheduler |
| Storage | `server/db.ts` | schema, migrations, `setting` helpers |
| Connectors | `server/connectors/` | the `Connector` contract, HN, merkur, feed, podcast, YouTube; fetch with a public-address guard, HTML extraction |
| Pipeline | `server/pipeline.ts` | insert, cluster, `harvest()` with progress events |
| Tagging | `server/tag.ts` | LLM tagging, local lexicon fallback |
| LLM layer | `server/llm.ts` | backends (API, Claude Code), models, schemas, `tagItems`, `streamText`, `streamLens` |
| Streams | `server/steep.ts` | one generation per key, shared by waiters, cached, resumable |
| Palate | `server/palate.ts` | scoring, signals, edition build, slots |
| Lenses | `server/lens.ts` | story material, lens cache |
| Listen | `server/listen.ts` | episode script (Claude or local), cached per edition and language |
| Studio | `server/studio.ts` | drafts, block validation, suggestions, previews, quote picker |
| Search | `server/search.ts` | story search over the `search` and `search_tri` indexes, snippets |
| Agent | `server/agent.ts` | plans one input, dossiers, probes, palate proposals with preview and undo, Ask answers |
| Media | `server/media.ts` | copies of every image shown (the browser should not contact sources), served per owner, size read from the file header |
| Images | `server/images.ts` | which picture a story gets, which logo a source gets, portraits of people and places from Wikipedia |
| Auth | `server/auth.ts`, `server/accounts/` | the accounts module (owned by oss-kit, `docs/accounts.md`): passkeys, links, roles, sessions |

**Data flow rules:**
- Modules call downward only: `main` → `pipeline`/`palate`/`lens` → `tag`/`llm`/`connectors` → `db`. Nothing below `main` knows about HTTP, except `steep.ts`, which returns a `ReadableStream` of SSE frames.
- Connectors never write to the database. They return `{items, updates, cursor}`; the pipeline persists.
- The LLM layer never reads the database. Callers pass the material in.

## 3. Tech stack

| Choice | Why |
|---|---|
| **Bun 1.3** | One binary for runtime, bundler, test runner and SQLite. `Bun.serve` streams SSE natively, `HTMLRewriter` extracts articles without a DOM library, `bun build --compile` ships one file. |
| **SQLite (`bun:sqlite`), WAL, STRICT, FTS5** | The workload is many small transactional writes (signals, ranks) and point reads, which is SQLite's home. DuckDB is columnar and built for scans over large tables; nothing here scans. One file, zero ops, backups by copy. |
| **Svelte 5 (runes)** | Smallest runtime of the compiled frameworks: the whole client is 53.5 KB JS after brotli. Compiled by a 30-line Bun plugin, no Vite. |
| **No other dependencies** | Svelte is the only package. Claude is two `fetch` calls in `server/llm.ts` (one JSON answer, one SSE stream); a test fails when `package.json` gains anything else. |
| **Claude Haiku 5.5** for tagging | Runs on every item, so price and speed matter; structured output (`json_schema`) makes the result typed. |
| **Claude Sonnet 5.5** for lenses, episodes and Studio | Runs only when the user asks; streamed. Sonnet writes well enough for rewriting given material and is faster and cheaper than Opus. |
| **WebAuthn by hand** | Passkeys without a library, in the fleet's shared accounts module: WebCrypto verifies, a small CBOR reader takes the COSE key from the attestation. Keys from before the module are SPKI and still verify. |
| **SSE, not WebSockets** | Server-to-client only, works through any proxy, resumes with `Last-Event-ID`. |
| **Web Speech API** for Listen | The device's own voices: free, offline, no audio files. Speaking per sentence gives seeking, speed and chapters. A TTS API (ElevenLabs or similar) stays an option for studio-quality audio. |

**Dependency rule:** a new runtime dependency needs a reason that the platform (Bun, Web APIs, SQLite) cannot meet. Dev tools follow the same rule: the CDP driver, the API stand-in and the e2e runner are each under 150 lines.

## 4. Data model

All tables are `STRICT`, timestamps are epoch milliseconds, every user-owned row has `owner_id`.

| Table | Holds | Key points |
|---|---|---|
| `users` (with `role`), `auth_*` | identity: the accounts module's passkeys, sessions and links | session and link tokens stored as SHA-256 hashes only |
| `sources` | one row per subscribed source | `kind`, `config` JSON, `cursor` JSON, `cadence_min`, `trust`, `last_error` |
| `items` | raw items | unique `(source_id, ext_id)`; `tags` JSON; `tagged` flag; `story_id`; FTS5 mirror via triggers |
| `stories` | clusters of items | `keys` (title words, `@person`, `@org`), merged `tags`, `item_count` |
| `editions`, `edition_items`, `edition_cut` | the harvest per slot | rank, score, reasons; the cut list keeps what fell below the line so it can be rescued |
| `affinities` | palate weights | `(kind, name)` with weight −3..3 |
| `rules` | hard rules | `always`, `boost`, `mute`, `never` on topic, person, place or source |
| `signals` | every user action | open, read, lens, more, less, rescue, skip, duel; drives affinities |
| `lens_cache` | finished lenses | keyed `(story, lens, lang, level)`, cascades with the story |
| `digs` | answers about one sentence of a story | keyed `(owner, story, kind, sentence, question, lang)`; quotes the sources do not hold are dropped before saving |
| `settings` | per-user knobs | budget, threshold |
| `judged` | Claude's order of the candidates | `(owner, story)` with `rank` out of `of` kept, `NULL` when left out; `at` is the run |
| `episodes` | spoken scripts | keyed `(edition, lang)` with the story list as signature, so a changed edition gets a new script |
| `drafts` | Studio drafts | `blocks` JSON (heading, paragraph, cited quote, claim note), status, saved with a version check |
| `pins` | the reading list | `(owner, story)`; saved stories leave Today and live on the list |
| `media` | image copies | keyed by owner and image link; fetched once with the address guard, width and height stored; kept 21 days after last use |
| `icons` | source logos | per owner and host: the largest icon the site declares, else `/apple-touch-icon.png` or `/favicon.ico`; 32 px or more preferred, 16 px accepted. Looked up on first ask through `/api/icon/:host`; a source's host is its feed's site (`sourceHost`). Rechecked every 14 days |
| `entities` | people and places | Wikipedia lead image per name and language, shared cache, rechecked after 30 days |
| `search`, `search_tri` | the search index | FTS5 over title, tag names, summary and text (unicode61), and over title and names as trigrams; kept by triggers on `items` |
| `tasks` | what an agent request became | `dossier`, `probe`, `explain`, `link`; steps, result JSON, the story it made |
| `proposals` | palate changes by the agent | `command` (applied at once) or `inference` (offered); the changes, the values they replaced (`before`), an edition preview |
| `asks` | questions about one story | question, language, answer with quoted passages |

**Migrations:** `schema_version` plus an ordered list in `db.ts`. A migration is append-only; an applied one is never edited.

## 5. Pipeline in detail

**Connector contract** (`server/connectors/index.ts`):

```ts
interface Connector {
  kind: string; label: string;
  discover(input: string): Promise<Discovered[]>;          // validate a URL or name, propose sources
  pull?(src, config, cursor): Promise<{ items: RawItem[]; updates?: Update[]; cursor: unknown }>;
}
```

- Connectors are polite: one shared `get()` with a user agent, timeouts, `ETag`/`If-Modified-Since`, and a concurrency `pool()`.
- Article bodies come from `extract()` (HTMLRewriter) with a per-site paragraph selector and a generic fallback.
- **Newsletter connector** (`connectors/newsletter.ts`, kind `mail`): each newsletter source gets its own plus address on peppermint's mailbox (`peppermint+nl-<10 chars>@` your domain), made when the source is made. A pull asks JMAP (`server/jmap.ts`) for mail to exactly that address since the last pull; each mail is an item: subject as title, the HTML read into text (layout tables, hidden preheaders, styles and pixels dropped), the "view in browser" link as the item's link, the unsubscribe link in its meta. A confirmation mail's confirm link is kept on the source until the first regular issue, and the Sources page offers it. Needs `PEPPERMINT_JMAP_URL`, `PEPPERMINT_JMAP_USER`, `PEPPERMINT_JMAP_PASSWORD` and `PEPPERMINT_REPLY_ADDRESS`; without them the picker says so.
- **ECHA lists** (`connectors/official.ts`, kind `echa`): echa.europa.eu refuses servers, so the Candidate List, the REACH restrictions (Annex XVII) and the Authorisation List (Annex XIV) come from ECHA CHEM's own JSON API with a browser user agent. Each list is read whole (about 250, 80 and 60 entries) and compared with the last pull: on the Candidate List one item per day of inclusion, on the other two one item per pull with what was added and amended. The first pull is the baseline and shows only the Candidate List's latest day. Twice a day.
- **EU consultations** (`connectors/official.ts`, kind `consult`): the search API behind Have your say, per keyword. An item whenever a matching initiative opens a feedback period (call for evidence, public consultation, draft act, proposal), with the deadline in its title and `meta.deadline`; the same initiative opening its next stage is news again. Twice a day.
- **Keyword filters** (`server/filter.ts`, column `sources.filter`): "only items that mention" and "never items that mention", per source, applied in `pullSource` before anything is stored. Whole words or phrases, case and accents ignored, `*` at the end for a prefix. What a filter drops is not kept, so a filter changed later applies from then on.
- **Feed connector:** a pasted site or feed link is resolved through `<link rel="alternate">`, then common paths (`/feed`, `/rss.xml`, `/atom.xml` and more). RSS, Atom and JSON Feed parse into the same entries. The first pull takes the newest 15; a summary under 700 characters means the article itself is read. Every fetch for a user-given address goes through `assertPublic`: http(s) only, no private, loopback or link-local address, checked again on each redirect.

**Tagging:** up to 50 untagged items from the last 72 h per run (the scheduler takes the rest a minute later, so a pull never waits on a backlog), in batches: one item per API request (four at a time), 25 items per Claude Code call. LLM first; on any error or invalid result, the local lexicon tags the item, so the palate never stalls. Older items are marked tagged with empty tags.

**Clustering:** an item joins a story from the last 72 h when `(≥3 shared words and similarity ≥0.6)` or `(≥1 shared person/org and ≥2 words and similarity ≥0.4)`. Places never count as evidence: half of merkur is "München".

**Scoring:** a sum of readable reasons (rules, topic weights, entities, source trust, freshness, story size, HN points, language cost, opinion), squashed with `1 / (1 + e^(-(raw-0.15)*4))`. Every reason is stored, so "Why you see this" is the score itself, not an explanation written afterwards.

**Claude's judgement** (`server/judge.ts`): Haiku reads who the reader is (palate weights and rules, followed stories, research questions, what they read and waved off in the last 14 days) and one line per candidate (`id | source | headline | gist`, newest first, at most 400, the palate's best on a busier day), and answers with the ids worth the reader's time, most interesting first; what it leaves out it judged not worth showing. It runs in the background on the CLI's tagging lane: after a restart, after a palate change by hand or by proposal, and otherwise when new candidates came in and the last run is 30 minutes old. A run over 400 candidates took 3 to 18 s in tests on the CLI.

**Edition build:** budget 12. Once Claude judged in the last 24 h, its order decides: the first 12 it kept, with no topic cap, threshold or local slot on top; a story it left out is cut as "Claude left it out", one that arrived after its run waits as "Claude has not read it yet". The card's score is its place in that order (1 for the first) and the first reason says "Claude's pick: 3 of 41". Before the first run, without Claude, and for the agent's previews, the palate's score decides: threshold 0.55, at most 2 stories per lead topic, one local slot. Never and always rules, stories on trial and stories the user touched hold in both. Slots follow Europe/Berlin: morning, and evening from 17:00.

**Feed after the edition:** the last week, a page at a time. With a judgement: Claude's latest run in its order, then what earlier runs kept, then unjudged stories the palate rates likely interesting; what Claude left out stays out. Without one: the palate's score with a floor a little below the threshold, two per lead topic first.

**Material and research** (`server/material.ts`): a story whose articles give little to read is researched before
Claude writes about it. Each item gets a grade from its own text, without a model: `walled` (a login, paywall, cookie,
script or error page), `thin` (under 60 words), `partial` (under 180), `full`. Podcasts, videos and posts count as full.

| Step | When | What it adds |
|---|---|---|
| Original page | the link is a wrapper (archive.org copy, AMP, a redirect link) | the page's own text replaces the body |
| Archived copy | the page was walled or thin | the newest Wayback snapshot's text |
| Discussion | an HN item that is still short | the top-level comments (`meta.discussion`); enough for a brief that says it retells the discussion |
| Other report | still nothing readable | one Bing News hit sharing at least 3 and 60 % of the headline's words (`meta.coverage`) |

| Rule | Why |
|---|---|
| Research runs inside the brief's own stream and sends `status` events; the card shows a shimmer and the step | only that card waits; Today and every other card stay usable |
| One run per story, joined by every lens and the background warm-up; 25 s at most | a slow site never piles up fetches |
| A page that only showed a wall goes to Claude as "(the page could not be read)" | Claude cannot describe a login page it never sees |
| Claude answers `@thin` when the material has nothing to write about; `thinGuard` holds the first characters back | the reader never sees the word or a paragraph about missing material |
| Nothing found: every item gets `meta.unreadable`, the card is slim (headline, "Open the original"), the score gets "Only the headline could be read" (-0.3), `seen` and `skip` on it move no weight | the headline still shows, but it neither leads nor teaches the palate |
| A brief is written only for a story graded `full` after research; a shorter one is `short` on its card, which shows the tagger's summary, and the Reader offers no TL;DR | condensing needs more text than a card shows; asked to fill sentences without material, Claude describes what is missing |
| The client streams at most four briefs at once | research can hold a stream open; the page's own requests must not queue behind cards |

**Learning:** each signal moves affinities by a fixed step (0.16 per weight unit, `SIGNAL_W` per kind). A weight set by hand lands in the same table; later signals move it from there.

### Pictures (layout D)

Rules come from what the sources really send (measured on 18.11.2026: merkur.de 84 of 85 stories with a 1200×675 photo,
Hacker News links 7 of 14 with a share picture, blogs none):

| Rule | Why |
|---|---|
| Wide (ratio ≥ 1.25) and ≥ 560 px: across the top of the card | news photos and video stills |
| Ratio 0.8 to 1.25: 72 px square beside the text | podcast artwork |
| Portrait (ratio < 0.8): reader only, shown whole | posters and vertical video crop badly |
| Under 200 px wide: dropped | blurry |
| Same link on 3+ items of one source: dropped | logos and stock share cards |
| People and places only for portraits | Wikipedia leads company articles with their building |

Pictures come from the feed (`media:content`, enclosures, `itunes:image`), else the article's `og:image` or
`twitter:image`, read while extracting the text; the first caption with a © becomes the credit. YouTube asks for
`maxresdefault` and falls back to `hqdefault`. `queueImages` copies what the newest edition and the reading list
need after each harvest; a card shows a picture only once its copy exists. SVG is never copied (it could carry
script on our origin), and copies are served with `sandbox`. Pages ask for `?w=160|320|480|800|1200`; each width
is made once with libvips (`vipsthumbnail`, WebP; `sips` on a Mac) and kept in `media_variants`. A picture whose copy
is not fetched yet still goes out with a guessed shape (`pending`): the first view fetches it behind the
peppermint shimmer (`.pm-shimmer`, with `.leaf` for picture slots), and the card corrects the shape from the
loaded picture's ratio. Palate › Briefs has a switch to turn pictures off.

### Charts

A chart is a fenced block of JSON inside any text peppermint renders (lens output, Studio drafts):

```
```chart
{ "title": "Minutes per bug fix", "unit": "min", "data": { "Gemini 4 Carbon": 22.35, "Opus 5.5": 9.55 }, "hero": true }
```
```

`data` maps labels to numbers for one series; `x` plus `series` gives several. A value may be a range `[low, high]`.
Optional: `type` (bar, column, line, area, stacked), `subtitle`, `source`, `note`, `unit`, `format` (percent, duration
in seconds, currency), `highlight`, `sort`, `hero`. `shared/chart.ts` normalizes and formats (used by client, server
and tests); `client/components/Chart.svelte` draws. Claude adds a chart to "In my style" and explainers when the text
has at least three comparable numbers, and to a brief only when it is the story's core (`hero`): the card then shows
the chart instead of the picture, and the reader puts it under the headline. Studio has a Chart block (`/`, JSON with
a live drawing) and "Chart from my numbers" (Claude reads the draft). Colours: six slots led by peppermint green,
checked with the dataviz validator in both themes; more than six series fold into "Other".

### The agent

One input bar on Today, Palate, the Reader and the dossier page. Where you type sets the scope. Nothing the agent makes
is a chat message; each answer is an object with its own place:

| You type | It becomes | Where |
|---|---|---|
| a link (also from the system share sheet, `/share`) | an item in the "Shared by you" source, tagged and clustered like any other | the Reader; a card on Today |
| a question about the world ("what's going on with …") | a dossier: a story built from a news search, plus a written state of things (summary, timeline, people, questions) | a topic in Research (`/research`), `/dossier/:id` |
| Research on a story in the Reader | the same dossier, planned from what that story says; its headline, picture and chips fly into Research and stay on the dossier as "Started from"; the same story again opens it | Research, `/dossier/:id` |
| "keep me posted" | the same dossier, followed: searched again every 6 h for 14 days; news leads Today as an update card, and the dossier opens with "Since you last read" | the dossier |
| a wish ("never football", "more energy") | a palate change, applied at once, with undo | toast, History |
| "why do I see …" | an explanation from the weights, rules and your behaviour | a card on Palate and Today |
| "check my palate" | up to three proposals, each with the evidence and what this edition would change | Palate |
| "something new" | probes: up to three stories on adjacent subjects; More of this / Not for me is a normal signal | Today |
| a question in the Reader | the Ask lens: an answer whose sentences point at quoted passages | the Reader |

| Rule | Why |
|---|---|
| The model plans and writes; `agent.ts` does every read and write, and checks what the model asks for (`cleanChanges`: known kinds, topics from the list, your own sources, weights in -3..3, at most eight) | nothing the model says reaches the database unchecked |
| Dossier and probe stories stay out of the edition, the endless feed and clustering (`AGENT_STORIES` in `db.ts`) | the edition stays the finite 12 the palate chose |
| What you said applies; what the agent inferred is offered | your hand beats the model |
| Every applied change keeps the values it replaced and is logged as an `agent` signal; History can undo it | every change is explainable and reversible |
| The edition preview builds the edition twice inside a transaction that is rolled back | the preview is the real build, not an estimate, and leaves nothing behind |
| Research uses the topic source's news search and the address-guarded page reader, not a model-side web tool | works on both backends, one fetch path, the same guard |
| Ask answers keep only quotes found word for word in the story's text | no claim stands on a passage the source never wrote |
| Agent sources (kind `agent`) are switched off and hidden from Sources | no harvest pulls them and your source count stays yours |
| A dossier you ask for (the first run, a steer) is researched in rounds: three or four planned questions with a search each, then up to two more rounds searching what Claude finds open or one-sided; at most 20 articles, 150 s. The scheduled refresh is one round | one search reads one angle; the second and third rounds bring the critics, those affected and the newer reports |
| Only readable articles go into a dossier: a walled page gets its Wayback copy (`archivedText`, shared with the reader's research) or is replaced by the next hit; an agency text already in it under another headline is left out (six-word runs, over half shared) | measured on 19.11.2026: one round kept 5 paywall stubs of 8; the deep run kept 20 readable reports from 18 outlets |
| Every timeline entry and answer names its articles (`src`, numbers checked against the material, shown as links); the text names outlets, never numbers | a claim you can open is a claim you can check |
| Research is a folder of topics (`GET /api/research`), the way List is a folder of articles: news first, then what is running (with its step), then the newest; Today shows no dossier cards, only update cards for followed topics with news | articles and topics are different things to keep; Today stays the edition |
| Following a dossier is following its story (a `follows` row, the same `seen_at`, the same `update` lens); the reader's and the list's Follow on that story switch the dossier's search on and off | one meaning of "follow": a story waits for your sources, a dossier also searches, both say what changed since you last read |
| A run you asked for (the first, a steer) marks what it found as read; a scheduled refresh with new reports leaves them unread and drops the cached "what changed" | you saw what you asked for; what arrived while you were away is the news |

Without Claude, links still work; every other request answers 503 with a sentence saying why.

### Investigations and publishing

Something the writer noticed (photos, a note, since when) becomes a researched piece in their voice, on their own
public page. `server/investigate.ts` runs a case in saved stages, so a restart resumes it: `see` (Sonnet reads the photos:
what is there, signs, faces and plates as boxes), `plan` (the place via OpenStreetMap, who runs it, searches, Wikipedia
titles, up to three questions only the writer can answer, one or two offices with a drafted question), `known` (news
search, pages read and graded by Haiku, the writer's own harvest), `background` (Wikipedia), `assess` (story, short note
or nothing; three angles), `write` (waits `PEPPERMINT_ANGLE_WAIT_MS`, default 4 min, for the writer to pick an angle, then
Sonnet writes Studio blocks citing evidence ids) and `check` (Sonnet tests each block against its evidence; a sentence
nothing carries becomes an unverified claim; up to three editor notes). Then a notification (`server/notify.ts`: Web Push
from `server/push.ts`, email to the briefing address when no device takes it).

| Rule | Why |
|---|---|
| Every fact the case knows is a row in `evidence` with its kind and origin; blocks cite evidence ids, checked to be the owner's on every save | the Sources panel, the public footnotes and the update proposals all read one record |
| Photos are shrunk and re-encoded on the device (location read first from EXIF by `shared/exif.ts`, then dropped); the public copy, faces and plates blurred, is made in the browser from Claude's boxes and uploaded separately | the server needs no image library, and no original ever leaves through a public URL |
| A piece with a page goes live only through `POST /drafts/:id/publish`, which refuses while a claim is unverified, someone it blames had no chance to reply, the imprint is missing or the photo has no public copy | the checks are the server's, not a button's |
| An unverified claim is cut, or kept as an open question (`open: true`, which states nothing and needs no source) | a published piece asserts only what its sources carry |
| After the piece, a case watches for 14 days: news searches every 6 h, answers by mail (JMAP, `server/jmap.ts`, plus addressed `Reply-To` per case) or pasted by hand; new evidence becomes a proposal (`pending`) the writer applies with one tap; on a live piece that adds a public "update" note | corrections and updates are visible, never silent |
| The public page (`server/public.ts`, everything under `/@handle`) is plain HTML with its own strict CSP; reads are counted for strangers only, not for bots or the owner; tips and subscriptions are rate limited per address; subscribing needs a confirmation link | the one part of peppermint that is open to anyone stays small and boring |


## 6. LLM layer

`llm.ts` exposes `tagItems(items)`, `streamText(system, user)` (with `streamLens` on top) and `askJSON(system, user, schema)` (one structured answer, Sonnet unless the caller asks for Haiku; used by the agent and the judge) and hides who serves them:

| Backend | Chosen when | How |
|---|---|---|
| `api` | `ANTHROPIC_API_KEY` is set | plain `fetch` to the Messages API (two retries, 120 s timeout); Haiku tags with `json_schema` output, Sonnet streams with the server-side fallback beta; system prompts cached |
| `cli` | no key, `claude` on the PATH | `claude -p` per call with no tools, no MCP, no settings or CLAUDE.md, no saved session, in an empty directory; tags use `--json-schema`, text uses `stream-json` with partial messages; billed to the logged-in subscription |
| `none` | neither, or `PEPPERMINT_LLM=off` | lexicon tagging; Claude features show a clear "off" notice |

- The subscription's OAuth token is never passed to the API client. That use is not permitted; the CLI is the supported route. On a server, `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` logs the CLI in.
- The CLI runs in two lanes: reading (lenses, episodes, Studio) gets 2 processes, background tagging gets 2 of its own, so a reader never waits behind a tagging batch.
- Results from the CLI are validated again (`validTags`) before they reach the database.

**Prompt rules:** prompts live next to their schema; the stable part goes first and is cached; source material is wrapped as data, never as instructions; output limits are set per call; claims from a single source stay marked as unconfirmed in every rewrite, in plain words.

## 7. HTTP API

JSON over `/api/*`, SSE where marked. Cookie session (`__Host-peppermint`, Secure, HttpOnly, SameSite=Lax so links from the briefing mail arrive signed in; 30 days after last use, 180 at most) for the app.

| Area | Routes |
|---|---|
| Accounts | the module's routes, answered before the app's own: `/auth/*`, `/account`, `/passkeys`, `/sessions`, `/members` (`docs/accounts.md`) |
| Edition | `GET /edition`, `GET /edition/cut`, `GET /harvest` (SSE progress), `POST /edition/rebuild` |
| Stories | `GET /stories/:id`, `GET /stories/:id/original`, `GET /stories/:id/lens/:lens?lang&level` (SSE; lenses `brief`, `tldr`, `digest`, `translate`, `audio`, `video`, `discussion`, `update`), `GET /stories/:id/dig?k&s&q` (SSE; digging into sentence `s`: `k` is `true`, `data`, `who`, `explain` or `ask` with question `q`) |
| Reading list | `GET /list` (saved stories; saving is the `pin` signal, removing `unpin`) |
| History | `GET /history`, `GET /history/export` (JSON download), `DELETE /history` (signals only; palate weights stay) |
| Creators | `GET /creators?kind=podcast|youtube&q` (Apple's podcast directory, YouTube's channel search or a pasted link/@handle; no account) |
| Sources | `GET/POST /sources`, `PATCH/DELETE /sources/:id`, `GET /discover?q` |
| Media | `GET /media/:key` (the owner's image copies) |
| Palate | `POST /signals`, `GET /palate`, `PUT /affinities`, `PUT /settings`, `GET /rule-values`, `POST /rules`, `DELETE /rules/:id`, `GET /duel` |
| Listen | `GET /listen?lang` (SSE: the episode script, `@intro` / `@story <id>` / `@outro` parts) |
| Search | `GET /search?q&limit` (cards with a snippet; matched words between `\u0002` and `\u0003`) |
| Investigations | `POST /cases` (form: `photo`, `taken_at`, `note`, `since`, `lat`, `lng`), `GET /cases`, `GET /cases/today`, `GET /cases/:id`, `POST /cases/:id/{answer,angle,anyway,retry,drop,watch,reply}`, `PUT /cases/:id/contacts/:cid`, `POST /cases/:id/contacts/:cid/send`, `POST /cases/:id/update/{apply,skip}`, `GET /place?lat&lng` |
| Desk | `GET /drafts/:id/desk`, `POST /drafts/:id/{rewrite,ask,question,weave,publish,unpublish,preview-link,corrections}`, `PATCH /drafts/:id/meta`, `POST /drafts/:id/versions/:vid/restore`, `GET/PATCH /photos/:id`, `PUT /photos/:id/public`, `POST /reader-notes/:id/done` |
| Writer | `GET/PUT /writer` (voice and profile), `POST /writer/{learn,try}`, `PUT /profile`, `GET /push/key`, `POST /push/{subscribe,unsubscribe,test}` |
| Public | `/@handle`, `/@handle/:slug`, `/@handle/feed.xml`, `/@handle/impressum`, `/@handle/photo/:id`, `/@handle/preview/:token`, `POST /@handle/:slug/{tip,beacon}`, `POST /@handle/subscribe`, `/@handle/{confirm,unsubscribe}/:token` (outside `/api`, no login) |
| Agent | `POST /agent` (`input`, `scope`), `GET /agent` (open tasks and proposals), `GET /agent/tasks/:id`, `POST /agent/tasks/:id/{steer,follow,react,dismiss,draft}`, `POST /agent/proposals/:id/{apply,dismiss,undo}`, `GET /stories/:id/asks`, `GET /stories/:id/ask?q` (SSE) |
| Studio | `GET/POST /drafts`, `GET/PUT/DELETE /drafts/:id` (PUT takes `base` and answers 409 on a stale save), `GET /drafts/:id/suggest?after&nth` (SSE), `GET /drafts/:id/preview/:form` (SSE), `GET /atoms?q` |

**SSE contract:** every text event has an `id`; a lens may also send `status` (`{ text }`, what research is doing) and close with `done` carrying `material: "none"` when there was nothing to write; a reconnect with `Last-Event-ID` resumes from there. A text being generated is shared: a second reader joins the same generation instead of starting another. Errors arrive as an `error` event with a code (`no_llm`, `llm`), never as a broken stream.

**Security:** every mutating request must come from our origin (`Origin`, or `Sec-Fetch-Site: same-origin`); every query filters by `owner_id`, and `tests/isolation.test.ts` tries each id-taking route across two accounts; Studio blocks are validated and may only cite the owner's stories; CSP allows only self; the setup link needs `PEPPERMINT_SETUP_TOKEN` and dies after the first passkey; a new reader starts with the default palate (`seedOwner` in `server/auth.ts`).

## 8. Runtime and deployment

| Env | Default | Purpose |
|---|---|---|
| `PORT`, `HOST` | 4317, `0.0.0.0` | listen address |
| `PEPPERMINT_ORIGIN` | `http://localhost:4317` | WebAuthn origin, RP ID derived from it |
| `PEPPERMINT_DB` | `data/peppermint.db` | database file, `:memory:` in tests |
| `PEPPERMINT_SETUP_TOKEN` | random, printed | first-passkey link |
| `PEPPERMINT_NO_SCHEDULER` | unset | disables the 60 s tick |
| `ANTHROPIC_API_KEY` | unset | selects the API backend |
| `PEPPERMINT_LLM`, `PEPPERMINT_CLAUDE_BIN`, `PEPPERMINT_CLI_CONCURRENCY` | auto, PATH, 2 | backend choice and CLI tuning |
| `PEPPERMINT_SMTP`, `PEPPERMINT_SMTP_USER`, `PEPPERMINT_SMTP_PASSWORD`, `PEPPERMINT_SMTP_TLS_NAME` | `127.0.0.1:25`, unset, unset, the host | where the briefing is sent; 465 means TLS, a user means AUTH PLAIN (on the mail server's own machine: `127.0.0.1:465` with a login, so the server signs it with DKIM) |
| `PEPPERMINT_JMAP_URL`, `PEPPERMINT_JMAP_USER`, `PEPPERMINT_JMAP_PASSWORD`, `PEPPERMINT_REPLY_ADDRESS` | unset | peppermint's mailbox over JMAP: replies to investigations (`+case-…`) and newsletter sources (`+nl-…`); for example `https://mail.example.org/.well-known/jmap` |
| `PEPPERMINT_BACKUPS`, `PEPPERMINT_DIST` | beside the database, found | backup folder, built assets |

- **Where it runs:** a small Linux server as `peppermint.service`: dynamic user, state in `/var/lib/peppermint`, 450 MB memory cap, low CPU and IO weight, localhost only. nginx on 443 switches by SNI and terminates `peppermint.kaleve.dev` itself (Let's Encrypt), letting only Cloudflare's addresses in, with buffering off for SSE. No login gate sits in front; the app's passkeys decide (`docs/accounts.md`), and `tests/open-surface.test.ts` holds the open surface. The app is listed on tools.kaleve.dev.
- **Deploy:** `deploy/deploy.sh` builds a Linux binary (`bun build --compile --target=bun-linux-x64`), copies it with the assets, keeps the previous build as `.prev`, restarts and checks `/healthz`.
- **Secrets:** `/etc/peppermint.env` (root, 0600): the setup token, the SMTP login for the briefing, and an API key or Claude Code token when Claude should run on the server.
- **Backups:** the scheduler writes a `VACUUM INTO` snapshot once a day and keeps the last 7; the database is the only state.

## 9. Guidelines

**Product rules:**
- A feature is complete or absent. Unfinished surfaces show "coming soon", never a half-working control.
- Every score is explainable: a ranking change must add a stored reason, not a hidden factor.
- The app works without any LLM. Each LLM feature has a local fallback or a clear disabled state.
- The user's hand always beats the model: rules before scores, a weight set by hand is the starting point for learning, touched stories stay.

**Code rules:**
- Read the problem fully, then take the first step that holds: does it need to exist, does Bun or the platform already do it, only then new code.
- No new dependency without a written reason (section 3).
- SQL stays in plain `db.query` strings next to the code that uses it. Batch writes go in `db.transaction`.
- Every query that touches user data filters by `owner_id`. A test for each new route should prove it.
- Network input is untrusted: decode, strip and length-cap before storing; never pass raw HTML to the client.
- One connector, one object in `connectors/`. A new source needs `discover`, `pull`, a fixture test and a cursor that survives restarts.
- Long work streams progress (SSE) instead of blocking a request.
- Comments say why, not what. Names follow the product's words: harvest, palate, lens, steep, cut, rescue.

**Performance budgets:**

| Budget | Limit | Today |
|---|---|---|
| Server response (TTFB) | under 10 ms | 3 ms |
| First paint | under 50 ms | 16 to 32 ms |
| Client JS (brotli) | under 60 KB | 53.5 KB |
| Lens first token | under 2 s (API), under 4 s (CLI) | 1.2 s (CLI, real Opus); API not measured |

**Testing:**
- `bun test` for pure logic and owner isolation: scoring, clustering, extraction, feeds, the address guard, auth, every id-taking route across two accounts.
- `bun tools/e2e.ts` drives Chrome over CDP with a virtual passkey and touch: every button, every page, overflow at 360 px, timing.
- `bun tools/stub-anthropic.ts` stands in for the API so e2e can run offline and free; with Claude Code logged in, e2e runs against real Claude.
- A change is done when both pass and the affected page has been looked at in a screenshot.

## 10. Open work

| Item | State |
|---|---|
| Claude on the server | Claude Code installed; off until `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) is in `/etc/peppermint.env` |
| API backend against the real API | Tested against the stub only; the CLI backend runs on real Claude |
| Pictures | Built (layout D). Not yet: telling headline-as-image share cards and one-off logos apart from photos, company logos from Wikidata, resizing copies (originals are served, about 100 KB each) |
| Podcast and video transcripts | Briefs use show notes and descriptions; no transcription yet |
| Studio-quality voices | Listen uses device voices; a TTS API would add downloadable audio |
| Newsletters | Built; live once the mailbox env is in `/etc/peppermint.env` |
