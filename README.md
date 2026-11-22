<div align="center">

<img src="app/client/icons/icon-512.png" width="96" alt="peppermint">

# peppermint

**Everything you follow, steeped to your taste. Twelve stories, and then it ends.**

</div>

You follow too much: three newsletters, a podcast, Hacker News, the local paper, a YouTube channel you meant to
catch up on. peppermint picks all of it, strips the stalks, and pours you one cup in the morning and one in the
evening. When the cup is empty there is no more scrolling, because there is nothing left to scroll.

<img src="assets/screenshot.jpg" alt="peppermint on the desktop: the Palate page, where topics and rules shape the edition" width="720">

## From leaf to cup

<img src="assets/brew.svg" alt="How peppermint makes an edition: harvest, atomize, cluster, score, steep" width="860">

Every source is harvested into one SQLite file. Each item is tagged (topics, people, places, a mood), items about
the same event become one story, and your palate ranks the stories. The top twelve are the edition.

## A palate that shows its work

Your palate is a set of plain reasons: topics you weigh up or down, people and sources you trust, rules that say
*never* or *always*. A story's score is the sum of those reasons, so *why am I seeing this* is the score itself,
not an excuse written afterwards. What fell below the line is not gone: the cut list keeps it, and one tap rescues
a story, which the palate remembers.

## Steeped your way

Open a story and it arrives the way you like to read: a TL;DR first, then the whole thing retold in your style, in
English or German, at one of three reading levels, streamed as it is written. The original is a tap away.

Tap any sentence to dig in: *is it true*, *the data behind it*, *who said it*, *explain it*, or your own question,
answered right under the paragraph from the story, other reports and Wikipedia, with the passages quoted.

**Listen** turns the edition into a spoken episode; the Android app downloads it with your podcasts and plays it
with the screen off. **Studio** is an editor for writing your own piece from what you read. One input bar searches
everything you follow as you type, and turns a sentence like *less crypto, more Munich* into a palate change you can
undo.

## Brew your own

For one reader or a small group who trust each other, on a server one of them runs. Each reader has their own
sources and palate, and nobody sees anyone else's. Everyone signs in with a passkey; there are no passwords and no
mail.

```sh
cd app && bun install && bun run build && bun run start   # http://localhost:4317, prints a setup link
```

Claude does the tagging and the writing, on whichever backend is there: `ANTHROPIC_API_KEY` uses the API (Haiku tags,
Sonnet writes); without a key, a logged-in Claude Code on the PATH is run headless on your subscription; with
neither, tagging falls back to a local lexicon and the writing features say they are off.

1. Put it behind HTTPS (passkeys need it) with `HOST=127.0.0.1`: a Cloudflare Tunnel, or Caddy with
   `reverse_proxy 127.0.0.1:4317`. Set `PEPPERMINT_ORIGIN` to the public address once; passkeys are bound to its host
   name. The proxy must set `X-Forwarded-For` and overwrite what the client sent.
2. Open the `https://<host>/setup#<token>` link the first start prints. That makes the first account, an admin.
3. Invite from the Account page, or `peppermint invite <name>` on the server. The link works once, within a week.
4. A lost phone: an admin taps *New passkey* next to the person. A locked-out last admin runs
   `peppermint reset-passkeys <name>` on the server.

Every setting is in [`app/README.md`](app/README.md), the design of the server in
[`app/docs/backend.md`](app/docs/backend.md), accounts in [`app/docs/accounts.md`](app/docs/accounts.md).
The only dependency is Svelte. Everything else is Bun, SQLite and the web platform.
