const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { esc, textParam, textUpdate, idParam } = require('../services/sqlSafety');
const { DB_FILE } = require('../services/db');

// Column caps. These mirror what public/index.html already enforces on the prop
// form (name 120, location 160, notes 2000) so the server is never stricter than
// the UI the user is typing into. costumeId's 64 matches the POST check below.
const MAX_PROP_NAME_LENGTH = 120;
const MAX_CATEGORY_LENGTH = 120;
const MAX_CONDITION_LENGTH = 120;
const MAX_LOCATION_LENGTH = 160;
const MAX_PROP_NOTES_LENGTH = 2000;
const MAX_COSTUME_ID_LENGTH = 64;

// Execute SQL queries helper
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

// Full column list of the "Prop" table (see init_db.sql / live schema).
// This file SELECTs `p.*, c.character AS costumeName`, so the parse order
// must match exactly — a mismatch silently mislabels fields in the UI.
const PROP_COLUMNS = [
  'id', 'costumeId', 'name', 'category', 'location', 'condition',
  'notes', 'imageUrls', 'createdAt', 'updatedAt', 'costumeName'
];

// Parse SQLite output
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
// GET /api/props - List all props with filtering
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // All three filters are free text as far as the WRITE path is concerned:
    // POST /api/props accepts any string for category/condition, so the filter
    // cannot be an enum allowlist without breaking a legitimate search. They are
    // therefore type-checked, length-capped, and escaped. costumeId uses the same
    // 64-char cap POST enforces, so the filter domain matches the write domain.
    const costumeId = textParam(req.query.costumeId, { name: 'costumeId', maxLength: MAX_COSTUME_ID_LENGTH });
    const category = textParam(req.query.category, { name: 'category', maxLength: MAX_CATEGORY_LENGTH });
    const condition = textParam(req.query.condition, { name: 'condition', maxLength: MAX_CONDITION_LENGTH });

    // Columns are aliased with the `p.` prefix because the query joins "Costume".
    let where = '1=1';
    if (costumeId) where += ` AND p.costumeId = ${esc(costumeId)}`;
    if (category) where += ` AND p.category = ${esc(category)}`;
    if (condition) where += ` AND p.condition = ${esc(condition)}`;

    // Left join so each prop also carries the display name of its costume.
    // `p.*` restores notes/imageUrls, which the narrow column list omitted.
    // ORDER BY p.name is a hard-coded column — nothing user-supplied reaches an
    // identifier position anywhere in this file.
    const sql = `SELECT p.*, c.character AS costumeName
                 FROM "Prop" p
                 LEFT JOIN "Costume" c ON c.id = p.costumeId
                 WHERE ${where}
                 ORDER BY p.name ASC;`;
    const result = await queryDb(sql);
    const props = parseSqlResult(result, PROP_COLUMNS);

    res.json({
      count: props.length,
      props: props,
      categories: ['Weapon', 'Armor', 'Headpiece', 'Wig', 'Accessory', 'Shoes']
    });
  } catch (error) {
    // Rejected filters are 400s, not server faults — see costumes.js.
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// GET /api/props/:id - Get single prop
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = id === null ? '' : await queryDb(
      `SELECT p.*, c.character AS costumeName
       FROM "Prop" p
       LEFT JOIN "Costume" c ON c.id = p.costumeId
       WHERE p.id = ${esc(id)} LIMIT 1;`
    );

    if (!result) return res.status(404).json({ error: 'Prop not found' });

    const prop = parseSqlResult(result, PROP_COLUMNS)[0];
    res.json(prop);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/props - Create new prop
// ============================================================================
// "Prop".costumeId is `TEXT` with `FOREIGN KEY (costumeId) REFERENCES
// "Costume"(id) ON DELETE SET NULL` (init_db.sql) and the Prisma model declares
// `costumeId String?` / `costume Costume?`. A standalone prop — one that
// belongs to no costume — is therefore a legitimate row in this data model, so
// costumeId is optional here and stored as NULL when it is absent. The
// dashboard's prop form currently marks the select as required; that is a UI
// constraint, not an API rule, and it is not enforced server-side.
router.post('/', async (req, res) => {
  try {
    const { costumeId, name, category, location, condition, notes } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'name and category are required' });
    }

    // Normalise the optional link: '' / null / undefined all mean "standalone".
    const linkedCostumeId = typeof costumeId === 'string' && costumeId.trim() !== ''
      ? costumeId.trim()
      : null;
    if (costumeId !== undefined && costumeId !== null && typeof costumeId !== 'string') {
      return res.status(400).json({ error: 'costumeId must be a string' });
    }
    if (linkedCostumeId && linkedCostumeId.length > MAX_COSTUME_ID_LENGTH) {
      return res.status(400).json({ error: 'costumeId is too long' });
    }

    // `category` and `condition` used to be pasted into the INSERT with NO
    // escaping, so a single quote in the request body ended the literal and the
    // rest of the body was parsed as SQL. They are now validated and escaped
    // like every other column.
    const normalizedName = textParam(name, { name: 'name', maxLength: MAX_PROP_NAME_LENGTH, noSeparator: true });
    const normalizedCategory = textParam(category, { name: 'category', maxLength: MAX_CATEGORY_LENGTH, noSeparator: true });
    const normalizedLocation = textParam(location, { name: 'location', maxLength: MAX_LOCATION_LENGTH, noSeparator: true });
    const normalizedCondition = textParam(condition, { name: 'condition', maxLength: MAX_CONDITION_LENGTH, noSeparator: true });
    const normalizedNotes = textParam(notes, { name: 'notes', maxLength: MAX_PROP_NOTES_LENGTH, noSeparator: true });
    if (!normalizedName || !normalizedCategory) {
      return res.status(400).json({ error: 'name and category are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const sql = `INSERT INTO "Prop" (id, costumeId, name, category, location, condition, notes, createdAt, updatedAt)
                 VALUES (${esc(id)}, ${linkedCostumeId ? esc(linkedCostumeId) : 'NULL'}, ${esc(normalizedName)}, ${esc(normalizedCategory)}, ${normalizedLocation ? esc(normalizedLocation) : 'NULL'}, ${normalizedCondition ? esc(normalizedCondition) : 'NULL'}, ${normalizedNotes ? esc(normalizedNotes) : 'NULL'}, ${esc(now)}, ${esc(now)});`;

    await queryDb(sql);

    res.status(201).json({
      id,
      costumeId: linkedCostumeId,
      name: normalizedName,
      category: normalizedCategory,
      location: normalizedLocation || null,
      condition: normalizedCondition || null,
      createdAt: now
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// PUT /api/props/:id - Update prop
// ============================================================================
// CONTRACT (the edit modal in public/index.html submits exactly these keys)
//   costumeId  string <= 64   link to a costume; '' / null CLEARS the link back
//                            to NULL ("standalone"). This is the one field that
//                            can be cleared explicitly, because "standalone" is
//                            a meaningful state rather than "unknown".
//   name       string <= 120  textParam-trimmed, no '|' or newline
//   category   string <= 120  same
//   location   string <= 160  same
//   condition  string <= 120  same
//   notes      string <= 2000 same
// Absent, null or '' for name/category/location/condition/notes means "leave the
// column alone" — the same contract these three fields always had, so an existing
// client sending a partial body is unaffected. A body in which every field is
// absent is a 400, matching costumes.js and lenses.js.
//
// `condition` was the unescaped one on this route; name and category were not
// editable at all before, which is why a prop could only ever be deleted.
router.put('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';
    const body = req.body || {};
    const { name, category, location, condition, notes } = body;

    // costumeId is validated exactly as POST does, with the same 64-char cap.
    let linkedCostumeUpdate = null;
    if (body.costumeId !== undefined && body.costumeId !== null) {
      if (typeof body.costumeId !== 'string') {
        throw Object.assign(new Error('costumeId must be a string'), { status: 400 });
      }
      const trimmedCostumeId = body.costumeId.trim();
      if (trimmedCostumeId.length > MAX_COSTUME_ID_LENGTH) {
        throw Object.assign(new Error('costumeId is too long'), { status: 400 });
      }
      linkedCostumeUpdate = trimmedCostumeId;   // '' => NULL, see above
    }

    const normalizedName = textParam(name, { name: 'name', maxLength: MAX_PROP_NAME_LENGTH, noSeparator: true });
    const normalizedCategory = textParam(category, { name: 'category', maxLength: MAX_CATEGORY_LENGTH, noSeparator: true });
    const normalizedLocation = textParam(location, { name: 'location', maxLength: MAX_LOCATION_LENGTH, noSeparator: true });
    const normalizedCondition = textParam(condition, { name: 'condition', maxLength: MAX_CONDITION_LENGTH, noSeparator: true });
    const normalizedNotes = textParam(notes, { name: 'notes', maxLength: MAX_PROP_NOTES_LENGTH, noSeparator: true });

    // Presence is decided on the KEY, via textUpdate(), not on whether the
    // trimmed value happens to be non-empty. Gating on `!== null` made a
    // user-cleared input indistinguishable from an untouched one, so clearing
    // the description silently kept the old text.
    //
    // A present-but-empty value clears the column to '' — the same end state
    // NULL would give, since the sqlite3 pipe transport reads NULL back as an
    // empty field. name and category are the exceptions: they are required by
    // the schema, so an empty value is a caller error and stays a 400.
    if (textUpdate(body, 'name') && !normalizedName) {
      throw Object.assign(new Error('name cannot be empty'), { status: 400 });
    }
    if (textUpdate(body, 'category') && !normalizedCategory) {
      throw Object.assign(new Error('category cannot be empty'), { status: 400 });
    }

    let updates = [];
    if (linkedCostumeUpdate !== null) {
      updates.push(`costumeId = ${linkedCostumeUpdate === '' ? 'NULL' : esc(linkedCostumeUpdate)}`);
    }
    if (textUpdate(body, 'name')) updates.push(`name = ${esc(normalizedName)}`);
    if (textUpdate(body, 'category')) updates.push(`category = ${esc(normalizedCategory)}`);
    if (textUpdate(body, 'location')) updates.push(`location = ${esc(normalizedLocation)}`);
    if (textUpdate(body, 'condition')) updates.push(`condition = ${esc(normalizedCondition)}`);
    if (textUpdate(body, 'notes')) updates.push(`notes = ${esc(normalizedNotes)}`);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    }

    updates.push(`updatedAt = ${esc(new Date().toISOString())}`);

    const sql = `UPDATE "Prop" SET ${updates.join(', ')} WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ id, message: 'Prop updated successfully', updatedFields: req.body });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// DELETE /api/props/:id - Delete prop
// ============================================================================
router.delete('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';
    const sql = `DELETE FROM "Prop" WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ id, message: 'Prop deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
