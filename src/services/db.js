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

async function queryAll(sql, columns) {
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

    // Columns added to "User" after init_db.sql was written.
    for (const [column, definition] of [['passwordHash', 'TEXT'], ['role', "TEXT DEFAULT 'user'"]]) {
      await runSql(`ALTER TABLE "User" ADD COLUMN ${column} ${definition};`).catch(() => {
        // Column already exists, or the table is not there yet.
      });
    }
  })();

  return schemaReady;
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
