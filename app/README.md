# peppermint

Everything you follow, distilled to your taste. A mobile-first web app for one reader, built so more can follow.

Sources (Hacker News, merkur.de, podcasts and YouTube channels picked by name, any site with an RSS, Atom or JSON feed) are pulled into one
SQLite file, tagged, clustered into stories, scored by your palate, and served as a finite edition twice a day.
A story opens in your style: a TL;DR for you first, then, as you scroll, the whole story retold the way you like to
read, in English or German, at three reading levels, streamed over SSE; the original is one tap away. Tap any sentence
to dig into it: is it true, the data behind it, who said it, explained, or your own question, answered under the
paragraph from the story plus a quick search of other reports and Wikipedia, with quoted passages. Listen turns the edition into a spoken episode; Studio is a live editor for writing from it. One input bar searches
everything you follow as you type, and its agent turns a line into something the app shows: a link into an item, a
question into a dossier, a wish into a palate change you can undo, a question about a story into the Ask lens, answered from the story plus a quick search of other reports and Wikipedia, so a walled article still gets an answer.

Live at https://peppermint.kaleve.dev. The design of the server is in `docs/backend.md`.

## Run

```sh
bun install
bun run build                      # client: Svelte compiled by a small Bun plugin, brotli + gzip assets
bun run start                      # http://localhost:4317
```

Claude runs on whichever backend is there: an `ANTHROPIC_API_KEY` uses the API; without one, a logged-in Claude Code
(`claude` on the PATH) is scripted headless and billed to that subscription; with neither, tagging is local and the
Claude features say they are off.

## Hosting it yourself

peppermint is for one reader or a small group who trust each other, on a server one of them runs. Each reader has their
own sources, palate and writing; nobody reads anyone else's. Everyone signs in with a passkey: there are no passwords
and no mail. `docs/accounts.md` has the full rules.

1. Run it behind HTTPS (passkeys need it), with `HOST=127.0.0.1`: a Cloudflare Tunnel, or Caddy with automatic
   certificates (`reverse_proxy 127.0.0.1:4317`). Set `PEPPERMINT_ORIGIN` to the public address; passkeys are bound to
   its host name, so pick it once. The proxy must set `X-Forwarded-For` and overwrite what the client sent.
2. On the first start the server prints `https://<host>/setup#<token>` (the token is `PEPPERMINT_SETUP_TOKEN`, or a
   random one). Opening it makes the first account, an admin.
3. Invite on the Account page (the key on Today, or Account in the sidebar), or `peppermint invite <name>` on the
   server. The invite is a link that works once, within a week; send it over a messenger.
4. A lost phone: an admin taps "New passkey" next to the person, which gives a link that replaces their passkeys. If
   the only admin is locked out, `peppermint reset-passkeys <name>` on the server prints such a link.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4317` | Listen port |
| `HOST` | `0.0.0.0` | Listen address; `127.0.0.1` behind a tunnel or proxy |
| `PEPPERMINT_ORIGIN` | `http://localhost:4317` | Public origin. Passkeys are bound to its host name, so set `https://peppermint.kaleve.dev` in production |
| `PEPPERMINT_DB` | `data/peppermint.db` | SQLite file |
| `PEPPERMINT_SETUP_TOKEN` | random, printed | Token for the first-run passkey link; it stops working once any passkey exists |
| `ANTHROPIC_API_KEY` | none | Claude over the API: Haiku 5.5 tags every item, Sonnet 5.5 writes lenses, episodes and Studio text |
| `PEPPERMINT_LLM` | auto | `api`, `cli` or `off` to force a backend |
| `PEPPERMINT_CLAUDE_BIN` | `claude` on PATH | Claude Code binary for the subscription backend |
| `PEPPERMINT_CLI_CONCURRENCY` | `2` | Claude Code processes for reading at once (tagging gets two more of its own) |
| `PEPPERMINT_BACKUPS` | `data/backups` | Daily `VACUUM INTO` snapshot, last 7 kept |
| `PEPPERMINT_DIST` | found | Built assets folder |
| `PEPPERMINT_NO_SCHEDULER` | unset | `1` disables the minute scheduler (tests) |

## Deploy

```sh
deploy/deploy.sh   # builds a Linux binary, installs it on kaleve-home as a systemd service, checks /healthz
```

The service (`deploy/peppermint.service`) runs as a dynamic user with a capped memory budget and listens on
localhost only. `deploy/nginx.sh` (run once, again to refresh) writes the nginx site on kaleve-home: plain HTTP on
127.0.0.1:8445, the target of the Cloudflare tunnel (TLS ends at Cloudflare). Nothing else sits in front: the app's
passkeys are the only gate, and `tests/open-surface.test.ts` lists everything a stranger can reach. It is listed on
https://tools.kaleve.dev as `eigen` in `~/sideprojects/toolbox/zugang/apps.json`. The scripts are oss-kit's bun-app template, configured by `deploy/app.env`;
`deploy/README.md` explains it.
Secrets go in `/etc/peppermint.env` (root, 0600): the first-run setup token is created there by the first deploy.
`deploy/after.sh` installs `peppermint-invite`, `peppermint-reset-passkeys` and `peppermint-members`, which run the
accounts commands as the service's own user.

Claude on the server runs on your subscription: Claude Code is installed at `/usr/local/bin/claude` (a release
binary from downloads.claude.ai, checksum verified). Run `claude setup-token` on your own machine, put
`CLAUDE_CODE_OAUTH_TOKEN=…` into `/etc/peppermint.env` on the server and `systemctl restart peppermint`. Until the
token is there, Claude counts as off. An API key (`ANTHROPIC_API_KEY`) also works but bills per use.

## Develop and test

```sh
PEPPERMINT_SETUP_TOKEN=devsetup bun run start                       # uses your Claude Code login if no key is set
bun run stub                                                        # or: a local stand-in for the Messages API on :4399
ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://localhost:4399 PEPPERMINT_SETUP_TOKEN=devsetup bun run start
bun test --isolate                                                  # unit tests: feeds, extraction, clustering, palate, passkeys, owner isolation
bun run e2e <screenshot-dir>                                        # headless Chrome walk through every page, phone and desktop
```

Run e2e against the stub (second line above) by default: it costs nothing and the stub speaks every format the app
asks for (tags, lenses, briefs, the Listen script, audio and video scripts). Point it at a server on real Claude only
for a final check, since every run writes fresh briefs, episodes and scripts on your subscription.

For debugging by hand (or by Claude), `bun tools/cdp.ts serve [--phone]` keeps one headless Chrome open with a
virtual passkey, and short commands drive it: `go /list`, `click '.card h2 a'`, `type …`, `eval '__pm.app.path'`,
`shot`, `logs`, `overflow`, `size 320 700 phone`, `theme dark`, `stop`. On localhost the page exposes `__pm` (app state,
`go`, `api`).

`tools/cdp.ts` drives Chrome over the DevTools protocol directly; the e2e run registers a passkey with a virtual
authenticator, adds sources through the picker (a pasted site link among them), and checks streaming, tuning, rules,
rescue, Listen, the Studio editor (suggestions, quotes, slash menu, previews, publishing), pull to harvest and layout.

## Map

| Path | What it holds |
|---|---|
| `server/connectors/` | The source contract (`discover`, `pull`) and the Hacker News, merkur.de, feed, podcast and YouTube connectors |
| `server/pipeline.ts` | Pull, insert, tag, cluster into stories |
| `server/palate.ts` | Scoring with readable reasons, learning from signals, building the edition |
| `server/search.ts` | Search over everything you follow, as you type |
| `server/agent.ts` | The agent: one input becomes a dossier, a palate change, probes, an explanation or an item; Ask answers in the Reader |
| `server/llm.ts` | Claude on the API or through Claude Code headless, behind `tagItems` and `streamText` |
| `server/steep.ts` | Generate once, stream to every waiting reader, cache, resume with `Last-Event-ID` |
| `server/lens.ts`, `server/listen.ts`, `server/studio.ts` | Lenses, the spoken episode, Studio drafts and their streams |
| `server/investigate.ts`, `server/desk.ts`, `server/public.ts` | Investigations (photo and note to a researched piece), the editor's desk and publishing, the writer's public page under `/@handle` |
| `server/notify.ts`, `server/push.ts`, `server/jmap.ts` | Notifications (Web Push by hand, email otherwise) and answers by mail |
| `server/auth.ts`, `server/accounts/` | Who is asking: the fleet's accounts module (oss-kit, `docs/accounts.md`), configured for peppermint |
| `client/` | Svelte 5 app: Today, Reader, Sources, Add source, Palate, Listen, Studio, Account |
| `deploy/` | systemd unit, nginx site and deploy scripts for kaleve-home |
| `shared/logo.mjs` | The sprig mark, generated as SVG |

Dependencies: `svelte`, nothing else. Everything else is Bun and the web platform; `tests/deps.test.ts` keeps it that way.
