# cosplay-cms — Electron desktop build

A packaging of the existing CMS as a desktop app. The Docker deployment in
[`DOCKER.md`](DOCKER.md) is unchanged and remains the primary target; this is a
second way to run the same code.

## Design in one paragraph

The Express server is **not reimplemented**. `electron/main.js` sets the
environment and then does `require('../src/server')`, so the desktop app runs
byte-identical server code to the container, and all six existing test suites
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

The window is same-origin with the server it loads, and `src/server.js` allows
requests with no `Origin` header, so CORS never actually fires. The Electron
origin is still appended to the allowlist as insurance for preload/devtools
fetches. The operator's `.env` `CORS_ORIGIN` is preserved, never replaced.

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

### The Windows package carries unused Linux sharp binaries

`node_modules` holds the `linux-x64` and `linuxmusl-x64` variants alongside the
Windows one, and `asarUnpack` keeps them all. Harmless — sharp selects at
runtime — but it is why `win-unpacked` is ~327MB. Excluding the unused variants
in the `win` block would shrink the installer.

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

**Not verified — treat as untested:**

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
- **No renderer changes.** `nodeIntegration` is off, `contextIsolation` and
  `sandbox` are on. The UI talks over HTTP exactly as it does in a browser.
- **No route changes.** All eight routers, both mount paths, and the n8n
  `X-CMS-API-KEY` integration are untouched.
- **Single-instance lock.** Two processes writing one SQLite file can corrupt it,
  so a second launch focuses the first window instead of starting a rival server.
