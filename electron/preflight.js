/**
 * Pre-flight: the two things the container gets from docker/entrypoint.sh and
 * that an Electron app has no other way to get.
 *
 * WHY THIS EXISTS
 *
 * In Docker, /app/docker/entrypoint.sh runs as PID 1's parent before Node ever
 * starts, and it does two load-bearing jobs:
 *
 *   1. Proves the `sqlite3` CLI exists on PATH. This project has NO in-process
 *      SQLite driver — every query is a short-lived spawn('sqlite3', [DB_FILE])
 *      in src/services/db.js and eleven equivalent call sites across
 *      src/routes/*.js. Without the binary, every data route 500s while
 *      /health still returns 200, because /health never touches the database.
 *      A green healthcheck is not evidence the database works.
 *
 *   2. Applies init_db.sql, which is 100% idempotent (CREATE TABLE IF NOT EXISTS
 *      throughout, no DROP/DELETE/ALTER, no seed INSERTs) and is MANDATORY. The
 *      app itself only creates the auth/2FA tables via initSchema(). Without
 *      this step the app boots perfectly healthy and then 500s on every data
 *      route, because Costume/User/Prop/ContactLens do not exist.
 *
 * A packaged Electron app has no shell PID 1 and no entrypoint script, so both
 * jobs have to happen in JS. They are duplicated here rather than shelled out to
 * so that the desktop build is not dependent on a POSIX shell existing on the
 * target machine — it is not, on Windows.
 *
 * `initSchema()` alone is NOT sufficient. It does not create Costume, Prop,
 * ContactLens, Brand, Fandom, Maker, ServerSetting or TelegramChat, so a fresh
 * desktop install would show a working server whose every tab 500s.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const paths = require('../src/services/paths');

// Mirrors REQUIRED_TABLES in docker/entrypoint.sh. Checked BY NAME, not by
// count: a count silently couples startup to the number of tables that happened
// to exist when the list was written, so adding a table later would either
// break a healthy install or let a broken one through.
const REQUIRED_TABLES = [
  'Brand', 'Fandom', 'Costume', 'Prop', 'ContactLens',
  'Maker', 'ServerSetting', 'TelegramChat'
];

/**
 * Run a statement against the DB with the sqlite3 CLI. Throws on failure.
 *
 * `args` overrides the default `[DB_FILE]`. It exists for the `--version` probe,
 * which must NOT pass a database path: `sqlite3 <db> --version` treats the flag
 * as a SQL statement to run against that database, so it exits 0 with empty
 * output and reports a blank version. Omitting the path is what makes it a
 * version query.
 */
function sqlite(sql, { input, args } = {}) {
  const result = spawnSync('sqlite3', args || [paths.DB_FILE], {
    input: input !== undefined ? input : sql,
    encoding: 'utf8'
  });

  if (result.error) {
    // ENOENT lands here and is the single most important failure to report
    // clearly: it means the driver is missing, not that the SQL was bad.
    throw new Error(
      `Could not run the sqlite3 CLI (${result.error.message}).\n` +
      'This app has no in-process SQLite driver and shells out to `sqlite3` for ' +
      'every query. The binary must exist on PATH — see electron/README section ' +
      '"Bundling the sqlite3 binary".'
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `sqlite3 exited ${result.status}: ${(result.stderr || '').trim()}`
    );
  }

  return (result.stdout || '').trim();
}

/** True if a `sqlite3` binary is resolvable on PATH. */
function hasSqlite() {
  const probe = process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3';
  // encoding is REQUIRED: spawnSync returns Buffers by default, and .trim() does
  // not exist on a Buffer — the check would throw instead of answering, turning
  // a clean "driver missing" message into a stack trace.
  const found = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [probe],
    { encoding: 'utf8' }
  );
  return found.status === 0 && String(found.stdout || '').trim() !== '';
}

/**
 * Run the full pre-flight. Throws with an operator-readable message on any
 * failure — Electron's main process catches this and shows a dialog rather than
 * opening a window onto a server that cannot serve data.
 */
function preflight() {
  if (!hasSqlite()) {
    throw new Error(
      'sqlite3 CLI not found on PATH.\n\n' +
      'This app has no in-process SQLite driver — it spawns the `sqlite3` ' +
      'binary for every query. Without it, every data route fails while the ' +
      'app still looks like it started.\n\n' +
      'Install it (Debian/Ubuntu: apt-get install sqlite3, macOS: ' +
      'brew install sqlite, Windows: add sqlite3.exe to PATH) or re-run ' +
      '"npm run electron:dist" so the bundled copy is unpacked.'
    );
  }

  // The sqlite3 CLI will not create the file's parent directory, and a fresh
  // userData directory is empty. Idempotent, so it is safe on every launch.
  fs.mkdirSync(path.dirname(paths.DB_FILE), { recursive: true });
  fs.mkdirSync(paths.UPLOAD_DIR, { recursive: true });

  if (!fs.existsSync(paths.INIT_SQL)) {
    throw new Error(
      `Missing schema file: ${paths.INIT_SQL}\n` +
      'Without it the app boots healthy and then 500s on every data route. ' +
      'init_db.sql must be listed in the electron-builder "files" array.'
    );
  }

  // Idempotent, so it runs unconditionally on every launch — exactly as the
  // entrypoint does. CREATE TABLE IF NOT EXISTS creates a MISSING table rather
  // than skipping it, which is what makes this safe against a half-created
  // database from an interrupted earlier run.
  sqlite('', { input: fs.readFileSync(paths.INIT_SQL, 'utf8') });

  // Do not trust the exit code alone — report what is actually present now.
  const missing = REQUIRED_TABLES.filter(
    (table) => sqlite(
      `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${table}';`
    ) !== '1'
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required table(s) after init_db.sql: ${missing.join(', ')}.\n` +
      'The schema did not apply correctly — refusing to start.'
    );
  }

  const count = sqlite(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table';"
  );

  return {
    driver: sqlite('', { args: ['--version'] }),
    database: paths.DB_FILE,
    uploads: paths.UPLOAD_DIR,
    tables: count
  };
}

module.exports = { preflight, hasSqlite };
