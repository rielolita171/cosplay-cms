/**
 * Electron main process.
 *
 * SHAPE OF THE SOLUTION
 *
 * The Express server is NOT reimplemented and its routes are NOT touched. It is
 * required in-process via `require('../src/server')`, so the desktop app runs
 * byte-identical server code to the container and all six existing test suites
 * keep exercising the same surface.
 *
 * What this process supplies is the four things the container got from
 * docker/entrypoint.sh and its environment, none of which exist in a packaged
 * desktop app:
 *
 *   1. Points writable paths at app.getPath('userData') via the DATA_DIR /
 *      UPLOAD_DIR overrides read by src/services/paths.js. Without this the
 *      database and every uploaded image resolve inside the read-only app.asar
 *      archive and the first write fails with EROFS.
 *   2. Runs the pre-flight (sqlite3 presence + init_db.sql), which replaced the
 *      entrypoint script.
 *   3. Binds the server to 127.0.0.1 rather than 0.0.0.0.
 *   4. Owns the window and the shutdown sequence.
 *
 * ENVIRONMENT SETUP IS FIRST AND UNCONDITIONAL.
 * `require('../src/services/paths')` reads process.env at module load, and
 * src/server.js reads its config at load too. Setting these after those requires
 * would be silently ignored, so the order below is load-bearing.
 */
const { app, BrowserWindow, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// NOTE: './preflight' is deliberately NOT required here.
//
// It looks harmless, but requiring it at module scope transitively loads
// src/services/paths.js, which reads process.env ONCE at module load and caches
// the result. Requiring it here would therefore evaluate paths.js BEFORE the
// environment block below sets CMS_DATA_DIR / CMS_UPLOAD_DIR — and those
// assignments would be silently discarded, sending the database and uploads
// back to the repo's data/ directory instead of app.getPath('userData').
// That was a real bug, caught only by actually launching the app.
//
// It is required lazily inside app.whenReady() instead, which is after the
// environment is fully set. The rule this encodes: nothing that transitively
// reads paths.js may be required before the environment block has run.

// ============================================================================
// ENVIRONMENT — MUST BE SET BEFORE ANY require OF APP CODE
// ============================================================================

/**
 * Loopback only. This app has no authentication at all (see the note at the top
 * of src/server.js), so publishing the port on every interface would expose full
 * read AND write access to the entire collection to the whole LAN.
 */
process.env.BIND_ADDRESS = '127.0.0.1';

/**
 * A fixed default rather than an arbitrary free port.
 *
 * 0 would be more "correct" in the abstract, but the port must be known BEFORE
 * the window is created so the renderer can be pointed at it, and a stable port
 * lets a second launch detect the first and focus it instead of starting a rival
 * server against the same SQLite file. Two processes writing one database file
 * is a real corruption risk, so single-instance is enforced below.
 */
process.env.PORT = process.env.PORT || '4101';

/**
 * userData is per-user, per-OS and writable by definition — which is the whole
 * point. It sits outside app.asar.
 */
const userData = app.getPath('userData');

/**
 * The CMS_ prefix is not cosmetic — see the long note in src/services/paths.js.
 * This repo's .env contains a `UPLOAD_DIR="/data/uploads"` container path that no
 * line of code has ever read. Setting the same bare name here would collide with
 * that value the moment dotenv loads, and every non-Electron start would break
 * too. The prefixed names cannot collide with anything already in a .env.
 */
process.env.CMS_DATA_DIR = process.env.CMS_DATA_DIR ||
  path.join(userData, 'data');

process.env.CMS_UPLOAD_DIR = process.env.CMS_UPLOAD_DIR ||
  path.join(process.env.CMS_DATA_DIR, 'uploads');

/**
 * THE BUNDLED SQLITE3 BINARY — put it on PATH.
 *
 * This app has no in-process SQLite driver; every query is spawn('sqlite3').
 * electron-builder bundles only the files listed in its config, and a system
 * binary is not one of them, so a packaged app would have no database at all.
 *
 * `scripts/fetch_sqlite.js` downloads the sqlite3 CLI for the build platform
 * into `resources/sqlite3/` (extraResources). That directory is prepended to
 * PATH here, and because every query in the app spawns the bare name 'sqlite3',
 * this one assignment makes the whole application work unchanged — no call
 * site needed editing.
 *
 * PREPEND, not append. An operator who already has sqlite3 on PATH may have a
 * different version; preferring the bundled one makes a packaged build behave
 * identically everywhere rather than depending on what happened to be installed.
 *
 * In development nothing is bundled, so this is a no-op and the system binary is
 * used — which is why `npm run electron:dev` works without running the fetch
 * script first.
 */
const BUNDLED_SQLITE_DIR = process.resourcesPath
  ? path.join(process.resourcesPath, 'sqlite3')
  : path.join(__dirname, '..', 'resources', 'sqlite3');

if (fs.existsSync(BUNDLED_SQLITE_DIR)) {
  process.env.PATH = BUNDLED_SQLITE_DIR + path.delimiter + process.env.PATH;
}

/**
 * Add this app's own origin to the CORS allowlist.
 *
 * The window is same-origin with the server it loads, and src/server.js allows
 * any request with no Origin header, so in practice the SPA never trips CORS.
 * This is belt-and-braces for the cases that DO send an Origin: a fetch issued
 * from a preload script or devtools, and any future non-relative API call.
 *
 * The operator's .env CORS_ORIGIN is preserved rather than replaced — the
 * container's allowlist is the one that matters for the n8n integration, and
 * silently dropping it because someone launched the desktop app would be a
 * nasty surprise. Note this only affects an Electron launch; dotenv never runs
 * against a packaged app, so there is no .env to preserve there.
 */
const electronOrigin = `http://127.0.0.1:${process.env.PORT}`;
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (configuredOrigins.indexOf(electronOrigin) === -1) {
  configuredOrigins.push(electronOrigin);
}
process.env.CORS_ORIGIN = configuredOrigins.join(',');

/**
 * A shipped app has no .env. The container reads one; dotenv finds nothing and
 * every variable falls back to its default, which is the correct outcome. The
 * Telegram token and the API key are deliberately NOT invented here — they are
 * real credentials, and a generated placeholder would produce a key that looks
 * configured but is not. Both are settable from the Settings UI, which persists
 * them to the database, and that is the documented path for a desktop user.
 *
 * NODE_ENV=production is set explicitly because dotenv will not supply it.
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

// ============================================================================
// WINDOW
// ============================================================================

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 700,
    title: 'Cosplay CMS',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      // The renderer loads the app's own localhost server, which is same-origin
      // with itself, so nodeIntegration in the renderer is not needed and stays
      // off. Everything the UI needs goes over HTTP exactly as in a browser.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Painted only once the first frame is ready, so the window never flashes an
  // empty white rectangle while the server is still booting.
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.loadURL(`http://127.0.0.1:${process.env.PORT}/`);

  // Any external link opens in the real browser rather than navigating the app
  // window away from the CMS. A maker store link is the common case.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Nothing in this app should ever navigate the window off the local server;
  // refuse it and hand the URL to the OS browser instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${process.env.PORT}`)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ============================================================================
// LIFECYCLE
// ============================================================================

/**
 * Without this, a second launch starts a second server against the SAME SQLite
 * file. SQLite tolerates concurrent readers, but two writers on one file can
 * produce a corrupt database — so this is a data-safety guard, not a
 * convenience.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Required HERE, not at module scope: this is the first line to pull in
    // src/services/paths.js, and it must not happen until CMS_DATA_DIR and
    // CMS_UPLOAD_DIR above are set. See the note at the top of this file.
    const { preflight } = require('./preflight');

    let info;
    try {
      info = preflight();
    } catch (error) {
      // Refuse to open a window onto a server that cannot serve data. Quitting
      // after the dialog makes this a hard stop rather than a dismissible toast.
      dialog.showErrorBox('Cosplay CMS cannot start', error.message);
      app.quit();
      return;
    }

    console.log(`[electron] sqlite3 driver: ${info.driver}`);
    console.log(`[electron] database: ${info.database}`);
    console.log(`[electron] uploads:  ${info.uploads}`);
    console.log(`[electron] tables:   ${info.tables}`);

    // Required LAST, inside whenReady. Requiring src/server.js at the top of this
    // file would call app.listen() before the pre-flight proved the sqlite3
    // binary exists — reproducing exactly the "boots healthy, then 500s
    // everywhere" failure the entrypoint exists to prevent.
    require('../src/server');

    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Standard macOS behaviour is to stay resident, but this app owns a database
    // and a daily Telegram timer — quitting everywhere keeps that unambiguous.
    app.quit();
  });
}

/**
 * Graceful shutdown.
 *
 * src/server.js already installs SIGTERM/SIGINT handlers that drain connections
 * with a 9s failsafe (written for `docker stop`). Electron does not forward
 * signals to the app on quit, so re-raising SIGTERM against our own PID hands
 * shutdown to that existing handler and the desktop app drains exactly the same
 * way instead of being torn down mid-write.
 */
app.on('before-quit', () => {
  if (process.platform !== 'win32') {
    process.kill(process.pid, 'SIGTERM');
  }
});
