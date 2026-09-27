/**
 * Shared SQLite helper: consistent escaping + row-parsing contract, and a home
 * for the idempotent migration statements.
 *
 * WHY THIS EXISTS
 * The route files each carry their own copy of the `spawn('sqlite3')` helper.
 * The migrations and the reference-list backfill need a single, consistent
 * escaping + row-parsing contract, so they live here rather than being copied
 * into each route.
 *
 * THE DRIVER: there is no in-process SQLite binding. Every query in this project
 * is a short-lived `spawn('sqlite3', [DB_FILE])` child process fed SQL on stdin.
 * `better-sqlite3` was declared in package.json but required by zero lines of app
 * code, and it cannot install in a slim container image (no prebuilds, gypfile
 * disabled, no install script), so it has been removed as a dependency.
 *
 * DB_FILE IS THE SINGLE SOURCE OF TRUTH FOR THE DATABASE PATH. It is exported
 * below and the route files' own spawn helpers consume it instead of each
 * hardcoding the same literal: six of them used to pass 'data/db/cms.db'
 * directly, so setting DATABASE_PATH moved the settings surface onto one
 * database while the data routes silently kept reading another.
 *
 * It stays relative on purpose — 'data/db/cms.db', resolved against
 * process.cwd() — so a bare `node src/server.js` from the repo root keeps
 * working exactly as before, and the test suites can still isolate a run by
 * changing the cwd (scripts/test_phase5.js copies the DB into a temp dir and
 * spawns the server from there).
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DB_FILE = process.env.DATABASE_PATH || 'data/db/cms.db';

// The sqlite3 CLI will not create the file's parent directory, so a container
// starting against a mounted-but-empty volume would fail on the very first
// query. Idempotent and cheap, so it runs once at module load.
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

// ============================================================================
// Low level
// ============================================================================
function runSql(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', [DB_FILE]);
    let output = '';

    sqlite.stdout.on('data', (data) => { output += data; });
    sqlite.stderr.on('data', (data) => { reject(new Error(data.toString().trim())); });

    sqlite.stdin.write(sql);
    sqlite.stdin.end();

    sqlite.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`SQLite exited with code ${code}`));
    });
  });
}

/**
 * Escape a value for safe interpolation into a SQL string literal.
 * Strings are the only caller-supplied type that reaches SQL; everything else
 * is coerced to a number/boolean by the caller.
 */
function esc(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Parse pipe-delimited sqlite3 CLI output into objects. */
function parseRows(output, columns) {
  if (!output) return [];
  return output.split('\n')
    .map(row => row.split('|'))
    .map(values => {
      const obj = {};
      columns.forEach((col, i) => { obj[col] = values[i]; });
      return obj;
    });
}

async function queryAll(sql, columns, params) {
  // `params` are bound as ? placeholders. Only the fixed COSTUME_SIZE_ENUM uses
  // them; it is an internal constant, never caller input.
  if (params && params.length) {
    sql = params.reduce((acc, _p, i) => acc.replace('?', esc(params[i])), sql);
  }
  return parseRows(await runSql(sql), columns);
}

/** Run a write statement and return the number of affected rows. */
async function exec(sql) {
  const output = await runSql(`${sql} SELECT changes();`);
  const lines = output.split('\n').filter(Boolean);
  return parseInt(lines[lines.length - 1], 10) || 0;
}

// ============================================================================
// Idempotent migrations
// ============================================================================
let schemaReady = null;

/**
 * SQL twin of collapseWhitespace() in src/services/sqlSafety.js.
 *
 * SQLite has no REGEXP_REPLACE, so the collapse is done with nested REPLACE:
 * tab/CR/LF are first turned into a plain space, then the two-space sequence is
 * folded to one space repeatedly. Five folds are enough for any realistic run of
 * spaces (2^5 = 32); anything longer is still reduced to at most 32 consecutive
 * spaces, and such a value cannot exist in this data set.
 *
 * The result is TRIM()med, matching the JS helper's `.replace(/\s+/g,' ').trim()`
 * exactly, so the backfill below and the route writers agree byte for byte.
 *
 * @param {string} column a bare column name (never caller input)
 * @returns {string} a SQL expression over that column
 */
function sqlNormalize(column) {
  let expr = `REPLACE(REPLACE(REPLACE(${column}, char(9), ' '), char(10), ' '), char(13), ' ')`;
  for (let i = 0; i < 5; i++) expr = `REPLACE(${expr}, '  ', ' ')`;
  return `TRIM(${expr})`;
}

async function initSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    // Runtime server settings (currently the CORS allowlist).
    //
    // A KEY/VALUE table rather than columns on some existing table, because
    // these are settings of the SERVER, not of a costume or a user, and because
    // new ones should not each need a migration.
    //
    // `value` is TEXT holding JSON, not a parsed column: the shape of a setting
    // is allowed to change (a scalar today, a list tomorrow) without a schema
    // change, and the single-reader contract lives in src/services/settings.js
    // rather than being spread across this file.
    //
    // `updatedBy` is retained as a free-text note about the change. With a single
    // operator and no accounts there is no identity to record, so src/routes/
    // settings.js writes NULL; the column survives so an existing row keeps its
    // shape rather than needing a migration. It is nullable for that reason.
    //
    // updatedAt is ISO-8601 TEXT because a human reads it, and toISOString() is
    // fixed-width UTC, so a byte comparison is also a chronological one.
    //
    // The row is ABSENT until an override is saved. That absence is the mechanism
    // by which "reset to the .env value" works, so no row is ever seeded with the
    // default — a seeded row would be indistinguishable from a deliberate choice.
    await runSql(`
      CREATE TABLE IF NOT EXISTS "ServerSetting" (
        key TEXT PRIMARY KEY,
        value TEXT,
        updatedAt TEXT,
        updatedBy TEXT
      );
    `).catch((error) => {
      // Its own catch, like every other migration in this function: a failure
      // here must never stop the server booting. The CORS routes fail loudly
      // at call time instead, and settings.js degrades to the .env/default
      // list rather than leaving the allowlist empty.
      console.warn('⚠️  ServerSetting table not created:', error.message);
    });

    // The Telegram delivery address. init_db.sql declares this table, so a fresh
    // container already has it, but that file is CREATE-IF-NOT-EXISTS ONLY: an
    // existing volume was built from the old schema and has no "TelegramChat" at
    // all. Without this statement every getTelegramChatId() call on such a volume
    // would fail with "no such table", so the table is declared here too.
    //
    // Two independent CREATEs of the same table are harmless — the second is a
    // no-op — which is what lets a fresh install and a migrated one converge.
    await runSql(`
      CREATE TABLE IF NOT EXISTS "TelegramChat" (
        slot TEXT PRIMARY KEY,
        telegramChatId TEXT UNIQUE,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
    `).catch((error) => {
      console.warn('⚠️  TelegramChat table not created:', error.message);
    });

    // ONE-TIME MIGRATION of the operator's chat id out of the old account table.
    //
    // WHY THIS IS NEEDED AT ALL
    // "User" held telegramChatId as one column among fourteen. Dropping the
    // account system without carrying that one value forward would silently lose
    // it: the new table would be empty and notifications would have nowhere to go,
    // with nothing in the logs to say why. The instruction was to KEEP this
    // value, so the value is moved rather than merely made reachable.
    //
    // WHY IT IS SPLIT ACROSS STEPS RATHER THAN ONE INSERT...SELECT
    // SQLite prepares a whole statement before running it, so a single statement
    // naming "User" fails with "no such table: User" on a database that never had
    // accounts. Probing sqlite_master first is what makes the backfill a no-op
    // there instead of a boot-time warning on every fresh install.
    //
    // WHY IT IS IDEMPOTENT AND CANNOT OVERWRITE
    // The backfill is skipped in JS unless "TelegramChat" is completely empty,
    // checked immediately before the write. That is the idempotence: once a value
    // exists the statement is never even sent, so a value the operator has since
    // changed is not merely out-ranked but never read. It is also why the single
    // guaranteed slot can be taken from the empty table.
    //
    // WHY THIS IS DONE IN JS RATHER THAN AS ONE INSERT...SELECT
    // Both guards a single statement would need are per-source-ROW in SQLite,
    // not per-statement, which makes the naive versions wrong in ways that still
    // "work":
    //   - `... ; LIMIT 1` — the LIMIT is a separate statement after the INSERT has
    //     already committed, so a multi-row "User" blows the UNIQUE constraint and
    //     only a spurious parse error hides it.
    //   - `SELECT MIN(...) ... WHERE NOT EXISTS (...)` — MIN() aggregates the whole
    //     result to one row, but NOT EXISTS is still evaluated per source row, so
    //     with 2+ accounts the aggregate receives a row that still evaluated true
    //     (checked before the first insert landed) and the slot collides.
    // Deciding emptiness once, in JS, is what makes this exact rather than
    // accidentally right for a single account.
    const existingTelegramChat = String(await runSql(
      `SELECT COUNT(*) FROM "TelegramChat";`
    )).trim();

    const legacyUserTable = String(await runSql(
      `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='User';`
    )).trim() === '1';

    if (existingTelegramChat === '0' && legacyUserTable) {
      // MIN() collapses a multi-row "User" to the single row this insert needs.
      // Deliberately NOT run when the old table is absent: SQLite prepares the
      // whole statement before executing it, so merely naming "User" would fail
      // with "no such table" on a database that never had accounts.
      await runSql(`
        INSERT INTO "TelegramChat" (slot, telegramChatId, createdAt, updatedAt)
        SELECT 'default', MIN("User".telegramChatId), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          FROM "User"
         WHERE "User".telegramChatId IS NOT NULL
           AND TRIM("User".telegramChatId) <> '';
      `).catch((error) => {
        // Its own catch, like every other migration here: a failure must never
        // stop the server booting. The operator can still set the chat id by hand.
        console.warn('⚠️  telegramChatId not migrated out of the old "User" table:', error.message);
      });
    }

    // -----------------------------------------------------------------------
    // Managed reference lists + the one-time backfill of "Costume".brand/fandom.
    //
    // The first statements CREATE the tables; the rest is INSERT OR IGNORE keyed
    // off the UNIQUE index on nameLower. That makes the whole block a no-op on
    // every boot after the first, which is what lets a fresh install and an
    // existing DB converge on the same schema without a separate migration step.
    //
    // WHY THE BACKFILL DOES NOT REWRITE "Costume"
    // "Costume".brand / .fandom hold the NAME (not the id) of the managed row —
    // see the header comment in init_db.sql. So the mapping is implicit: a
    // costume already "points at" the row whose name matches its own text, and
    // there is literally nothing to update on the costume side. That is the
    // strongest possible no-data-loss guarantee — the 83 rows are never rewritten,
    // only read. Lookups are case-insensitive (nameLower) on both sides, so a
    // group holding two spellings of the same name still resolves to one row.
    //
    // WHITESPACE NORMALISATION (idempotent, and a no-op on clean data)
    // Every WRITER now collapses internal whitespace before deriving nameLower
    // (brands.js / fandoms.js normalizeName, costumes.js normalizeReferenceName,
    // both via collapseWhitespace() in sqlSafety.js). This block makes the READ
    // side agree with them, so a database that predates that change cannot end
    // up with a stored list entry that no writer would ever produce again:
    //   1. UPDATE normalises any EXISTING "Brand"/"Fandom" row in place, but
    //      ONLY rows that actually need it (the WHERE). On the current dataset
    //      it matches zero rows, so it is a provable no-op — verified by
    //      dumping the table before and after a boot.
    //   2. The INSERT then groups on the NORMALISED expression, so two costumes
    //      spelled "blue archive" / "blue  archive" land in ONE group and one
    //      list row instead of two.
    //
    // THE COSTUME SIDE IS NOT TOUCHED, AND THAT IS THE POINT
    // A managed-list row whose name differs from a costume's stored text only by
    // whitespace would still resolve, because the list lookup is
    // LOWER(TRIM(costume.brand)) = nameLower on both sides and TRIM is a no-op
    // for the values normalisation leaves alone. Normalising the list WITHOUT
    // normalising the costume would be the dangerous half; doing both, and only
    // ever moving a value that is already whitespace-equivalent, is safe.
    // -----------------------------------------------------------------------
    await runSql(`
      CREATE TABLE IF NOT EXISTS "Brand" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nameLower TEXT NOT NULL,
        storeUrl TEXT,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_Brand_nameLower" ON "Brand"(nameLower);
      CREATE INDEX IF NOT EXISTS "idx_Brand_name" ON "Brand"(name);

      CREATE TABLE IF NOT EXISTS "Fandom" (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        nameLower TEXT NOT NULL,
        createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
        updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_Fandom_nameLower" ON "Fandom"(nameLower);
      CREATE INDEX IF NOT EXISTS "idx_Fandom_name" ON "Fandom"(name);

      -- One row per DISTINCT non-empty brand / fandom currently stored.
      -- MIN(TRIM(col)) is deliberate: under GROUP BY a bare column reference
      -- picks an ARBITRARY member of the group, which would make the stored
      -- spelling non-deterministic across runs. MIN() is stable.
      -- Values containing the sqlite3 CLI's '|' row separator or a newline are
      -- skipped rather than inserted, because they could not survive the pipe
      -- transport the route files use. The costume keeps its own value either
      -- way, so that is a display-list gap, never a data loss.
      INSERT OR IGNORE INTO "Brand" (id, name, nameLower, createdAt, updatedAt)
      SELECT lower(hex(randomblob(16))), MIN(${sqlNormalize('brand')}), LOWER(MIN(${sqlNormalize('brand')})),
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM "Costume"
      WHERE brand IS NOT NULL AND ${sqlNormalize('brand')} <> ''
        AND INSTR(${sqlNormalize('brand')}, '|') = 0
      GROUP BY LOWER(${sqlNormalize('brand')});

      INSERT OR IGNORE INTO "Fandom" (id, name, nameLower, createdAt, updatedAt)
      SELECT lower(hex(randomblob(16))), MIN(${sqlNormalize('fandom')}), LOWER(MIN(${sqlNormalize('fandom')})),
             CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM "Costume"
      WHERE fandom IS NOT NULL AND ${sqlNormalize('fandom')} <> ''
        AND INSTR(${sqlNormalize('fandom')}, '|') = 0
      GROUP BY LOWER(${sqlNormalize('fandom')});
    `).catch((error) => {
      // "Costume" does not exist yet (init_db.sql has not been run).
      console.warn('⚠️  Brand/Fandom tables not created:', error.message);
    });

    // IDEMPOTENT BACKFILL OF THE MANAGED-LIST ROWS' OWN WHITESPACE.
    // Runs AFTER the CREATE/INSERT block so the tables definitely exist, and in
    // its OWN runSql() with its own catch so that a constraint violation here can
    // never abort the backfill above or stop the server booting.
    //
    // The WHERE clause is the idempotence: a row whose name and nameLower are
    // already normalised does not match, so the statement writes nothing and the
    // database is byte-identical to what it was before. On the current data set
    // ZERO rows match, which is why this is safe to ship against real data.
    //
    // It is also self-limiting: it can only move a name to a value that already
    // means the same thing under the lookup (LOWER(TRIM(...)) = nameLower), so
    // no costume can be orphaned by it. Should two legacy rows ever collapse onto
    // the same nameLower, the UNIQUE index rejects the second UPDATE and the
    // catch below reports it rather than silently merging or deleting anything.
    await runSql(`
      UPDATE "Brand"
         SET name = ${sqlNormalize('name')}, nameLower = LOWER(${sqlNormalize('name')})
       WHERE name <> ${sqlNormalize('name')} OR nameLower <> LOWER(${sqlNormalize('name')});
      UPDATE "Fandom"
         SET name = ${sqlNormalize('name')}, nameLower = LOWER(${sqlNormalize('name')})
       WHERE name <> ${sqlNormalize('name')} OR nameLower <> LOWER(${sqlNormalize('name')});
    `).catch((error) => {
      console.warn('⚠️  Brand/Fandom whitespace backfill skipped (list left as-is):', error.message);
    });

    // Column added to "ContactLens" after init_db.sql was written, for the lens
    // colour picker: `color` keeps holding the NAME and gains this #RRGGBB
    // companion, which is the only thing painted into a style context.
    //
    // IDEMPOTENT, AND A NO-OP ON A FRESH DATABASE
    // `ALTER TABLE ... ADD COLUMN` is not itself idempotent — running it twice
    // fails with "duplicate column name". The catch below is what makes it so:
    // the second run's error is swallowed. This is the established pattern in
    // this file rather than a PRAGMA-table_info probe.
    //
    // IT REWRITES NOTHING
    // ADD COLUMN appends the column to every existing row with no value (NULL)
    // and touches no other table. The 83 costumes are not involved at all, and
    // the two existing lenses keep `color = 'Amber'` — a name, not a hex — which
    // is why the client falls back to a preset lookup when colorHex is NULL
    // rather than treating the missing hex as a data error.
    //
    // It is appended LAST, matching the position it is declared at in
    // init_db.sql, so the positional `SELECT *` in src/routes/lenses.js parses
    // identically on a migrated and a freshly-initialised database.
    await runSql('ALTER TABLE "ContactLens" ADD COLUMN colorHex TEXT;').catch(() => {
      // Column already exists, or the table is not there yet.
    });

    // Surface (never repair) any pre-existing size that sits outside XS–3XL.
    await reportSizeEnumDrift();
  })();

  return schemaReady;
}

/**
 * The size enum enforced by POST/PUT /api/costumes (COSTUME_SIZES in
 * src/routes/costumes.js). "Costume".size deliberately has NO CHECK constraint:
 * legacy rows may hold a bespoke value ("One Size", a custom measurement) and a
 * CHECK would make those rows unwritable. Instead the routes reject an
 * out-of-enum `size` for new/edited entries, and this function reports how many
 * pre-existing rows sit outside the enum so the drift is visible instead of
 * silent.
 */
const COSTUME_SIZE_ENUM = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];

async function reportSizeEnumDrift() {
  const placeholders = COSTUME_SIZE_ENUM.map(() => '?').join(', ');
  try {
    const rows = await queryAll(
      `SELECT size, COUNT(*) AS n FROM "Costume"
       WHERE size IS NOT NULL AND TRIM(size) <> '' AND UPPER(TRIM(size)) NOT IN (${placeholders})
       GROUP BY size ORDER BY n DESC;`,
      ['size', 'n'],
      COSTUME_SIZE_ENUM
    );
    if (rows.length === 0) return;
    // No error: these rows are preserved exactly as they are and still render.
    console.warn('⚠️  Costume sizes outside XS–3XL (preserved as-is, '
      + `${rows.reduce((sum, r) => sum + parseInt(r.n, 10), 0)} rows): `
      + rows.map(r => `${r.size} ×${r.n}`).join(', '));
  } catch (_) {
    // "Costume" missing — nothing to report.
  }
}

// ============================================================================
// Telegram delivery address
// ============================================================================
// The CMS has no accounts, but it does have exactly one place a notification is
// delivered TO. That is a configuration value, so it is persisted here rather
// than left as a loose env var that the container has no way to edit.
//
// `DEFAULT_SLOT` is the single fixed key. The table is keyed on it rather than
// being a bare one-row table so that "which chat?" is a named, explicit lookup
// instead of an implicit LIMIT 1 that would silently start reading a second row
// if one were ever added.
const DEFAULT_SLOT = 'default';

/**
 * The configured chat id, or null when nothing has been saved yet.
 *
 * Null is a real, expected state — a fresh install has never opened Telegram —
 * so callers must handle it. It is deliberately NOT an empty string: a
 * configured chat id of '' would be indistinguishable from 'not configured' at
 * every call site, and there is no Telegram chat whose id is empty.
 */
async function getTelegramChatId(slot = DEFAULT_SLOT) {
  await initSchema();
  const output = await runSql(
    `SELECT telegramChatId FROM "TelegramChat" WHERE slot = ${esc(slot)} AND telegramChatId IS NOT NULL AND TRIM(telegramChatId) <> '' LIMIT 1;`
  );
  const value = String(output).trim();
  return value === '' ? null : value;
}

/**
 * Save (or clear) the delivery address.
 *
 * Passing null/empty CLEARS it rather than storing a blank row: the UNIQUE
 * constraint on telegramChatId would otherwise be satisfied by an empty string,
 * which is not a deliverable address. Clearing writes NULL and leaves the row in
 * place, so the table keeps its single stable slot.
 *
 * upsert (not INSERT OR REPLACE) so a cleared value updates the existing row
 * instead of deleting and re-inserting it — REPLACE would reset createdAt on
 * every save and churn the row's identity for no reason.
 */
async function setTelegramChatId(chatId, slot = DEFAULT_SLOT) {
  await initSchema();
  const value = (chatId === null || chatId === undefined) ? null : String(chatId).trim();
  const now = new Date().toISOString();
  await exec(
    `INSERT INTO "TelegramChat" (slot, telegramChatId, createdAt, updatedAt)
     VALUES (${esc(slot)}, ${value === '' ? 'NULL' : esc(value)}, ${esc(now)}, ${esc(now)})
     ON CONFLICT(slot) DO UPDATE SET telegramChatId = ${value === '' ? 'NULL' : esc(value)}, updatedAt = ${esc(now)};`
  );
  return getTelegramChatId(slot);
}

module.exports = {
  runSql,
  exec,
  esc,
  parseRows,
  initSchema,
  reportSizeEnumDrift,
  getTelegramChatId,
  setTelegramChatId,
  DB_FILE
};
