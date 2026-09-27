/**
 * Fandom reference list.
 *
 * "Costume".fandom holds the NAME of a row in "Fandom" (a soft reference — see
 * the header comment in init_db.sql). Structurally identical to
 * src/routes/brands.js minus the store link; the two files deliberately keep
 * their own copy of the `spawn('sqlite3')` helper, matching the existing
 * costume/prop/lens routers.
 */
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { collapseWhitespace } = require('../services/sqlSafety');
const { DB_FILE } = require('../services/db');


// Execute SQL queries helper (same pattern as costumes.js / lenses.js)
async function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', [DB_FILE]);
    let output = '';

    sqlite.stdout.on('data', (data) => { output += data; });
    sqlite.stderr.on('data', (data) => { reject(new Error(data.toString())); });

    sqlite.stdin.write(sql);
    sqlite.stdin.end();

    sqlite.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`SQLite exited with code ${code}`));
    });
  });
}

const FANDOM_COLUMNS = ['id', 'name', 'nameLower', 'createdAt', 'updatedAt'];
const FANDOM_SELECT = `SELECT ${FANDOM_COLUMNS.map(c => `"${c}"`).join(', ')} FROM "Fandom"`;

/** Parse pipe-delimited sqlite3 CLI output into objects. */
function parseSqlResult(output, columns) {
  if (!output) return [];
  return output.split('\n').map(row => {
    const values = row.split('|');
    const obj = {};
    columns.forEach((col, i) => { obj[col] = values[i]; });
    return obj;
  });
}

// ============================================================================
// Field validators
// ============================================================================
const MAX_NAME_LENGTH = 120;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Validate a fandom name.
 *
 * '|' and newlines are rejected because they are the `sqlite3` CLI's row/field
 * separators on the pipe transport this project uses; a value containing one
 * would be split into extra columns and corrupt every read of this table.
 *
 * @returns {{value: string, lower: string}|null} null when the field is absent.
 * @throws {Error} with `status = 400`.
 */
// Internal whitespace is COLLAPSED before `lower` is derived, so "blue  archive"
// and "blue archive" share one nameLower and therefore one managed-list row and
// one UNIQUE-index collision (409 FANDOM_EXISTS) instead of two near-duplicates.
// The identical collapse is applied to the costume side (normalizeReferenceName
// in costumes.js) and to the boot backfill (db.js). A line break is turned into a
// space by the collapse before it can reach the '|' / newline check below; a bare
// '|' is not whitespace and is still rejected.
function normalizeName(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('name must be a string');
  const trimmed = collapseWhitespace(value);
  if (trimmed === '') return null;
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw badRequest(`name accepts at most ${MAX_NAME_LENGTH} characters`);
  }
  if (trimmed.indexOf('|') !== -1) {
    throw badRequest('name cannot contain the character |');
  }
  return { value: trimmed, lower: trimmed.toLowerCase() };
}

function esc(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

// Route a validator's thrown Error to the right status; 500 for anything else.
function respondWithError(res, error) {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message,
    code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
  });
}

/** How many costumes currently point at this fandom (case-insensitive). */
async function countCostumesUsing(name) {
  const result = await queryDb(
    `SELECT COUNT(*) FROM "Costume" WHERE LOWER(TRIM(fandom)) = ${esc(name.toLowerCase())};`
  );
  return parseInt(result, 10) || 0;
}

// ============================================================================
// GET /api/fandoms - List fandoms with their costume usage count
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // LEFT-equivalent correlated subquery, so a fandom with zero costumes still
    // appears in the management list.
    const sql = `SELECT f.id, f.name, f.nameLower, f.createdAt, f.updatedAt,
                        (SELECT COUNT(*) FROM "Costume" c
                          WHERE LOWER(TRIM(c.fandom)) = f.nameLower) AS costumeCount
                 FROM "Fandom" f
                 ORDER BY f.name COLLATE NOCASE ASC;`;
    const fandoms = parseSqlResult(await queryDb(sql), FANDOM_COLUMNS.concat(['costumeCount']));

    res.json({ count: fandoms.length, fandoms });
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// GET /api/fandoms/:id
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const result = await queryDb(`${FANDOM_SELECT} WHERE id = ${esc(req.params.id)} LIMIT 1;`);
    const fandom = parseSqlResult(result, FANDOM_COLUMNS)[0];
    if (!fandom) {
      return res.status(404).json({ error: 'Fandom not found', code: 'NOT_FOUND' });
    }
    res.json(fandom);
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// POST /api/fandoms - Create a fandom
// ============================================================================
router.post('/', async (req, res) => {
  try {
    const name = normalizeName(req.body && req.body.name);
    if (!name) throw badRequest('name is required');

    const existing = parseSqlResult(
      await queryDb(`${FANDOM_SELECT} WHERE nameLower = ${esc(name.lower)} LIMIT 1;`),
      FANDOM_COLUMNS
    )[0];
    if (existing) {
      return res.status(409).json({
        error: `A fandom named "${name.value}" already exists`,
        code: 'FANDOM_EXISTS',
        fandom: existing
      });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await queryDb(
      `INSERT INTO "Fandom" (id, name, nameLower, createdAt, updatedAt)
       VALUES (${esc(id)}, ${esc(name.value)}, ${esc(name.lower)}, ${esc(now)}, ${esc(now)});`
    );

    res.status(201).json({
      id, name: name.value, nameLower: name.lower,
      createdAt: now, updatedAt: now, costumeCount: 0
    });
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// PUT /api/fandoms/:id - Rename
// ============================================================================
// The rename is applied to "Costume" in the SAME transaction, because the
// costume column holds the name. Renaming without that would leave every
// costume pointing at a name that no longer exists — silently orphaning them
// from the managed dropdown, which is the failure mode to avoid.
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const name = normalizeName(req.body && req.body.name);
    if (!name) {
      return res.status(400).json({ error: 'name is required', code: 'VALIDATION_ERROR' });
    }

    const current = parseSqlResult(
      await queryDb(`${FANDOM_SELECT} WHERE id = ${esc(id)} LIMIT 1;`),
      FANDOM_COLUMNS
    )[0];
    if (!current) {
      return res.status(404).json({ error: 'Fandom not found', code: 'NOT_FOUND' });
    }

    if (name.lower !== current.nameLower) {
      const clash = parseSqlResult(
        await queryDb(`${FANDOM_SELECT} WHERE nameLower = ${esc(name.lower)} AND id <> ${esc(id)} LIMIT 1;`),
        FANDOM_COLUMNS
      )[0];
      if (clash) {
        return res.status(409).json({
          error: `A fandom named "${name.value}" already exists`,
          code: 'FANDOM_EXISTS'
        });
      }
    }

    const now = new Date().toISOString();
    const costumeUpdate = name.lower === current.nameLower
      ? ''
      : ` UPDATE "Costume" SET fandom = ${esc(name.value)} WHERE LOWER(TRIM(fandom)) = ${esc(current.nameLower)};`;

    await queryDb(
      `BEGIN; UPDATE "Fandom" SET name = ${esc(name.value)}, nameLower = ${esc(name.lower)}, updatedAt = ${esc(now)} WHERE id = ${esc(id)};${costumeUpdate} COMMIT;`
    );

    res.json({
      id, name: name.value, nameLower: name.lower,
      createdAt: current.createdAt, updatedAt: now,
      costumeCount: await countCostumesUsing(name.lower)
    });
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// DELETE /api/fandoms/:id
// ============================================================================
// REFUSE (409) when any costume still uses the fandom. Nulling the costumes'
// fandom would blank data the user typed, and cascading would delete real
// costumes — irreversible from the UI. A 409 is recoverable: reassign first.
router.delete('/:id', async (req, res) => {
  try {
    const current = parseSqlResult(
      await queryDb(`${FANDOM_SELECT} WHERE id = ${esc(req.params.id)} LIMIT 1;`),
      FANDOM_COLUMNS
    )[0];
    if (!current) {
      return res.status(404).json({ error: 'Fandom not found', code: 'NOT_FOUND' });
    }

    const inUse = await countCostumesUsing(current.nameLower);
    if (inUse > 0) {
      return res.status(409).json({
        error: `Cannot delete "${current.name}": ${inUse} costume(s) still use it. `
          + 'Reassign or remove them first.',
        code: 'FANDOM_IN_USE',
        costumeCount: inUse
      });
    }

    await queryDb(`DELETE FROM "Fandom" WHERE id = ${esc(current.id)};`);
    res.json({ id: current.id, message: 'Fandom deleted successfully' });
  } catch (error) {
    respondWithError(res, error);
  }
});

module.exports = router;
