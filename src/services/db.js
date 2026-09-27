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

    // Admin-minted, single-use password-reset tokens.
    //
    // A TABLE, NOT NEW COLUMNS ON "User". Several tokens must be able to exist
    // per user, each with its own expiry, so that a superseded one can be
    // revoked and the history audited rather than silently overwritten. A column
    // on "User" can only ever hold the most recent token, which would make both
    // of those impossible.
    //
    // `createdBy` records WHICH admin minted it. This is a single-admin instance
    // today, but the column makes the audit question ("who issued this?")
    // answerable later, and it is nullable so a row inserted by any other means
    // (a test fixture, a manual fix) is still legal.
    //
    // createdAt/expiresAt/usedAt are ISO-8601 TEXT, not INTEGER epoch, because
    // this table is read by humans (the admin panel shows the expiry; the .txt
    // file prints it) and every other timestamp column in this schema that a
    // human reads is ISO text. It is also what makes the expiry comparison in
    // completePasswordReset() a correct lexicographic compare: `toISOString()`
    // is fixed-width, zero-padded and always UTC with a 'Z', so byte order IS
    // chronological order. Anything written in that same format — including by
    // a test using strftime('%Y-%m-%dT%H:%M:%fZ', ...) — compares correctly.
    //
    // The index is on userId because that is the only column ever filtered on
    // (revoke-the-prior-token, and the admin panel's lookups).
    await runSql(`
      CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        tokenHash TEXT NOT NULL,
        createdBy TEXT,
        createdAt TEXT,
        expiresAt TEXT NOT NULL,
        usedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS "idx_PasswordResetToken_user" ON "PasswordResetToken"(userId);
    `).catch((error) => {
      // Its own catch, like every migration in this function: a failure here
      // must never stop the server booting. The routes that need this table
      // fail loudly at call time instead.
      console.warn('⚠️  PasswordResetToken table not created:', error.message);
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
  // Reset tokens get a much longer retention than a refresh token: the row is
  // the audit record of a completed reset, so it is kept for 30 days past
  // expiry rather than swept the moment it lapses.
  await sweepPasswordResetTokens(30 * 24 * 60 * 60 * 1000);
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

/**
 * Destroy EVERY session for a user — not just the family of one presented token.
 *
 * Used by the password-reset completion. The reason a reset must go this far: a
 * password change is the user's statement that "whoever had my old credentials
 * should no longer have my account". Revoking only the family that happened to
 * present the refresh token would leave every other device signed in, which is
 * precisely the session an attacker who phished the old password is holding.
 * DELETE rather than the revokedAt soft-delete used elsewhere, because a
 * consumed session row has no further use and this is a credential-compromise
 * response, not a routine logout.
 */
async function destroyAllSessionsForUser(userId) {
  return exec(`DELETE FROM "RefreshToken" WHERE userId = ${esc(userId)};`);
}

// ============================================================================
// Password-reset token store
// ============================================================================
/**
 * Record a freshly minted reset token.
 *
 * `tokenHash` is a SHA-256 hex digest, NOT the token. The plaintext exists only
 * in the response that mints it and in the .txt file the admin hands over; it is
 * never persisted, so a database disclosure does not yield a usable token even
 * though every row is "valid". See the hashing note in src/routes/auth.js.
 */
async function createPasswordResetToken({ id, userId, tokenHash, createdBy, createdAt, expiresAt }) {
  await initSchema();
  await exec(
    `INSERT INTO "PasswordResetToken" (id, userId, tokenHash, createdBy, createdAt, expiresAt, usedAt)
     VALUES (${esc(id)}, ${esc(userId)}, ${esc(tokenHash)}, ${esc(createdBy)}, ${esc(createdAt)}, ${esc(expiresAt)}, NULL);`
  );
}

/**
 * Look a token up BY HASH, returning the raw row with no validity filtering.
 *
 * WHY THIS DELIBERATELY DOES NOT FILTER ON usedAt / expiresAt
 * Both public reset endpoints must answer "unknown token", "already used" and
 * "expired" with ONE identical response, so that the status code, the body and
 * the amount of work done are identical for all three. If this query filtered
 * them out in SQL, the three cases would travel through different code and
 * could drift apart (different error text, a different status, a row present
 * vs absent changing a later `.length` check). Returning the row and letting the
 * CALLER apply the predicate in JS keeps all three on one code path, which is
 * what actually makes them indistinguishable.
 */
async function findPasswordResetTokenByHash(tokenHash) {
  await initSchema();
  return queryRow(
    `SELECT id, userId, tokenHash, createdBy, createdAt, expiresAt, usedAt
       FROM "PasswordResetToken" WHERE tokenHash = ${esc(tokenHash)} LIMIT 1;`,
    ['id', 'userId', 'tokenHash', 'createdBy', 'createdAt', 'expiresAt', 'usedAt']
  );
}

/**
 * Drop the user's UNUSED tokens so only one can ever be live.
 *
 * WHY DELETE AND NOT "mark used"
 * The table has no revokedAt column, and the only spare flag is usedAt — which
 * means "this token completed a reset". Writing it here would forge a
 * completion record for a reset that never happened, and the audit trail is the
 * main reason this is a table rather than a column on "User". Deleting is
 * honest: a revoked token simply stops existing, and rows for resets that DID
 * complete are retained.
 */
async function revokeUnusedPasswordResetTokens(userId) {
  await initSchema();
  return exec(
    `DELETE FROM "PasswordResetToken" WHERE userId = ${esc(userId)} AND usedAt IS NULL;`
  );
}

/**
 * Complete a reset: burn the token, set the new password, kill every session —
 * atomically, or not at all.
 *
 * WHY ALL THREE ARE IN ONE TRANSACTION
 * The single-use property is the whole security value of this endpoint, and it
 * is enforced by the `usedAt IS NULL` predicate on the first UPDATE. SQLite
 * applies a write under an exclusive lock, so of N concurrent submissions of
 * the same token exactly one sees changes() = 1; the rest match nothing. The
 * two dependent writes are then gated on `usedAt = <claimStamp>`, where
 * claimStamp is a per-request value, so a request that LOST the claim cannot
 * drive them. That closes the one race a "claim, then check the result, then
 * write" implementation would leave open: two requests landing in the same
 * millisecond, where the loser would otherwise see the winner's timestamp and
 * proceed. It also means there is no window in which the password is set but
 * the token is still live (replayable), or the token is burned but the
 * password never changed (which would silently lock the user out).
 *
 * The dependent writes select the userId from the row rather than taking it as
 * a parameter, so the user the password is changed on is the user the token
 * actually belongs to — never one derived from the request.
 *
 * @param {{tokenHash: string, passwordHash: string, claimStamp: string}} args
 * @returns {Promise<{ok: boolean, userId: string|null, sessionsRevoked: number}>}
 */
async function completePasswordReset({ tokenHash, passwordHash, claimStamp }) {
  await initSchema();
  // busy_timeout first: a concurrent write from another request (each runSql()
  // is a separate sqlite3 process) would otherwise fail the whole transaction
  // instantly with SQLITE_BUSY instead of waiting its turn.
  const output = await runSql(`
    PRAGMA busy_timeout = 5000;
    BEGIN IMMEDIATE;
    UPDATE "PasswordResetToken" SET usedAt = ${esc(claimStamp)}
     WHERE tokenHash = ${esc(tokenHash)} AND usedAt IS NULL AND expiresAt > ${esc(claimStamp)};
    SELECT 'claim=' || changes();
    UPDATE "User" SET passwordHash = ${esc(passwordHash)}, updatedAt = ${esc(claimStamp)}
     WHERE id = (SELECT userId FROM "PasswordResetToken"
                  WHERE tokenHash = ${esc(tokenHash)} AND usedAt = ${esc(claimStamp)});
    SELECT 'user=' || changes();
    DELETE FROM "RefreshToken"
     WHERE userId = (SELECT userId FROM "PasswordResetToken"
                      WHERE tokenHash = ${esc(tokenHash)} AND usedAt = ${esc(claimStamp)});
    SELECT 'sessions=' || changes();
    COMMIT;
  `);

  // The markers are the transaction's own report. A failed claim (claim=0)
  // forces user=0 and sessions=0, because the subqueries that drive them are
  // themselves keyed on the claim stamp this request owns.
  const marker = (name) => {
    const line = String(output).split('\n').find((l) => l.startsWith(name + '='));
    return line ? parseInt(line.slice(name.length + 1), 10) || 0 : 0;
  };
  const claim = marker('claim');
  const user = marker('user');
  const sessions = marker('sessions');
  return { ok: claim === 1 && user === 1, userId: null, sessionsRevoked: sessions };
}

/**
 * Housekeeping for the reset table alongside the token sweep: drop rows that
 * are long past expiry. A USED row is kept — it is the audit record that a
 * reset happened — but it is removed once it is old enough that keeping it can
 * no longer answer a question anyone is asking.
 */
async function sweepPasswordResetTokens(maxAgeMs) {
  await initSchema();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  await exec(`DELETE FROM "PasswordResetToken" WHERE expiresAt < ${esc(cutoff)};`);
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

/**
 * How many accounts currently have Telegram 2FA switched on.
 *
 * Used by the startup check in src/server.js (reportTelegram2FAConfig) to warn
 * that such accounts cannot receive an OTP while Telegram is unconfigured.
 * `requireChatId` splits the count into "enabled AND has a chat id" vs "enabled
 * with no chat id", because the second group is locked out for a different and
 * more specific reason: even a correctly configured bot has nowhere to send.
 *
 * The comparison is on the TEXT form of the column because SQLite INTEGER values
 * arrive as the string '1' over this CLI pipe transport and the string '0' is
 * truthy in JavaScript — the exact trap toBool() exists to handle elsewhere.
 */
async function countUsersWith2FAEnabled(requireChatId) {
  await initSchema();
  const chatClause = requireChatId ? " AND telegramChatId IS NOT NULL AND TRIM(telegramChatId) <> ''" : '';
  const output = await runSql(
    `SELECT COUNT(*) FROM "User" WHERE telegram2FAEnabled = '1'${chatClause};`
  );
  return parseInt(String(output).trim(), 10) || 0;
}

/**
 * Every account, for the admin panel.
 *
 * The projection is EXPLICIT rather than `USER_SELECT *` because the two columns
 * that must never leave the process — passwordHash and twoFactorSecret — sit in
 * the same table. Selecting a column list here is what guarantees a future
 * `SELECT *` edit cannot start shipping bcrypt hashes and TOTP seeds to a
 * browser-facing endpoint. `twoFactorEnabled` is derived from the raw column with
 * toBool() for the same reason the rest of the codebase does it: over this pipe
 * transport an INTEGER arrives as the string '1'/'0', and the string '0' is
 * truthy in JavaScript.
 */
async function listUsers() {
  await initSchema();
  const columns = ['id', 'username', 'email', 'role', 'telegram2FAEnabled', 'createdAt', 'updatedAt'];
  const rows = await parseRows(
    await runSql(
      `SELECT ${columns.map(c => `"${c}"`).join(', ')} FROM "User" ORDER BY LOWER(username) ASC;`
    ),
    columns
  );
  return rows.map(row => ({
    id: row.id,
    username: row.username,
    email: row.email,
    // A row predating the ladder, or a hand-edited one, can hold anything. Report
    // the stored value verbatim rather than inventing one, and let the client show
    // it as-is; roleLevel() already maps an unknown value to the floor, so an
    // unrecognised role can never satisfy a write check.
    role: row.role || 'user',
    twoFactorEnabled: row.telegram2FAEnabled === '1',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
}

/**
 * How many accounts currently hold the 'admin' role.
 *
 * The role endpoint refuses to demote the last admin. That check is only
 * meaningful if it can count admins, and it has to count them the same way the
 * ladder reads them — hence a string comparison against the literal rather than a
 * numeric level.
 */
async function countAdmins() {
  await initSchema();
  const output = await runSql(`SELECT COUNT(*) FROM "User" WHERE role = 'admin';`);
  return parseInt(String(output).trim(), 10) || 0;
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
  destroyAllSessionsForUser,
  createPasswordResetToken,
  findPasswordResetTokenByHash,
  revokeUnusedPasswordResetTokens,
  completePasswordReset,
  sweepPasswordResetTokens,
  consumeJti,
  isJtiConsumed,
  getUserById,
  getUserByUsername,
  createUser,
  listUsers,
  countAdmins,
  updateUser,
  countUsersWith2FAEnabled,
  DB_FILE
};
