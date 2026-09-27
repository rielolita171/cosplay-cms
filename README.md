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
matter are `PORT`, `DATABASE_URL`, `API_KEY`, `JWT_SECRET`, `SESSION_SECRET`
and `TELEGRAM_BOT_TOKEN`. **Their values live in `.env` and must never be
copied into this file, into a commit, or into a ticket** — refer to them by
name, as done here. `JWT_SECRET` in particular is validated at boot: a
placeholder value, a value under 32 characters, or an unexpanded `$(...)` is
fatal and the server refuses to start (`src/middleware/auth.js:46-83`).

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
| `admin` | Everything `user` can do, **plus user management**: `GET /api/auth/users` and `PATCH /api/auth/users/:id/role`. | `authorize('admin')`, `src/middleware/auth.js:234-248`, mounted at `src/routes/auth.js:600` and `src/routes/auth.js:637` |

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
the two admin endpoints. It is not mounted anywhere else.

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
