# Cosplay CMS

A private inventory system for cosplay props, costumes and contact lenses, with
Telegram-delivered two-factor login and a role ladder that separates
"can look at the records" from "can change them".

Express + `better-sqlite3` on the back end, a single self-contained
`public/index.html` on the front end. No build step, no bundler, no CDN.

---

## Running it

```bash
npm install
npm start          # node src/server.js, listens on PORT (default 4001)
npm run dev        # node --watch src/server.js
```

Configuration is read from `.env` at the repository root. The names that
matter are `PORT`, `DATABASE_PATH`, `API_KEY`, `JWT_SECRET`, `SESSION_SECRET`
and `TELEGRAM_BOT_TOKEN`. **Their values live in `.env` and must never be
copied into this file, into a commit, or into a ticket** — refer to them by
name, as done here. `JWT_SECRET` in particular is validated at boot: a
placeholder value, a value under 32 characters, or an unexpanded `$(...)` is
fatal and the server refuses to start (`src/middleware/auth.js:46-83`).

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

## User roles

The ladder is defined once, in `src/middleware/auth.js`, and everything else
reads it. `viewer` < `user` < `curator` < `admin`; the write threshold is
`user`.

| Tier | What it may do | Enforced at |
|---|---|---|
| `viewer` | Read everything. **No writes at all** — every mutating request is refused with `403` and code `READ_ONLY_ROLE`. Browsing the costume photo gallery *is* allowed; viewing is a read. | `requireWriteAccess`, `src/middleware/auth.js:279-296` |
| `user` | Full CRUD on costumes, brands, fandoms, props and lenses, plus the upload endpoints. This is the tier every self-registration receives. | same write guard — `user` is the threshold (`WRITE_ROLE`, `src/middleware/auth.js:218`) |
| `curator` | Everything `user` can do. Retained so pre-existing curator accounts keep whatever they could already do; it currently grants nothing extra over `user`. | same write guard |
| `admin` | Everything `user` can do, **plus user management**: `GET /api/auth/users`, `PATCH /api/auth/users/:id/role`, and `POST /api/auth/users/:id/password-reset` (the Jellyfin-style one-time reset *file* — there is no mail server on this box, so an admin mints a token and hands the file over manually). Also **plus server settings**: `GET`/`PUT /api/settings/cors` and `POST /api/settings/cors/reset`, which edit the CORS allowlist at runtime without a restart. | `authorize('admin')`, `src/middleware/auth.js:234-248`, mounted at `src/routes/auth.js:600` and `src/routes/auth.js:637`; settings at [`src/routes/settings.js:54`](src/routes/settings.js:54), `:111`, `:189` |

`curator` and `admin` are the only roles that are meaningfully distinct at
runtime, and only `admin` adds a capability today. `curator` sits in the
ordering so that existing curator rows keep working; it is not a place to
hang new permissions without a matching `authorize(...)` mount.

### Two independent gates

Writes are stopped by `requireWriteAccess`, which is **method-based**: it
passes `GET`/`HEAD`/`OPTIONS` and refuses everything else, mounted per
resource immediately after authentication in `src/server.js:280-312`. The
alternative — listing every write route by hand — is the shape of bug this
guard is shaped to avoid: one forgotten route is an unauthenticated write.

`authorize(role)` is the separate "at least this tier" guard, used only on
the admin endpoints (the two user-management routes, the password-reset mint,
and the three CORS settings routes). It is not mounted anywhere else.

The two unauthenticated password-reset endpoints are the deliberate exception and
are called out in full in [`src/server.js`](src/server.js) under
`POST /api/auth/password-reset/validate (public)` /
`POST /api/auth/password-reset (public)`: they have to be reachable by someone
who *cannot* sign in, so they authenticate with the reset token itself and are
rate limited per-IP **and** per-token. Every reset failure returns one identical
message, because a differentiated one is an oracle for whether a token exists.

> Both gates read the same `ROLE_LEVELS` map, so they cannot drift apart.

### Unknown roles fail closed

`roleLevel()` (`src/middleware/auth.js:220-222`) returns `0` for any role
string it does not recognise, rather than throwing or falling back to a
default. `role` is a plain `TEXT` column, so a hand-edited or imported row can
hold any string at all. Mapping those to the floor means a role the code does
not understand can never satisfy a `>= 'user'` check.

The practical consequence: **a typo in a role value locks an account out
rather than granting it access.** Setting a role to `Admin`, `ADMIN` or
`admin ` (trailing space) produces an account that can still log in, can
still read, and cannot write anything and cannot see the Users tab. The
allowed values are exactly the four in the table above, and the API rejects
anything else with `400` before it reaches the database.

The browser mirrors this: `roleRank()` in `public/index.html:2046-2049`
returns `-1` for anything it does not know, so a malformed role also leaves
every write control hidden.

---

## Getting a usable account

### 1. Register (always a plain `user`)

```bash
curl -X POST http://localhost:4001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"your-username","email":"you@example.com","password":"a-password-of-your-own"}'
```

Registration **always** creates a `user`. `src/routes/auth.js:212` destructures
only `username`, `email` and `password` from the body, and line 227 passes a
hardcoded `role: 'user'` to `db.createUser()`. A `role` field in the request
body is not read and is silently ignored.

> This is deliberate. A `role` parameter on a public registration endpoint is
> a privilege-escalation hole: anyone who can reach the URL could POST
> `{"role":"admin"}` and own the instance. Registration cannot mint an admin,
> by design.

**Watch the 2FA gate.** The `User` table defaults `telegram2FAEnabled` to `1`
(`init_db.sql:52`) and registration does not override it, so a brand-new
account has 2FA *on*. Login (`src/routes/auth.js:274-297`) then refuses to
issue an access token unless the server has a real `TELEGRAM_BOT_TOKEN` in
`.env` **and** the row already carries a `telegramChatId`; otherwise it
returns `503 TELEGRAM_NOT_CONFIGURED`. No public endpoint sets
`telegramChatId`, and the 2FA toggle (`src/routes/auth.js:417-418`) itself
requires an access token you do not have yet. In practice a fresh
self-registration cannot complete login until an operator links Telegram for
it — see the SQL below.

### 2. Create the first admin

**There is no bootstrap script, no seed command, and no environment variable
for this.** Verified: `package.json` has no `create-admin`; `scripts/`
contains only `import_excel.js` and the test suites; `init_db.sql` creates
the `"User"` table (`init_db.sql:41-58`) but inserts no rows; and nothing in
`src/` reads an `ADMIN_*`, `BOOTSTRAP_*` or `SEED_*` variable. There is
deliberately no API for it either — every role-writing route is
`authorize('admin')`, so a fresh install with no admins has no in-app way to
create one.

The only real path is **one SQL statement against the database file**, which
requires filesystem access to the server. Back up first:

```bash
cd /home/natanieldt/scripts/cms-cosplay
cp data/db/cms.db "data/db/cms.db.bak-$(date +%Y%m%d-%H%M%S)"
```

Check who you are about to promote, then promote:

```sql
-- table "User" (capital U, double-quoted), column `role` is TEXT
SELECT id, username, role FROM "User";

UPDATE "User" SET role = 'admin' WHERE username = 'your-username';
```

If the same account also needs to log in before Telegram is linked, unblock
2FA in the same sitting:

```sql
UPDATE "User" SET telegram2FAEnabled = 0 WHERE username = 'your-username';
```

Do not put a password in this file or in a command that lands in shell
history. The account's `passwordHash` is already set by registration, and
`src/routes/auth.js:270-272` upgrades any legacy hash to bcrypt on first
successful login.

**The promoted account must log in again.** See the propagation note below —
a manual `UPDATE` does not touch a token that is already in someone's hand.

### 3. Promote other accounts

Once an admin exists, everyone else is promoted through the API by an admin.
This is also a browser feature: the admin-only **Users** tab, whose `<select>`
options come from the server's own `assignableRoles` list
(`src/routes/auth.js:603`, rendered at `public/index.html:4366-4378`) rather
than from a second hardcoded copy, so the dropdown cannot offer a role the
endpoint would reject.

```bash
curl -X PATCH http://localhost:4001/api/auth/users/<user-id>/role \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}'
```

The token is **the signed-in admin's own access token**, not the target's.
`<user-id>` is the target's UUID from the `id` column of `"User"` (as listed
by the admin-only `GET /api/auth/users`).

### Two guards that will surprise you

Both are deliberate anti-lockout rules, and both return `400` with a code you
can match on:

- **`SELF_ROLE_CHANGE`** (`src/routes/auth.js:660-665`) — you cannot change
  your own role. The browser disables the select on your own row
  (`public/index.html:4395`) because this one is *always* refused; offering it
  and then rejecting it would be pure noise. Promote someone else, then have
  them promote you.
- **`LAST_ADMIN`** (`src/routes/auth.js:676-684`) — the last remaining admin
  cannot be demoted. `db.countAdmins()` (`src/services/db.js:491-495`) is read
  *before* the write, so "is this the last one" is answered against the state
  the change would apply to. It counts `role = 'admin'` as a literal string
  rather than via the numeric ladder, because the ladder's floor-mapping would
  disagree with a literal comparison for a role value the code does not know.
  Note the guard only fires when the change actually *removes* an admin, so
  promoting a non-admin is never blocked.

> Worth knowing: because the caller must already be an admin and the target
> must already be an admin, `LAST_ADMIN` is effectively unreachable through
> the API — reaching it would require `countAdmins() >= 2`. It is a backstop
> against a future route or a direct database edit, not a routine 400 you will
> hit in normal use. `SELF_ROLE_CHANGE` is the 400 you will actually meet.

Other refusals on the same route, for completeness: a role outside the
allowlist is `400 INVALID_ROLE` (`:645-651`); an id that is not a valid UUID
is `400 INVALID_ID` (`:639-642`); an unknown id is `404 USER_NOT_FOUND`
(`:653-656`) rather than a silent 200. Setting a role to the value it already
has is an idempotent `200` with `"changed": false`, so a double-submit from
the dropdown is not surfaced as an error.

### A role change is not immediate

The role is a **claim inside the JWT**, and `verifyToken`
(`src/middleware/auth.js:158-174`) reads the role from that claim — it does
*not* re-read the database on each request:

```js
req.user = { id: decoded.id || decoded.sub, role: decoded.role || 'user' };
```

So a token that was already issued keeps the role it was minted with. The new
role appears in the database at once, but the account keeps its old
permissions until it obtains a **fresh access token**:

- `POST /api/auth/refresh` re-reads the row (`db.getUserById`,
  `src/routes/auth.js:535`) and mints the replacement token with the current
  database role (`src/routes/auth.js:542-543`), so a refresh picks the change
  up immediately.
- Access tokens live 15 minutes (`ACCESS_TTL`, `src/middleware/auth.js:19`),
  which is the hard upper bound if no refresh happens.

Do not expect the change on the target's very next request. If you demote
someone they keep their old access for up to 15 minutes, and the practical
symptom — "I demoted them and they were still editing" — is expected
behaviour, not a broken feature. If you need it to stop right now, revoke
their session (log them out / drop their refresh tokens) rather than
concluding the role system is not working.

---

## What a viewer actually sees

- A **read-only notice** at the top of the dashboard, shown only to viewers
  (`public/index.html:1056-1068`). It states that everything can be browsed
  but nothing can be added, edited or deleted, that the server enforces this
  separately and answers `403 READ_ONLY_ROLE`, and to ask an administrator for
  write access.
- **Write controls are hidden and independently refused.** Hiding is
  presentation, not security: the buttons carry `data-write-only` and are
  swept in one pass by `applyRoleVisibility()`, and the mutating
  `data-action`s are refused client-side too — but a viewer who skips the UI
  and calls the API directly still gets `403 READ_ONLY_ROLE` from
  `requireWriteAccess`.
- **The Users tab does not exist for them.** The tab button is hidden unless
  `isAdmin()` (`public/index.html:2091-2096`), the tab is refused if
  requested directly (`:4296`), and the user list is fetched lazily — only
  when an admin actually opens the tab (`:4325`) — so a viewer's browser
  never even asks for it.
- **The costume photo gallery is fully available.** Opening it is a read, so
  `open-gallery` is deliberately absent from the list of write actions
  (`public/index.html:2042-2043`, `:3023-3030`).

---

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

### `[open]` Rate-limiter ordering in the verify harnesses

- **Symptom.** `verify-cors.sh` aborts early with "login failed (rate limited?)"
  and reports failures that have nothing to do with CORS.
- **Mechanism.** The per-IP login limiter is in-memory with
  `windowMs = 15 * 60 * 1000`. `verify-reset.sh` deliberately saturates it.
- **Rule.** Run `verify-cors.sh` **before** `verify-reset.sh` on any fresh
  instance, or accept the abort. Recorded results: `verify5a.sh` 25/25,
  `verify5b.sh` 26/26, `verify-reset.sh` 92/92, `verify-cors.sh` 75/75.

### `[open]` The Security tab is not itself admin-gated in the client

- **Symptom.** A non-admin who reaches the tab sees the CORS allowlist editor
  rendered; the save silently fails against the server.
- **Mechanism.** The underlying routes are correctly protected —
  [`src/routes/settings.js:54`](src/routes/settings.js:54),
  [`src/routes/settings.js:111`](src/routes/settings.js:111) and
  [`src/routes/settings.js:189`](src/routes/settings.js:189) each carry
  `verifyToken, authorize('admin')` — so this is a client-side affordance bug,
  not a security hole. It is nonetheless a misleading affordance, and unlike the
  Users tab (which refuses the tab and fetches lazily) there is no equivalent
  client-side refusal.
- **Fix.** Apply the same `isAdmin()` refusal the Users tab already has.

### `[open]` Admin user CRUD is still queued

- **Symptom.** Admins can change a role but cannot create, disable or delete a
  user through the UI.
- **Mechanism.** Only `PATCH /api/auth/users/:id/role` exists
  ([`src/routes/auth.js:834`](src/routes/auth.js:834) onwards). Password reset
  exists as the one compensating workflow, because it is the operation that
  cannot be deferred — see [`src/routes/auth.js`](src/routes/auth.js).
- **Fix.** Add the CRUD endpoints, and make sure the new password-reset flow and
  the new CRUD flow cannot disagree about what a valid account is.

### `[open]` No regression test covers the boot splash

- **Symptom.** The flash-on-refresh fix has no automated proof and can silently
  regress.
- **Mechanism.** [`scripts/test_phase5.js`](scripts/test_phase5.js) contains no
  assertion on `screen-login`, `showLogin`, or the splash. There is also no
  headless browser available on the remote host — `node_modules/@puppeteer/` is
  present but empty — so nothing in the toolchain can assert on first-paint
  behaviour. The only automated check that does exist is a static parse of the
  single inline `<script>` block, which proves the script is syntactically valid
  but says nothing about what it paints.
- **Fix.** Either add a jsdom-level test that asserts `#screen-login` is
  `display: none` at parse time, or install a real headless browser. Until then,
  treat the boot splash as manually-verified-only and say so in release notes.

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

Nothing in this repository should ever contain a real password, token, API key
or TOTP seed — not in this file, not in the phase guides, not in an example
that was "copied from a running system". Live values belong in `.env`
(reference them by name) and in the database (`"User".passwordHash`,
`"User".twoFactorSecret`). Committing a credential is the mistake this file
exists to help avoid.
