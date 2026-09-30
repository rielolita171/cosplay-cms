# cosplay-cms — Electron desktop build

A packaging of the existing CMS as a desktop app. The Docker deployment in
[`DOCKER.md`](DOCKER.md) is unchanged and remains the primary target; this is a
second way to run the same code.

## Design in one paragraph

The Express server is **not reimplemented**. `electron/main.js` sets the
environment and then does `require('../src/server')`, so the desktop app runs
byte-identical server code to the container, and the existing test suites
keep exercising the same surface. What the main process supplies is the four
things Docker got from `docker/entrypoint.sh` and its environment — writable
paths, the schema bootstrap, the driver check, and a loopback bind.

```
electron/main.js          window, lifecycle, environment setup
electron/preflight.js     the port of docker/entrypoint.sh (driver check + init_db.sql)
scripts/fetch_sqlite.js   downloads the sqlite3 CLI at BUILD time
src/services/paths.js     one source of truth for every internal path
```

## Commands

| Command | What it does |
|---|---|
| `npm run electron:dev` | Run the desktop app against your checkout (uses the system `sqlite3`) |
| `npm run electron:build` | Unpacked build in `dist/` — fastest way to check packaging |
| `npm run electron:dist` | Real installers: AppImage, NSIS, DMG |
| `npm run electron:dist:win` | Windows NSIS installer only |
| `npm run electron:sqlite` | Fetch the `sqlite3` binary for **this** machine |
| `npm run electron:sqlite:win` | Fetch the Windows binary (needed when cross-compiling) |
| `npm test` | The existing suite — unaffected by any of this |

## Building for Windows

```bash
npm run electron:dist:win     # -> dist/Cosplay CMS Setup 1.0.0.exe
```

Cross-compiling from Linux/macOS works, but **two things must be told explicitly
what target they are for.** Both were real failures during the first attempt.

**1. The sqlite3 binary must be fetched for the TARGET, not the host.**
`fetch_sqlite.js` defaults to `process.platform` — correct for a native build,
wrong for a cross-build, because the build host is still Linux. It would
download the Linux ELF and bundle it into a Windows installer: an app that
installs fine and then fails on the first database query. Hence
`--platform=win`, and binaries live in per-platform directories
(`resources/sqlite3/win-x64/`) so both can coexist in one checkout. The script
now also verifies the **magic bytes** — `MZ` for Windows, `\x7fELF` otherwise —
and refuses to package a binary for the wrong platform. A cross-built binary
cannot be executed on the host, so that check replaces the usual `--version`
run for cross targets.

**2. `sharp` needs its Windows binaries in `node_modules`.** The installed
Linux variants are irrelevant to a Windows package, and image uploads would fail
at runtime. `sharp@0.33.5` pulls `@img/sharp-win32-x64` as an *optional*
dependency, which npm refuses to install on Linux. Installing it:

```bash
npm install --no-save --os=win32 --cpu=x64 @img/sharp-win32-x64@0.33.5
# if npm still refuses on os/cpu constraints, unpack the tarball from
# https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.33.5.tgz
# into node_modules/@img/sharp-win32-x64/
```

Both platforms' binaries can coexist; `sharp` picks at runtime by platform, so a
Linux dev run is unaffected. They are listed in `asarUnpack` so the `.node` file
and libvips DLLs sit outside the asar where they can be loaded.

`npmRebuild` is `false` in the build config: nothing in this tree compiles
(`sharp` ships prebuilt), and a rebuild attempt would need a full Windows
toolchain on the Linux host.

**Icons:** none are set, so builds use the default Electron icon. Drop a
`.ico` in `build/` and reference it under the `win` block to change that.

## The four things that would otherwise break

### 1. `sqlite3` is a system binary, not an npm module

**This is the whole ballgame.** There is no in-process SQLite driver. Every
query in this project is a short-lived `spawn('sqlite3', [DB_FILE])` —
`src/services/db.js` plus eleven duplicated helpers across `src/routes/*.js`.
The [`Dockerfile`](Dockerfile) proves the consequence by installing sqlite3 via
apt-get and *failing the boot* when the binary is missing.

`electron-builder` bundles only what its `files` array lists. A system binary is
not in that list, so a packaged app would contain no SQLite at all: the window
opens, `/health` returns 200, and every data route fails.

So `scripts/fetch_sqlite.js` downloads the pinned `sqlite3` CLI into
`resources/sqlite3/`, `extraResources` ships it to `resources/sqlite3/` beside
the app, and `main.js` **prepends that directory to `PATH`**. Because the whole
app spawns the bare name `sqlite3`, that one assignment makes everything work
unchanged — no call site is edited.

Two deliberate properties:

- **It runs at build time, never at app start.** A shipped app fetches nothing.
  This matters more than usual here: the app has *no authentication*, so a
  component that downloads an executable on first run would be a serious hole.
- **The version is pinned** (3.45.1). An unpinned "latest" means an installer
  built today and one built next month ship different SQLite versions.

Prebuilt binaries exist for Windows only; on Linux and macOS the script builds
from the official SQLite amalgamation and needs a C compiler (`cc`).

### 2. Writable paths cannot live inside `app.asar`

Five files each built the same two paths out of `__dirname`. That is correct in
a container (the app is always `/app`) and **wrong** in a packaged app, where
`__dirname` resolves inside a read-only archive — the database and every uploaded
image would be unwritable, and the first write fails with `EROFS`.

They now resolve from `src/services/paths.js`, which reads `DATA_DIR` and
`UPLOAD_DIR`. `main.js` points both at `app.getPath('userData')`, which is
per-user, per-OS, and outside the archive.

**Defaults are unchanged.** Every fallback is byte-for-byte the old path, so
`npm start` and `docker compose up` resolve exactly what they always did.

### 3. There is no shell PID 1 to run the entrypoint

`docker/entrypoint.sh` does two jobs before Node starts: it proves the `sqlite3`
binary exists, and it applies `init_db.sql`. Both are mandatory:

- Without the driver check, every data route 500s while `/health` stays green —
  `/health` never touches the database.
- Without `init_db.sql`, the app boots healthy and then 500s on every data
  route, because `Costume`/`Prop`/`ContactLens` do not exist. `initSchema()` in
  `db.js` does **not** create these.

`electron/preflight.js` does both in JS, because a packaged app may run on
Windows where no POSIX shell exists. It verifies the driver, applies the schema,
and asserts the required tables **by name** (not by count — a count silently
couples startup to how many tables existed when the check was written). On
failure it raises an operator-readable error and the app shows a dialog and
quits, rather than opening a window onto a broken server.

### 4. The bind address must change

`src/server.js` binds `0.0.0.0`. That is a deliberate container decision and is
unchanged there. On a laptop it would put full read **and write** access to
every costume behind a plain TCP port on the office LAN — a strictly larger
blast radius than the same app has inside a container network.

`main.js` sets `BIND_ADDRESS=127.0.0.1`, the correct boundary for a single-user
desktop app whose only client is its own window.

### 5. The desktop build enforces a CORS allowlist like any other build

`main.js` sets `CMS_SELF_ORIGIN`, which marks the app's own serving origin
(`http://127.0.0.1:4101`) as permanently allowed. `src/server.js` runs the same
allowlist check on the desktop build as on a self-hosted server — there is no
desktop bypass. A page in any other browser on the machine is refused.

**This used to be permissive, and the reason it was is still the reason it is
scoped to the desktop build.** A database migrated from a self-hosted install
brings its `cors_origins` row with it, naming the origin it was saved on
(`http://localhost:4001`). That row outranks everything `.env` can say, so the
app rejected its own writes:

| Request | Result |
|---|---|
| `GET /api/costumes` (no `Origin`) | 200 — looks healthy |
| `PUT /api/settings/cors` (`Origin: 127.0.0.1:4101`) | 403 `CORS_DENIED` |

Browsers omit `Origin` on same-origin GETs but send it on a same-origin JSON
`PUT`/`POST`/`DELETE`, so reads worked and every settings write failed —
including the save that would fix the list, and the reset that would clear it.
The operator was stuck with no in-app way back.

The fix was not to disable the check but to make that origin **non-removable**:
`withSelfOrigin()` in [`src/services/settings.js`](src/services/settings.js)
appends `CMS_SELF_ORIGIN` *after* the whole `database → .env → default`
resolution chain, so no stored row can evict it and no save can lock the
operator out. That is why enforcement is now safe on the desktop build, and why
the earlier "enforce but risk lockout" objection no longer applies.

**What is enforced now.** Only the serving origin, plus any origin the operator
adds in the Settings tab. The opaque origin `null` — which sandboxed iframes,
`file://` and `data:` pages send — is rejected, as is every foreign origin.

**Note for non-browser clients.** CORS is a browser mechanism, not
authorization. `curl`, the n8n workflow and any server-to-server caller send no
`Origin` header, so they are unaffected either way and were never blocked by the
allowlist. That is why tightening this closes browser-based cross-origin access
without changing any integration.

**Escape hatch.** If some setup of yours genuinely needs a foreign origin to
reach the API, set `CMS_ALLOW_ANY_ORIGIN=1` before launching and the old
permissive behaviour returns. It accepts `1`/`true`/`yes`/`on`, is **off by
default**, and an unrecognised value is ignored with a warning rather than
guessed at, so a typo fails closed. The Settings tab detects the mode from
`GET /api/settings/cors` and renders an explanation in place of the editor,
because a Save button wired to a list the server ignores would look like a
control that works. In that mode the `LOCKOUT_RISK` check is skipped on save:
no stored list can lock anyone out, so warning about it would describe a
consequence that cannot occur.

Set it as an environment variable, not in `.env` — a packaged app has no
`.env`, and dotenv never runs against it. On Windows:

```
set CMS_ALLOW_ANY_ORIGIN=1 && npm run electron:dev
```

### 6. Only the Electron window can read the collection

**The CORS allowlist above is necessary but not sufficient, and this is the part
that closes the remaining gap.**

Typing `http://127.0.0.1:4101` into Chrome is a top-level **navigation**. Browsers
send no `Origin` header on navigation, so the CORS callback never runs at all and
every `/api` route answers normally. A tightened allowlist does nothing about it,
because CORS governs `fetch()`, not the address bar. Without the mechanism below,
any browser on the machine got the full collection, including export/import.

So the desktop build requires a **per-launch 256-bit token**:

| Step | Where |
|---|---|
| Generated before the server is required | [`electron/main.js`](../electron/main.js) |
| Held only by the main process, in memory | `CMS_DESKTOP_TOKEN` |
| Handed to the renderer through a context bridge | [`electron/preload.js`](../electron/preload.js) |
| Attached to every request at the single chokepoint | `api()` in [`public/index.html`](../public/index.html) |
| Compared in constant time | [`src/services/desktopToken.js`](../src/services/desktopToken.js) |
| Enforced on `/api` and `/uploads` | [`src/server.js`](../src/server.js) |

A browser pointed at the same server has no preload, so it cannot obtain the
token: every request that returns collection data comes back **403
`DESKTOP_TOKEN_REQUIRED`**.

**Two deliberate exceptions, neither of which leaks anything:**

- **`GET /` is not guarded, and cannot be.** Electron's first page load is a
  navigation, which carries no custom headers — there is no mechanism by which the
  shell could present the token, so guarding it would mean the app could never
  start. `index.html` contains no collection data: it is markup and script, so a
  browser loading it renders an empty shell, because every request it then makes is
  refused.
- **`/health` is not guarded**, so "is the server up" stays answerable without the
  token.

The token is never written to disk, never persisted, never placed in a URL (so it
cannot reach an access log, browser history, or a `Referer` header), and a fresh
one is generated on every launch.

**What this does not do.** It does not protect against the person at the keyboard.
They can read the SQLite file directly, or open the app's DevTools and call
`window.cosplayCms.desktopToken()`. The renderer has to hold the token in order to
send it, and the renderer is theirs. What it stops is a website, a browser address
bar, and other software on the machine — raising the bar from "type a URL" to
"deliberately extract a secret from a running process".

**Docker and `npm start` are unaffected.** The guard requires both
`CMS_SELF_ORIGIN` and a valid `CMS_DESKTOP_TOKEN`; a self-hosted server has
neither, so `isGuarded()` is false and the middleware is a straight pass-through.
The n8n notification endpoints and any `curl` workflow keep working unchanged —
they have no way to receive a token, and demanding one would break them for no
security gain on a server that is meant to be reachable over the network behind
its own boundary.

To reproduce the guarded behaviour without Electron:

```
CMS_SELF_ORIGIN=http://127.0.0.1:4101 \
CMS_DESKTOP_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
npm start
```

## Does this still run outside Electron?

Yes — `npm start`, `node src/server.js`, and `docker compose up` all behave
exactly as before. Every default in `src/services/paths.js` is byte-for-byte the
path the corresponding file computed originally, and Docker never reads the new
variables at all (its entrypoint runs `node src/server.js` explicitly).

Two things make that true:

- **Docker is untouched.** `docker/entrypoint.sh` runs `node /app/src/server.js`
  directly, so `main` in `package.json` pointing at `electron/main.js` cannot
  affect it. `npm start` still runs the bare server.
- **The overrides are namespaced** as `CMS_DATA_DIR` / `CMS_UPLOAD_DIR`, which
  is not cosmetic. A bare `UPLOAD_DIR` was tried first and it **broke the
  existing workflow**: this repo's `.env` contains `UPLOAD_DIR="/data/uploads"`,
  a container path that had been sitting inert because no code read it. The
  moment `paths.js` started reading that bare name, every non-Electron start died
  with `EACCES: permission denied, mkdir '/data/uploads'`.

The `CMS_` prefix means a key already sitting in someone's `.env` cannot
suddenly acquire meaning and break their server. The prefix also matters on
Windows, where environment variables are case-insensitive and `upload_dir` and
`UPLOAD_DIR` are the same variable.

`DATABASE_PATH` is deliberately **not** renamed — it predates this work and is
documented in `.env.example` and `DOCKER.md`.

## Where the data lives

Everything writable goes under Electron's `userData`:

| Platform | Path |
|---|---|
| Linux | `~/.config/<app>/data/` |
| macOS | `~/Library/Application Support/<app>/data/` |
| Windows | `%APPDATA%\<app>\data\` |

`<app>` is `cosplay-cms` in a development run (it comes from `name` in
`package.json`) and `Cosplay CMS` in a packaged build (from `productName`).

Inside `data/` are `db/cms.db` and `uploads/`. Back up the whole `data/`
directory — it is the only copy of the collection. The repository's own `data/`
is a *different* database and is never touched by the desktop app.

**Migrating from a self-hosted install** means exporting there (Settings →
Move this collection), then importing the `.zip` here. Everything in the
database carries over — costumes, props, lenses, makers, brands, fandoms,
Telegram config and every image.

**The origin allowlist is the one thing that does NOT travel, in either
direction.** It is host configuration — it names a hostname and a port — so it
is reconciled per direction rather than carried along:

| Direction | What happens to the allowlist |
|---|---|
| **self-hosted → desktop** | The incoming origins are **discarded**. They would be rules about a network this machine is not on, and the desktop build now enforces its own origin. The row is dropped, so this data later run under `npm start` does not silently inherit a dead allowlist. |
| **desktop → self-hosted** | The **target server's own rules win**, exactly as they were. Only `localhost`/`127.0.0.1` for that server's own port are added, and only if its list does not already permit them. Your existing LAN or domain origins are never removed. |

Neither direction can lock you out of the machine you are sitting at, and
neither removes an origin you configured deliberately.

## Gotchas

### `ELECTRON_RUN_AS_NODE` breaks the desktop app

If it is set in your shell, Electron runs as plain **Node**: `process.type` is
`undefined` and `require('electron')` fails with `app` undefined. An environment
quirk, not an app bug.

```bash
unset ELECTRON_RUN_AS_NODE
npm run electron:dev
```

### The app has no authentication — do not widen the bind

Every data route is open by design (see the note at the top of `src/server.js`).
The container publishes `0.0.0.0` on a trusted network; `electron/main.js`
overrides this to `127.0.0.1`, which was verified to actually contain it — the
external interface refuses connections while loopback serves. Changing it back
to `0.0.0.0` on a desktop would publish full read/write access to the whole LAN.

### Two modules freeze their config at load time

`src/services/paths.js` reads `process.env` once at module load and caches it.
So **nothing that transitively requires `paths.js` may be required before the
environment block in `electron/main.js` has run** — that is why `preflight` is
required lazily inside `whenReady()`. Getting this wrong fails silently: the app
starts, then writes to the wrong directory.

`src/services/db.js` similarly resolves `DB_FILE` once. That is deliberate and
is why the test suites set `DATABASE_PATH` before requiring it.

### `npm ci` fails unless package.json and the lockfile agree

The Dockerfile installs with `npm ci`. After **any** dependency change, run
`npm install --package-lock-only`, or the Docker build stops with `EUSAGE`.

### Windows builds are unsigned, with the default icon

SmartScreen warns on first run; no code-signing certificate is configured. Drop
an `.ico` in `build/` and reference it under the `win` block to change the icon.

### The Windows package no longer carries unused Linux sharp binaries

`sharp` resolves its platform binaries from optional dependencies, so
`node_modules` on a Linux build holds `@img/sharp-linux-x64`,
`@img/sharp-linuxmusl-x64` and both libvips trees. The Windows build now
excludes them under the `win` block: the installer went from 99.4 MB to
87.7 MB and the payload from 119 to 103 files, with `@img/sharp-win32-x64` the
only `@img` package left inside the extracted `app-64.7z`. Image conversion was
re-verified under Wine after the exclusion.

Two things to know if you edit that block:

- The exclusions are under `win` **only**. A top-level rule would strip the
  Linux binaries and produce a Linux package that cannot process an image.
  macOS is handled by omission — its block excludes nothing today, but adding
  `darwin/linux` there keeps the three builds from drifting.
- A platform-level `files` array **replaces** the top-level one rather than
  merging, so the includes are repeated verbatim above the exclusions. Dropping
  that repetition ships an installer with no application in it.

## What has and has not been verified

**Verified by running, not by inspection:**

- **Docker** — image builds, container reaches `Up (healthy)`, all data routes
  200, image upload converts PNG→WebP via `sharp`, full create/read/delete
  cycle, named-volume persistence, clean `exit=0` graceful shutdown.
- **Electron (Linux)** — launched headless under `xvfb-run`, `process.type`
  confirmed `browser`, all routes 200 on `127.0.0.1:4101`, database created
  under `userData`, external interface refused.
- **Electron (Windows)** — `dist/Cosplay CMS Setup 1.0.0.exe` builds, and the
  packaged app was run under wine: it loaded the bundled `sqlite3.exe`
  (3.45.1), applied the schema, served every route 200, and converted an uploaded
  PNG to WebP via the bundled Windows `sharp`.

**Verified by running (the server-side token guard, without Electron):**

- **The guard itself** — a real `node src/server.js` in desktop mode with a
  generated token: `GET /` → 200 (the shell), `/api/costumes` with no token → 403,
  with a wrong token → 403, with the correct token → 200 and real JSON; same for
  `/api/props` and `/api/lenses`; `POST` → 403; `/health` → 200.
- **The self-hosted path is untouched** — the same server without the desktop
  variables: `curl` → 200, the n8n notification endpoint with
  `X-CMS-API-KEY` → 200 and with a wrong key → 403, a browser from an allowed
  origin → 200, and from a foreign origin → 403. `isGuarded()` is `false` and the
  CORS allowlist resolves exactly as before.

**Packaging verified on the shipped artifact.** The v1.0.0 installer was rebuilt
and re-uploaded, and the packaged `app.asar` was inspected directly to confirm
the chain is actually present rather than merely present in the source tree:
`electron/preload.js` and `src/services/desktopToken.js` are both inside the
archive, the bundled `resources/sqlite3/sqlite3.exe` is the Windows build, and
the shipped `public/index.html` carries the `window.cosplayCms.desktopToken()`
read and the `X-CMS-Desktop-Token` header. The published download was then
fetched back and its SHA-512 compared against `latest.yml` — identical, so the
update feed points at the binary that is actually being served.

## The guard shipped switched off, and it shipped twice

**Read this before touching the token code.** Both published v1.0.0 installers
had `isGuarded()` returning `false`. Not "off by default" — the guard was never
established in the packaged app at all, while the headless path worked, and the
UI asserted the guard was on.

The cause was load ordering, and it is worth writing down because the code
*reads* like it works:

```js
const { generate } = require('../src/services/desktopToken');   // runs install()
process.env.CMS_DESKTOP_TOKEN ||= generate();                    // too late
```

`require` executes a module's top-level code once and caches the result.
`desktopToken.js` self-installs from `CMS_DESKTOP_TOKEN` as it loads. That
`require` therefore ran the self-install while the variable was still unset, and
the module latched onto nothing. The assignment on the next line could not
recover it, and re-requiring would not have helped either — `require` hands back
the same cached object. The comment in `desktopToken.js` claiming `main.js` set
the variable *before* requiring the module was the false premise behind it.

Two things are now load-bearing and should stay that way:

- `electron/main.js` calls `desktopToken.install()` **explicitly**, after the
  value exists, and calls `app.quit()` if a token still cannot be obtained.
- `scripts/test_desktop_token.js` replays the exact `main.js` sequence in a
  fresh child process, so this specific ordering cannot regress silently again.
  Run it alongside the rest of the suite.

**The reason it was found at all** was the Settings panel reporting live state
from the server rather than asserting it in prose. The badge read "NOT ACTIVE"
and was telling the truth. Anything that reports a security control's real state
is worth building before the control, not after — the badge found the bug in one
glance, and a paragraph in this file would have kept claiming it worked.

**Not verified — treat as untested:**

- **The preload bridge inside a running Electron window.** The server side is
  proven, and the file is confirmed to ship inside the archive, but
  `contextBridge` has not been exercised in a real window: confirm the desktop
  app still loads data on your first launch of a new build. If it does not, the
  likely cause is the preload path, not the guard.
- **macOS.** Never built or run. `PRECOMPILED.mac` points at the x64 build, and
  on Apple Silicon that needs Rosetta 2.
- **Native Windows.** The Windows checks ran under wine, which is how NSIS itself
  runs, but GPU and some Win32 edge cases differ. Do a quick native run before
  trusting it.

## Note on your `.env`

Your `.env` contains `UPLOAD_DIR="/data/uploads"` — a container path that no line
of code reads. It is harmless and stays inert: the desktop build uses the
prefixed `CMS_UPLOAD_DIR`, and Docker's entrypoint does not read it either. You
can leave it, or delete it to avoid confusion.

## What was deliberately not done

- **Docker is untouched.** The entrypoint runs `node src/server.js` explicitly,
  not `npm start`, so `main` pointing at `electron/main.js` cannot affect it.
  `npm start` still runs the bare server, unchanged.
- **Minimal renderer change.** `nodeIntegration` is off, `contextIsolation` and
  `sandbox` are on. The UI still talks over plain HTTP, but `api()` now reads one
  value off `window.cosplayCms` and sends it as a header. On a non-desktop
  origin `window.cosplayCms` is `undefined`, so the header is simply omitted and
  the request is byte-identical to before.
- **The CORS allowlist editor is removed on the desktop build only.** No
  cross-origin caller exists to allow there — the server is on 127.0.0.1 and the
  token check decides who gets in — so an editor would save origins nothing
  legitimate calls from. It is still fully functional on Docker and `npm start`,
  where the allowlist is the only protection there is and other origins really
  do need adding.
- **No route changes.** All eight routers, both mount paths, and the n8n
  `X-CMS-API-KEY` integration are untouched.
- **Single-instance lock.** Two processes writing one SQLite file can corrupt it,
  so a second launch focuses the first window instead of starting a rival server.
