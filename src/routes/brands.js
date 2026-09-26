/**
 * Brand reference list.
 *
 * "Costume".brand holds the NAME of a row in "Brand" (a soft reference — see the
 * header comment in init_db.sql). These routes own that list: the dashboard's
 * brand dropdown is populated from GET /api/brands, and the "Reference Lists"
 * tab uses the rest to add / rename / delete entries.
 *
 * Follows the same conventions as costumes.js / lenses.js / props.js: a local
 * `spawn('sqlite3')` helper, positional parsing, and validation that rejects bad
 * input with 400 BEFORE any SQL runs.
 */
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { collapseWhitespace } = require('../services/sqlSafety');


// Execute SQL queries helper (same pattern as costumes.js / lenses.js)
async function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', ['data/db/cms.db']);
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

// Physical column order of "Brand" — every SELECT here is explicit, but the
// order must match the table so a future column addition is caught here.
const BRAND_COLUMNS = ['id', 'name', 'nameLower', 'storeUrl', 'createdAt', 'updatedAt'];
const BRAND_SELECT = `SELECT ${BRAND_COLUMNS.map(c => `"${c}"`).join(', ')} FROM "Brand"`;

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
const MAX_STORE_URL_LENGTH = 2048;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Validate a brand name.
 *
 * BEYOND LENGTH, TWO MORE RULES
 * 1. '|' and a line break are rejected: those are the `sqlite3` CLI's row/field
 *    separators on the pipe transport this project uses, so a value containing
 *    one would be silently split into extra columns and corrupt every read of
 *    this table. (collapseWhitespace below turns a line break into a space
 *    before it can get here; a bare '|' is not whitespace and still has to be
 *    rejected.)
 * 2. Internal whitespace is COLLAPSED, and the collapse happens BEFORE `lower`
 *    is derived. Without it "blue  archive" and "blue archive" would produce two
 *    different nameLower values, two managed-list rows and two <select> options
 *    both of which resolve to the same costumes — the exact near-duplicate the
 *    user complained about. Normalising here also means the UNIQUE index on
 *    nameLower rejects the second spelling with the normal 409, so a curl client
 *    gets the same answer as the UI.
 *
 * The identical collapse is applied to the costume side (normalizeReferenceName
 * in costumes.js) and to the boot backfill (db.js), so the two halves of this
 * soft reference can never disagree.
 *
 * @returns {{value: string, lower: string}|null} null when the field is absent.
 * @throws {Error} with `status = 400`.
 */
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

/**
 * Validate the optional online-store link.
 *
 * The client already filters through safeUrl() (public/index.html), but a
 * client-side check is not a control: this is the same javascript:/data:/
 * protocol-relative rejection enforced server-side, so a `javascript:` URL can
 * never reach the database even via curl.
 *
 * @returns {string|null} the URL, '' meaning "explicitly cleared", or null when
 *   the field is absent (leave the column alone).
 * @throws {Error} with `status = 400`.
 */
function normalizeStoreUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('storeUrl must be a string');
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length > MAX_STORE_URL_LENGTH) {
    throw badRequest(`storeUrl accepts at most ${MAX_STORE_URL_LENGTH} characters`);
  }
  if (/[|\r\n]/.test(trimmed)) {
    throw badRequest('storeUrl cannot contain the characters | or a line break');
  }
  // http(s) only. A protocol-relative '//evil.tld' is rejected too: it resolves
  // to another origin and would navigate the user off-site.
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(trimmed)) {
    throw badRequest('storeUrl must be an absolute http:// or https:// URL');
  }
  return trimmed;
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

/** How many costumes currently point at this brand (case-insensitive). */
async function countCostumesUsing(name) {
  const result = await queryDb(
    `SELECT COUNT(*) FROM "Costume" WHERE LOWER(TRIM(brand)) = ${esc(name.toLowerCase())};`
  );
  return parseInt(result, 10) || 0;
}

// ============================================================================
// GET /api/brands - List brands with their costume usage count
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // LEFT JOIN on the lower-cased name is the soft-reference lookup. LEFT (not
    // INNER) so a brand with zero costumes still appears in the management list.
    const sql = `SELECT b.id, b.name, b.nameLower, b.storeUrl, b.createdAt, b.updatedAt,
                        (SELECT COUNT(*) FROM "Costume" c
                          WHERE LOWER(TRIM(c.brand)) = b.nameLower) AS costumeCount
                 FROM "Brand" b
                 ORDER BY b.name COLLATE NOCASE ASC;`;
    const brands = parseSqlResult(await queryDb(sql), BRAND_COLUMNS.concat(['costumeCount']));

    res.json({ count: brands.length, brands });
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// GET /api/brands/:id
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const result = await queryDb(`${BRAND_SELECT} WHERE id = ${esc(req.params.id)} LIMIT 1;`);
    const brand = parseSqlResult(result, BRAND_COLUMNS)[0];
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found', code: 'NOT_FOUND' });
    }
    res.json(brand);
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// POST /api/brands - Create a brand
// ============================================================================
router.post('/', async (req, res) => {
  try {
    const name = normalizeName(req.body && req.body.name);
    if (!name) throw badRequest('name is required');
    const storeUrl = normalizeStoreUrl(req.body && req.body.storeUrl);

    const existing = parseSqlResult(
      await queryDb(`${BRAND_SELECT} WHERE nameLower = ${esc(name.lower)} LIMIT 1;`),
      BRAND_COLUMNS
    )[0];
    if (existing) {
      return res.status(409).json({
        error: `A brand named "${name.value}" already exists`,
        code: 'BRAND_EXISTS',
        brand: existing
      });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    // storeUrl === null means "not supplied"; '' means "explicitly empty" and is
    // stored as NULL, because the two are equivalent for a nullable column.
    await queryDb(
      `INSERT INTO "Brand" (id, name, nameLower, storeUrl, createdAt, updatedAt)
       VALUES (${esc(id)}, ${esc(name.value)}, ${esc(name.lower)},
               ${storeUrl ? esc(storeUrl) : 'NULL'}, ${esc(now)}, ${esc(now)});`
    );

    res.status(201).json({
      id, name: name.value, nameLower: name.lower,
      storeUrl: storeUrl || null, createdAt: now, updatedAt: now, costumeCount: 0
    });
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// PUT /api/brands/:id - Rename and/or re-point the store link
// ============================================================================
// A rename is applied to "Costume" in the SAME transaction, because the costume
// column holds the name: without that, renaming "1/3 Delusion" would leave 14
// costumes pointing at a name that no longer exists — i.e. silently orphaning
// them out of the managed list, which is exactly the failure mode to avoid.
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const name = normalizeName(body.name);
    const storeUrl = normalizeStoreUrl(body.storeUrl);

    const current = parseSqlResult(
      await queryDb(`${BRAND_SELECT} WHERE id = ${esc(id)} LIMIT 1;`),
      BRAND_COLUMNS
    )[0];
    if (!current) {
      return res.status(404).json({ error: 'Brand not found', code: 'NOT_FOUND' });
    }
    if (name === null && storeUrl === null) {
      return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    }

    if (name && name.lower !== current.nameLower) {
      const clash = parseSqlResult(
        await queryDb(`${BRAND_SELECT} WHERE nameLower = ${esc(name.lower)} AND id <> ${esc(id)} LIMIT 1;`),
        BRAND_COLUMNS
      )[0];
      if (clash) {
        return res.status(409).json({
          error: `A brand named "${name.value}" already exists`,
          code: 'BRAND_EXISTS'
        });
      }
    }

    const now = new Date().toISOString();
    const assignments = ['updatedAt = ' + esc(now)];
    if (name) {
      assignments.push('name = ' + esc(name.value), 'nameLower = ' + esc(name.lower));
    }
    if (storeUrl !== null) {
      assignments.push('storeUrl = ' + (storeUrl === '' ? 'NULL' : esc(storeUrl)));
    }

    // BEGIN/COMMIT keeps the Brand row and the 83 Costume rows in lock-step, so a
    // failure half-way leaves neither half applied.
    const renameClause = name ? ` UPDATE "Costume" SET brand = ${esc(name.value)} WHERE LOWER(TRIM(brand)) = ${esc(current.nameLower)};` : '';
    await queryDb(
      `BEGIN; UPDATE "Brand" SET ${assignments.join(', ')} WHERE id = ${esc(id)};${renameClause} COMMIT;`
    );

    const updated = parseSqlResult(
      await queryDb(`${BRAND_SELECT} WHERE id = ${esc(id)} LIMIT 1;`),
      BRAND_COLUMNS
    )[0];
    res.json(Object.assign({}, updated, {
      costumeCount: await countCostumesUsing(updated.nameLower)
    }));
  } catch (error) {
    respondWithError(res, error);
  }
});

// ============================================================================
// DELETE /api/brands/:id
// ============================================================================
// REFUSE (409) when any costume still uses the brand. The alternatives were
// both rejected deliberately:
//   * nulling the costumes' brand silently blanks data the user typed;
//   * cascading would delete real costumes, which is catastrophic for an
//     inventory app and can never be undone from the UI.
// A 409 is recoverable: the user reassigns or deletes the costumes first.
router.delete('/:id', async (req, res) => {
  try {
    const current = parseSqlResult(
      await queryDb(`${BRAND_SELECT} WHERE id = ${esc(req.params.id)} LIMIT 1;`),
      BRAND_COLUMNS
    )[0];
    if (!current) {
      return res.status(404).json({ error: 'Brand not found', code: 'NOT_FOUND' });
    }

    const inUse = await countCostumesUsing(current.nameLower);
    if (inUse > 0) {
      return res.status(409).json({
        error: `Cannot delete "${current.name}": ${inUse} costume(s) still use it. `
          + 'Reassign or remove them first.',
        code: 'BRAND_IN_USE',
        costumeCount: inUse
      });
    }

    await queryDb(`DELETE FROM "Brand" WHERE id = ${esc(current.id)};`);
    res.json({ id: current.id, message: 'Brand deleted successfully' });
  } catch (error) {
    respondWithError(res, error);
  }
});

module.exports = router;
