<div align="center">

# 🧥 Cosplay CMS

### Inventory for costumes, props & contact lenses

[![Live site](https://img.shields.io/badge/Website-live-8b5cf6?style=flat-square&logo=github&logoColor=white)](https://rielolita171.github.io/cosplay-cms/)
[![Pages](https://img.shields.io/badge/GitHub%20Pages-passing-2ea44f?style=flat-square&logo=github&logoColor=white)](https://rielolita171.github.io/cosplay-cms/)
[![Node](https://img.shields.io/badge/Node-22-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-CLI-003b57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](#license)
[![No build step](https://img.shields.io/badge/build-none%20required-6f42c1?style=flat-square)](#running-it)

[**Visit the project site →**](https://rielolita171.github.io/cosplay-cms/)

</div>

---

A private, single-user inventory system for cosplay props, costumes and contact
lenses. Express and the `sqlite3` CLI on the back end, a single self-contained
`public/index.html` on the front end. No build step, no bundler, no CDN.

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
```

Configuration is read from `.env` at the repository root. The names that
matter are `PORT`, `NODE_ENV`, `DATABASE_PATH`, `API_KEY`, `CORS_ORIGIN` and
`TELEGRAM_BOT_TOKEN`. **Their values live in `.env` and must never be copied
into this file, into a commit, or into a ticket** — refer to them by name, as
done here.

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

> **Do not test uploads against a second/dev instance.** `UPLOAD_DIR` is dead
> config that nothing reads; `src/routes/images.js`,
> `src/middleware/imageUpload.js` and `src/middleware/imageProcessor.js` all
> resolve `path.join(__dirname, '../../data/uploads')`, which is
> `__dirname`-relative. A dev server on another port writes into the *same*
> production upload directory. Point a dev run at a scratch copy, or simply
> do not exercise the upload endpoints there.

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
  mount ([`src/server.js:136-144`](src/server.js:136)). In earlier versions a
  viewer-tier account could not fetch an image directly. **This is a genuine
  regression in per-image access control**, accepted as part of removing auth —
  but it is the one to be aware of, because an image URL is now a bearer
  reference with no expiry.
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
migrated once at boot ([`src/services/db.js:164-200`](src/services/db.js:164)).
See "What happens to your Telegram chat id on upgrade" in
[`DOCKER.md`](DOCKER.md) for the verification and repair SQL.



## Known issues and deferred fixes

Engineer-facing notes. These are **real, unfixed defects**, not a roadmap and
not a wishlist. Each one is either a bug that is present in the tree right now
or an operational hazard that has already caused a mistake. Severities are the
honest ones, not the flattering ones: `[high]` means it can point a process at
production data by accident, `[medium]` means a user sees something wrong, and
`[open]` means a known gap with no code behind it at all.

The `verify-*.sh` harnesses that used to accompany these items are not in this
repository and are not part of the deployment: they need their own scratch
database, and nothing checked in here should be able to run one by accident.

### `[medium]` The Retry button is visible from the first frame of every boot

- **Symptom.** On a completely normal, successful boot the user sees a clickable
  "Retry" button and a "Your session has been kept" message painted over the
  splash for the entire duration of the profile call plus `loadAllData()`.
- **Mechanism.** [`public/index.html:737`](public/index.html:737) is
  `.loading-overlay.boot .boot-retry { display: flex; }`, which keys off the
  `.boot` class alone. But [`public/index.html:3527`](public/index.html:3527)
  `showBootSplash()` adds `boot` at the top of *every* boot, not only when a
  failure occurs. The retry block is therefore visible whenever `.boot` is
  present, and `.boot` is present during every boot.
- **Second half of the same bug.** On a genuine transient failure the static
  "Loading..." label still renders next to the retry block, because
  [`public/index.html:742`](public/index.html:742) only hides the *spinner*
  (`.boot.is-retrying .spinner`), not the text label that follows it.
- **Fix.** Gate the retry block on an actual transient state — e.g.
  `.boot.is-retrying .boot-retry { display: flex; }` — and hide the loading
  label in that state as well.
- **Ref.** [`public/index.html`](public/index.html)

### `[medium]` A throw during boot leaves a permanently blank page

- **Symptom.** If anything throws in the pre-restore bootstrap, the page renders
  as nothing at all: no dashboard, no error, and no way in. The boot splash is
  painted over the top and never dismissed.
- **Mechanism.** In [`public/index.html:8624`](public/index.html:8624) `init()`,
  the calls to `bindGridEvents()` (`:8625`), `installModalCloseButtons()`
  (`:8629`) and `renderColorSwatches()` (`:8636`) sit **outside every
  try/catch** — the first `try` begins at `:8641`, around `loadAllData()` alone
  — and there is no `window.onerror` / `unhandledrejection` handler anywhere in
  the inline script. If any of the three throws, `init()` aborts before
  `showDashboard()` and `showLoading(false)`, so the `#loading-overlay` that
  `showBootSplash()` raised is never taken down and the user is left staring at
  an opaque splash over a dashboard whose data never loaded.
- **Note on severity.** `.screen` no longer sets `display: none`
  ([`public/index.html:639`](public/index.html:639)), so the markup underneath
  is technically visible; the boot splash is what actually hides it. There is
  only one `.screen` now (`#screen-dashboard`,
  [`public/index.html:1376`](public/index.html:1376)) — the login screen and
  `showLogin()` were removed with the auth work, so "falls back to
  `showLogin()`" is no longer available as a remedy.
- **Realistic trigger.** `renderColorSwatches()` is null-guarded, so
  `bindGridEvents()` is the likely culprit — it is the largest of the three and
  the one
  [`public/index.html:8621`](public/index.html:8621) calls out as attaching the
  delegated card-action listeners, and the comment at
  [`public/index.html:3655`](public/index.html:3655) records work done in and
  around it.
- **Fix.** Wrap the three pre-splash bootstrap calls in `try`/`catch` that still
  calls `showDashboard()` and `showLoading(false)`, and/or install a boot-scoped
  `error` + `unhandledrejection` safety net that removes itself once boot
  resolves. There is no login form to fall back to, so the splash must always
  come down.
- **Ref.** [`public/index.html`](public/index.html)

### `[high]` `DATABASE_URL` is dead config that silently points at production

- **Symptom.** Anyone who "fixes" the database by exporting `DATABASE_URL` is
  still talking to the production database, with no error and no warning.
- **Mechanism.** [`src/services/db.js:33`](src/services/db.js:33) resolves
  `DB_FILE` from
  `process.env.DATABASE_PATH`, not `DATABASE_URL`. `.env` line 2 sets
  `DATABASE_URL="file:/data/db/cms.db"`, dotenv loads it, and the code ignores
  it entirely — so `DB_FILE` falls back to the **cwd-relative**
  `data/db/cms.db`. The dead name is also set in [`.env.example`](.env.example)
  and is named in the Docker deployment docs, which makes it look authoritative
  everywhere it is read.
- **Consequence.** This trap has already fired once in this project's history: a
  process configured to point somewhere safe kept writing to production.
- **Fix.** Either rename/remove the dead `DATABASE_URL` everywhere it appears,
  or make [`src/services/db.js:33`](src/services/db.js:33) accept it. Do not
  leave a name that is documented in five places and honoured in none.

### `[medium]` Related: `DB_FILE` is still cwd-relative

- **Symptom.** A server started from the wrong working directory writes to
  production regardless of `DATABASE_PATH`.
- **Mechanism.** [`src/services/db.js:33`](src/services/db.js:33) resolves
  `DB_FILE` as `process.env.DATABASE_PATH || 'data/db/cms.db'` — the fallback is
  a **cwd-relative literal**, not `__dirname`-anchored. The `queryDb()` helper is
  still duplicated per route file, but each copy now imports the single
  `DB_FILE` binding rather than hardcoding its own literal, so there is one place
  to fix: the fallback.
- **Already improved.** This item used to be worse and was written when each of
  six route files hardcoded the string `'data/db/cms.db'` independently, ignoring
  `DB_FILE` entirely. Those copies now share the binding
  ([`src/routes/costumes.js:6`](src/routes/costumes.js:6),
  [`src/routes/lenses.js:6`](src/routes/lenses.js:6),
  [`src/routes/brands.js:18`](src/routes/brands.js:18),
  [`src/routes/fandoms.js:15`](src/routes/fandoms.js:15),
  [`src/routes/props.js:6`](src/routes/props.js:6),
  [`src/routes/notifications.js:6`](src/routes/notifications.js:6),
  [`src/routes/makers.js:31`](src/routes/makers.js:31)), which is why the count is seven
  now and the risk is one edit away rather than seven. The cwd sensitivity
  itself is **unfixed** — this is how the dev server on `:4139` was once found
  writing into the production database.
- **Fix.** Anchor the fallback to `__dirname` (or the container's `/app`) so a
  wrong working directory cannot silently redirect writes.

### `[low]` The z-index comment on the boot splash is wrong

- **Symptom.** None. This is a comment that misdescribes the code beneath it.
- **Mechanism.** [`public/index.html:718`](public/index.html:718) says the boot
  overlay is "the SAME `#loading-overlay` element (the same z-index and
  spinner)". The z-index is not the same: it is `9997` at
  [`public/index.html:725`](public/index.html:725) against the base overlay's
  `9998` at [`public/index.html:760`](public/index.html:760).
- **Blast radius.** Effectively zero. Only the toast at
  `z-index: 9999` outranks the boot splash, which is the correct ordering.
- **Fix.** Correct the comment, or unify the two values and then the comment is
  true. The next person to trust this comment will be wrong.

### `[low]` `z-index: 9997` on the boot splash is redundant

- **Symptom.** None.
- **Mechanism.** As above — 9997 exists only to be a slightly-lower duplicate of
  the base overlay's 9998, and nothing sits between the two values.
- **Fix.** Collapse to a single value; the distinction was never load-bearing.

### `[open]` Uploads are not isolated between instances

- **Symptom.** A dev instance and production share one uploads directory, so
  development writes production's user data (and vice versa).
- **Mechanism.** Uploads always resolve to `data/uploads`; there is no
  `public/uploads/` directory at all. `UPLOAD_DIR` is **dead config** —
  `grep -rn UPLOAD_DIR src/` returns no matches — yet it is still set in
  [`.env`](.env) and named in [`.env.example`](.env.example), and the dev server
  on `:4139` is nevertheless *launched with it set*, which is the worst of both
  worlds. The hardcoded
  call sites are [`src/middleware/imageUpload.js:7`](src/middleware/imageUpload.js:7),
  [`src/middleware/imageProcessor.js:94`](src/middleware/imageProcessor.js:94),
  [`src/routes/images.js:120`](src/routes/images.js:120),
  [`src/routes/costumes.js:911`](src/routes/costumes.js:911) and the static
  mount at [`src/server.js:136`](src/server.js:136).
- **Also unverified.** Two files in `data/uploads` (mtimes 16:35:04 and 16:43:24)
  are of **unconfirmed reference status**. An earlier session quarantined two
  *confirmed* orphans, but whether these two are still referenced by any
  `Costume` row has not been checked. Do not delete them on the strength of this
  note.
- **Fix.** Give each instance its own upload root, make `UPLOAD_DIR` real or
  delete it from the docs, and GC unreferenced files on a schedule.

### `[open]` No process supervisor

- **Symptom.** Production does not come back on its own after a crash or a
  reboot.
- **Mechanism.** It runs as a bare `npm start`. There is no systemd unit, no
  `pm2`, no restart policy.
- **Operational hazard.** A restart must be a manual
  `kill -TERM <explicit PID>`. **Never** run `pkill -f "src/server.js"` — that
  pattern matches the dev server on `:4139` as well as production on `:4001`,
  and will take both down. Read `/proc/<pid>/cwd` to confirm which process you
  are about to signal.
- **Fix.** A systemd unit with `Restart=on-failure` and an explicit `WorkingDirectory`.

### `[open]` No regression test covers the boot splash

- **Symptom.** The flash-on-refresh fix has no automated proof and can silently
  regress.
- **Mechanism.** No test script asserts on the splash. There is also no headless
  browser available on
  the remote host — `node_modules/@puppeteer/` is present but empty — so nothing in
  the toolchain can assert on first-paint behaviour. The only automated check
  that does exist is a static parse of the single inline `<script>` block, which
  proves the script is syntactically valid but says nothing about what it paints.
- **Fix.** Either add a jsdom-level test that asserts the splash is `display:
  none` at parse time, or install a real headless browser. Until then, treat the
  boot splash as manually-verified-only and say so in release notes.

> The three items that previously sat here — the login rate-limiter ordering in
> the external `verify-*.sh` harnesses, the client-side admin gate on the
> Security tab, and the queued admin user CRUD — are **withdrawn as resolved by
> the auth removal**, not by a fix. The login limiter and `verify-reset.sh` no
> longer exist; the Settings routes lost their `verifyToken, authorize('admin')`
> guard along with every other admin capability, because there are no longer any
> non-admins; and there is no user CRUD left to build.

> **One artefact of that removal is still in the tree.**
> [`scripts/test_phase5.js`](scripts/test_phase5.js) is **obsolete**: it holds 44
> references to `/api/auth/*` endpoints that no longer exist anywhere in `src/`,
> and asserts on `RefreshToken` rows that are no longer in the schema. It cannot
> be producing a meaningful pass count. It is retained for now only because
> `package.json` still exposes it as `npm run test:phase5`; that script entry
> should be dropped or the suite rewritten against the current API.
> `scripts/test_makers.js`, `test_wishlist.js` and `test_phase4.js` reference
> only live endpoints and are unaffected.

---

## Next

The items above are defects, not a schedule. This is the order I would take them
in, bundled by what each one unblocks rather than by severity. Nothing here is
committed work — it is the shape of the next pass, so a reader can judge how
finished this is.

**1. Stop the data hazards, because they are the ones that can lose records.**
Anchor `DB_FILE` to `__dirname` so a wrong working directory cannot redirect
writes, then delete the `DATABASE_URL` name from `.env`, `.env.example` and the
Docker docs. These two are one change: the trap is the name, and the fix is to
stop honouring it in one place. Then give each instance its own upload root and
add a scheduled pass that deletes unreferenced files — today an image URL is a
permanent bearer reference with no expiry, and there is no GC at all.

**2. Make the boot path impossible to get wrong.** Gate the retry block on
`is-retrying` instead of `boot`, and wrap the three pre-splash calls in
`init()` so a throw can never leave the opaque splash up. These are one change
too — both are the same missing state machine. Then install a headless browser
so the splash has a regression test; without one, that fix is unverifiable and
will silently rot.

**3. Retire the obsolete test suite.** `scripts/test_phase5.js` still asserts
against `/api/auth/*` and cannot pass. Rewrite it against the current API, or
drop the `test:phase5` entry in `package.json` and stop advertising a suite
that does not run. Do not leave a green-looking script that is red.

**4. Operational, once the above is stable.** A systemd unit with
`Restart=on-failure` and an explicit `WorkingDirectory`. This is the one item
that pays off only when nothing else is on fire, which is exactly why it goes
last.

**Deliberately not planned.** No authentication, no roles, no multi-user. The
boundary is the network or a reverse proxy, and the cheapest correct answer to
"who can reach this" is still an authenticating proxy in front. Adding auth
back into an app that works on a private LAN would be solving a problem this
deployment does not have.

---

## Further reading

This file covers the application. Container deployment — the image, the volume
layout, the boot sequence, the verification SQL and the failure modes — is
documented separately:

- [`DOCKER.md`](DOCKER.md) — the deployment and operations reference.
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
