# Cosplay CMS

A private inventory system for cosplay props, costumes and contact lenses.

**This deployment has no authentication.** There is no login, no password, no
role ladder and no session token. Anyone who can reach the published port has
full read *and* write access to every record. That is deliberate — it is a
single-user box on a private network, and the boundary is the network or a
reverse proxy, not the application. See "Security model" below, and do not
publish this port to the internet.

Express + the `sqlite3` CLI on the back end, a single self-contained
`public/index.html` on the front end. No build step, no bundler, no CDN.

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

There is no authentication in this build. Not "disabled by default" — removed.
Concretely, the following are gone from the tree and return `404`:

| Removed | What it used to do |
|---|---|
| `POST /api/auth/register` | Create a `user` account |
| `POST /api/auth/login` | Exchange credentials for a JWT |
| `GET /api/auth/profile` | Report the signed-in user and their role |
| `POST /api/auth/refresh` | Mint a replacement access token |
| `GET/PATCH /api/auth/users*` | List accounts, change a role |
| `POST /api/auth/users/:id/password-reset` | Mint a one-time reset file |
| `POST /api/auth/password-reset*` | Redeem a reset token |

Along with them: the `"User"` table's account columns, the `RefreshToken`,
`ConsumedToken` and `PasswordResetToken` tables, the `viewer`/`user`/`curator`/
`admin` ladder, the Telegram 2FA gate, the Users tab, and the login screen. The
frontend boots straight into the dashboard.

The machine-readable check, if you want to confirm this on a running instance:

```bash
curl -s http://localhost:4001/api/version | grep -A2 authentication
# "required": false, "scheme": "none"
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
  mount ([`src/server.js:132-140`](src/server.js:132)). In earlier versions a
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

### There is no account to create

If you are looking for a bootstrap step, there isn't one — and that is the point.
The old "register, then promote yourself to admin by hand-editing the
`"User"` table" dance existed only to work around the role ladder. There is no
`create-admin` script because there is nothing to administer. Start the server
and open the dashboard.



## Known issues and deferred fixes

Engineer-facing notes. These are **real, unfixed defects**, not a roadmap and
not a wishlist. Each one is either a bug that is present in the tree right now
or an operational hazard that has already caused a mistake. Severities are the
honest ones, not the flattering ones: `[high]` means it can point a process at
production data by accident, `[medium]` means a user sees something wrong, and
`[open]` means a known gap with no code behind it at all.

A note on the verification harnesses, since several items below reference them:
`verify5a.sh`, `verify5b.sh`, `verify-cors.sh` and `verify-reset.sh` live
**outside the repository**, in `/home/natanieldt/dev4139` and
`/home/natanieldt/dev4140`. That is deliberate — they need their own scratch
database, and nothing in this repository should be able to run them by accident
(see item 9).

### `[medium]` The Retry button is visible from the first frame of every boot

- **Symptom.** On a completely normal, successful boot the user sees a clickable
  "Retry" button and a "Your session has been kept" message painted over the
  splash for the entire duration of the profile call plus `loadAllData()`.
- **Mechanism.** [`public/index.html:548`](public/index.html:548) is
  `.loading-overlay.boot .boot-retry { display: flex; }`, which keys off the
  `.boot` class alone. But [`public/index.html:3126`](public/index.html:3126)
  `showBootSplash()` adds `boot` at the top of *every* `restoreSession()`, not
  only when a failure occurs. The retry block is therefore visible whenever
  `.boot` is present, and `.boot` is present during every boot.
- **Second half of the same bug.** On a genuine transient failure the static
  "Loading..." label still renders next to the retry block, because
  [`public/index.html:553`](public/index.html:553) only hides the *spinner*
  (`.boot.is-retrying .spinner`), not the text label that follows it.
- **Fix.** Gate the retry block on an actual transient state — e.g.
  `.boot.is-retrying .boot-retry { display: flex; }` — and hide the loading
  label in that state as well.
- **Ref.** [`public/index.html`](public/index.html)

### `[medium]` A throw during boot leaves a permanently blank page

- **Symptom.** If anything throws in the pre-restore bootstrap, the page renders
  as nothing at all: no login form, no dashboard, no error. There is no way in.
- **Mechanism.** In [`public/index.html:7073`](public/index.html:7073) `init()`,
  the calls to `bindGridEvents()` (`:7074`) and `renderColorSwatches()`
  (`:7078`) sit **outside every try/catch**, and there is no
  `window.onerror` / `unhandledrejection` handler anywhere in the inline script.
  The boot-splash change deleted the old unconditional `showLoading(false)` at
  the end of `init()`, so if either call throws, all four `.screen` sections stay
  at `display: none` — including [`public/index.html:1149`](public/index.html:1149)
  `#screen-login`, which now ships hidden by default.
- **Regression.** Before this change the same throw at least left a clickable
  login form on screen. The blank page is new.
- **Realistic trigger.** `renderColorSwatches()` is null-guarded, so
  `bindGridEvents()` is the likely culprit — and the comment at
  [`public/index.html:3622`](public/index.html:3622) records that
  `bindGridEvents()` has previously thrown a `ReferenceError` on load, which
  killed the restore branch outright.
- **Fix.** Wrap the pre-restore bootstrap in `try`/`catch` that falls back to
  `showLogin()`, and/or install a boot-scoped `error` + `unhandledrejection`
  safety net that removes itself once boot resolves.
- **Ref.** [`public/index.html`](public/index.html)

### `[high]` `DATABASE_URL` is dead config that silently points at production

- **Symptom.** Anyone who "fixes" the database by exporting `DATABASE_URL` is
  still talking to the production database, with no error and no warning.
- **Mechanism.** [`src/services/db.js:18`](src/services/db.js:18) reads
  `process.env.DATABASE_PATH`, not `DATABASE_URL`. `.env` line 2 sets
  `DATABASE_URL="file:/data/db/cms.db"`, dotenv loads it, and the code ignores
  it entirely — so `DB_FILE` falls back to the **cwd-relative**
  `data/db/cms.db`. The dead name also appears in
  [`prisma/schema.prisma:10`](prisma/schema.prisma:10),
  [`verify.js:38`](verify.js:38), and five `phase-1-setup/*.md` documents,
  which makes it look authoritative everywhere it is read.
- **Consequence.** This trap has already fired once in this project's history: a
  process configured to point somewhere safe kept writing to production.
- **Fix.** Either rename/remove the dead `DATABASE_URL` everywhere it appears,
  or make [`src/services/db.js:18`](src/services/db.js:18) accept it. Do not
  leave a name that is documented in five places and honoured in none.

### `[medium]` Related: database resolution is cwd-relative in six route files

- **Symptom.** A server started from the wrong working directory writes to
  production regardless of `DATABASE_PATH`.
- **Mechanism.** The `queryDb()` helper is duplicated per route file, and each
  copy hardcodes the literal `'data/db/cms.db'` as a `spawn('sqlite3', [...])`
  argument — it never consults `DB_FILE` or `process.env` at all:
  [`src/routes/costumes.js:8`](src/routes/costumes.js:8),
  [`src/routes/lenses.js:24`](src/routes/lenses.js:24),
  [`src/routes/brands.js:21`](src/routes/brands.js:21),
  [`src/routes/fandoms.js:18`](src/routes/fandoms.js:18),
  [`src/routes/props.js:18`](src/routes/props.js:18) and
  [`src/routes/notifications.js:8`](src/routes/notifications.js:8).
  Only [`src/services/db.js:25`](src/services/db.js:25) uses the resolved
  `DB_FILE`. This is exactly how the dev server on `:4139` was once found
  writing into the production database.
- **Fix.** Resolve the database path from a single source (e.g. from `__dirname`)
  and honour `DATABASE_PATH` in every copy.

### `[low]` The z-index comment on the boot splash is wrong

- **Symptom.** None. This is a comment that misdescribes the code beneath it.
- **Mechanism.** [`public/index.html:529`](public/index.html:529) says the boot
  overlay is "the SAME `#loading-overlay` element (the same z-index and
  spinner)". The z-index is not the same: it is `9997` at
  [`public/index.html:536`](public/index.html:536) against the base overlay's
  `9998` at [`public/index.html:571`](public/index.html:571).
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
  `grep -rn UPLOAD_DIR src/` returns no matches — yet it is documented in
  `phase-1-setup/03-environment-config.md:49` and
  `phase-1-setup/README.md:116`, and the dev server on `:4139` is nevertheless
  *launched with it set*, which is the worst of both worlds. The hardcoded
  call sites are [`src/middleware/imageUpload.js:7`](src/middleware/imageUpload.js:7),
  [`src/middleware/imageProcessor.js:57`](src/middleware/imageProcessor.js:57),
  [`src/routes/images.js:120`](src/routes/images.js:120),
  [`src/routes/costumes.js:710`](src/routes/costumes.js:710) and the static
  mount at [`src/server.js:146`](src/server.js:146).
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

### `[open]` The phase-5 suite can write to production

- **Symptom.** Running the tests can mutate the live database.
- **Mechanism.** It is known to insert `RefreshToken` rows. It is a
  black-box HTTP suite and has no isolation of its own.
- **Rule.** Only run it with the working directory set to a scratch directory
  **outside the project tree**, using `DATABASE_PATH` — never `DATABASE_URL`
  (see item 3). The harness self-asserts a sha256 of the real database before
  and after, so a silent write is detectable, but detecting it is not the same as
  preventing it.
- **Recorded result.** `npm run test:phase5` → **109 passed / 0 failed / 2
  skipped**. The two skips are pre-existing and data-driven, not regressions:
  the lens list field contract (the scratch database contains no lenses) and
  `GET /api/lenses/:id` (no fixture id available). The production database
  contains no lenses either. Any figure claiming 110/110 is wrong; 109/0/2 is
  the true baseline.
- **Ref.** [`scripts/test_phase5.js`](scripts/test_phase5.js)

### `[open]` No regression test covers the boot splash

- **Symptom.** The flash-on-refresh fix has no automated proof and can silently
  regress.
- **Mechanism.** [`scripts/test_phase5.js`](scripts/test_phase5.js) contains no
  assertion on the splash. There is also no headless browser available on the
  remote host — `node_modules/@puppeteer/` is present but empty — so nothing in
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

---

## Further reading

This file is deliberately short. The long-form documentation already in the
repository is not duplicated here:

- [`cosplay_cms_phase_by_phase_implementation_server_setup_guide.md`](cosplay_cms_phase_by_phase_implementation_server_setup_guide.md)
  — the phase-by-phase server setup guide.
- [`HANDOFF-viewer-role-and-costume-gallery.md`](HANDOFF-viewer-role-and-costume-gallery.md)
  — the design and verification record for the viewer tier and the costume
  gallery, including the per-assertion test results.
- [`phase-5-setup/README.md`](phase-5-setup/README.md) — the frontend SPA.

## Security note

Nothing in this repository should ever contain a real API key, bot token or
Telegram chat id — not in this file, not in the phase guides, not in an example
that was "copied from a running system". Live values belong in `.env` (reference
them by name) and, for the chat id, in the `TelegramChat` table. Committing a
credential is the mistake this file exists to help avoid.

There are no longer any passwords, password hashes or TOTP seeds in the schema
at all, so the class of leak this file was originally guarding against no longer
applies to the account tables. `API_KEY` and `TELEGRAM_BOT_TOKEN` are what
remain worth protecting.
