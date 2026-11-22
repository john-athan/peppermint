# Accounts

<!-- Owned by oss-kit (templates/shared/accounts). Change it there and run `oss sync-tooling`, never in a copy. -->

This app is meant for a small group of people who trust each other, on a server one of them runs. Everyone signs in
with a passkey: there are no passwords and no mail, and nothing to leak but public keys. Anyone who has no passkey
yet gets a one-time link. The same code does this in every app that carries it (`server/accounts/`,
`client/lib/passkeys.ts`, `shared/accounts.ts`, `tests/accounts.test.ts`). This file is its contract.

## The one building block: a link

A link is `https://<host>/setup#<token>`. The token sits in the fragment, so no server, proxy or log ever sees it;
the page reads it, clears the address bar and sends it in a POST body. Only its SHA-256 is stored. It works once.
An account has at most one open link: making a new one ends the old one.

| Link | Who makes it | Lives | What the passkey made with it does |
| --- | --- | --- | --- |
| setup | the server's first start (`<APP>_SETUP_TOKEN`) | until any passkey exists | makes the first account, an admin |
| join | an admin (invite), or `<app> invite` | 7 days | the person's first passkey |
| recover | an admin, for someone who has passkeys; `<app> reset-passkeys` | 1 day (1 hour from the CLI) | replaces all their passkeys and ends all their browser sessions |
| add | the person themselves, signed in | 1 hour | one more passkey, for a device that cannot reach the old one |

A device next to one that is signed in needs no link: the browser's own "use a phone" QR code signs it in, and the
Passkeys list adds more keys from a signed-in browser.

A link opened in a browser where someone else is signed in still makes the passkey of the person it was made for.
That browser then belongs to them, and the previous session ends.

## Roles

Two, no more. A trusted group needs nothing finer, but someone has to be able to invite, help with a lost phone,
and take access away.

| Rule | Why |
| --- | --- |
| The first account is admin. | Someone must be able to invite from the start. |
| Admins invite, make links for others, rename, promote, demote and remove. | One place to look when something goes wrong. |
| Everyone sees who is in the group, never anyone's links. | The group is the point; a link is a key. |
| Everyone manages their own name, passkeys, sessions and devices. | Nobody waits for an admin to tidy their own things. |
| There is always at least one admin; the last one can neither step down nor be removed. | A group without an admin can only be repaired over SSH. |
| Removing someone takes their passkeys, sessions, links and devices. Their data stays, and a new link brings them back. | Taking access away must never delete photos or writing by accident. |
| Someone invited who never joined and owns nothing is deleted outright. | A typo in an invite should leave no trace. |
| Names are unique, ignoring case. | `<app> reset-passkeys <name>` must find exactly one person. |

## Passkeys and sessions

- WebAuthn by hand with WebCrypto, no library. ES256 and RS256; resident keys and user verification required; the
  challenge is single use and lives five minutes; origin, rp id hash, UP and UV flags, signature and sign counter are
  all checked. A counter that moves must move forward.
- A session is 32 random bytes in a `__Host-` cookie (Secure, HttpOnly, Path=/). SameSite is Strict unless people
  open the app from links in mail (then Lax, as the app's config says). Only the SHA-256 is stored. It ends 30 days
  after its last use and 180 days after sign-in at the latest; every session is listed and can be ended.
- Every state-changing request must come from the app's own origin (`Origin`, or `Sec-Fetch-Site: same-origin`).
  Device requests with a bearer token are exempt: they carry no cookie to forge.
- Rate limits in memory: 10 a minute per address for login, registration and link previews, 5 for pairing claims.
  The client address comes from `X-Forwarded-For`, which the proxy in front must set and overwrite.

## Devices

An app that has companion devices (Monet's Mac and Android apps) names their kinds and scopes. A signed-in person
makes a pairing code (8 characters without I, O, 0 or 1, ten minutes, once); the device trades it for a token
(`Authorization: Bearer`, stored hashed) with only its kind's scopes. A device never manages accounts. Removing a
device ends its token and its sessions at once.

## API

All JSON. Errors are `{ "error": "<a sentence for the person>" }` with a fitting status.

| Route | Who | What |
| --- | --- | --- |
| `GET /api/auth/state` | anyone | `{ setupOpen, loggedIn, device, hasCredential, me }` |
| `POST /api/auth/link {token}` | anyone | what the link will do: `{ purpose, name, expiresAt }`, or 404 |
| `POST /api/auth/register/options {token?}` | a link, or signed in | creation options |
| `POST /api/auth/register/verify {credential, name}` | same | the passkey; a link signs this browser in |
| `POST /api/auth/login/options`, `POST /api/auth/login/verify {credential}` | anyone | sign in |
| `POST /api/auth/logout` | signed in | ends this session |
| `GET`, `PATCH /api/account {name}` | signed in | yourself |
| `POST /api/account/link` | signed in | an add link for yourself |
| `GET /api/passkeys`, `DELETE /api/passkeys/:id` | signed in | your passkeys; the last one stays |
| `GET /api/sessions`, `DELETE /api/sessions/:id` | signed in | your sessions |
| `GET /api/members` | signed in | the group |
| `POST /api/members {name, role?, ...}` | admin | invite; returns the join link |
| `POST /api/members/:id/link` | admin | join, recover or (for yourself) add link |
| `PATCH /api/members/:id {name?, role?}` | admin | rename, promote, demote |
| `DELETE /api/members/:id` | admin | `{ result: "deleted" \| "revoked" }` |
| `POST /api/devices/pair`, `GET /api/devices`, `DELETE /api/devices/:id` | signed in | pairing codes and your devices |
| `POST /api/devices/claim {code, name, kind}` | a device | trades a code for a token |
| `POST /api/devices/session` | a device token | a cookie with the device's scopes, for its own web view |

## On the server

```
<app> invite <name> [--admin] [--<field> <value> ...]   a new person and their join link
<app> reset-passkeys [name]                             a recovery link for one hour (the first admin without a name)
<app> members                                           who is here, their role and state
```

These run as the service user against the live database. The deploy installs wrappers for them
(`<app>-invite`, `<app>-reset-passkeys`, `<app>-members`).

## Wiring it into an app

```ts
migrateAccounts(db, "users");                        // after the app's own migrations, every start
const accounts = createAccounts({ db, table: "users", app: "Name", origin, cookie: "__Host-name", lang: "en",
  setupToken: process.env.NAME_SETUP_TOKEN, onJoin, hasData });
// in the request handler, before the app's own routes:
const r = await accounts.handle(req, accounts.clientIp(req, peer)); if (r) return r;
const p = await accounts.principal(req);             // null, a browser, or a device with scopes
```

The account table is the app's own (`id`, `name`, `created_at`; the module adds `role`). Everything else is the
module's, in tables named `auth_*` with their own version counter.
