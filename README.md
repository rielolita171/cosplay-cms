<div align="center">

# 🧥 Cosplay CMS

### Inventory for costumes, props & contact lenses

[![Live site](https://img.shields.io/badge/Website-live-8b5cf6?style=flat-square&logo=github&logoColor=white)](https://rielolita171.github.io/cosplay-cms/)
[![Pages](https://img.shields.io/badge/GitHub%20Pages-passing-2ea44f?style=flat-square&logo=github&logoColor=white)](https://rielolita171.github.io/cosplay-cms/)
[![Node](https://img.shields.io/badge/Node-22-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-CLI-003b57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](#license)
[![No build step](https://img.shields.io/badge/build-none%20required-6f42c1?style=flat-square)](#running-it)
[![Desktop](https://img.shields.io/badge/Electron-early%20release-d29922?style=flat-square&logo=electron&logoColor=white)](#desktop-app-electron)

[**Visit the project site →**](https://rielolita171.github.io/cosplay-cms/)

</div>

---

A private, single-user inventory system for cosplay props, costumes and contact
lenses. Express and the `sqlite3` CLI on the back end, a single self-contained
`public/index.html` on the front end. No build step, no bundler, no CDN.

It runs three ways from the same server code: as a Node process, as a Docker
container (**the primary target**), and as a packaged desktop app (Electron,
**early release** — see [`ELECTRON.md`](ELECTRON.md)).

<p align="center">
  <em>Live screenshots of a running instance are on the project site, not pasted
  here — the repository stays lean and nothing in it needs to be re-encoded.</em>
</p>

> ⚠️ **This deployment has no authentication.** There is no login, no password,
> no role ladder and no session token. Anyone who can reach the published port
> has full read *and* write access to every record. That is deliberate — it is a
> single-user box on a private network, and the boundary is the network or a
> reverse proxy, not the application. See "Security model" below, and do not
> publish this port to the internet.

> **There is no in-process SQLite binding.** Every query is a short-lived
> `spawn('sqlite3', [DB_FILE])` child process fed SQL on stdin, so the
> `sqlite3` **CLI binary must exist in the runtime image**. `better-sqlite3` is
> not used and is not a dependency.

---

## Running it

```bash
npm install
npm start          # node src/server.js, listens on PORT (default 4001)
npm run dev        # node --watch src/server.js
npm test           # makers, wishlist, lens-expiry and transfer suites
```

## Desktop app (Electron)

A second way to run the *same* server code, packaged as a desktop app. The
Express server is not reimplemented: `electron/main.js` sets the environment and
then `require`s `src/server`, so every route, test and database behaves exactly
as it does in the container.

```bash
npm run electron:dev          # run the app against your checkout
npm run electron:build        # unpacked build in dist/ — fastest packaging check
npm run electron:dist         # real installers: AppImage, NSIS, DMG
npm run electron:dist:win     # Windows NSIS installer only
```

What is verified, and what is not, is written down in
[`ELECTRON.md`](ELECTRON.md) rather than guessed at. The short version: the
Linux run and the Windows installer are verified, the Windows run was verified
under Wine rather than on native Windows, and **macOS has never been built**.
The installers are unsigned and there is no auto-updater.


Configuration is read from `.env` at the repository root. The names that
matter are `PORT`, `NODE_ENV`, `DATABASE_PATH`, `CMS_DATA_DIR`,
`CMS_UPLOAD_DIR`, `API_KEY`, `CORS_ORIGIN` and `TELEGRAM_BOT_TOKEN`. **Their
values live in `.env` and must never be copied into this file, into a commit, or
into a ticket** — refer to them by name, as done here.

`CMS_DATA_DIR` and `CMS_UPLOAD_DIR` are the opt-in path overrides, read by
[`src/services/paths.js`](src/services/paths.js). They exist for the desktop
build, which cannot use `__dirname` because that resolves inside the read-only
`app.asar` archive. Every fallback is byte-for-byte the path the old hardcoded
literals produced, so leaving both unset changes nothing about `npm start` or
`docker compose up`.

`API_KEY` is the only credential the app still has, and **it is not a login.**
It guards exactly one thing: the three `/api/notifications/*` endpoints that
n8n calls server-to-server (`X-CMS-API-KEY`). It does not protect the CMS data
routes — those are open.

There is no `JWT_SECRET` and no `SESSION_SECRET` any more. The app has no login,
so there is no token to sign. A `JWT_SECRET` line left in an existing `.env` is
simply ignored; you can delete it.

> **The database variable is `DATABASE_PATH`, not `DATABASE_URL`.** `.env` does
> set `DATABASE_URL`, and several documents in this repository mention it, but
> **no code reads it** — the name is honoured nowhere and silently does
> nothing. Setting it does *not* move the database. See the `DATABASE_URL` entry
> under "Known issues and deferred fixes" before you trust it.

`data/db/cms.db` is the SQLite database and `data/uploads` is the image store.

> **Do not test uploads against a second/dev instance.** A dev server on
> another port writes into the *same* upload directory as production. Every
> internal path is resolved by [`src/services/paths.js`](src/services/paths.js),
> so you can now separate them — set `CMS_DATA_DIR` and `CMS_UPLOAD_DIR` to a
> scratch directory for the dev run, or simply do not exercise the upload
> endpoints there. Note the `CMS_` prefix is load-bearing: a bare `UPLOAD_DIR`
> is dead config that nothing reads, and this repository's `.env` still carries
> a container value for it. See
> [`ELECTRON.md`](ELECTRON.md#does-this-still-run-outside-electron) for why a
> key already sitting inert in someone's `.env` must not be given a meaning.

---

## Security model

The warning at the top of this file is the short version. In detail: the
authentication system was **removed**, not disabled — the entire `/api/auth/*`
surface is gone and returns `404`, along with the `User` account columns, the
`RefreshToken` / `ConsumedToken` / `PasswordResetToken` tables, the
`viewer`/`user`/`curator`/`admin` ladder, the Telegram 2FA gate, the Users tab
and the login screen. The frontend boots straight into the dashboard.

Confirm both facts on a running instance:

```bash
curl -s http://localhost:4001/api/version | grep -A2 authentication
# "required": false, "scheme": "none"

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4001/api/auth/login
# 404 — gone, not merely disabled
```

### What is still enforced

Being unauthenticated is not the same as undefended. What remains:

- **Input validation on every write.** Length caps, type checks, and enum
  allowlists run before any SQL is built, so a malformed request is a `400` and
  never a partial row. See `src/services/sqlSafety.js`.
- **SQL escaping on every interpolated value.** All string-literal positions go
  through a single `esc()` helper; every query is parameter-shaped rather than
  concatenation-shaped.
- **Rate limiting** on `/api` (`src/middleware/rateLimit.js`) plus a tighter
  limiter on the CORS settings writes.
- **API key on the notification endpoints.** `/api/notifications/*` requires
  `X-CMS-API-KEY`; it fails closed (403) if `API_KEY` is unset.
- **Helmet, CORS, and `express.static` hardening** in
  [`src/server.js`](src/server.js).
- **Uploads are still image-processed and renamed** by `sharp` via
  `src/middleware/imageUpload.js` / `imageProcessor.js`.

### What is no longer enforced, and is a real change

- **`/uploads` is world-readable to anyone who can reach the port.** The
  per-image access middleware (`src/middleware/uploadAccess.js`) was deleted
  along with the role system, and `/uploads` is now a bare `express.static`
  mount ([`src/server.js:153`](src/server.js)). In earlier versions a
  viewer-tier account could not fetch an image directly. **This is a genuine
  regression in per-image access control**, accepted as part of removing auth —
  but it is the one to be aware of, because an image URL is now a bearer
  reference with no expiry. (The desktop build is the one case where the blast
  radius is smaller — it binds `127.0.0.1` — but it also **switches the origin
  allowlist off entirely**, so any page in any browser on that machine can reach
  it. See "The desktop build runs with CORS restrictions switched off" in
  [`ELECTRON.md`](ELECTRON.md).)
- **Every record is readable and writable by any client on the network.**

### Where the boundary is

The security boundary is the network, not the application. Three workable
options, in descending order of how much you have to remember to do:

1. **Trusted LAN or VPN only.** Bind the port to an interface your untrusted
   devices cannot reach.
2. **An authenticating reverse proxy.** Put Caddy/nginx/Authelia in front and
   let *it* terminate auth. The app keeps no session state, so an
   externally-authenticated proxy drops in cleanly.
3. **An SSH tunnel** for a single operator, leaving the port bound to loopback:
   `ssh -L 4001:127.0.0.1:4001 user@host`.

In Docker, `127.0.0.1:${CMS_PORT:-4001}:4001` in
[`docker-compose.yml`](docker-compose.yml) makes the port invisible to the LAN
and forces the tunnel.

### The Telegram chat id, which is the one thing auth was load-bearing for

Two-factor login is gone, but the **Telegram chat id was deliberately kept** —
it is what the n8n notification workflows send to. It now lives in its own
`TelegramChat` table rather than on the user row, and on an old database it is
migrated once at boot ([`src/services/db.js:197-213`](src/services/db.js:197)).
See "What happens to your Telegram chat id on upgrade" in
[`DOCKER.md`](DOCKER.md) for the verification and repair SQL.



## Known issues and deferred fixes

Engineer-facing notes. These are **real, unfixed defects** in the tree right now.
Severities are the honest ones, not the flattering ones: `[low]` means a comment
or a cosmetic value is wrong, and `[open]` means a known gap with no code behind
it at all.

> **Test coverage.** `npm test` runs four suites: makers (85), wishlist (59),
> lens expiry (44) and transfer (61). The transfer suite covers the ZIP
> container, export, the inspect pre-flight, import in both modes, the ZIP-slip
> guard, the HTTP confirmation gate, and the CORS reconciliation in both
> migration directions. **Not covered:** anything needing a browser, so the
> Settings "Move this collection" panel is verified only by static checks — the
> inline script parses and every `getElementById` target exists, but the panel
> has never been rendered.

### `[low]` The z-index comment on the boot splash is wrong

- **Symptom.** None. This is a comment that misdescribes the code beneath it.
- **Mechanism.** [`public/index.html:792`](public/index.html:792) says the boot
  overlay is "the SAME `#loading-overlay` element (the same z-index and
  spinner)". The z-index is not the same: it is `9997` at
  [`public/index.html:799`](public/index.html:799) against the base overlay's
  `9998` at [`public/index.html:842`](public/index.html:842).
- **Blast radius.** Effectively zero. Only the toast at
  `z-index: 9999` outranks the boot splash, which is the correct ordering.
- **Fix.** Correct the comment, or unify the two values and then the comment is
  true. The next person to trust this comment will be wrong.

### `[low]` `z-index: 9997` on the boot splash is redundant

- **Symptom.** None.
- **Mechanism.** As above — 9997 exists only to be a slightly-lower duplicate of
  the base overlay's 9998, and nothing sits between the two values.
- **Fix.** Collapse to a single value; the distinction was never load-bearing.

### `[open]` Uploads are not garbage-collected, and the old config key still exists

- **Symptom.** Nothing ever deletes an uploaded image that is no longer
  referenced, so the store grows without bound.
- **Mechanism.** There is no GC pass anywhere. Because `/uploads` is a bare
  `express.static` mount
  ([`src/server.js:153`](src/server.js)), an image URL is also a permanent
  bearer reference with no expiry.
- **Partly resolved since this was first written.** The five hardcoded
  `path.join(__dirname, '../../data/uploads')` call sites are gone; they all
  resolve from [`src/services/paths.js`](src/services/paths.js) now, and the
  desktop build points them at its own `userData` directory. So *per-instance*
  isolation is achievable today with `CMS_UPLOAD_DIR` — it is just not applied
  to the dev-vs-production case above.
- **Still wrong.** A bare `UPLOAD_DIR` remains **dead config** that no code
  reads, yet it is still set in [`.env`](.env) and named in
  [`.env.example`](.env.example). It is not harmless-looking: it holds a
  container path, and a future edit that starts reading the bare name would
  break every non-Electron start. Either delete it from the docs and this
  `.env`, or leave it with a comment saying it is inert.
- **Also unverified.** Two files in `data/uploads` (mtimes 16:35:04 and 16:43:24)
  are of **unconfirmed reference status**. An earlier session quarantined two
  *confirmed* orphans, but whether these two are still referenced by any
  `Costume` row has not been checked. Do not delete them on the strength of this
  note.
- **Fix.** Decide `UPLOAD_DIR`'s fate, then add a scheduled pass that deletes
  unreferenced files. Both halves belong together: the store already relocates
  cleanly, so without GC an isolated directory just relocates the unbounded
  growth.

### `[open]` The desktop build is early, and macOS has never been built

- **Status.** The Electron target landed as an explicitly early release.
  Verified by running: Linux under `xvfb-run`, and the Windows NSIS installer
  run under Wine. Full detail in [`ELECTRON.md`](ELECTRON.md).
- **Not verified.** macOS has never been built or run at all — `PRECOMPILED.mac`
  points at the x64 SQLite build, so Apple Silicon would need Rosetta 2. The
  Windows checks ran under Wine, which is also how NSIS itself runs, so GPU and
  some Win32 edge cases differ from native Windows.
- **Operational hazards while it holds.** Installers are **unsigned**, so
  SmartScreen warns on first run, and there is **no auto-updater**. Icons are
  unset, so builds use the default Electron icon.
- **A desktop install does not see the Docker database.** Everything writable
  lives under Electron's `userData`, which is a *different* database and upload
  store from the container's Docker volume. They share nothing in either
  direction. **Settings → Move this collection** is the supported way to get
  data across: export on one side, import on the other. It carries every table
  and every image, takes a backup first, and handles the origin allowlist per
  direction — discarded when the target is a desktop app, and the target
  server's own rules preserved when it is self-hosted.
- **Fix.** Build and run a macOS DMG on a real Mac, run the installer once
  natively on Windows, and add code signing plus an `app-builder` update feed.

### `[open]` No regression test covers the boot splash

- **Symptom.** The boot-splash behaviour has no automated proof and can silently
  regress.
- **Mechanism.** No test script asserts on the splash. There is also no headless
  browser available on this host — `node_modules/@puppeteer/` is present but
  empty — so nothing in the toolchain can assert on first-paint behaviour. The
  only automated check that exists is a static parse of the single inline
  `<script>` block, which proves the script is syntactically valid but says
  nothing about what it paints.
- **Fix.** Install a real headless browser, or add a jsdom-level test that
  asserts the splash is `display: none` after load and that the retry block is
  hidden on a successful boot. Until then, treat the boot splash as
  manually-verified-only and say so in release notes.

### `[open]` No process supervisor outside Docker

- **Symptom.** A bare-metal `npm start` does not come back after a crash or a
  reboot, and a restart means finding the PID by hand.
- **Mechanism.** There is no systemd unit and no `pm2` in this repository. A
  bare `node` process gets nothing: it dies with the shell that started it.
- **Not a gap in the container deployment.**
  [`docker-compose.yml`](docker-compose.yml) sets `restart: unless-stopped`,
  which already covers crash-restart and reboot for the supported deployment —
  adding a host supervisor on top of that would just put two things fighting
  over the same port.
- **Operational hazard while it holds no supervisor.** A restart must be a manual
  `kill -TERM <explicit PID>`. **Never** `pkill -f "src/server.js"` — that
  pattern matches a dev server on `:4139` as well as anything on `:4001` and
  takes both down. Read `/proc/<pid>/cwd` to confirm which process you are about
  to signal.
- **Fix.** If you deploy bare metal, write a unit with `Restart=on-failure` and
  an explicit `WorkingDirectory`. Note that systemd does not read a shell
  profile, so `ExecStart` needs an absolute `node` path or an nvm install will
  fail with `203/EXEC`.

### `[open]` The Docker build is automated but unproven against a real deployment

- **Status.** [`.github/workflows/docker.yml`](.github/workflows/docker.yml)
  builds the image on every change that could affect it, then **runs** it and
  asserts a data route, the `sqlite3` driver, `sharp` at require time, a
  non-root uid, a writable data dir, and a clean SIGTERM shutdown.
- **Why a data route and not just `/health`.** `/health` returns 200 without
  touching the database, so a green healthcheck does not prove the `sqlite3`
  driver or the schema work. The worst failure mode for this image is one that
  boots healthy and then 500s everywhere, and the smoke test hits
  `/api/costumes` for exactly that reason.
- **Still unproven.** CI has never run yet — the workflow was added after the
  last push, so the first green run is the first evidence the image builds at
  all. Until it passes on `main`, treat the build as reasoned rather than
  demonstrated, and expect the first run to need a small adjustment (most likely
  apt package availability on the pinned Debian base, not the design).
- **Also unverified by CI.** [`docker-compose.yml`](docker-compose.yml) itself is
  never started by the workflow, only the image it builds. The volume layout and
  host-port remapping are still documented rather than demonstrated.

## Next

The order I would take the items above in, bundled by what each group unblocks
rather than by severity. None of it is committed work.

**1. Garbage-collect uploads.** This is the only remaining item that can lose
or corrupt someone's data, so it goes first. The path half is already done:
everything resolves from `src/services/paths.js`, so an instance can be pointed
at its own root. What is missing is the second half — a scheduled pass that
deletes unreferenced files. Add it while deciding `UPLOAD_DIR`'s fate; an
isolated store with no GC just relocates the unbounded growth.

**2. Prove the boot path.** Install a headless browser and assert that the splash
is `display: none` after load and that the retry block is hidden on a successful
boot. Until that exists the boot behaviour is manually verified only, and the
retry state machine in particular has no automated protection against a future
edit reverting it.

**3. Get the first green CI run, then exercise compose.** The workflow builds and
runs the image, but it has never executed — so the first run is the first real
evidence any of this works, and it is worth watching rather than ignoring. After
it passes, bring [`docker-compose.yml`](docker-compose.yml) itself under test
too: the workflow runs the image directly, so the volume layout and the
`127.0.0.1` port remap remain configured but unexercised. Do this last: it is the
item that pays off most when the code behind it has stopped moving.

**Deliberately not planned.** No authentication, no roles, no multi-user. The
boundary is the network or a reverse proxy, and the cheapest correct answer to
"who can reach this" is still an authenticating proxy in front. Adding auth
back into an app that works on a private LAN would be solving a problem this
deployment does not have.

## Further reading

This file covers the application. The other two deployment targets are
documented separately:

- [`DOCKER.md`](DOCKER.md) — the container deployment and operations reference.
  This is the primary target.
- [`ELECTRON.md`](ELECTRON.md) — the desktop build: what the main process
  supplies, where the data lives, the packaging gotchas, and what has and has
  not been verified per platform.
- [`docker-compose.yml`](docker-compose.yml) — the deployment of record.
- [`workflows/n8n_contact_lens_expiry_alert.json`](workflows/n8n_contact_lens_expiry_alert.json)
  — the inbound n8n workflow that drives the lens-expiry alerts.
- [`docs/`](docs) — the GitHub Pages profile site, published from this repository.

## License

ISC, as declared in [`package.json`](package.json). The full text is in
[`LICENSE`](LICENSE).

## Security note

Nothing in this repository should ever contain a real API key, bot token or
Telegram chat id — not in this file, not in DOCKER.md, not in an example
that was "copied from a running system". Live values belong in `.env` (reference
them by name) and, for the chat id, in the `TelegramChat` table. Committing a
credential is the mistake this file exists to help avoid.

There are no longer any passwords, password hashes or TOTP seeds in the schema
at all, so the class of leak this file was originally guarding against no longer
applies to the account tables. `API_KEY` and `TELEGRAM_BOT_TOKEN` are what
remain worth protecting.
