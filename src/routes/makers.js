// ============================================================================
// MAKER CORNER — the people who build the props, weapons and accessories
// ============================================================================
//
// WHAT THIS IS
// A directory of makers with the two things you actually need to reach one of
// them: their social media link and their WhatsApp. Each maker is filed under
// WHAT THEY MAKE — PROP, WEAPON or ACCESSORY — because that is the question the
// Corner is asked when you are looking for someone who can build the thing in
// your hand.
//
// WHY IT IS NOT A COLUMN ON "Prop"
// A maker is entered once and reused. As a prop column it would be retyped on
// every row by hand, with one spelling drift per row ("Rina", "Rina.", "rina"),
// and a correction would have to be made N times. See the init_db.sql header for
// the full reasoning.
//
// THE SHAPE OF THIS FILE IS props.js ON PURPOSE
// Same spawn/parse helpers, same textParam/esc helpers, same pagination
// envelope, same 400-vs-500 split. Every one of those decisions was already made
// and defended in the routes this one is modelled on; re-deciding any of them
// here would be how two files drift apart. The few places it necessarily differs
// — the enum, the URL, the phone number — say why at the point of difference.
// ============================================================================

const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { esc, textParam, textUpdate, idParam, enumParam, badRequest } = require('../services/sqlSafety');
const { DB_FILE } = require('../services/db');

// Column caps. These mirror what the Maker form in public/index.html enforces,
// so the server is never stricter than the UI the user is typing into.
const MAX_MAKER_NAME_LENGTH = 120;
const MAX_SOSMED_LENGTH = 2048;
const MAX_WHATSAPP_LENGTH = 32;
const MAX_MAKER_NOTES_LENGTH = 2000;

/**
 * WHAT A MAKER MAKES — the closed set the Corner is filtered by.
 *
 * Enforced here as an allowlist (enumParam) rather than merely offered as a
 * <select>, so a bad value is a 400 by curl and not just impossible from the
 * dashboard. The order is the display order on the form, so it is also the
 * order the client renders without a second list to keep in sync.
 *
 * It is exported so the client <select> can be built from ONE list — the same
 * reason COSTUME_STATUSES and COSTUME_SIZES are exported from costumes.js.
 */
const MAKER_TYPES = ['PROP', 'WEAPON', 'ACCESSORY'];

/** Human-readable labels, for the API response and the client badge. */
const MAKER_TYPE_LABELS = {
  PROP: 'Props',
  WEAPON: 'Weapons',
  ACCESSORY: 'Accessories'
};

// Execute SQL queries helper — identical to the one in props.js/costumes.js.
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

// Full column list of the "Maker" table. This file SELECTs `*`, so the parse
// order must match the physical column order exactly — a mismatch silently
// mislabels fields in the UI (put whatsapp where sosmed belongs and the number
// renders as a link).
//
// THIS MUST STAY IN SYNC WITH BOTH init_db.sql AND the CREATE in
// src/services/db.js's initSchema(). The db.js copy is the only one an existing
// database ever runs; this array is only correct if all three agree.
const MAKER_COLUMNS = [
  'id', 'name', 'makerType', 'sosmed', 'whatsapp', 'notes',
  'createdAt', 'updatedAt'
];

// Parse SQLite output — identical to the helper in props.js.
function parseSqlResult(output, columns) {
  if (!output) return [];
  return output.split('\n').map(row => {
    const values = row.split('|');
    const obj = {};
    columns.forEach((col, i) => { obj[col] = values[i]; });
    return obj;
  });
}

/**
 * Validate the maker's social media LINK.
 *
 * The dashboard renders this as an <a href>, so it is a URL and not a handle,
 * and it is validated AT THE API BOUNDARY rather than only in the browser. The
 * client's safeUrl() filter is a convenience; a client-side check is not a
 * control, and this is the same javascript:/data:/protocol-relative rejection
 * "Brand".storeUrl enforces — see src/routes/brands.js normalizeStoreUrl.
 *
 * NO HOST ALLOWLIST. Instagram, TikTok, Bluesky, X, a Linktree, a Ko-fi page and
 * a self-hosted portfolio are all legitimate, and the user may well be recording
 * a maker they found somewhere unusual. The scheme check is the security
 * boundary; the host is not one.
 *
 * @returns {string|null} the URL, '' meaning "explicitly cleared", or null when
 *   the field is absent (leave the column alone).
 * @throws {Error} with `status = 400`.
 */
function normalizeSosmedUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest('sosmed must be a string');
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length > MAX_SOSMED_LENGTH) {
    throw badRequest(`sosmed accepts at most ${MAX_SOSMED_LENGTH} characters`);
  }
  // '|' and newlines could not survive the pipe transport this file reads
  // through, so accepting them would store a value that comes back misaligned.
  if (/[|\r\n]/.test(trimmed)) {
    throw badRequest('sosmed cannot contain the characters | or a line break');
  }
  // http(s) only. A protocol-relative '//evil.tld' is rejected too: it resolves
  // to another origin and would navigate the user off-site.
  if (!/^https?:\/\/[^\s/$.?#][^\s]*$/i.test(trimmed)) {
    throw badRequest('sosmed must be an absolute http:// or https:// URL');
  }
  return trimmed;
}

/**
 * Validate the WhatsApp number.
 *
 * STORED AS TYPED, digits and all. The user types what is on the business card
 * — '+62 812-3456-7890' — and having them strip the '+' to satisfy a numeric
 * column is the kind of friction that gets the field left blank. The number is
 * validated here only as TEXT; interpreting it as a dialled number is the
 * CLIENT's job when it builds the wa.me link, and that is the single place the
 * digits are ever parsed (see waLinkDigits in public/index.html).
 *
 * The character class is a WHITELIST rather than a black list, so a paste of
 * "wa.me/6281234567890" or "+62 (812) 3456 7890" is rejected with a clear
 * message instead of being silently mangled into a different number than the
 * one the user meant to save. Stored as typed either way; this only decides
 * whether we accept it.
 *
 * @returns {string|null} the number, '' meaning "explicitly cleared", or null
 *   when the field is absent (leave the column alone).
 * @throws {Error} with `status = 400`.
 */
function normalizeWhatsapp(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return normalizeWhatsapp(String(value));
  if (typeof value !== 'string') throw badRequest('whatsapp must be a string');
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (trimmed.length > MAX_WHATSAPP_LENGTH) {
    throw badRequest(`whatsapp accepts at most ${MAX_WHATSAPP_LENGTH} characters`);
  }
  if (/[|\r\n]/.test(trimmed)) {
    throw badRequest('whatsapp cannot contain the characters | or a line break');
  }
  // Digits, and only the punctuation a phone number is actually written with.
  // Letters are excluded, which is what rejects a pasted wa.me URL.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) {
    throw badRequest('whatsapp must be a phone number — digits only, optionally with +, spaces, dashes, dots or brackets');
  }
  // A number with no digits at all is not a number. Checked on the STRIPPED
  // form rather than with a length test, because '+' with brackets and spaces
  // is long but empty of information.
  if (!/\d/.test(trimmed)) {
    throw badRequest('whatsapp must contain at least one digit');
  }
  return trimmed;
}

// ============================================================================
// GET /api/makers - List makers with filtering and pagination
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // `makerType` is a closed enum here (unlike props' free-text `category`),
    // so it is allowlisted outright: an unknown type is a client error, not a
    // search for rows that cannot exist.
    const makerType = enumParam(req.query.makerType, MAKER_TYPES, 'makerType');
    // Free text, type-checked, length-capped and escaped like every other.
    const search = textParam(req.query.search, { name: 'search', maxLength: MAX_MAKER_NAME_LENGTH });

    // Pagination: page (1-based), limit (10, 25, 50) — the same allowlist the
    // other three list routes use, so the client paging control is uniform.
    const pageNum = Math.max(1, parseInt(req.query.page) || 1);
    const limitNum = [10, 25, 50].includes(parseInt(req.query.limit)) ? parseInt(req.query.limit) : 25;
    const offset = (pageNum - 1) * limitNum;

    // LIKE WILDCARDS ARE PRESERVED deliberately, exactly as costumes.js does:
    // '%' and '_' keep their "matches anything" meaning. That is LIKE
    // semantics, not an injection — it cannot widen access beyond rows the
    // caller could already list.
    let where = '1=1';
    if (makerType) where += ` AND makerType = ${esc(makerType)}`;
    if (search) where += ` AND name LIKE ${esc(`%${search}%`)}`;

    const countSql = `SELECT COUNT(*) FROM "Maker" WHERE ${where};`;
    const countResult = await queryDb(countSql);
    const totalCount = parseInt(countResult, 10) || 0;

    // SELECT * so the parse order is the table's own column order. ORDER BY is
    // a hard-coded column name — nothing user-supplied reaches an identifier
    // position anywhere in this file, which is the only correct way to handle
    // ORDER BY, since no escaping makes an identifier safe.
    const sql = `SELECT * FROM "Maker" WHERE ${where} ORDER BY name ASC LIMIT ${limitNum} OFFSET ${offset};`;
    const result = await queryDb(sql);
    const makers = parseSqlResult(result, MAKER_COLUMNS);

    res.json({
      count: makers.length,
      totalCount: totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(totalCount / limitNum),
      makers: makers,
      // The enum is sent on every list response for the same reason props.js
      // sends `categories`: the filter <select> and the type badge are built
      // from ONE list, so a new type cannot be added to the API and forgotten
      // in the UI.
      makerTypes: MAKER_TYPES,
      makerTypeLabels: MAKER_TYPE_LABELS
    });
  } catch (error) {
    // A rejected filter is a 400, not a server fault — the enumParam 400 above
    // would otherwise be flattened into a 500, which both misreports the
    // failure and leaks the validator message as a server error.
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// GET /api/makers/:id - Get single maker
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id);

    // A :id that cannot be a real row id is reported as "not found" rather
    // than rejected, so GET/PUT/DELETE keep the contract the other routes have.
    const result = id === null ? '' : await queryDb(
      `SELECT * FROM "Maker" WHERE id = ${esc(id)} LIMIT 1;`
    );

    if (!result) return res.status(404).json({ error: 'Maker not found' });

    const maker = parseSqlResult(result, MAKER_COLUMNS)[0];
    res.json(maker);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/makers - Create new maker
// ============================================================================
// CONTRACT
//   name       string <= 120   required
//   makerType  enum            required, one of MAKER_TYPES
//   sosmed     http(s) URL     optional, '' clears it to NULL
//   whatsapp   phone number    optional, stored as typed, '' clears it to NULL
//   notes      string <= 2000  optional
router.post('/', async (req, res) => {
  try {
    const { name, makerType, sosmed, whatsapp, notes } = req.body || {};

    if (!name || !makerType) {
      return res.status(400).json({ error: 'name and makerType are required' });
    }

    const normalizedName = textParam(name, { name: 'name', maxLength: MAX_MAKER_NAME_LENGTH, noSeparator: true });
    const normalizedType = enumParam(makerType, MAKER_TYPES, 'makerType');
    const normalizedSosmed = normalizeSosmedUrl(sosmed);
    const normalizedWhatsapp = normalizeWhatsapp(whatsapp);
    const normalizedNotes = textParam(notes, { name: 'notes', maxLength: MAX_MAKER_NOTES_LENGTH, noSeparator: true });

    if (!normalizedName) {
      return res.status(400).json({ error: 'name and makerType are required' });
    }
    // enumParam returns null for an absent value, and the guard above only
    // catches a falsy one — so '0' or 'false' would arrive here as a non-empty
    // string that is not in the set, which enumParam already rejected. This is
    // the remaining case: a present-but-empty type.
    if (!normalizedType) {
      return res.status(400).json({ error: 'makerType is required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    const sql = `INSERT INTO "Maker" (id, name, makerType, sosmed, whatsapp, notes, createdAt, updatedAt)
                 VALUES (${esc(id)}, ${esc(normalizedName)}, ${esc(normalizedType)}, ${normalizedSosmed ? esc(normalizedSosmed) : 'NULL'}, ${normalizedWhatsapp ? esc(normalizedWhatsapp) : 'NULL'}, ${normalizedNotes ? esc(normalizedNotes) : 'NULL'}, ${esc(now)}, ${esc(now)});`;

    await queryDb(sql);

    res.status(201).json({
      id,
      name: normalizedName,
      makerType: normalizedType,
      sosmed: normalizedSosmed || null,
      whatsapp: normalizedWhatsapp || null,
      notes: normalizedNotes || null,
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
// PUT /api/makers/:id - Update maker
// ============================================================================
// CONTRACT (the edit modal in public/index.html submits exactly these keys)
//   name       string <= 120
//   makerType  enum
//   sosmed     http(s) URL
//   whatsapp   phone number
//   notes      string <= 2000
// Absent, null or '' for the optional fields means "leave the column alone" —
// except on an EMPTY STRING, which CLEARS the column to NULL. Presence is
// decided on the KEY (textUpdate), not on whether the trimmed value is non-empty:
// gating on `!== null` made a user-cleared input indistinguishable from an
// untouched one, so clearing the field silently kept the old text.
//
// `makerType` is NOT clearable. A maker with no type cannot be filed, and the
// Corner's whole organising axis is the type — so an empty one is a caller error
// and stays a 400, exactly as `name` and props' `category` do.
//
// A body in which every field is absent is a 400, matching costumes.js and
// props.js.
router.put('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';
    const body = req.body || {};

    const normalizedName = textParam(body.name, { name: 'name', maxLength: MAX_MAKER_NAME_LENGTH, noSeparator: true });
    const normalizedType = enumParam(body.makerType, MAKER_TYPES, 'makerType');
    const normalizedSosmed = normalizeSosmedUrl(body.sosmed);
    const normalizedWhatsapp = normalizeWhatsapp(body.whatsapp);
    const normalizedNotes = textParam(body.notes, { name: 'notes', maxLength: MAX_MAKER_NOTES_LENGTH, noSeparator: true });

    // `makerType` needs the same presence check as `name`: enumParam maps an
    // absent value to null, so a request that deliberately sends
    // `makerType: ""` to clear it must be rejected rather than quietly skipped.
    if (textUpdate(body, 'name') && !normalizedName) {
      throw badRequest('name cannot be empty');
    }
    if (textUpdate(body, 'makerType') && !normalizedType) {
      throw badRequest('makerType cannot be empty');
    }

    const updates = [];
    if (textUpdate(body, 'name')) updates.push(`name = ${esc(normalizedName)}`);
    if (textUpdate(body, 'makerType')) updates.push(`makerType = ${esc(normalizedType)}`);
    // The two optionals are the ones that CAN be cleared, so they are pushed on
    // the KEY's presence and the empty string becomes NULL. A maker's whole
    // purpose here is to be reachable, so "contact removed" is a meaningful
    // state rather than "unknown".
    if (textUpdate(body, 'sosmed')) {
      updates.push(`sosmed = ${normalizedSosmed ? esc(normalizedSosmed) : 'NULL'}`);
    }
    if (textUpdate(body, 'whatsapp')) {
      updates.push(`whatsapp = ${normalizedWhatsapp ? esc(normalizedWhatsapp) : 'NULL'}`);
    }
    if (textUpdate(body, 'notes')) {
      updates.push(`notes = ${normalizedNotes ? esc(normalizedNotes) : 'NULL'}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    }

    updates.push(`updatedAt = ${esc(new Date().toISOString())}`);

    const sql = `UPDATE "Maker" SET ${updates.join(', ')} WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ id, message: 'Maker updated successfully', updatedFields: body });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// DELETE /api/makers/:id - Delete maker
// ============================================================================
router.delete('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';
    const sql = `DELETE FROM "Maker" WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ id, message: 'Maker deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Exported alongside the router so the list, the API response and the form's
// <select> are all built from one list — the same reason costumes.js exports
// its normalizers.
router.MAKER_TYPES = MAKER_TYPES;
router.MAKER_TYPE_LABELS = MAKER_TYPE_LABELS;
// MAKER_COLUMNS is exported for the same reason, and more importantly: it is the
// one array that has to match TWO other hand-written lists (init_db.sql and the
// CREATE in db.js). scripts/test_makers.js compares all three against PRAGMA
// table_info, so a reordering cannot reach the running database unnoticed.
router.MAKER_COLUMNS = MAKER_COLUMNS;

module.exports = router;
