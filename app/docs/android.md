# The Android app

`android/` is peppermint on the phone. Reading stays the web app: the icon opens peppermint in Chrome's engine,
full screen (a Trusted Web Activity), with the same passkeys and session as Chrome. The app adds only what a browser
on a phone does badly: listening.

- **Podcasts with the screen off.** Episodes play in the app's own player (Media3), with lock screen and headphone
  controls, and keep their place.
- **Offline.** On Wi-Fi the app downloads the newest episodes of the podcasts you follow and the episodes you saved,
  so the U-Bahn has something to play.
- **The edition read aloud.** The app fetches the edition's script (the one the Listen page reads) and records it
  with the phone's own voice, so it is ready before you open anything.

Monet's app is built the same way, and both share the plumbing from oss-kit's `android-device` kind
(`android/app/src/main/kotlin/dev/kaleve/device/`: pairing, the token vault, the device API, the Trusted Web
Activity). Change those files in oss-kit and run `oss sync-tooling`, never here.

## Pairing

The phone pairs once, as a device of the accounts module (`docs/accounts.md`, "Devices"), kind `android`, scope
`listen`. On the Account page, "Connect a phone" makes a code. Inside the app the page offers the link
`peppermint://pair?code=…` instead, and the app asks before it claims it, so a link from elsewhere cannot pair the
phone to someone else's account unnoticed. Disconnecting the phone on the Account page ends its token.

## What a phone may call

Only routes that name the scope `listen` in `server/main.ts` accept the device token; every other route answers 401
to it. `tests/open-surface.test.ts` holds that list.

| Route | What |
| --- | --- |
| `GET /api/listen/queue` | `{ name, lang, edition, episodes }`: who is paired, the reading language, the current edition (`id`, `day`, `slot`, `sig`, `stories`; null when there is none) and up to 30 episodes, saved ones first, then what followed podcasts published in the last 14 days, newest first, without the heard ones |
| `GET /api/listen/episodes/:id` | one episode, for "Play in the app" in the reader |
| `POST /api/listen/episodes/:id/heard` `{heard?}` | heard (or, with `heard: false`, not); a heard episode leaves the queue |
| `GET /api/listen?lang=en\|de` | the edition's script as the Listen page reads it (SSE: `open`, `delta {t}`, `status`, `done`, `error`) |

An episode is `{ id, story_id, title, show, audio, duration, image, published_at, saved }`; `audio` is the
publisher's own URL, so the phone downloads from the podcast's host, not from peppermint.

The script has one marker line per part, then its text: `@intro`, `@story <id>`, `@outro`. The app records each part
as its own file and plays them in order.

## Building and installing

```sh
android/tools/validate.sh                         # unit tests and lint
cd android && ./gradlew assembleRelease           # signed with ~/.config/peppermint-android/keystore.properties
adb install -r app/build/outputs/apk/release/app-release.apk
```

The release key stays outside the repo, in `~/.config/peppermint-android/`. Its fingerprint is in
`server/listen-routes.ts` (`ASSETLINKS`, served as `/.well-known/assetlinks.json`): lose the key and the installed
app can no longer be updated, and Chrome shows an address bar again. A debug build has another key, so it opens the
web app with an address bar; that is expected.
