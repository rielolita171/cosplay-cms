# Handoff — viewer role + costume multi-image gallery

**Status: backend COMPLETE and VERIFIED. Frontend (5c) COMPLETE and VERIFIED. Nothing committed.**

Working tree: `/home/natanieldt/scripts/cms-cosplay`
Last commit: `7e353cc` — the whole viewer/gallery line of work is still uncommitted.

```
 public/index.html            | 1184 +++++++++++++++++- (5c, the frontend)
 src/middleware/apiKeyAuth.js |   9 +++
 src/middleware/auth.js       | 123 +++++++++++++++++++++++++++++++++++---
 src/routes/auth.js           | 114 +++++++++++++++++++++++
 src/routes/costumes.js       |  176 ++++++++++  (5b + the `body` fix)
 src/routes/lenses.js         |  29 ++--
 src/routes/props.js          |  28 ++--
 src/server.js                |  66 +++++++---
 src/services/db.js           |  52 ++++++
 src/services/sqlSafety.js    |  28 +++++
```

Verification status as of this update:

| Suite | Command | Result |
|---|---|---|
| Phase 5 regression | `npm run test:phase5` | **110 / 110 PASS** |
| 5a role endpoints | `bash ~/dev4139/verify5a.sh` | **25 / 25 PASS** |
| 5b image delete | `bash ~/dev4139/verify5b.sh` | **26 / 26 PASS** |
| 5c frontend | `node -e` inline-script parse + manual browser pass | **PASS — parses; 4074-line inline script, no automated harness** |

Read the 5c row honestly: there is **no `verify5c.sh`**. `test:phase5` reads
`public/index.html` only for its §4.4 XSS assertions, so the role ladder, the
Users tab, the multi-upload path and the lightbox are covered by manual/browser
verification, not by an automated suite. If you touch 5c, closing that gap is the
obvious next piece of work.

---

## 0. House rules that still apply (do not break these)

- **A production server is running on port 4001, PID 194925, holding the user's real
  data** (84 costumes, 1 lens, 23 brands, 24 fandoms). Never kill it. Never restart
  it. Never start a second instance on 4001.
  - **NEVER `pkill -f "src/server.js"`** — a previous agent killed production that way.
  - Kill by explicit PID only.
- Never mutate the real DB. Its sha256 must be `66465f63ab69a797…` before and after
  any test run. The phase-5 suite asserts this itself and prints it in Section 5.
- `npm run test:phase5` is the baseline guard. Do not weaken assertions to get green.
- In `public/index.html`: the XSS guards must not drop. "Zero bare `fetch(` outside
  `api()`" must hold; authenticated image delivery must keep working; the colour
  picker's strict hex handling must keep working. CSP blocks CDN/external
  fonts/`eval`.
  - **The exact `escapeHtml(` / `safeUrl(` call-site count is not the contract.** It is
    expected to move as code is added, so do not read a change in it as a regression
    and do not "restore" it to a remembered number. 5c landed on 35 `escapeHtml(` and
    5 `safeUrl(`; an audit had previously counted 37 and 4. Both are fine.
  - What *is* the contract, and what to actually check:
    - `test:phase5` asserts `escapeHtml(` call sites **`>= 20`**. That floor is the
      assertion; the count is its input, not the requirement.
    - The three **renderer markers** must still be present, because they are what
      prove escaping happens on *DB-derived* strings rather than somewhere in the file
      at all: `escapeHtml(clean(c.character` (costume card),
      `escapeHtml(clean(p.name` (prop card), `escapeHtml(colorName || 'n/a')` (lens
      card). The third deliberately replaced an older `escapeHtml(clean(l.character)`
      marker: lenses are not bound to a character, so that heading no longer exists.
      That was a re-point, not a weakening.
- New input handling goes through the shared validators in `src/services/sqlSafety.js`.
  No hand-rolled escaping.
- No new dependencies, no build step. No schema change was needed (see §3).

### 0.1 The test-server isolation trap — read this before running anything

`src/services/db.js` resolves its database from `process.env.DATABASE_PATH`, but the
**route files do not**. `queryDb()` in `src/routes/costumes.js` spawns
`sqlite3 ['data/db/cms.db']` with a **hardcoded, cwd-relative** path, so those routes
ignore `DATABASE_PATH` entirely and follow the process's working directory.

Consequence: a dev server started from the repo root — which is how the :4139 server
happened to be running when this work resumed — executes every costume write against
**the real production database**, even while `DATABASE_PATH` points at a scratch file.
`DATABASE_PATH` alone is NOT isolation. **cwd is the isolation.**

The dev server is now started correctly:

```bash
cd ~/dev4139 && PORT=4139 \
  DATABASE_PATH=/home/natanieldt/dev4139/data/db/cms.db \
  UPLOAD_DIR=/home/natanieldt/scripts/cms-cosplay/data/uploads \
  CORS_ORIGIN=http://100.66.231.52:4139,http://localhost:4139,http://127.0.0.1:4139 \
  nohup node /home/natanieldt/scripts/cms-cosplay/src/server.js >> ~/dev4139/server.log 2>&1 &
```

`~/dev4139/.env` is a symlink to the repo `.env`, because `require('dotenv').config()`
resolves `.env` from cwd and the JWT/API secrets are needed.

**Uploads are NOT isolated at all.** This is the companion trap to the cwd trap
above, and it is the nastier of the two, because the database at least *moves* when
you change cwd. The upload directory does not move at all.

`src/routes/images.js`, `src/middleware/imageUpload.js` and
`src/middleware/imageProcessor.js` each resolve
`path.join(__dirname, '../../data/uploads')` — **`__dirname`-relative, not
cwd-relative**. Both servers therefore share one upload directory regardless of cwd,
regardless of `DATABASE_PATH`, and regardless of `UPLOAD_DIR`. You cannot isolate
uploads by starting the dev server somewhere else.

`UPLOAD_DIR` is **dead config**: `grep -rn UPLOAD_DIR src/` returns no matches. The dev
server above is nevertheless *launched with `UPLOAD_DIR=...` set*, which is the worst
version of this trap — the command line implies the directory was redirected when it
was not. Setting it buys you nothing and reads as reassurance. Drop it from the command
so it stops implying an isolation that does not exist.

**Consequence: any upload test against :4139 writes into the production upload
directory.** This is a real incident, not a hypothetical. A multi-upload test of the
new 5c path left two unreferenced `.webp` files in production `data/uploads` at
**12:59:27–28**, taking the directory from its baseline of 2 files to 4. Both were
proven unreferenced first — a full `sqlite3 .dump | grep` for both filename stems
returned **0** across every table, with the two pre-existing files used as a control
(they returned **2**, which is what proves the grep would have found a real
reference). They were then **moved, not deleted**, to `~/dev4139/quarantine/`, so the
directory is back to its baseline of 2 and the bytes remain recoverable.

**The rule:** never exercise an upload endpoint against the dev server. Point the
harness at a throwaway file it created itself and never go through the live upload
route — that is exactly what `verify5b.sh` does, and it is why 5b never left litter.
If you must call `/api/images/upload` or `/api/images/upload-multiple` at all, assume
it has just written into production and go and look.

---

## 1. What the user asked for

1. Each costume gets an image preview and multi-image support.
2. Multi-level users, where a **viewer** can see records but cannot edit.

## 2. Decisions the user made (do not relitigate)

| Question | Answer |
|---|---|
| How are viewer accounts created? | Registration always creates `user`. An **admin-only** `PATCH /api/auth/users/:id/role` promotes/demotes, plus a small admin panel. |
| Which tiers? | Keep `admin`/`curator`/`user` as-is and add **`viewer` below `user`** (read-only). `curator` keeps whatever it has today. |
| Image scope? | **Full gallery**: multi-select upload in one go, click-to-open lightbox paging through all images, per-image delete with confirmation, thumbnail strip on the card. |

Self-registration taking a `role` parameter was explicitly rejected — it is a
privilege-escalation hole.

---

## 3. Audit findings — most of this already existed

Do not rebuild these; they are done and working:

**Images — storage + upload are already in place.**
- `Costume.imageUrls TEXT DEFAULT '[]'` already holds a **JSON array**
  (`init_db.sql:76`). No schema change needed.
- `POST /api/images/upload` (single) and `POST /api/images/upload-multiple`
  (multer, up to 10, field name `images`) already exist in `src/routes/images.js`
  with WebP conversion via `src/middleware/imageProcessor.js`.
- `public/index.html` already has the authenticated image pipeline:
  `parseImageUrls`, `costumeImages()`, `loadImageObjectUrl`,
  `hydrateAuthenticatedImages`, LRU `imageObjectUrls` cache,
  `IMAGE_LOADING_PIXEL`, `MEDIA_PLACEHOLDER_HTML`.
- `renderCostumes` already renders `images[0]` plus a **"N images"** text badge.
- The upload flow already merges into `imageUrls` and PUTs it back.

**The real gaps for images were UI-only** (see §6) plus the delete endpoint, now built.

**Roles — the ladder existed but was decorative.**
- `User.role TEXT DEFAULT 'user'` already exists (`init_db.sql:47`), added to
  existing DBs by `ALTER TABLE` in `src/services/db.js`.
- `authorize(requiredRole)` already existed — and was **never mounted on a single
  route**. Every authenticated account could write everything.
- Registration hardcodes `role: 'user'`; there was no way to change a role.
- `state.user` is already populated from the login/register response and **already
  carries `role`**, so the frontend can gate on it with no new plumbing.

---

## 4. Backend — DONE and verified

### 4.1 The role ladder + write guard — `src/middleware/auth.js`
- `ROLE_LEVELS` ladder; unknown roles are **fail-closed** (a role this code does not
  understand can never satisfy `>= 'user'`).
- `hasRoleAtLeast(role, min)`.
- `authorize(requiredRole)` — kept, now reading the shared ladder so it cannot
  drift from the write guard.
- `requireWriteAccess(req, res, next)` — **method-based**: `GET/HEAD/OPTIONS` pass,
  every mutating method needs `>= 'user'`, else `403 { code:'READ_ONLY_ROLE' }`.
  Rationale in the code comment: a per-route list is exactly the shape of bug this
  project already hit once with the too-broad guard mount in `server.js`; deciding
  from `req.method` covers every existing handler and every one added later.

### 4.2 `src/middleware/apiKeyAuth.js`
- `requireApiKey` sets **`req.apiKeyAuth = true`**, only *after* the constant-time
  key comparison passes. This marker is what lets an n8n caller through
  `requireWriteAccess`: an API-key request never populates `req.user`, so without the
  marker "machine caller" and "somebody forgot to authenticate" are indistinguishable.

### 4.3 `src/server.js`
- Every data mount carries the guard **after** `verifyToken`: `/api/costumes`,
  `/costumes`, `/api/brands`, `/brands`, `/api/fandoms`, `/fandoms`, `/api/props`,
  `/props`, `/api/lenses`, `/lenses`.
- Image routes `/api/images`, `/images`, plus the `POST /api/upload` and
  `POST /upload` aliases, get `verifyTokenOrApiKey, requireWriteAccess`.
- `/api/version` advertises the new endpoints and documents the ladder +
  the `READ_ONLY_ROLE` 403.

### 4.4 `src/services/db.js`
- `listUsers()` — explicit projection `id, username, email, role,
  telegram2FAEnabled, createdAt, updatedAt`. **Deliberately not `USER_SELECT *`**,
  because `passwordHash` and `twoFactorSecret` live in the same table.
  `twoFactorEnabled` derived with an explicit `=== '1'` (over this pipe transport an
  INTEGER arrives as a string and `'0'` is truthy).
- `countAdmins()` — for the "don't demote the last admin" guard.
- `updateUser()` (pre-existing) is what the promotion endpoint calls.

### 4.5 5a — admin user management — `src/routes/auth.js`
- `GET  /api/auth/users` → `db.listUsers()` + `assignableRoles`.
- `PATCH /api/auth/users/:id/role` → body `{ role }`, `verifyToken` + `authorize('admin')`.
  Safety rules, all implemented: role validated against the `ASSIGNABLE_ROLES`
  allowlist (it lands in a SQL literal); no demoting the last admin
  (`countAdmins()` read *before* the write); no admin changing their own role.
- **Verified 25/25.** Note for whoever reads the harness: the `LAST_ADMIN` branch is
  **unreachable through the API** — the actor must be an admin AND the target must be
  an admin, which already implies `countAdmins() >= 2`, and the self-change guard
  covers the remaining single-admin case. `verify5a.sh` records the real behaviour
  (a sole admin demoting a *non*-admin is permitted, because the branch correctly
  does not apply) rather than asserting a case that cannot be built.

- **A role change is not retroactive — the role lives in the JWT.** `PATCH` updates
  `User.role` in the DB, but an access token already issued to the target still
  carries the old role claim and keeps carrying it until that token is refreshed or
  expires. A demotion therefore takes effect on the target's *next* request with a
  fresh token, not instantly; until then the demoted account can still write.
  This is the explanation for the otherwise-confusing "I demoted them but they can
  still write" report — it is the token, not the guard, and it is not a bug in
  `PATCH /api/auth/users/:id/role`. The admin Users tab already says so in its own UI
  text beside the role `<select>`; this is the same note for the handoff reader. Do
  not "fix" it by re-reading the role from the DB on every request unless you also
  intend to add revocation.

### 4.6 5b — per-image delete — `src/routes/costumes.js`
`DELETE /api/costumes/:id/images`, body `{ url }`. Design points that matter:

- **Validation runs before the row lookup.** A missing/malformed `url` is a `400`
  and must not be reported as "no such costume" just because the id is also wrong.
  (The phase-5 manifest test probes this route with a synthetic id and an *empty
  body* precisely to distinguish "route missing" from "row missing" — so this
  ordering is load-bearing for the suite, not just taste.)
- `404` if the costume or the url is not on it; `400` for malformed/oversized url.
- A corrupt (unparseable) stored `imageUrls` is a `500`, **not** a silent overwrite —
  the operator finds out instead of losing whatever the column held.
- The array is re-serialised through the existing `normalizeImageUrls`, so this
  writer and the dashboard's writer cannot drift.
- **The unlink is conditional on a cross-reference count** (`json_each` matches whole
  array elements, so `/uploads/a.webp` cannot false-match `/uploads/a.webp.bak`).
  Skipping it would let one costume's delete break another's thumbnail.
- `uploadFileNameFor()` refuses anything that is not a single bare filename. This is
  a path-traversal guard: `path.basename` alone would reduce `../../etc/passwd` to
  `passwd` and unlink a file that was never ours.
- `ENOENT` on unlink is not a failure of the delete; any other error is surfaced in
  the response so orphaned bytes are not silently forgotten.
- **Verified 26/26**, including both unlink branches (kept while shared, deleted on
  the last reference) and the traversal case.

### 4.7 Regression found and fixed — `textUpdate` + the cleared-notes bug
`sqlSafety.textUpdate(body, key)` decides field presence on the **key**, not on
whether the value is non-empty. `textParam()` collapses absent / null / `''` into the
single value `null`, which a route read as "leave this column alone" — conflating
"the caller never mentioned this field" (partial update) with "the caller cleared
the input" (must blank the column). Clearing a description silently kept the old text.

**The bug that was live on resume:** the call site in the `PUT /:id` handler read
`textUpdate(body, 'notes')`, but that handler destructures straight from `req.body`
and never binds a local `body`. Every `PUT /api/costumes/:id` threw
`ReferenceError: body is not defined` → `500`. Fixed to `textUpdate(req.body, 'notes')`.
This was **not** caught by the 5a harness (it only reads costumes); it showed up as
four separate phase-5 failures. Worth remembering: a *presence* check on a
destructured handler is exactly the kind of edit that passes `node --check`.

---

## 5. 5c, the frontend — DONE and verified

`public/index.html` is now the larger half of this change. Everything this section
previously listed as absent is present. What it delivered:

**The role ladder, fail-closed, in the client.** `ROLE_RANKS` maps role to rank and
`roleRank()` resolves a role from `state.user`; both `canWrite()` and `isAdmin()` are
built on that one table, so the client cannot drift from the server's ladder. It is
fail-closed in the same direction: a role this code does not understand ranks below
`user` and can therefore never satisfy a write check. Viewers get a read-only notice
and no write affordances.

**The admin-only Users tab, lazy-loaded.** The user list is not fetched until an admin
actually opens the tab. The role `<select>` is populated from the server's
`assignableRoles` in the `GET /api/auth/users` response rather than a client-side list,
so the dropdown cannot offer a role the endpoint would reject. Only
`role === 'admin'` sees the tab at all.

**Multi-upload.** `#costume-image-input` takes `multiple` and the picker iterates
`input.files` into `POST /api/images/upload-multiple` (field `images`, max 10). The
client-side MIME/size pre-checks (`ALLOWED_UPLOAD_TYPES`, `MAX_UPLOAD_BYTES`) are
applied **per file** — a 10-file batch whose 9th entry is a 20 MB TIFF is rejected on
the 9th, instead of posting the whole batch first and discovering the problem
server-side.

**Thumbnail strip + lightbox.** Cards carry the full set as a thumbnail strip, and
clicking opens a lightbox that pages through every image on that costume.

**Per-image delete, behind `confirmAction()`.** Nothing is deleted without a
confirmation, and the response's `fileDeleted` / `stillReferenced` flags are surfaced
to the user, so "removed" and "removed from this costume but still on disk because
another costume uses it" are reported differently instead of the file silently
vanishing from under the user.

**Two enforcement layers, deliberately.** The presentation layer hides and disables
write controls, but it is not trusted on its own: the `bindGridEvents` dispatcher
re-checks `canWrite()` at the point it acts on a grid action, and `openModal` /
`openImagePicker` re-check on the way in. So a control hidden but still reachable by
keyboard, or an action dispatched from stale markup, is caught where it is used and
not merely where it is painted. The server's `requireWriteAccess` remains the
authoritative third layer — the client-side checks are UX, and the role ladder must
keep being enforced in the backend.

**On verification honesty:** see the note under the table at the top. 5c has no
automated harness; it was verified by parsing the inline script and by hand in a
browser. Treat it as the least-covered part of this work.

---

## 6. The one `public/index.html` change that already exists

A comment above the costume-form payload builder, documenting that **every key is
always sent, including when its input is empty** — which is the client half of the
4.7 fix. The server distinguishes an ABSENT key (leave the column alone) from a
PRESENT-but-empty one (clear it), so the form must not omit emptied fields. Do not
"tidy" this by dropping empty keys; that reinstates the bug.

---

## 7. Re-running the verification

```bash
# 1. the dev server must be running and ISOLATED (see §0.1)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4139/health   # 200
ss -tlnp | grep 4139    # confirm the owning pid's cwd is ~/dev4139

# 2. the three suites
bash ~/dev4139/verify5a.sh     # 25/25
bash ~/dev4139/verify5b.sh     # 26/26
cd ~/scripts/cms-cosplay && npm run test:phase5   # 110/110

# 3. production must be byte-identical and never restarted
sha256sum ~/scripts/cms-cosplay/data/db/cms.db    # 66465f63ab69a797…
kill -0 194925 && echo "prod alive"
```

Both harnesses mint each token exactly once and set their SQL baseline with direct
`sqlite3` writes, because the login routes are rate limited to 10 per 15 minutes and
repeated logins return 401 and cascade into false failures.
