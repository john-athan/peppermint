# peppermint

The app lives in `app/`. Start with `app/README.md`, then `app/docs/backend.md`.

## Everyone works on main

Several Claude sessions work on this repo at the same time. All of them work on `main`, in this checkout
(`~/sideprojects/peppermint`). No branches, no worktrees (also not `isolation: "worktree"` for
subagents), no "WIP" branches to park someone else's changes.

- Every piece of work ends pushed and deployed, without being asked: commit, `git pull --rebase`, `git push`, then
  `app/deploy/deploy.sh`. Work that is only committed, or only pushed, is not done.
- Commit small and often, straight on `main`, with `bun test --isolate` green (from `app/`; `--isolate` because the test files share one
  in-memory database otherwise, and pass or fail by the order the disk lists them in). Before each commit `git pull --rebase`; after it
  `git push`. Uncommitted changes in the checkout belong to a session that is still working: never stash, reset,
  check out or commit them yourself; ask that session.
- Database migrations are appended at the end of `MIGRATIONS` in `server/db.ts`. Pull first, so two sessions never
  add the same number.
- Deploy only `main`, only right after `git pull` with nothing of yours uncommitted (`deploy/deploy.sh` builds the
  checkout as it is). A deploy from anything older overwrites newer work on the server: this happened on 2026-11-19.

## No new dependencies

`app/package.json` has exactly one package: `svelte`. Keep it that way. Everything else is built on Bun
(`Bun.serve`, `bun:sqlite`, `Bun.spawn`, the bundler, `bun test`), Node built-ins and the web platform (`fetch`,
WebCrypto, `HTMLRewriter`, streams).

- Before reaching for a package, write the small code at the place that needs it. Claude is two `fetch` calls in
  `app/server/llm.ts`; passkeys are WebCrypto by hand. Those are the pattern.
- No dev dependencies either: no TypeScript compiler, linter, formatter, test library or Vite.
- `app/tests/deps.test.ts` fails when `package.json` lists anything but `svelte`, or when a source file imports a
  package other than `svelte`, `bun:*` or `node:*`. Never change its allow list to make a test pass.
- If a task truly cannot be done without a package, stop and ask the owner, giving the package, its size and why
  the platform is not enough. Do not add it first and ask later.

## Reuse before you write

Look here first. If something close exists, extend it; do not write a second one.

| Need | Use | Where |
|---|---|---|
| In-app link | `<Link href>` (Cmd/Ctrl-click keeps working) | `client/components/Link.svelte` |
| Bottom sheet / dialog | `<Sheet bind:open label>` | `client/components/Sheet.svelte` |
| Page or block still loading | `<Loading text?>`, `<Skeleton lines last sm cls>` | `client/components/` |
| Picture with shimmer and srcset | `<Pic>` | `client/components/Pic.svelte` |
| Source badge | `<Fav kind name size src>`; colour is `--fav` per kind in `app.css` | `client/components/Fav.svelte` |
| Logo, loading mark | `<Mark cls>` | `client/components/Mark.svelte` |
| Toast | `toast(msg, opts)` | `client/lib/state.svelte.ts` |
| Input for the agent and search | `<AskBar scope>`; agent replies, polling and undo in `lib/agent.svelte.ts` | `client/components/AskBar.svelte` |
| Something the agent made | `<AgentCard task>`, `<ProposalCard proposal>` (lilac) | `client/components/` |
| Navigate in code | `go(path)` | `client/lib/state.svelte.ts` |
| Keyboard (arrows, Enter, Escape) | put `data-item` on each row of a list; a widget that uses a key itself calls `preventDefault` | `client/lib/keys.ts` |
| After adding a source | `firstHarvest(name)` | `client/lib/state.svelte.ts` |
| Any request | `api`, `sse`, `drain`, `beacon` | `client/lib/api.ts` |
| Passkeys, invite links, who is asking | `register`, `login`, `previewLink`, `passkeyMessage` (client); `accounts`, `ownerFromRequest` (server). Shared with Monet: change it in oss-kit's `templates/shared/accounts` | `client/lib/passkeys.ts`, `server/auth.ts`, `docs/accounts.md` |
| Icon | `I.<name>` | `client/lib/icons.ts` |
| Dates, numbers | `ago`, `dayLabel`, `signed` | `client/lib/format.ts` |
| Animation, springs, haptics | `animate`, `flyTo` (one element or several, to a tab), `steepIn`, `var(--spring)`/`var(--snappy)` in CSS | `client/lib/motion.ts` |
| Charts | `shared/chart.ts` (format), `<Chart>` (drawing) | |
| Stand-in for a missing picture | `<Emblem spec seed wide small>`; `emblemFor(card)` picks motif and mood (tagger, else topic), moods in `.emblem` in `app.css` | `client/components/Emblem.svelte`, `shared/emblem.ts` |
| API shapes (Card, Edition, Block, Draft…) | import the type | `shared/types.ts` |
| Buttons | `.primary` (filled), `.ghost` (outlined, mint when `aria-pressed`), `.link-btn` (text); `.sm` for a 30 px pill, `.full` for the big one; `.danger` only recolours | button block in `client/app.css` |
| Start an investigation (camera, shared photos, a reader's tip) | `openCapture(files?, note?)` opens the one `<CaptureSheet>` | `client/lib/capture.svelte.ts` |
| Photos: shrink, read GPS/time, blur faces for the public copy, crops | `prepare`, `blurred`, `crop`, `here` | `client/lib/photo.ts`, `shared/exif.ts` |
| Notifications on this device | `enablePush`, `push` state; server side `notify(owner, note)` | `client/lib/push.svelte.ts`, `server/notify.ts` |
| Publishing a draft (checks, channels, when, Instagram slides) | `<PublishSheet>`, `<PhotoSheet>`; slides in `lib/slides.ts` | `client/components/` |
| Form fields, toggles | `.field` (label + input), `.field-pre` (fixed prefix), `.switch` | `client/app.css` |
| Pull to refresh (drag, overscroll, R) | `<Pull verb busy msg onpull>` | `client/components/Pull.svelte` |
| Segmented controls, chips, notices | `.seg` `.opt` `.chip` `.chip-btn` `.notice` `.empty` | `client/app.css` |
| Which sentence the reader tapped or selected, and marking it | `sentenceAt`, `markSentence` | `client/lib/dig.ts` |
| Spacing, small layout | `.mt-xs/s/m/l` `.between` `.hrow` `.hint` `.accent` … | end of `client/app.css` |

## Rules that `bun test` enforces

`app/tests/conventions.test.ts` fails the suite when one of these breaks:

- One rule per top-level selector in `app.css`. Add to the existing rule.
- Colours are tokens: a hex value only where a `--custom-property` is declared; none in `.svelte`/`.ts`.
- No `style="…"` in Svelte. Use a class; `style:prop={value}` is fine for computed values.
- No `<a onclick={… preventDefault(); go(…)}>`; use `<Link>`.
- No `fetch(` outside `client/lib/api.ts`.
- No hand-built `.steeping` lines or loading marks; use `<Skeleton>` / `<Loading>`.
- No inline `<svg>` outside components that draw data (Chart, the Sources sparkline); add icons to `lib/icons.ts`.
- Names exported from `shared/types.ts` are declared nowhere else.
- Button padding, height, corners and type size are set only in the button block of `app.css`.

When a new shared piece is added, add a row above and, if it replaces a pattern, a check in that test.
