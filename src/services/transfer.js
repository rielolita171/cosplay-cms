/**
 * Export and import of the whole collection, as one .zip.
 *
 * WHAT "THE DATA" IS
 *
 *   db/cms.db        every table: costumes, props, lenses, brands, fandoms,
 *                    makers, wishlist rows, Telegram config, server settings
 *   uploads/         every stored image
 *   manifest.json    what the archive claims to contain, for pre-flight checks
 *
 * WHY A SQL DUMP RATHER THAN COPYING cms.db
 *
 * The database is not copied as a file. `sqlite3 .dump` emits portable SQL,
 * which means an import works across SQLite builds and does not carry a
 * journal or WAL file alongside it — a raw file copy of a database that was
 * not cleanly closed produces a corrupt volume, and copying it while the server
 * is running copies a half-written page. The dump is taken through the same
 * `sqlite3` CLI that is the only driver in this project, so there is no new
 * mechanism to trust.
 *
 * THE MIGRATION DIRECTION THIS SOLVES
 *
 * Desktop -> self-hosted server is the awkward one, because the two disagree
 * about which origins are allowed to reach the API. The desktop app does not
 * enforce an allowlist at all; a self-hosted server does. An archive exported
 * from the desktop build therefore carries no usable allowlist, and a naive
 * import leaves the operator unable to load the UI on the new host. See
 * `reconcileCorsAfterImport()` below, which is the whole reason import is not
 * just "read the SQL and run it". The allowlist is host configuration: it
 * describes the machine the app runs on, so it is reconciled per migration
 * direction rather than carried along.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { DB_FILE, UPLOAD_DIR } = require('./paths');
const settings = require('./settings');
const zip = require('./zip');

// The manifest version. Bumped only if the archive LAYOUT changes; an import
// refuses a version it does not understand rather than guessing.
const MANIFEST_VERSION = 1;

// Tables dumped. Listed explicitly rather than dumping the whole file with
// `.dump`, because `.dump` also emits any table a future migration adds — and
// `sqlite_sequence` and friends are internal state that must not be restored
// onto a database whose AUTOINCREMENT counters belong to a different history.
// The real tables, in dependency-free order (there are no enforced foreign
// keys, so order does not matter for the load itself).
//
// NOTE: there is no "Wishlist" table. The wishlist is a flag/columns on
// "Costume", so it travels with that table. The auth-era leftovers
// (User / RefreshToken / ConsumedToken / PasswordResetToken) are deliberately
// ABSENT: they are not in init_db.sql, no code reads them any more, and
// restoring one would resurrect a password hash table that this project
// deliberately deleted.
const DATA_TABLES = [
  'Brand',
  'Fandom',
  'Maker',
  'TelegramChat',
  'ServerSetting',
  'Costume',
  'Prop',
  'ContactLens'
];

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
function buildManifest(counts) {
  return Buffer.from(JSON.stringify({
    format: 'cosplay-cms-transfer',
    version: MANIFEST_VERSION,
    // Both, not one: createdAt records when the export was made, and source
    // records which build made it, which is the thing that decides whether the
    // allowlist needs fixing on the way in.
    createdAt: new Date().toISOString(),
    source: settings.getSelfOrigin() ? 'desktop' : 'server',
    tables: counts.tables,
    uploads: counts.uploads,
    uploadBytes: counts.uploadBytes
  }, null, 2));
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Run `sqlite3 DB_FILE <args...>` and resolve with stdout.
 *
 * `.dump` is a dot-command, not SQL, so it is passed as the CLI's own argument
 * rather than written to stdin. That is why this spawns directly instead of
 * reusing db.js:runSql(), which feeds SQL text and cannot express a dot-command.
 */
function sqlite3(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', [DB_FILE, ...args]);
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.stdin.end();
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `sqlite3 exited with code ${code}`));
    });
  });
}

/**
 * Produce a SQL dump of DATA_TABLES.
 *
 * The table list is explicit rather than "whatever is in the file", because two
 * things in a database are state belonging to the TARGET, not data to move:
 *
 *   * `sqlite_sequence` is internal AUTOINCREMENT bookkeeping. Restoring it
 *     can set a counter below rows that already exist on the target, so the
 *     next insert collides on the primary key.
 *   * A future migration's table would otherwise start being dumped and
 *     restored silently, which is a behaviour change nobody reviewed.
 *
 * Each table is dumped separately so one malformed table fails naming itself,
 * instead of yielding a partial file that imports as a partial collection.
 */
async function dumpData() {
  const listing = await sqlite3(["SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"]);
  const present = new Set(listing.split('\n').map(s => s.trim()).filter(Boolean));

  const missing = DATA_TABLES.filter(t => !present.has(t));
  if (missing.length === DATA_TABLES.length) {
    throw new Error('This database has none of the expected tables — is it a Cosplay CMS database?');
  }
  const existing = DATA_TABLES.filter(t => present.has(t));

  const parts = [
    '-- cosplay-cms data export\n'
      + `-- tables: ${existing.join(', ')}\n`
      + (missing.length ? `-- absent here, skipped: ${missing.join(', ')}\n` : '')
      + 'PRAGMA foreign_keys=OFF;\n'
      + 'BEGIN TRANSACTION;\n'
  ];
  for (const table of existing) {
    // `.dump` emits its own `BEGIN TRANSACTION; ... COMMIT;` around each table.
    // Those are stripped, because this wraps ALL the tables in ONE transaction:
    // an import is then atomic across tables, and a failure halfway leaves the
    // target database as it was. Left in place, the first COMMIT would close
    // the outer transaction and every later CREATE TABLE would run outside it.
    //
    // The table name is double-quoted INSIDE the dot-command argument, not
    // passed as a second argv entry. `sqlite3 db .dump Brand` runs `.dump` and
    // then tries to execute `Brand` as SQL of its own, which is a syntax error
    // — and it only names the table, so the cause is not obvious from the
    // message. The quotes also matter for the mixed-case names this schema uses.
    const dumped = await sqlite3([`.dump "${table}"`]);
    parts.push(dumped
      .replace(/^PRAGMA foreign_keys=OFF;$/m, '')
      .replace(/^BEGIN TRANSACTION;$/m, '')
      .replace(/^COMMIT;$/m, ''));
  }
  parts.push('COMMIT;\n');
  return parts.join('\n');
}

/** Row counts per table, for the manifest. */
async function countRows() {
  const counts = {};
  for (const table of DATA_TABLES) {
    try {
      const out = await sqlite3([`SELECT COUNT(*) FROM "${table}";`]);
      counts[table] = parseInt(String(out).trim(), 10) || 0;
    } catch (_) {
      counts[table] = 0; // table absent on this database
    }
  }
  return counts;
}

/**
 * The image files that belong in an export.
 *
 * Subdirectories are skipped, not walked. The upload store is flat by
 * construction (multer writes one level deep, named uuid-timestamp.ext), so a
 * subdirectory means something else is writing here, and guessing at its layout
 * is how a migration silently drops files. Dotfiles are skipped for the same
 * reason: a .DS_Store in an archive serves no purpose.
 */
function listUploads() {
  if (!fs.existsSync(UPLOAD_DIR)) return [];
  return fs.readdirSync(UPLOAD_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

/**
 * Build the archive at `outPath` and return a summary.
 *
 * The caller owns the file: this writes it and does not remove it, because the
 * two callers want opposite things (the HTTP route streams it to the browser,
 * where it must outlive the response; a CLI caller keeps it on disk).
 */
async function exportTo(outPath) {
  const sql = await dumpData();
  const tables = await countRows();
  const names = listUploads();

  let uploadBytes = 0;
  const entries = [{ name: 'data.sql', buffer: Buffer.from(sql, 'utf8') }];
  for (const name of names) {
    const full = path.join(UPLOAD_DIR, name);
    try {
      uploadBytes += fs.statSync(full).size;
    } catch (_) {
      continue; // vanished between readdir and stat
    }
    entries.push({ name: `uploads/${name}`, file: full });
  }

  entries.push({
    name: 'manifest.json',
    buffer: buildManifest({ tables, uploads: names.length, uploadBytes })
  });

  const result = zip.createZip(outPath, entries);
  return { ...result, tables, uploads: names.length, uploadBytes };
}

/** Write an export to a temporary file and return its path plus the summary. */
async function exportToTemp() {
  const outPath = path.join(os.tmpdir(), `cosplay-cms-export-${Date.now()}.zip`);
  const summary = await exportTo(outPath);
  return { outPath, summary };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Read and validate an archive WITHOUT changing anything.
 *
 * This is the pre-flight for the confirm step. It reports what the archive
 * contains and what the import would do, so the operator can see "this will
 * replace 412 costumes and 88 images" before agreeing to it. An import that
 * discovers its own contents only after committing is an import nobody should
 * run twice.
 */
function inspect(zipPath) {
  const archive = zip.readZip(zipPath);
  try {
    const names = archive.entries.map(e => e.name);
    const manifestEntry = archive.entries.find(e => e.name === 'manifest.json');
    const sqlEntry = archive.entries.find(e => e.name === 'data.sql');

    if (!sqlEntry) {
      throw new Error('This archive has no data.sql, so it is not a Cosplay CMS export.');
    }

    let manifest = null;
    if (manifestEntry) {
      try {
        manifest = JSON.parse(zip.readEntry(archive, manifestEntry).toString('utf8'));
      } catch (_) {
        throw new Error('The archive manifest is unreadable. The file may be damaged.');
      }
      if (manifest.format !== 'cosplay-cms-transfer') {
        throw new Error('This archive is not a Cosplay CMS export.');
      }
      if (manifest.version > MANIFEST_VERSION) {
        throw new Error(
          `This archive was made by a newer version (format ${manifest.version}; this build understands ${MANIFEST_VERSION}). Update the app before importing.`
        );
      }
    }

    // A directory entry ends in "/" and carries no data.
    const uploads = archive.entries.filter(
      e => e.name.startsWith('uploads/') && !e.name.endsWith('/') && e.size > 0
    );

    let totalBytes = 0;
    for (const entry of archive.entries) totalBytes += entry.size;
    if (totalBytes > zip.LIMITS.maxTotalBytes) {
      throw new Error(`Archive expands to ${totalBytes} bytes, over the ${zip.LIMITS.maxTotalBytes} byte limit.`);
    }

    return {
      manifest,
      createdAt: manifest ? manifest.createdAt : null,
      source: manifest ? manifest.source : 'unknown',
      tables: manifest ? manifest.tables : null,
      uploads: uploads.length,
      uploadBytes: uploads.reduce((sum, e) => sum + e.size, 0),
      totalBytes,
      // Names only — reading every image into memory to count them would be
      // the exact memory blow-up an import is supposed to avoid.
      uploadNames: uploads.map(e => e.name.slice('uploads/'.length))
    };
  } finally {
    // The archive holds an open descriptor. inspect() is the one entry point
    // that opens and closes within a single call, so the release belongs here.
    zip.closeZip(archive);
  }
}

/**
 * Reconcile the CORS allowlist after an import, per migration direction.
 *
 * WHY CORS NEEDS HANDLING AT ALL
 *
 * The allowlist is HOST configuration, not collection data. It describes the
 * machine the app runs on — which hostname, which port — and those two things
 * are different on the other side of a migration. So a `cors_origins` row that
 * travelled in the archive is meaningful only on the machine that wrote it, and
 * carrying it across is actively wrong in BOTH directions. Hence the two rules:
 *
 *   self-hosted  ->  desktop
 *     The incoming origins are DISCARDED, not merged. The desktop build does
 *     not enforce an allowlist at all (CMS_SELF_ORIGIN puts it in permissive
 *     mode), so keeping a list that names `http://192.168.1.50:4001` would be
 *     storing a rule about a network this machine is not on. The stored row is
 *     removed so the desktop app falls back to its own permissive behaviour,
 *     and so a later `npm start` on that data does not silently inherit a
 *     dead allowlist from a machine two moves ago.
 *
 *   desktop  ->  self-hosted
 *     The TARGET's own rules are what survive. This is the direction that
 *     matters most: the self-hosted server enforces an allowlist, and the
 *     archive's row (if any) came from a machine that enforced nothing. So the
 *     target's pre-import configuration is preserved exactly, and only the
 *     loopback origins for THIS server's port are added — and only if the
 *     target's own list does not already permit them.
 *
 * IN BOTH CASES the target's pre-import list is never discarded, and nothing is
 * ever removed from it. The operator's deliberate configuration on the machine
 * they are running is the authority; the archive only ever adds loopback.
 *
 * @param {string[]|null} targetOrigins the target's list before the import, or
 *   null when the target had no stored override and was falling back to .env
 */
async function reconcileCorsAfterImport(targetOrigins) {
  // ---- self-hosted -> desktop: ignore whatever came in -------------------
  //
  // This keys off isDesktopTarget(), NOT isCorsDisabled(). The two were the
  // same predicate when the desktop build enforced nothing, and splitting them
  // matters here: an operator who sets CMS_ALLOW_ANY_ORIGIN=1 as an escape hatch
  // must NOT thereby start retaining a `cors_origins` row imported from another
  // machine. Origins describe a host and port, so that row is meaningless on the
  // machine that imported it either way. Migration behaviour is keyed on WHICH
  // BUILD this is, never on how permissive its CORS currently is.
  if (settings.isDesktopTarget()) {
    // Clear any row the import brought in, so nothing survives that references
    // an origin belonging to another machine. resetCorsOrigins() is the
    // supported way to drop it and re-seed the cache from the env/default.
    await settings.resetCorsOrigins();
    return {
      applied: true,
      reason: 'desktop-allowlist-reset',
      // Reported so the UI can say what happened rather than showing a silent
      // "ok" for a list the operator may have expected to see.
      added: [],
      discarded: true
    };
  }

  // ---- desktop -> self-hosted: keep the TARGET's rules -------------------
  const port = process.env.PORT || '4001';
  const candidates = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];

  // Start from the target's own pre-import list. `targetOrigins` is null when
  // the target had no stored override, in which case the effective list it was
  // using is the env-sourced one — re-read it rather than guessing.
  const base = targetOrigins || (await settings.getCorsOrigins()).origins.slice();

  if (candidates.some(o => base.indexOf(o) !== -1)) {
    // The target's own list already permits loopback, so there is nothing to
    // add. One case still needs a write: in replace mode the import has just
    // DELETED the ServerSetting table, and an archive that carried no allowlist
    // does not put one back. If the target HAD a stored row, that row is now
    // gone and must be restored, or a deliberate LAN allowlist silently
    // disappears and the server falls back to the env default.
    //
    // This is deliberately limited to targetOrigins !== null. A target that was
    // running on the env-sourced list had no stored row to lose, and writing
    // one now would promote a .env value into a stored override the operator
    // never chose — the exact thing the reconciliation is meant to avoid.
    if (targetOrigins) {
      const validation = settings.validateCorsOrigins(targetOrigins);
      if (validation.ok) {
        await settings.setCorsOrigins(validation.origins, null);
      }
    }
    return { applied: false, reason: 'already-allowed', added: [], discarded: true };
  }

  const merged = base.concat(candidates.filter(o => base.indexOf(o) === -1));
  const validation = settings.validateCorsOrigins(merged);
  if (!validation.ok) {
    // Never fail an import over this. The data is already restored by the time
    // this runs, and throwing here would report a failed import that actually
    // succeeded. Warn, and let the operator fix the list in the UI.
    console.warn(`⚠️  Could not add loopback origins after import: ${validation.error}`);
    return { applied: false, reason: 'rejected', added: [], discarded: true };
  }

  await settings.setCorsOrigins(validation.origins, null);
  return { applied: true, reason: 'added', added: candidates, discarded: true };
}

/** Run a SQL script against DB_FILE via the sqlite3 CLI. */
function runSqlOn(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-bail', DB_FILE]);
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => {
      // -bail makes sqlite3 stop at the first error and exit non-zero, so a
      // failed import cannot be mistaken for a successful one. The backup taken
      // before the write is the way back.
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `sqlite3 exited with code ${code} while importing`));
    });
    child.stdin.write(sql);
    child.stdin.end();
  });
}

/**
 * Restore an archive.
 *
 * ORDER MATTERS, and it is close to the reverse of the obvious one:
 *
 *   1. Back up the current database. Nothing else happens until this exists —
 *      an import replaces the operator's collection, and the copy is what
 *      makes that safe.
 *   2. Write the images. Before the SQL, because a costume row referencing a
 *      missing image is a broken collection, whereas an orphaned image for a
 *      few milliseconds is invisible.
 *   3. Apply the SQL.
 *   4. Fix the allowlist.
 *
 * `mode`:
 *   'replace' — wipe the target tables first, so the result is exactly the
 *               archive. This is the migration semantic: what you moved is what
 *               you have. Rows created on the target since the export are lost,
 *               which is why the UI confirms it and why step 1 exists.
 *   'merge'   — INSERT OR IGNORE, keeping target rows. Additive and safe to run
 *               twice; a costume that already exists is left alone.
 */
async function importFrom(zipPath, options = {}) {
  const mode = options.mode === 'merge' ? 'merge' : 'replace';
  const report = inspect(zipPath);

  if (!fs.existsSync(DB_FILE)) {
    throw new Error('There is no database to import into. Start the server once first.');
  }
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });

  // -- 1. backup -------------------------------------------------------------
  const backupPath = `${DB_FILE}.before-import-${Date.now()}`;
  fs.copyFileSync(DB_FILE, backupPath);

  // The target's OWN allowlist, captured BEFORE the SQL runs.
  //
  // This has to happen here, not after: the archive's `ServerSetting` rows are
  // about to be written into this very table, so once the load completes the
  // target's pre-import configuration is gone and cannot be recovered except
  // from the backup file. Reconciling CORS is supposed to preserve the target's
  // rules, so they are read first. Null means "no stored override" — the target
  // was falling back to .env or the default — which is a meaningfully different
  // state from an empty list and must not be conflated with one.
  const targetCors = await settings.getCorsOrigins();
  const targetOrigins = targetCors.source === 'database' ? targetCors.origins.slice() : null;

  const archive = zip.readZip(zipPath);
  let imagesWritten = 0;
  try {
    const sqlEntry = archive.entries.find(e => e.name === 'data.sql');
    if (!sqlEntry) throw new Error('This archive has no data.sql.');

    // -- 2. images -----------------------------------------------------------
    //
    // Every entry is classified, and anything unrecognised is REFUSED rather
    // than skipped. Skipping it would be quietly safe today — an entry named
    // `/etc/passwd` or `C:\evil` does not start with `uploads/`, so the loop
    // ignored it — but "ignored" is exactly the wrong shape for a security
    // control: a future change that widened the prefix test would turn a
    // silent skip into a write. The archive format is closed (data.sql,
    // manifest.json, uploads/*), so an entry outside it means a hand-built or
    // tampered file, and the honest answer to that is to stop.
    //
    // Directory entries (a trailing "/") are the one exception: a zip written
    // by a desktop OS legitimately contains them, and they carry no data.
    const KNOWN_ROOT_ENTRIES = ['data.sql', 'manifest.json'];
    for (const entry of archive.entries) {
      if (entry.name.endsWith('/')) continue; // directory marker, no payload
      if (KNOWN_ROOT_ENTRIES.indexOf(entry.name) !== -1) continue;
      if (!entry.name.startsWith('uploads/') || entry.size === 0) {
        throw new Error(
          `Refusing archive entry outside uploads/: ${entry.name}. `
          + 'A Cosplay CMS export contains only data.sql, manifest.json and uploads/.'
        );
      }
      const destination = safeUploadName(entry.name.slice('uploads/'.length));
      fs.writeFileSync(destination, zip.readEntry(archive, entry));
      imagesWritten++;
    }

    // -- 3. data -------------------------------------------------------------
    const sql = zip.readEntry(archive, sqlEntry).toString('utf8');
    const statements = mode === 'replace'
      // Each DELETE is terminated by its own semicolon. Built by mapping to a
      // complete statement per table rather than splicing a shared semicolon
      // between them, which produces `DELETE FROM "A; DELETE FROM "B"` — a
      // syntax error that only appears once a second table exists.
      ? DATA_TABLES.map(t => `DELETE FROM "${t}";`).join('\n') + '\n' + sql
      : sql.replace(/^INSERT INTO /gm, 'INSERT OR IGNORE INTO ');

    await runSqlOn(statements);

    // initSchema() adds columns an older database may predate. Running it after
    // the load means a dump from an older build lands on a current schema
    // rather than failing the first query that touches a new column.
    await require('./db').initSchema();
  } finally {
    zip.closeZip(archive);
  }

  // -- 4. allowlist ----------------------------------------------------------
  // Reconcile per direction: a self-hosted TARGET keeps its own rules and gains
  // loopback if needed; a desktop TARGET discards whatever the archive carried,
  // because the desktop build enforces no allowlist and those origins describe
  // a different machine. See reconcileCorsAfterImport for the reasoning.
  const cors = await reconcileCorsAfterImport(targetOrigins);
  settings.invalidate(); // the stored row just changed; drop the cached list

  return { ...report, mode, imagesWritten, backupPath, cors };
}

module.exports = {
  exportTo,
  exportToTemp,
  inspect,
  importFrom,
  reconcileCorsAfterImport,
  MANIFEST_VERSION,
  DATA_TABLES
};

/**
 * Reject an archive entry name that would write outside the upload directory.
 *
 * This is the ZIP-slip guard and it is not optional. An entry named
 * `uploads/../../.ssh/authorized_keys` or an absolute `/etc/cron.d/x` resolves
 * outside the target directory once the extractor joins it, and an import runs
 * with the server's own privileges. `path.resolve` is used rather than string
 * prefix tests, and the check is on the RESOLVED path, so `..` and absolute
 * paths and symlink-ish tricks are all covered by the same test.
 */
function safeUploadName(name) {
  if (name.includes('\0')) throw new Error('Archive entry name contains a null byte.');
  if (path.isAbsolute(name)) throw new Error(`Refusing archive entry with an absolute path: ${name}`);
  if (/^[a-zA-Z]:[\\/]/.test(name)) throw new Error(`Refusing archive entry with a drive letter: ${name}`);

  const resolved = path.resolve(UPLOAD_DIR, name);
  const root = path.resolve(UPLOAD_DIR);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing archive entry that escapes the upload directory: ${name}`);
  }
  // Only a flat filename is accepted, which also rules out a nested path that
  // survived the check above.
  if (path.dirname(resolved) !== root) {
    throw new Error(`Refusing a nested archive entry: ${name}`);
  }
  return resolved;
}
