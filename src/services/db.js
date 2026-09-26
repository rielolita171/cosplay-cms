/**
 * Central SQLite helper for the security-sensitive paths (auth / 2FA / refresh
 * tokens) + idempotent migrations.
 *
 * WHY THIS EXISTS
 * The route files each carry their own copy of the `spawn('sqlite3')` helper.
 * The auth surface is the one place where SQL correctness actually matters
 * (user rows, OTP hashes, refresh-token state), so it gets a single shared
 * helper with a consistent escaping + row-parsing contract, and a home for the
 * migration statements.
 *
 * NOTE ON better-sqlite3: it is listed in package.json, but the prebuilt native
 * binding segfaults under this project's Node 18 runtime, so the established
 * `sqlite3` CLI pattern is used here instead of introducing a runtime crash.
 */
const { spawn } = require('child_process');

const DB_FILE = process.env.DATABASE_PATH || 'data/db/cms.db';

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

async function queryRow(sql, columns) {
  const rows = await queryAll(sql, columns);
  return rows[0] || null;
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
    // Rotating, single-use refresh tokens (family-based reuse detection).
    await runSql(`
      CREATE TABLE IF NOT EXISTS "RefreshToken" (
        jti TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        familyId TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        usedAt INTEGER,
        revokedAt INTEGER,
        createdAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_RefreshToken_family" ON "RefreshToken"(familyId);
      CREATE INDEX IF NOT EXISTS "idx_RefreshToken_user" ON "RefreshToken"(userId);
      CREATE INDEX IF NOT EXISTS "idx_RefreshToken_expires" ON "RefreshToken"(expiresAt);

      CREATE TABLE IF NOT EXISTS "ConsumedToken" (
        jti TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        consumedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS "idx_ConsumedToken_expires" ON "ConsumedToken"(expiresAt);
    `).catch((error) => {
      // Missing base tables (init_db.sql not run yet) — nothing to migrate.
      console.warn('⚠️  token tables not created:', error.message);
    });

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

    // Columns added to "User" after init_db.sql was written.
    for (const [column, definition] of [['passwordHash', 'TEXT'], ['role', "TEXT DEFAULT 'user'"]]) {
      await runSql(`ALTER TABLE "User" ADD COLUMN ${column} ${definition};`).catch(() => {
        // Column already exists, or the table is not there yet.
      });
    }

    // Column added to "ContactLens" after init_db.sql was written, for the lens
    // colour picker: `color` keeps holding the NAME and gains this #RRGGBB
    // companion, which is the only thing painted into a style context.
    //
    // IDEMPOTENT, AND A NO-OP ON A FRESH DATABASE
    // `ALTER TABLE ... ADD COLUMN` is not itself idempotent — running it twice
    // fails with "duplicate column name". The catch below is what makes it so:
    // the second run's error is swallowed, exactly as for the "User" columns
    // above. This is the established pattern in this file rather than a
    // PRAGMA-table_info probe, so the two migrations read the same way.
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
// Sweeper — removes expired rows so the tables cannot grow without bound
// ============================================================================
async function sweepExpired() {
  await initSchema();
  const now = Date.now();
  await exec(`DELETE FROM "RefreshToken" WHERE expiresAt < ${now};`);
  await exec(`DELETE FROM "ConsumedToken" WHERE expiresAt < ${now};`);
}

// ============================================================================
// Refresh token store
// ============================================================================
async function insertRefreshToken({ jti, userId, familyId, expiresAt }) {
  await initSchema();
  await exec(
    `INSERT OR REPLACE INTO "RefreshToken" (jti, userId, familyId, expiresAt, createdAt)
     VALUES (${esc(jti)}, ${esc(userId)}, ${esc(familyId)}, ${Number(expiresAt)}, ${Date.now()});`
  );
}

async function getRefreshToken(jti) {
  await initSchema();
  return queryRow(
    `SELECT jti, userId, familyId, expiresAt, usedAt, revokedAt FROM "RefreshToken" WHERE jti = ${esc(jti)} LIMIT 1;`,
    ['jti', 'userId', 'familyId', 'expiresAt', 'usedAt', 'revokedAt']
  );
}

async function markRefreshTokenUsed(jti) {
  await exec(`UPDATE "RefreshToken" SET usedAt = ${Date.now()} WHERE jti = ${esc(jti)};`);
}

async function revokeFamily(familyId) {
  return exec(`UPDATE "RefreshToken" SET revokedAt = ${Date.now()} WHERE familyId = ${esc(familyId)} AND revokedAt IS NULL;`);
}

async function revokeAllForUser(userId) {
  return exec(`UPDATE "RefreshToken" SET revokedAt = ${Date.now()} WHERE userId = ${esc(userId)} AND revokedAt IS NULL;`);
}

// ============================================================================
// Consumed (single-use) token ids
// ============================================================================
/**
 * Atomically records a jti as used.
 * Returns true when this call consumed it, false when it was already consumed
 * (i.e. the caller is looking at a replay).
 */
async function consumeJti(jti, purpose, expiresAt) {
  await initSchema();
  return (await exec(
    `INSERT OR IGNORE INTO "ConsumedToken" (jti, purpose, expiresAt, consumedAt)
     VALUES (${esc(jti)}, ${esc(purpose)}, ${Number(expiresAt)}, ${Date.now()});`
  )) > 0;
}

async function isJtiConsumed(jti) {
  await initSchema();
  const row = await queryRow(`SELECT jti FROM "ConsumedToken" WHERE jti = ${esc(jti)} LIMIT 1;`, ['jti']);
  return !!row;
}

// ============================================================================
// User helpers
// ============================================================================
const USER_COLUMNS = [
  'id', 'username', 'email', 'passwordHash', 'role',
  'telegramChatId', 'telegram2FAEnabled', 'twoFactorSecret', 'twoFactorExpiry',
  'recoveryCodeHash', 'createdAt', 'updatedAt'
];

// Explicit projection: "User" gained passwordHash/role via ALTER TABLE, so the
// physical column order does NOT match USER_COLUMNS. Always select by name.
const USER_SELECT = `SELECT ${USER_COLUMNS.map(c => `"${c}"`).join(', ')} FROM "User"`;

async function getUserById(id) {
  await initSchema();
  return queryRow(`${USER_SELECT} WHERE id = ${esc(id)} LIMIT 1;`, USER_COLUMNS);
}

async function getUserByUsername(username) {
  await initSchema();
  return queryRow(`${USER_SELECT} WHERE username = ${esc(username)} LIMIT 1;`, USER_COLUMNS);
}

async function createUser({ id, username, email, passwordHash, role = 'user' }) {
  await initSchema();
  const now = new Date().toISOString();
  // telegram2FAEnabled defaults to 1 in init_db.sql, but a brand new account has
  // no telegramChatId, so an OTP could never be delivered. Start at 0; the user
  // opts in from the Security tab after a chat id is configured.
  await exec(
    `INSERT INTO "User" (id, username, email, passwordHash, role, telegram2FAEnabled, createdAt, updatedAt)
     VALUES (${esc(id)}, ${esc(username)}, ${esc(email)}, ${esc(passwordHash)}, ${esc(role)}, 0, ${esc(now)}, ${esc(now)});`
  );
  return getUserById(id);
}

async function updateUser(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const assignments = keys.map(k => `${k} = ${esc(fields[k])}`).join(', ');
  await exec(`UPDATE "User" SET ${assignments}, updatedAt = ${esc(new Date().toISOString())} WHERE id = ${esc(id)};`);
}

module.exports = {
  runSql,
  exec,
  esc,
  parseRows,
  initSchema,
  reportSizeEnumDrift,
  sweepExpired,
  insertRefreshToken,
  getRefreshToken,
  markRefreshTokenUsed,
  revokeFamily,
  revokeAllForUser,
  consumeJti,
  isJtiConsumed,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  DB_FILE
};
