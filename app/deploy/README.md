# The bun-app template

A Bun + Svelte service on kaleve-home (monet, peppermint, anzeiger) is built and deployed by files oss-kit owns.
`oss sync-tooling <repo>` writes them; change them in `oss-kit/templates/shared/bun-app/`, never in a repo.

| File | What |
| --- | --- |
| `../tools/build-app.ts` | The shared build: Svelte plugin, hashed bundle and stylesheet, service worker, manifest, icons, br and gz. The app's `build.ts` calls `buildApp()` with what is its own (its option list is typed in that file). |
| `deploy.sh` | Build the Linux binary, copy it, run `install.sh` on the server, check the public URL. |
| `install.sh` | The server half. `setup` runs the app's `setup.sh`; `install` swaps the build in (the old one stays as `<name>.prev`), installs the unit, creates `/etc/<name>.env` with a setup token on the first run when `PASSKEYS=yes`, restarts, waits for `/healthz`. |
| `nginx.sh` | Copies itself to the server and writes the nginx site from `app.env` and `nginx.locations`. Run once per app, and again to change the site. It also keeps `worker_shutdown_timeout 60s` in `nginx.conf`: without it a reload leaves an old worker answering Cloudflare's long-lived connections with the old config for a day. |

## What each app owns

| File | What |
| --- | --- |
| `build.ts` | `buildApp({ root, css, icon, manifest, ... })` plus anything only this app builds (workers, generated marks, vendored files). |
| `deploy/app.env` | The keys below. |
| `deploy/<name>.service` | The systemd unit. Per app on purpose: user, memory cap, environment and comments are the substance, and a generated unit is harder to read than the file systemd reads. |
| `deploy/nginx.locations` | The `location` blocks of the site (timeouts, upload size, buffering). `@PORT@` becomes the app's port. |
| `deploy/setup.sh` | Optional. Runs as root before the build is swapped in: apt packages, the service user, data folders. Gets `NAME`, `HOST_NAME`, `PORT`. |
| `deploy/after.sh` | Optional. Runs as root after the build and unit are in place, before the restart: helper commands such as a passkey reset. |

## app.env

| Key | Meaning |
| --- | --- |
| `NAME` | Binary, unit, `/etc/<NAME>.env`, `/usr/local/lib/<NAME>`, nginx site. The setup token variable is `<NAME>_SETUP_TOKEN` in capitals. |
| `PASSKEYS` | `yes` for an app with passkey accounts: the first deploy writes `/etc/<NAME>.env` with a setup token and prints the link. Leave it out for an app without a login. |
| `HOST_NAME` | Public host name, for nginx `server_name` and the first-run setup link. |
| `PORT` | The app's port on 127.0.0.1. Keep the unit's `PORT=` equal. |
| `NGINX_PORT` | nginx's listener on 127.0.0.1, the tunnel's target in `toolbox/home/cloudflared-home.yml`. |
| `SSH_HOST` | ssh alias of the server; `DEPLOY_HOST=...` overrides it for one run. |
| `SYNC` | Optional. `"local-dir:/remote/dir ..."`, rsynced before the restart when the local folder exists. |
| `SERVICE_USER` | Optional. Owner given to the synced folders, when the unit runs as a static user. |
| `PUBLIC_URL`, `PUBLIC_EXPECT`, `PUBLIC_NOTE` | The check after the deploy and the status it must return; the note says why (for example "302 to the login" behind Access). |

## Adopting it in an app

1. `oss sync-tooling <repo>` (the repo's fleet.json entry lists `{"kind": "bun-app", "dir": "app"}` under `tooling`).
2. Cut `build.ts` down to a `buildApp()` call. Build before and after, and compare `dist/` file by file.
3. Write `deploy/app.env`, move the unit to `deploy/<name>.service`, the `location` blocks to `deploy/nginx.locations`, server-side extras to `setup.sh` and `after.sh`. Delete the old `deploy.sh` and `nginx.sh` copies (sync overwrites them).
4. `deploy/nginx.sh` once, then `deploy/deploy.sh`, then `toolbox/home/verify`.
