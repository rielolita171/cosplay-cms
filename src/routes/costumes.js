const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { esc, enumParam, textParam, textUpdate, numberParam, idParam, collapseWhitespace } = require('../services/sqlSafety');
const { DB_FILE } = require('../services/db');

// Helper function to execute SQL queries
async function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', [DB_FILE]);
    let output = '';
    
    sqlite.stdout.on('data', (data) => { output += data; });
    sqlite.stderr.on('data', (data) => { reject(new Error(data.toString())); });
    
    sqlite.stdin.write(sql);
    sqlite.stdin.end();
    
    sqlite.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`SQLite exited with code ${code}`));
      }
    });
  });
}

// Full column list of the "Costume" table (see init_db.sql / live schema).
// Every SELECT in this file is `SELECT *`, so the parse order MUST match this
// list exactly — an omission here silently blanks the field in the UI.
const COSTUME_COLUMNS = [
  'id', 'fandom', 'character', 'brand', 'size', 'isFullset',
  'doneCostest', 'doneEvent', 'donePhotoSession', 'status',
  'buyPrice', 'sellPrice', 'sellPriceMutual',
  'notes', 'referenceUrl', 'imageUrls', 'createdAt', 'updatedAt'
];

// Parse SQLite output into objects
function parseSqlResult(output, columns) {
  if (!output) return [];
  const rows = output.split('\n');
  return rows.map(row => {
    const values = row.split('|');
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = values[i];
    });
    return obj;
  });
}

/**
 * The distinct Fandom and Brand values in the collection, for the two filter
 * dropdowns.
 *
 * WHY THIS IS A QUERY AND NOT DERIVED FROM THE RETURNED ROWS
 * The dashboard paged this list, so `costumes` is one page — 25 rows out of 86
 * on the live database. Deriving the dropdowns from those rows (which the
 * client did before paging existed) would offer only the fandoms that happen to
 * sort into page 1, and a filter for any other fandom would be missing from the
 * control that is supposed to provide it. The dropdown is a property of the
 * COLLECTION, exactly like statusCounts, and so is computed from the whole
 * table.
 *
 * UNFILTERED, like statusCounts and for the same reason: a dropdown that
 * emptied itself as you typed in the search box would be a control the user
 * could not reason about.
 *
 * Blank and NULL values are dropped. The two are indistinguishable once they
 * have been through this project's pipe transport — a SQL NULL arrives as the
 * empty string — so both are skipped by the same test, and neither can produce
 * a blank <option>.
 *
 * Case-insensitive de-duplication: 'Blue Archive' and 'blue archive' are one
 * value to a person reading a dropdown, and offering both would be a filter
 * that appears to do nothing when picked. The FIRST spelling encountered is
 * the one kept, which for an ORDER BY means the value is shown as the
 * alphabetically-first casing rather than as whatever the newest row says.
 */
async function distinctCostumeValues() {
  const result = await queryDb(
    `SELECT DISTINCT fandom FROM "Costume" WHERE fandom IS NOT NULL AND TRIM(fandom) <> '';`
  );
  const brands = await queryDb(
    `SELECT DISTINCT brand FROM "Costume" WHERE brand IS NOT NULL AND TRIM(brand) <> '';`
  );
  // parseSqlResult on a single-column result gives [{fandom: 'x'}, ...].
  const collect = (output, column) => {
    const seen = new Map();
    parseSqlResult(output, [column]).forEach(row => {
      const label = String(row[column] == null ? '' : row[column]).trim();
      if (!label) return;
      const key = label.toLowerCase();
      if (!seen.has(key)) seen.set(key, label);
    });
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  };
  return { fandoms: collect(result, 'fandom'), brands: collect(brands, 'brand') };
}

// ============================================================================
// Field validators
// ============================================================================
// "Costume".imageUrls is TEXT holding a JSON array of strings (init_db.sql:
// `imageUrls TEXT DEFAULT '[]'`). The dashboard sends it as a JSON *string*
// (`JSON.stringify(urls)`), so a raw array is also tolerated and re-serialised
// here. Anything that is not a JSON array of strings is rejected outright —
// writing a half-parsed or object-shaped value into that column is what makes
// the thumbnail render as raw text in the UI.
const MAX_IMAGE_URLS = 20;
const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_NOTES_LENGTH = 2000;

/**
 * Validate an incoming `imageUrls` value.
 * @returns {string|null} the canonical JSON string to persist, or null when the
 *   field is absent (null === "leave the column alone").
 * @throws {Error} with `status = 400` when the value is malformed.
 */
function normalizeImageUrls(value) {
  if (value === undefined || value === null) return null;

  let urls;
  if (Array.isArray(value)) {
    urls = value;
  } else if (typeof value === 'string') {
    if (value.length > MAX_IMAGE_URLS * (MAX_IMAGE_URL_LENGTH + 8)) {
      throw Object.assign(new Error('imageUrls payload is too large'), { status: 400 });
    }
    try {
      urls = JSON.parse(value);
    } catch (parseError) {
      throw Object.assign(new Error('imageUrls must be a JSON array of strings'), { status: 400 });
    }
  } else {
    throw Object.assign(new Error('imageUrls must be a JSON array of strings'), { status: 400 });
  }

  if (!Array.isArray(urls)) {
    throw Object.assign(new Error('imageUrls must be a JSON array of strings'), { status: 400 });
  }
  if (urls.length > MAX_IMAGE_URLS) {
    throw Object.assign(new Error(`imageUrls accepts at most ${MAX_IMAGE_URLS} entries`), { status: 400 });
  }
  for (const url of urls) {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_IMAGE_URL_LENGTH) {
      throw Object.assign(new Error('imageUrls entries must be non-empty strings of at most '
        + `${MAX_IMAGE_URL_LENGTH} characters`), { status: 400 });
    }
  }

  return JSON.stringify(urls);
}

// The four statuses the dashboard's edit form and filter bar understand. A PUT
// carrying anything else must be rejected with 400 rather than written, otherwise
// an arbitrary string lands in the "status" column and the card badge (which
// derives its CSS class from that value) breaks for every other row.
const COSTUME_STATUSES = ['IN_POSSESSION', 'ON_RENT', 'TO_BE_SOLD', 'WISHLIST'];

// Field caps for the GET filters and for the free-text columns that used to be
// interpolated unvalidated. MAX_REFERENCE_NAME_LENGTH (brand / fandom, enforced
// on write at normalizeReferenceName) is the right cap for the matching *filter*
// too: a substring of a stored name is never longer than the name itself, so it
// never rejects a filter that could have matched a row.
const MAX_CHARACTER_LENGTH = 120;
const MAX_REFERENCE_URL_LENGTH = 2048;

/**
 * Validate an incoming `status` value.
 * @returns {string|null} the value to persist, or null when the field is absent.
 * @throws {Error} with `status = 400` when the value is not one of the enum.
 */
function normalizeStatus(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || COSTUME_STATUSES.indexOf(value) === -1) {
    throw Object.assign(
      new Error('status must be one of ' + COSTUME_STATUSES.join(', ')),
      { status: 400 }
    );
  }
  return value;
}

/** Cap `notes` so an unbounded blob cannot be written into the TEXT column. */
function normalizeNotes(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('notes must be a string'), { status: 400 });
  }
  if (value.length > MAX_NOTES_LENGTH) {
    throw Object.assign(new Error(`notes accepts at most ${MAX_NOTES_LENGTH} characters`), { status: 400 });
  }
  return value;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------
// "Costume".buyPrice / sellPrice / sellPriceMutual are REAL columns
// (`REAL DEFAULT NULL` in init_db.sql) that the cards render — but until now
// neither POST nor PUT accepted them, so a price could be imported straight into
// the column by the Excel script and could never be typed in the dashboard.
//
// VALIDATION
//   accepted : a JSON number, or a string that Number() parses strictly —
//             1500, '1500', '1500.50', ' 1500 ' are all fine.
//   rejected : anything Number() cannot parse ('abc', '1,500', '1e'), NaN,
//             Infinity, negatives, and anything above MAX_PRICE. All 400.
//   blank    : '', null and undefined mean "absent" — leave the column alone on
//             PUT, store NULL on POST. A price is never silently coerced to 0.
//
// PRECISION — ROUNDED TO 2 DECIMAL PLACES
// The column is REAL (an IEEE double), so storing the parsed double verbatim
// would let binary rounding noise reach the card. Every accepted value is
// therefore rounded with Math.round(v * 100) / 100 before it is written, and
// the rounded value is what comes back on GET. Two decimals is chosen over
// "store exactly what was sent" because a money column that can hold 17
// significant digits is a bug waiting to happen, and over "round to whole
// rupiah" because the schema is generic and sellPriceMutual is often a
// negotiated fraction of a partner's price. MAX_PRICE additionally keeps the
// interpolated literal a sane number of digits.
const MAX_PRICE = 1e12;
const PRICE_PRECISION = 2;

/**
 * Validate an incoming money value.
 * @returns {number|null} the rounded value, or null when the field is absent.
 * @throws {Error} with `status = 400`.
 */
function normalizePrice(value, field) {
  if (value === undefined || value === null) return null;
  // A whitespace-only string must be treated as BLANK, not as a number. It is
  // not caught by the `=== ''` test above, and Number(''.trim()) is 0 — so
  // without this line `"buyPrice": "   "` would silently write 0 into the column
  // instead of meaning "no price given". (Found by the scratch-port tests.)
  if (typeof value === 'string' && value.trim() === '') return null;
  if (value === '') return null;
  const parsed = numberParam(value, { name: field, min: 0, max: MAX_PRICE });
  const factor = Math.pow(10, PRICE_PRECISION);
  return Math.round(parsed * factor) / factor;
}

// ---------------------------------------------------------------------------
// Size
// ---------------------------------------------------------------------------
// "Costume".size used to be free text. It is now a fixed enum for NEW/edited
// entries, enforced exactly like `status` above: anything outside the list is
// rejected with 400 BEFORE any SQL runs.
//
// THE ESCAPE HATCH, AND WHY THE COLUMN STILL HAS NO CHECK CONSTRAINT
// Existing rows may legitimately hold a bespoke value ("One Size", "Free Size",
// a custom measurement). A SQLite CHECK constraint would make those rows
// unwritable — the user could never re-save such a costume, because any UPDATE
// touching that row would fail. So instead:
//   * `size`    must be one of COSTUME_SIZES (case-insensitively) -> 400 otherwise.
//   * `sizeOther` is the explicit, labelled opt-out: a non-empty free-text
//     string stored verbatim in the same `size` column.
//   * Supplying both, or neither-and-a-blank-other, is a 400.
// Legacy out-of-enum values are therefore PRESERVED UNTOUCHED by the migration
// and still render; the enum is only enforced going forward. On boot,
// src/services/db.js:reportSizeEnumDrift() logs how many such rows exist so the
// drift is visible rather than silent.
const COSTUME_SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'];
const MAX_SIZE_OTHER_LENGTH = 40;

/**
 * Resolve the incoming `size` / `sizeOther` pair to the string to persist.
 * @returns {{persist: boolean, value: string|null}} `persist:false` means "field
 *   absent — leave the column alone"; `value:null` means "explicitly clear it".
 * @throws {Error} with `status = 400`.
 */
function normalizeSize(size, sizeOther) {
  const hasSize = size !== undefined && size !== null && size !== '';
  const hasOther = sizeOther !== undefined && sizeOther !== null && sizeOther !== '';

  if (hasSize && hasOther) {
    throw Object.assign(
      new Error('Send either size (one of ' + COSTUME_SIZES.join(', ') + ') or sizeOther, not both'),
      { status: 400 }
    );
  }

  if (hasOther) {
    if (typeof sizeOther !== 'string') {
      throw Object.assign(new Error('sizeOther must be a string'), { status: 400 });
    }
    const trimmed = sizeOther.trim();
    if (trimmed === '') return { persist: false, value: null };
    if (trimmed.length > MAX_SIZE_OTHER_LENGTH) {
      throw Object.assign(
        new Error(`sizeOther accepts at most ${MAX_SIZE_OTHER_LENGTH} characters`),
        { status: 400 }
      );
    }
    return { persist: true, value: trimmed };
  }

  if (!hasSize) return { persist: false, value: null };

  if (typeof size !== 'string') {
    throw Object.assign(new Error('size must be a string'), { status: 400 });
  }
  const canonical = size.trim().toUpperCase();
  if (COSTUME_SIZES.indexOf(canonical) === -1) {
    throw Object.assign(
      new Error('size must be one of ' + COSTUME_SIZES.join(', ')
        + ' (or use "sizeOther" for a custom measurement)'),
      { status: 400 }
    );
  }
  return { persist: true, value: canonical };
}

// ---------------------------------------------------------------------------
// Brand / Fandom (soft references into the managed lists)
// ---------------------------------------------------------------------------
// "Costume".brand / .fandom hold the NAME of a "Brand" / "Fandom" row (see the
// header comment in init_db.sql). A name that is not yet in the managed list is
// AUTO-CREATED rather than rejected, for three reasons:
//   1. It makes the endpoint lossless for existing clients — scripts/test_phase5.js
//      POSTs `{fandom: 'Phase5Test'}` and n8n/import flows do the same, and a
//      400 there would be a regression.
//   2. It cannot lose data: the value the user typed is what gets stored, and the
//      list is a strict superset of the costumes' values.
//   3. The alternative (reject) pushes list management onto the UI for no
//      safety gain, because the value is already length- and charset-checked.
const MAX_REFERENCE_NAME_LENGTH = 120;

/**
 * Validate a brand/fandom name that is about to be written onto a costume.
 * @returns {{value: string, lower: string}|null} null means "clear the column".
 * @throws {Error} with `status = 400`.
 */
function normalizeReferenceName(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error(`${field} must be a string`), { status: 400 });
  }
  // Whitespace is collapsed BEFORE the length check and BEFORE nameLower is
  // derived, so "blue  archive" and "blue archive" are the same reference and
  // the UNIQUE nameLower index makes the second one collide with the first. The
  // same collapse is applied by brands.js / fandoms.js and by the boot backfill
  // in db.js, so the costume side and the managed-list side can never disagree.
  const trimmed = collapseWhitespace(value);
  if (trimmed === '') return null;
  if (trimmed.length > MAX_REFERENCE_NAME_LENGTH) {
    throw Object.assign(
      new Error(`${field} accepts at most ${MAX_REFERENCE_NAME_LENGTH} characters`),
      { status: 400 }
    );
  }
  // '|' and newlines would be split by the sqlite3 CLI pipe transport on read.
  // A bare '|' survives collapseWhitespace (it is not whitespace) and must still
  // be rejected here; a line break never reaches this point because collapse
  // already turned it into a space.
  if (trimmed.indexOf('|') !== -1) {
    throw Object.assign(
      new Error(`${field} cannot contain the character |`),
      { status: 400 }
    );
  }
  return { value: trimmed, lower: trimmed.toLowerCase() };
}

/**
 * Ensure a "Brand"/"Fandom" row exists for this name, inserting it when missing.
 * INSERT OR IGNORE off the UNIQUE nameLower index makes this safe under the
 * concurrent-write races this CLI transport cannot lock against.
 */
async function ensureReferenceRow(table, name) {
  await queryDb(
    `INSERT OR IGNORE INTO "${table}" (id, name, nameLower, createdAt, updatedAt)
     VALUES (${esc(require('crypto').randomUUID())}, ${esc(name.value)}, ${esc(name.lower)},
             ${esc(new Date().toISOString())}, ${esc(new Date().toISOString())});`
  );
}

// ============================================================================
// GET /api/costumes - List all costumes with optional filtering and pagination
// ============================================================================
router.get('/', async (req, res) => {
  try {
    // Every filter is validated and escaped BEFORE the statement is assembled.
    // `status` is a closed enum (the same list POST/PUT enforce on write), so it
    // is allowlisted outright: an unknown status is a client error, not a search
    // for rows that cannot exist. `fandom` / `brand` are free text, so they are
    // type-checked, length-capped, and escaped for the string-literal position.
    //
    // LIKE WILDCARDS ARE DELIBERATELY PRESERVED: `%` and `_` inside a filter keep
    // their pre-existing "matches anything" meaning. That is LIKE semantics, not
    // an injection — it cannot widen access beyond rows the caller could already
    // list, and changing it would alter a documented filter behaviour.
    // `filters` echoes back exactly what the caller sent, unchanged.
    const { fandom: rawFandom, status: rawStatus, brand: rawBrand, search: rawSearch, page, limit } = req.query;
    const fandom = textParam(rawFandom, { name: 'fandom', maxLength: MAX_REFERENCE_NAME_LENGTH });
    const status = enumParam(rawStatus, COSTUME_STATUSES, 'status');
    const brand = textParam(rawBrand, { name: 'brand', maxLength: MAX_REFERENCE_NAME_LENGTH });
    // FREE-TEXT SEARCH. Added because the dashboard filters the costume list
    // SERVER-SIDE: with paging on, filtering the returned rows in the browser
    // would only ever search the 25 rows of the current page, so a costume on
    // page 4 would be unfindable by name. The same reasoning the status and
    // fandom filters already follow.
    const search = textParam(rawSearch, { name: 'search', maxLength: MAX_REFERENCE_NAME_LENGTH });

    // Pagination: page (1-based), limit (10, 25, 50) or the literal "all".
    //
    // "ALL" IS A REAL OPTION, NOT JUST A BIGGER NUMBER. The three sizes exist
    // so a long collection need not be rendered at once; they are not a cap on
    // how many rows the caller may see. A few hundred rows render perfectly
    // well in one go, and making someone click through four pages to look at a
    // list of their own things is a worse default than a longer page.
    //
    // It is a WORD rather than a large integer on purpose. `limit=1000000`
    // would be a denial of service delivered by a query string, and this server
    // authenticates nobody. Spelling the unlimited case out means the statement
    // below is always one of four fixed strings.
    const pageNum = Math.max(1, parseInt(page) || 1);
    const wantsAll = String(limit).trim().toLowerCase() === 'all';
    const limitNum = wantsAll
      ? null
      : ([10, 25, 50].includes(parseInt(limit)) ? parseInt(limit) : 25);
    const offset = limitNum === null ? 0 : (pageNum - 1) * limitNum;

    let where = '1=1';
    // The LIKE pattern is escaped as ONE string literal (esc() wraps and quotes
    // it), rather than pasting an escaped body between hand-written quotes.
    if (fandom) where += ` AND fandom LIKE ${esc(`%${fandom}%`)}`;
    if (status) where += ` AND status = ${esc(status)}`;
    if (brand) where += ` AND brand LIKE ${esc(`%${brand}%`)}`;
    // One LIKE over three columns, not three separate parameters: the search box
    // is ONE field and "blue" should find a Blue Archive costume whether the
    // word landed in the fandom, the character or the brand. Each `%term%` is
    // escaped individually and OR-ed, so a term containing a quote is data.
    if (search) {
      const like = `%${search}%`;
      where += ` AND (character LIKE ${esc(like)} OR fandom LIKE ${esc(like)} OR brand LIKE ${esc(like)})`;
    }

    // SELECT * so the list endpoint returns every column the dashboard cards
    // render (doneCostest, doneEvent, donePhotoSession, referenceUrl, imageUrls,
    // notes, prices, ...). A narrow column list here was the cause of blank cards.
    //
    // ORDER BY is a hard-coded column name. Nothing user-supplied reaches an
    // identifier position anywhere in this file, which is the only correct way to
    // handle ORDER BY — there is no escaping that makes an identifier safe.
    const countSql = `SELECT COUNT(*) FROM "Costume" WHERE ${where};`;
    const countResult = await queryDb(countSql);
    const totalCount = parseInt(countResult, 10) || 0;

    // COLLECTION WORTH — the sum of every owned costume's buy price.
    //
    // DELIBERATELY NOT FILTERED. The card this feeds is a property of the
    // collection, not of the current search: the number would otherwise drop to
    // Rp 0 the moment `status=WISHLIST` was applied (no wishlist entry is also
    // IN_POSSESSION), which reads as a broken widget rather than as a filtered
    // total. It also cannot be summed from the returned rows, because those are
    // one PAGE of a paged query — that would make the total silently mean
    // "worth of page 1" and change as the user pages through.
    //
    // `COALESCE(..., 0)` so an empty wardrobe is 0 rather than NULL, and
    // `COUNT(buyPrice)` so a costume with no price recorded is not silently
    // counted as a priced one — the sub-line under the card reports how many
    // rows actually contributed, which is what makes the number auditable.
    // PER-STATUS COUNTS — one row per status, for the Wishlist tab's badge.
    //
    // UNFILTERED AND UNPAGED, for the same reason the worth total above is: the
    // number on a tab badge is a property of the collection, not of whatever
    // search is currently in the box. Counting the returned rows would make the
    // badge mean "wishlist entries on page 1 of the current search" — a number
    // that changes when you type and when you page, on a badge whose whole job
    // is to tell you whether anything is waiting there.
    //
    // GROUP BY rather than four separate COUNTs: one round-trip over the pipe
    // instead of four, and a status with no rows simply does not appear rather
    // than needing a hard-coded zero for each.
    const countsSql = `SELECT status, COUNT(*) FROM "Costume" GROUP BY status;`;
    const countsResult = await queryDb(countsSql);

    // FULLSET COUNT — for the "N fullset ready" sub-line on the Total Costumes
    // card, and the reason it needed its own query rather than being counted in
    // the browser.
    //
    // The dashboard counted it as `state.costumes.filter(isFullset).length`,
    // which is correct only while the whole collection is loaded. Under paging
    // that would silently mean "fullsets among the 25 rows on this page", and
    // the number would change as the user paged through a card that claims to
    // be about the collection. Same for the other two count cards — see
    // updateMetrics() on the client.
    //
    // `isFullset` is an INTEGER 0/1 column (verified against the live schema),
    // so `= 1` matches exactly what the client's toBool() treats as true. The
    // loose form (`!= 0 AND IS NOT NULL`) was rejected: it would also count the
    // string 'true', which no writer in this codebase produces but which a
    // future import might, and then the two halves of the check would disagree.
    const fullsetResult = await queryDb(
      `SELECT COUNT(*) FROM "Costume" WHERE isFullset = 1;`
    );
    const fullsetCount = parseInt(fullsetResult, 10) || 0;
    // Pre-seeded to zero so the client's `statusCounts.X` is never `undefined`
    // for a status that currently has no rows — `undefined` would make a
    // "0" and a "not sent yet" indistinguishable on the badge.
    const statusCounts = {};
    COSTUME_STATUSES.forEach(s => { statusCounts[s] = 0; });
    parseSqlResult(countsResult, ['status', 'rowCount']).forEach(row => {
      // A NULL status cannot survive the pipe this file reads rows through —
      // it arrives as an empty string — so an empty key is skipped rather than
      // given a `"": n` entry the client would then have to special-case.
      const key = String(row.status == null ? '' : row.status).trim();
      const count = parseInt(row.rowCount, 10);
      if (!key || isNaN(count)) return;
      // A status the server does not know (a row written by a newer build) is
      // still counted rather than dropped — the badge would otherwise
      // under-report, and the alternative is refusing to show a real row.
      statusCounts[key] = count;
    });

    const worthSql = `
      SELECT COALESCE(SUM(buyPrice), 0), COUNT(buyPrice)
      FROM "Costume"
      WHERE status = ${esc('IN_POSSESSION')} AND buyPrice IS NOT NULL;`;
    const worthResult = await queryDb(worthSql);
    const worthRow = parseSqlResult(worthResult, ['totalBuyPrice', 'countedCostumes'])[0] || {};
    // Both come back as STRINGS (this transport pipes sqlite3 output), and the
    // sum is a float accumulation over a REAL column, so it is rounded to the
    // same 2 decimals a single price is stored at rather than printed with the
    // binary rounding noise of a partial sum.
    const totalBuyPrice = Math.round(Number(worthRow.totalBuyPrice) * 100) / 100 || 0;
    const countedCostumes = parseInt(worthRow.countedCostumes, 10) || 0;

    // LIMIT/OFFSET are OMITTED ENTIRELY for `limit=all` rather than
    // interpolated as a huge number. `limitNum` is null or one of three
    // hard-coded integers, so `paging` is always one of four fixed strings and
    // nothing user-supplied reaches it.
    const paging = limitNum === null ? '' : ` LIMIT ${limitNum} OFFSET ${offset}`;
    const sql = `SELECT * FROM "Costume" WHERE ${where} ORDER BY character ASC${paging};`;

    const result = await queryDb(sql);
    const costumes = parseSqlResult(result, COSTUME_COLUMNS);
    
    res.json({
      count: costumes.length,
      totalCount: totalCount,
      page: pageNum,
      // `limit` echoes the word back, so the client's <select> can keep showing
      // "All" instead of silently reverting to a number the API never honoured.
      // `page` is forced to 1 under `all`: there is only one page, and
      // echoing back the page 3 that was asked for would have the client
      // briefly render "page 3 of 1" before it clamped.
      page: wantsAll ? 1 : pageNum,
      limit: wantsAll ? 'all' : limitNum,
      totalPages: limitNum === null
        ? (totalCount > 0 ? 1 : 0)
        : Math.ceil(totalCount / limitNum),
      costumes: costumes,
      // Page-independent, filter-independent. The client falls back to summing
      // the rows it holds when this is absent, which is what a cached response
      // from before this field existed will look like.
      totals: { totalBuyPrice, countedCostumes },
      statusCounts: statusCounts,
      // Whole-collection, filter- AND page-independent. Every number on a
      // metric card is a property of the collection, so none of them is
      // derived from the rows that happen to be on the current page. The total
      // is the SUM of the per-status counts rather than a second COUNT(*), so
      // the "Total Costumes" card and the Wishlist badge can never disagree
      // about how many costumes exist — two independent counts of one table is
      // one more thing that can drift.
      collectionStats: {
        totalCostumes: Object.keys(statusCounts).reduce((sum, k) => sum + statusCounts[k], 0),
        fullsetCount: fullsetCount
      },
      filterOptions: await distinctCostumeValues(),
      filters: { fandom: rawFandom, status: rawStatus, brand: rawBrand, search: search }
    });
  } catch (error) {
    // A rejected filter is a client error. Without this, the enum/length 400s
    // raised above would be flattened into a 500, which both misreports the
    // failure and leaks the validator message as a server fault.
    const status = error.status || 500;
    res.status(status).json({
      error: error.message,
      code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR'
    });
  }
});

// ============================================================================
// GET /api/costumes/:id - Get single costume with props
// ============================================================================
router.get('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id);

    // A `:id` that cannot be a real row id is reported as "not found" rather than
    // rejected, so GET/PUT/DELETE keep their existing contract (404 / 200) for an
    // unknown id. Either way the value reaches SQL only through esc().
    const result = id === null ? '' : await queryDb(
      `SELECT * FROM "Costume" WHERE id = ${esc(id)} LIMIT 1;`
    );

    if (!result) {
      return res.status(404).json({ error: 'Costume not found' });
    }

    const costume = parseSqlResult(result, COSTUME_COLUMNS)[0];

    // Calculate completion percentage
    const completion = ((costume.isFullset ? 1 : 0) + (costume.doneCostest ? 1 : 0) + (costume.doneEvent ? 1 : 0) + (costume.donePhotoSession ? 1 : 0)) / 4 * 100;
    costume.completionPercent = Math.round(completion);

    res.json(costume);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/costumes - Create new costume
// ============================================================================
router.post('/', async (req, res) => {
  try {
    const { character, fandom, brand, size, sizeOther, notes, referenceUrl,
            buyPrice, sellPrice, sellPriceMutual } = req.body;

    if (!character || !fandom) {
      return res.status(400).json({ error: 'character and fandom are required' });
    }

    // Every validator runs BEFORE the first statement, so a rejected request
    // leaves no partial row and no half-created Brand/Fandom behind.
    //
    // `character` and `referenceUrl` are validated here too. They used to go
    // straight into the INSERT: `referenceUrl` was interpolated with NO escaping
    // at all (a quote in the body broke out of the literal), and `character` was
    // escaped but neither type-checked nor length-capped, so a non-string threw
    // a TypeError and surfaced as a 500.
    const normalizedCharacter = textParam(character, {
      name: 'character', maxLength: MAX_CHARACTER_LENGTH, noSeparator: true
    });
    if (!normalizedCharacter) {
      return res.status(400).json({ error: 'character and fandom are required' });
    }
    const normalizedReferenceUrl = textParam(referenceUrl, {
      name: 'referenceUrl', maxLength: MAX_REFERENCE_URL_LENGTH, noSeparator: true
    });
    const normalizedBuyPrice = normalizePrice(buyPrice, 'buyPrice');
    const normalizedSellPrice = normalizePrice(sellPrice, 'sellPrice');
    const normalizedSellPriceMutual = normalizePrice(sellPriceMutual, 'sellPriceMutual');
    const refFandom = normalizeReferenceName(fandom, 'fandom');
    const refBrand = normalizeReferenceName(brand, 'brand');
    const resolvedSize = normalizeSize(size, sizeOther);
    const normalizedNotes = normalizeNotes(notes);
    if (normalizedNotes !== null && /[|\r\n]/.test(normalizedNotes)) {
      throw Object.assign(new Error('notes cannot contain the characters | or a line break'), { status: 400 });
    }

    // Register the referenced names in the managed lists (no-op when present).
    await ensureReferenceRow('Fandom', refFandom);
    if (refBrand) await ensureReferenceRow('Brand', refBrand);

    const id = randomUUID();
    const now = new Date().toISOString();

    // Single helper for every string-literal position, so no column is left on
    // the ad-hoc `'${x}'` path that caused the original bug.
    const sql = `INSERT INTO "Costume" (id, character, fandom, brand, size, buyPrice, sellPrice, sellPriceMutual, notes, referenceUrl, status, isFullset, createdAt, updatedAt)
                 VALUES (${esc(id)}, ${esc(normalizedCharacter)}, ${esc(refFandom.value)}, ${refBrand ? esc(refBrand.value) : 'NULL'}, ${resolvedSize.value ? esc(resolvedSize.value) : 'NULL'}, ${normalizedBuyPrice === null ? 'NULL' : normalizedBuyPrice}, ${normalizedSellPrice === null ? 'NULL' : normalizedSellPrice}, ${normalizedSellPriceMutual === null ? 'NULL' : normalizedSellPriceMutual}, ${normalizedNotes ? esc(normalizedNotes) : 'NULL'}, ${normalizedReferenceUrl ? esc(normalizedReferenceUrl) : 'NULL'}, ${esc('IN_POSSESSION')}, 0, ${esc(now)}, ${esc(now)});`;

    await queryDb(sql);

    res.status(201).json({
      id,
      character: normalizedCharacter,
      fandom: refFandom.value,
      brand: refBrand ? refBrand.value : null,
      size: resolvedSize.value,
      buyPrice: normalizedBuyPrice,
      sellPrice: normalizedSellPrice,
      sellPriceMutual: normalizedSellPriceMutual,
      status: 'IN_POSSESSION',
      isFullset: false,
      createdAt: now
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message, code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR' });
  }
});

// ============================================================================
// PUT /api/costumes/:id - Update costume
// ============================================================================
router.put('/:id', async (req, res) => {
  try {
    // Length-capped; an id that cannot be a row id becomes '' below, so the
    // UPDATE matches nothing — the same observable result as before.
    const id = idParam(req.params.id) || '';
    const { status, isFullset, doneCostest, doneEvent, donePhotoSession, notes, imageUrls,
            brand, fandom, size, sizeOther, buyPrice, sellPrice, sellPriceMutual } = req.body;

    let updates = [];

    // Rejects anything outside the enum with 400 BEFORE a single statement runs.
    const normalizedStatus = normalizeStatus(status);

    // brand / fandom / size are editable now, with the same contract as POST:
    // an unknown brand/fandom name is registered in the managed list rather than
    // rejected, and `size` must be in the XS-3XL enum unless the explicit
    // `sizeOther` escape hatch is used.
    const refBrand = normalizeReferenceName(brand, 'brand');
    const refFandom = normalizeReferenceName(fandom, 'fandom');
    const resolvedSize = normalizeSize(size, sizeOther);
    // A price is validated (and rejected with 400) even though it is optional,
    // and a null result means "leave the column alone" rather than "store NULL".
    const normalizedBuyPrice = normalizePrice(buyPrice, 'buyPrice');
    const normalizedSellPrice = normalizePrice(sellPrice, 'sellPrice');
    const normalizedSellPriceMutual = normalizePrice(sellPriceMutual, 'sellPriceMutual');
    // Column names here are literals, so only the VALUES are caller-supplied and
    // every one of them goes through esc() rather than an ad-hoc quote-doubling.
    if (refBrand) updates.push(`brand = ${esc(refBrand.value)}`);
    if (refFandom) updates.push(`fandom = ${esc(refFandom.value)}`);
    if (resolvedSize.persist) {
      updates.push(`size = ${resolvedSize.value ? esc(resolvedSize.value) : 'NULL'}`);
    }
    // The price is a NUMBER column, so it is interpolated unquoted — and it can
    // only be a number at this point, because normalizePrice() has already
    // rejected everything Number() cannot parse strictly.
    if (normalizedBuyPrice !== null) updates.push(`buyPrice = ${normalizedBuyPrice}`);
    if (normalizedSellPrice !== null) updates.push(`sellPrice = ${normalizedSellPrice}`);
    if (normalizedSellPriceMutual !== null) updates.push(`sellPriceMutual = ${normalizedSellPriceMutual}`);
    if (normalizedStatus !== null) {
      updates.push(`status = ${esc(normalizedStatus)}`);
    }
    if (isFullset !== undefined) updates.push(`isFullset = ${isFullset ? 1 : 0}`);
    if (doneCostest !== undefined) updates.push(`doneCostest = ${doneCostest ? 1 : 0}`);
    if (doneEvent !== undefined) updates.push(`doneEvent = ${doneEvent ? 1 : 0}`);
    if (donePhotoSession !== undefined) updates.push(`donePhotoSession = ${donePhotoSession ? 1 : 0}`);

    // `imageUrls` is part of the Phase 5 upload flow: the image POST returns the
    // saved URL and the dashboard then PUTs the merged list back. Omitting it
    // from this whitelist made the thumbnail survive only until a page reload.
    const normalizedImages = normalizeImageUrls(imageUrls);
    if (normalizedImages !== null) {
      updates.push(`imageUrls = ${esc(normalizedImages)}`);
    }

    const normalizedNotes = normalizeNotes(notes);
    // Presence is decided on the KEY, not on whether the value is non-empty.
    // Gating on `!== null` made a user-cleared description indistinguishable from
    // an untouched one, so clearing the field silently kept the old text.
    if (textUpdate(req.body, 'notes')) {
      updates.push(`notes = ${normalizedNotes ? esc(normalizedNotes) : 'NULL'}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update', code: 'VALIDATION_ERROR' });
    }

    updates.push(`updatedAt = ${esc(new Date().toISOString())}`);

    // Only once every field has validated: register the referenced names, so a
    // rejected request can never leave an orphan entry in the managed list.
    if (refBrand) await ensureReferenceRow('Brand', refBrand);
    if (refFandom) await ensureReferenceRow('Fandom', refFandom);

    const sql = `UPDATE "Costume" SET ${updates.join(', ')} WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({
      id,
      message: 'Costume updated successfully',
      updatedFields: req.body
    });
  } catch (error) {
    // Malformed input is a client error (400), not a server fault (500).
    const status = error.status || 500;
    res.status(status).json({ error: error.message, code: status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_ERROR' });
  }
});

// ============================================================================
// DELETE /api/costumes/:id - Delete costume
// ============================================================================
router.delete('/:id', async (req, res) => {
  try {
    const id = idParam(req.params.id) || '';

    const sql = `DELETE FROM "Costume" WHERE id = ${esc(id)};`;
    await queryDb(sql);

    res.json({ 
      id, 
      message: 'Costume deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DELETE /:id/images — remove ONE image from a costume's gallery
// ============================================================================
// WHY A DEDICATED ENDPOINT, WHEN THE FRONTEND COULD JUST PUT A SHORTER ARRAY
// The dashboard can already recompute `imageUrls` and PUT it through the
// whitelisted field, which would need no new backend at all. It was rejected
// because that leaves the file on disk forever: the row forgets the picture
// while the bytes stay in data/uploads, so deleting every image from a costume
// reclaims nothing and the directory grows without bound. Owning the removal
// here is what makes the disk actually shrink.
//
// A SECOND REASON: the unlink must be conditional. The same upload can be
// referenced by more than one costume, and removing the last mention of a
// shared URL is the ONLY point at which the file is truly garbage. So the
// cross-reference COUNT decides the unlink; skipping it would let one costume's
// delete break another's thumbnail.
router.delete('/:id/images', async (req, res) => {
  try {
    // Validate the payload BEFORE the lookup. A missing/malformed `url` is a
    // request error (400) and must not be reported as "no such costume" (404)
    // just because the id in the path is also wrong — the caller learns nothing
    // about which of the two was wrong. Ordering it this way also keeps a
    // syntactically invalid id from ever reaching the SQL layer.
    const rawUrl = req.body ? req.body.url : undefined;
    if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
      return res.status(400).json({
        error: 'url is required and must be a non-empty string',
        code: 'VALIDATION_ERROR'
      });
    }
    const url = rawUrl.trim();
    // Same bound the array entries are held to, so a caller cannot make the
    // response or the LIKE-style comparison below work on an unbounded string.
    if (url.length > MAX_IMAGE_URL_LENGTH) {
      return res.status(400).json({
        error: `url must be at most ${MAX_IMAGE_URL_LENGTH} characters`,
        code: 'VALIDATION_ERROR'
      });
    }

    const id = idParam(req.params.id) || '';

    // Read the stored array. An empty result means either "no such costume" or
    // "imageUrls IS NULL"; both are 404 for this endpoint's purposes, because
    // there is no gallery to remove anything from either way.
    const stored = await queryDb(`SELECT imageUrls FROM "Costume" WHERE id = ${esc(id)};`);
    if (!stored) {
      return res.status(404).json({ error: 'Costume not found', code: 'NOT_FOUND' });
    }

    let current;
    try {
      current = JSON.parse(stored);
    } catch (parseError) {
      // The column is TEXT holding a JSON array, so an unparseable value is
      // corrupt data, not a bad request. Surfacing it as 500 (rather than
      // silently overwriting the column with a fresh array) means the operator
      // finds out instead of losing whatever the column was meant to hold.
      throw Object.assign(
        new Error('Stored imageUrls for this costume is not a JSON array'),
        { status: 500 }
      );
    }
    if (!Array.isArray(current)) {
      throw Object.assign(
        new Error('Stored imageUrls for this costume is not a JSON array'),
        { status: 500 }
      );
    }

    if (!current.includes(url)) {
      // 404, not 400: the request was well formed, this costume simply does
      // not have that image. Repeating the delete is not the fix.
      return res.status(404).json({
        error: 'Image is not on this costume',
        code: 'NOT_FOUND'
      });
    }

    const remaining = current.filter((entry) => entry !== url);
    // Reuse the shared writer-side validator so the array this route persists
    // is held to exactly the same rules as one arriving from the dashboard.
    // It cannot throw here (the entries already passed it on the way in), but
    // routing it through the same call is what stops the two writers drifting.
    const serialized = normalizeImageUrls(remaining);

    await queryDb(
      `UPDATE "Costume" SET imageUrls = ${esc(serialized)}, `
      + `updatedAt = ${esc(new Date().toISOString())} WHERE id = ${esc(id)};`
    );

    // Only now that this costume no longer points at the file: is anything ELSE
    // still pointing at it? json_each matches whole array elements, so a
    // substring collision ("/uploads/a.webp" vs "/uploads/a.webp.bak") cannot
    // produce a false "still referenced".
    const stillReferenced = Number(await queryDb(
      `SELECT COUNT(*) FROM "Costume" WHERE id <> ${esc(id)} `
      + `AND EXISTS (SELECT 1 FROM json_each("Costume".imageUrls) WHERE value = ${esc(url)});`
    )) || 0;

    let fileDeleted = false;
    if (stillReferenced === 0) {
      const fileName = uploadFileNameFor(url);
      if (fileName) {
        const fs = require('fs').promises;
        const path = require('path');
        // Same directory images.js serves from. Note this is resolved from
        // __dirname, not from the process cwd, so it stays correct no matter
        // which directory the server was started in.
        const filePath = path.join(__dirname, '../../data/uploads', fileName);
        try {
          await fs.unlink(filePath);
          fileDeleted = true;
        } catch (unlinkError) {
          // The row is already correct, which is what the caller actually
          // asked for, so a failure here must not be reported as a failed
          // delete. ENOENT simply means the bytes were already gone. Anything
          // else (a permission problem) is surfaced in the response so the
          // orphaned file is not silently forgotten.
          if (unlinkError.code !== 'ENOENT') {
            res.json({
              id, url, removed: true, remaining, fileDeleted: false,
              warning: `Removed from the costume but could not delete the file: ${unlinkError.code}`
            });
            return;
          }
        }
      }
    }

    res.json({
      id,
      url,
      removed: true,
      remaining,
      stillReferenced,
      fileDeleted
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

/**
 * Map an `/uploads/...` URL to a bare filename, or null when the URL does not
 * point into the upload directory.
 *
 * A delete endpoint that builds a filesystem path out of caller input is a
 * path-traversal endpoint unless this refuses everything that is not a plain
 * filename. `path.basename` alone is not enough: it would happily reduce
 * `../../etc/passwd` to `passwd` and then unlink a file that was never ours.
 * So the remainder must be a single segment containing no separator and no
 * parent reference at all.
 *
 * @param {string} url
 * @returns {string|null}
 */
function uploadFileNameFor(url) {
  const prefix = '/uploads/';
  if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
  const name = url.slice(prefix.length);
  if (name.length === 0) return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name.includes('..') || name.includes('\0')) return null;
  return name;
}

module.exports = router;

/**
 * The write-path normalisers, exported so that non-HTTP writers reuse them
 * instead of reimplementing them.
 *
 * WHY THIS EXPORT EXISTS
 * The Excel backfill (scripts/import_excel.js) writes "Costume" rows directly.
 * Before this, it applied none of the rules below: a spreadsheet cell with a
 * double-spaced brand produced a costume whose brand matched no managed-list row
 * (the UNIQUE index is built on the whitespace-collapsed nameLower), and a
 * spreadsheet size went in unvalidated. Reimplementing these validators in the
 * script would guarantee they drift; importing them cannot.
 *
 * They are attached to the router object rather than exported as a separate
 * module so that this file keeps exactly one definition of each rule — the
 * export is a re-publication, not a copy.
 */
module.exports.normalizers = {
  normalizeImageUrls,
  normalizeStatus,
  normalizeNotes,
  normalizePrice,
  normalizeSize,
  normalizeReferenceName,
  ensureReferenceRow,
  COSTUME_COLUMNS,
  COSTUME_STATUSES,
  COSTUME_SIZES,
  MAX_REFERENCE_NAME_LENGTH,
  MAX_CHARACTER_LENGTH,
  MAX_REFERENCE_URL_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_IMAGE_URLS,
  MAX_IMAGE_URL_LENGTH
};
