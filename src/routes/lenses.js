const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { esc, enumParam, textParam, textUpdate, idParam, hexColorParam } = require('../services/sqlSafety');

// The five states a lens can be in. The GET / filter allowlists against this
// list, and PUT validates against it too, so a status can never be written that
// the filter would then be unable to represent. The frontend derives its status
// badge class from this exact value, which is why an out-of-set write is worse
// than cosmetic.
const LENS_STATUSES = ['UNOPENED', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'DISPOSED'];

// Column caps, mirroring what public/index.html enforces on the lens form
// (character 120, color 80, colorHex 7 (#RRGGBB), prescription 40, notes 2000).
const MAX_LENS_CHARACTER_LENGTH = 120;
const MAX_LENS_COLOR_LENGTH = 80;
const MAX_LENS_BRAND_LENGTH = 120;
const MAX_PRESCRIPTION_LENGTH = 40;
const MAX_LENS_NOTES_LENGTH = 2000;
const MAX_DATE_LENGTH = 40;

// Execute SQL queries helper
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

// Full column list of the "ContactLens" table (see init_db.sql / live schema).
// Every SELECT in this file is `SELECT *`, so this list must match the table
// order exactly — an omission silently blanks the field in the UI.
//
// `colorHex` is LAST, and that position is load-bearing rather than cosmetic.
// It was added by ALTER TABLE (see the migration in src/services/db.js), and
// SQLite always appends an added column at the end of the physical order, so on
// a migrated database it is last. init_db.sql therefore also declares it last:
// a fresh database and a migrated one then have the SAME physical order, which
// is the only reason the positional `SELECT *` above stays correct on both.
// Inserting it next to `color` in init_db.sql would silently shift every
// following column by one on fresh installs only.
const LENS_COLUMNS = [
  'id', 'character', 'color', 'brand', 'prescription', 'purchaseDate',
  'openedDate', 'expiryDate', 'isOpened', 'status', 'notes', 'imageUrl',
  'createdAt', 'updatedAt', 'colorHex'
];

// `color` remains the free-text NAME and keeps its 80-char cap; `colorHex` is the
// optional, strictly-validated #RRGGBB companion. Both live side by side: the
// name is what the user reads, searches (GET /?color=) and already has bespoke
// values for ("Amber"), the hex is only what the swatch is painted with. The hex
// needs no length cap of its own — hexColorParam() admits only the anchored
// #RRGGBB pattern, which is exactly 7 characters by construction. See that
// function for why the hex is allowlisted rather than escaped.

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

// Check if lens is expiring soon (within 30 days)
function checkExpiryStatus(expiryDate) {
  const now = new Date();
  const expiry = new Date(expiryDate);
  const daysUntilExpiry = Math.floor((expiry - now) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry < 0) return 'EXPIRED';
  if (daysUntilExpiry <= 30) return 'EXPIRING_SOON';
  return 'ACTIVE';
}

// ============================================================================
// GET /api/lenses - List all lenses with filtering
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // `status` is a closed enum — the same five values the response advertises —
    // so it is allowlisted rather than escaped. `color` / `brand` are free text
    // and are type-checked, length-capped and escaped.
    const status = enumParam(req.query.status, LENS_STATUSES, 'status');
    const color = textParam(req.query.color, { name: 'color', maxLength: MAX_LENS_COLOR_LENGTH });
    const brand = textParam(req.query.brand, { name: 'brand', maxLength: MAX_LENS_BRAND_LENGTH });

    let where = '1=1';
    if (status) where += ` AND status = ${esc(status)}`;
    if (color) where += ` AND color LIKE ${esc(`%${color}%`)}`;
    if (brand) where += ` AND brand LIKE ${esc(`%${brand}%`)}`;

    // SELECT * so the cards receive prescription/purchaseDate/notes/imageUrl,
    // which the previous 6-column projection dropped.
    // ORDER BY character is a hard-coded column — nothing user-supplied reaches
    // an identifier position anywhere in this file.
    const sql = `SELECT * FROM "ContactLens" WHERE ${where} ORDER BY character ASC;`;
    const result = await queryDb(sql);
    const lenses = parseSqlResult(result, LENS_COLUMNS);

    res.json({
      count: lenses.length,
      lenses: lenses,
      statuses: LENS_STATUSES
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
// GET /api/lenses/:id - Get single lens
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const result = id === null ? '' : await queryDb(
      `SELECT * FROM "ContactLens" WHERE id = ${esc(id)} LIMIT 1;`
    );

    if (!result) return res.status(404).json({ error: 'Lens not found' });

    const lens = parseSqlResult(result, LENS_COLUMNS)[0];
    res.json(lens);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/lenses - Create new lens
// ============================================================================
// `character` IS OPTIONAL. It used to be required, which was a contract the UI
// could not honour once the field was removed from both lens modals: a form
// that does not collect the value cannot send it, and a server that refuses to
// create a row without it makes lens registration impossible.
//
// NO MIGRATION IS NEEDED. `character` is declared `character TEXT` with no NOT
// NULL in init_db.sql and `character String?` in prisma/schema.prisma, and the
// live schema agrees (`sqlite3 data/db/cms.db ".schema ContactLens"`). The
// column has always been physically capable of holding NULL; only this route's
// validation pretended otherwise. So the fix is to stop requiring it and to
// write SQL NULL — not '' — when it is absent, so "no character" stays
// distinguishable from "a character whose name is the empty string" for any
// future reader. The existing row(s) keep their stored value untouched.
router.post('/', async (req, res) => {
  try {
    const { character, color, colorHex, brand, prescription, purchaseDate, expiryDate, notes } = req.body;

    if (!color) {
      return res.status(400).json({ error: 'color is required' });
    }

    // `prescription`, `purchaseDate` and `expiryDate` used to be interpolated with
    // NO escaping into the INSERT — the clearest injection on this route, since
    // the dashboard's expiryDate is a free <input type="date"> string.
    // Optional, but still fully validated WHEN SUPPLIED: a non-string or an
    // over-long value is a 400, not a silent drop.
    const normalizedCharacter = textParam(character, { name: 'character', maxLength: MAX_LENS_CHARACTER_LENGTH, noSeparator: true });
    const normalizedColor = textParam(color, { name: 'color', maxLength: MAX_LENS_COLOR_LENGTH, noSeparator: true });
    if (!normalizedColor) {
      return res.status(400).json({ error: 'color is required' });
    }
    const normalizedColorHex = hexColorParam(colorHex, { name: 'colorHex' });
    const normalizedBrand = textParam(brand, { name: 'brand', maxLength: MAX_LENS_BRAND_LENGTH, noSeparator: true });
    const normalizedPrescription = textParam(prescription, { name: 'prescription', maxLength: MAX_PRESCRIPTION_LENGTH, noSeparator: true });
    const normalizedPurchaseDate = textParam(purchaseDate, { name: 'purchaseDate', maxLength: MAX_DATE_LENGTH, noSeparator: true });
    const normalizedExpiryDate = textParam(expiryDate, { name: 'expiryDate', maxLength: MAX_DATE_LENGTH, noSeparator: true });
    const normalizedNotes = textParam(notes, { name: 'notes', maxLength: MAX_LENS_NOTES_LENGTH, noSeparator: true });

    const id = randomUUID();
    const now = new Date().toISOString();

    // Derived from the VALIDATED expiry date, so a value that survived validation
    // but is not a real date falls through to the same "expired/soon" branches as
    // before rather than being interpolated.
    const status = checkExpiryStatus(normalizedExpiryDate || new Date().toISOString());

    const sql = `INSERT INTO "ContactLens" (id, character, color, colorHex, brand, prescription, purchaseDate, expiryDate, isOpened, status, notes, createdAt, updatedAt)
                 VALUES (${esc(id)}, ${normalizedCharacter ? esc(normalizedCharacter) : 'NULL'}, ${esc(normalizedColor)}, ${normalizedColorHex ? esc(normalizedColorHex) : 'NULL'}, ${normalizedBrand ? esc(normalizedBrand) : 'NULL'}, ${normalizedPrescription ? esc(normalizedPrescription) : 'NULL'}, ${normalizedPurchaseDate ? esc(normalizedPurchaseDate) : 'NULL'}, ${normalizedExpiryDate ? esc(normalizedExpiryDate) : 'NULL'}, 0, ${esc(status)}, ${normalizedNotes ? esc(normalizedNotes) : 'NULL'}, ${esc(now)}, ${esc(now)});`;

    await queryDb(sql);

    res.status(201).json({
      id,
      // null, not '', when absent — the same distinction the row now stores.
      character: normalizedCharacter || null,
      color: normalizedColor,
      colorHex: normalizedColorHex || null,
      brand: normalizedBrand || null,
      status,
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
// PUT /api/lenses/:id - Update lens
// ============================================================================
// CONTRACT (the edit modal in public/index.html submits exactly these keys)
//   character     string <= 120   LEGACY / NO LONGER COLLECTED BY THE UI.
//                            The field was removed from the edit modal, so the
//                            dashboard does not send it and "absent means leave
//                            the column alone" therefore preserves whatever a
//                            pre-existing row stored. It is still accepted and
//                            still validated so a scripted client (and the n8n
//                            workflow) that sets it keeps working.
//   color         string <= 80
//   brand         string <= 120
//   prescription  string <= 40
//   purchaseDate  string <= 40   ISO date
//   expiryDate    string <= 40   ISO date
//   notes         string <= 2000
//   colorHex      #RRGGBB       optional companion to `color` (see below)
//   openedDate    string <= 40   still accepted (PATCH /:id/open owns it)
//   isOpened      0/1            still accepted
//   status        LENS_STATUSES  still accepted — see below
// Absent / null / '' means "leave the column alone", the contract these five
// fields always had. An all-absent body is a 400, as on costumes and props.
//
// THE ONE EXCEPTION IS `colorHex`, AND IT IS DELIBERATE.
// `colorHex` is DERIVED from `color`: the client sends the swatch the user
// actually picked, or the preset hex for a name it recognises, or nothing. That
// last case has to be expressible, and "absent means leave alone" cannot express
// it — a lens whose colour was changed from "Amber" to a bespoke name would keep
// an amber swatch forever. So for this ONE field the presence of the KEY is the
// intent: present-and-non-empty sets it, present-and-empty/null clears it to
// NULL, absent leaves it untouched. An all-absent body is still a 400.
//
// WHY `status` IS STILL WRITABLE HERE BUT NOT IN THE EDIT FORM
// The edit modal deliberately does NOT expose status. status is DERIVED state:
// checkExpiryStatus() computes it from expiryDate, PATCH /:id/open recomputes it
// from the new openedDate, and the frontend's lensDisplayStatus() overrides it
// again from the date. A value hand-typed into a form would therefore be
// overwritten by the next open/expiry recomputation, which is worse than not
// offering it. The allowlist is KEPT on this route so an existing scripted
// client that PUTs { status: 'DISPOSED' } keeps working, and so an out-of-enum
// value can still never reach the column. An explicit status in the body always
// wins; only when it is absent AND expiryDate changed is the status recomputed
// from the new date, so editing the date cannot leave a stale derived status.
router.put('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';
    const body = req.body || {};
    const { character, color, colorHex, brand, prescription, purchaseDate,
            status, isOpened, openedDate, expiryDate, notes } = body;
    // Key presence, not truthiness — see the note on the contract above.
    const colorHexSupplied = Object.prototype.hasOwnProperty.call(body, 'colorHex');

    // `status`, `openedDate` and `expiryDate` were all unescaped here. `status`
    // is a closed enum, so it is allowlisted instead — matching the GET filter,
    // so no status can be written that the filter cannot represent.
    const normalizedStatus = enumParam(status, LENS_STATUSES, 'status');
    const normalizedOpenedDate = textParam(openedDate, { name: 'openedDate', maxLength: MAX_DATE_LENGTH, noSeparator: true });
    const normalizedExpiryDate = textParam(expiryDate, { name: 'expiryDate', maxLength: MAX_DATE_LENGTH, noSeparator: true });
    const normalizedNotes = textParam(notes, { name: 'notes', maxLength: MAX_LENS_NOTES_LENGTH, noSeparator: true });
    const normalizedCharacter = textParam(character, { name: 'character', maxLength: MAX_LENS_CHARACTER_LENGTH, noSeparator: true });
    const normalizedColor = textParam(color, { name: 'color', maxLength: MAX_LENS_COLOR_LENGTH, noSeparator: true });
    // Validated even when the value is going to be used to CLEAR the column, so a
    // scripted client that sends a crafted string is refused with 400 either way.
    const normalizedColorHex = hexColorParam(colorHex, { name: 'colorHex' });
    const normalizedBrand = textParam(brand, { name: 'brand', maxLength: MAX_LENS_BRAND_LENGTH, noSeparator: true });
    const normalizedPrescription = textParam(prescription, { name: 'prescription', maxLength: MAX_PRESCRIPTION_LENGTH, noSeparator: true });
    const normalizedPurchaseDate = textParam(purchaseDate, { name: 'purchaseDate', maxLength: MAX_DATE_LENGTH, noSeparator: true });

    // Presence is decided on the KEY (textUpdate), not on whether the trimmed
    // value is non-empty. Gating on `!== null` made a user-cleared input
    // indistinguishable from an untouched one, so clearing a field was silently
    // discarded. colorHexSupplied above already worked this way; these did not.
    //
    // `color` is NOT NULL in the schema, so an empty value is a caller error
    // rather than something to clear.
    if (textUpdate(body, 'color') && !normalizedColor) {
      throw Object.assign(new Error('color cannot be empty'), { status: 400 });
    }

    let updates = [];
    if (textUpdate(body, 'character')) updates.push(`character = ${esc(normalizedCharacter)}`);
    if (textUpdate(body, 'color')) updates.push(`color = ${esc(normalizedColor)}`);
    if (colorHexSupplied) {
      updates.push(`colorHex = ${normalizedColorHex ? esc(normalizedColorHex) : 'NULL'}`);
    }
    if (textUpdate(body, 'brand')) updates.push(`brand = ${esc(normalizedBrand)}`);
    if (textUpdate(body, 'prescription')) updates.push(`prescription = ${esc(normalizedPrescription)}`);
    if (textUpdate(body, 'purchaseDate')) updates.push(`purchaseDate = ${esc(normalizedPurchaseDate)}`);
    if (isOpened !== undefined) updates.push(`isOpened = ${isOpened ? 1 : 0}`);
    if (textUpdate(body, 'openedDate')) updates.push(`openedDate = ${esc(normalizedOpenedDate)}`);
    if (textUpdate(body, 'expiryDate')) updates.push(`expiryDate = ${esc(normalizedExpiryDate)}`);
    if (textUpdate(body, 'notes')) updates.push(`notes = ${esc(normalizedNotes)}`);

    if (normalizedStatus !== null) {
      updates.push(`status = ${esc(normalizedStatus)}`);
    } else if (normalizedExpiryDate !== null) {
      // No explicit status and the expiry moved: recompute the derived value so
      // the row cannot disagree with itself. Derived from the VALIDATED date, so
      // a value that is not a real date falls through to the same branches as
      // POST rather than being interpolated.
      updates.push(`status = ${esc(checkExpiryStatus(normalizedExpiryDate))}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    }

    updates.push(`updatedAt = ${esc(new Date().toISOString())}`);

    const sql = `UPDATE "ContactLens" SET ${updates.join(', ')} WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ id, message: 'Lens updated successfully', updatedFields: req.body });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// DELETE /api/lenses/:id - Delete lens
// ============================================================================
// ============================================================================
// PATCH /api/lenses/:id/open - Mark a lens as opened
// Idempotent: calling it on an already-open lens is a no-op that still returns
// 200. Sets openedDate (now) and recalculates expiryDate to +12 months.
// ============================================================================
const OPEN_LIFETIME_MONTHS = 12;

router.patch('/:id/open', async (req, res) => {
  try {
    const id = idParam(req.params.id);

    const existing = id === null ? '' : await queryDb(
      `SELECT id, isOpened, openedDate, expiryDate, status FROM "ContactLens" WHERE id = ${esc(id)} LIMIT 1;`
    );

    if (!existing) {
      return res.status(404).json({ error: 'Lens not found' });
    }

    const row = parseSqlResult(existing, ['id', 'isOpened', 'openedDate', 'expiryDate', 'status'])[0];
    const alreadyOpened = row.isOpened === '1' && !!row.openedDate;

    // Idempotent path — no write, identical response shape.
    if (alreadyOpened) {
      return res.json({
        id: row.id,
        isOpened: true,
        openedDate: row.openedDate,
        expiryDate: row.expiryDate,
        status: row.status,
        message: 'Lens already open'
      });
    }

    const openedDate = new Date().toISOString();
    const newExpiry = new Date(openedDate);
    newExpiry.setMonth(newExpiry.getMonth() + OPEN_LIFETIME_MONTHS);
    const expiryDate = newExpiry.toISOString();
    const status = checkExpiryStatus(expiryDate);

    await queryDb(
      `UPDATE "ContactLens"
       SET isOpened = 1, openedDate = ${esc(openedDate)}, expiryDate = ${esc(expiryDate)}, status = ${esc(status)}, updatedAt = ${esc(new Date().toISOString())}
       WHERE id = ${esc(id)};`
    );

    res.json({
      id,
      isOpened: true,
      openedDate,
      expiryDate,
      status,
      message: 'Lens marked as opened'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DELETE /api/lenses/:id - Delete lens
// ============================================================================
router.delete('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';
    const sql = `DELETE FROM "ContactLens" WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ id, message: 'Lens deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
