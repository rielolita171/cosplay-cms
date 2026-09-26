#!/usr/bin/env node

/**
 * Backfill importer: `imports/Costume Inventory List (1).xlsx` -> "Costume".
 *
 * ============================================================================
 * READ THIS BEFORE RUNNING IT AGAINST A DATABASE THAT MATTERS
 * ============================================================================
 * The CMS already holds 83 real costumes. This script will happily add 90 more.
 * So it is DRY RUN BY DEFAULT: without `--apply` it parses, normalises,
 * validates and reports, and opens the database read-only. Nothing is written
 * unless you type `--apply`.
 *
 *   node scripts/import_excel.js                       # dry run (default)
 *   node scripts/import_excel.js --dry-run             # same, explicitly
 *   node scripts/import_excel.js --apply               # WRITE (opt-in)
 *   node scripts/import_excel.js --apply --db /tmp/x.db
 *   node scripts/import_excel.js --apply --allow-duplicates
 *
 * Flags
 *   --dry-run              Report only. This is the DEFAULT.
 *   --apply                Required for any write. No flag, no write.
 *   --db <path>            Database file. Default: data/db/cms.db (relative to
 *                          the repo root, so run it from the repo root).
 *                          Dry-run mode still opens it read-only, purely to
 *                          report how many rows would duplicate.
 *   --file <path>          Spreadsheet. Default: the imports/ file.
 *   --allow-duplicates     Insert even when (character, fandom) already exists.
 *                          Without it, a row that matches an existing costume
 *                          (case-insensitive, whitespace-collapsed) is SKIPPED —
 *                          this is what stops a re-run from doubling the table.
 *   --limit-rows <n>       Process only the first n data rows.
 *
 * ============================================================================
 * WHY IT IS BUILT THE WAY IT IS
 * ============================================================================
 * (a) TRANSPORT. The previous version of this file required `better-sqlite3`,
 *     whose prebuilt native binding SEGFAULTS under this project's Node 18
 *     runtime (the same reason src/services/db.js documents avoiding it), so
 *     running the script crashed the process. It now uses src/services/db.js —
 *     the same `sqlite3` CLI pipe transport as every route in the app — so there
 *     is one transport in the project instead of two, and one set of escaping
 *     rules.
 *
 * (b) NORMALISATION. The previous version did its own ad-hoc `replace(/'/g,"''")`
 *     and wrote raw spreadsheet text straight into the columns. It bypassed
 *     everything the HTTP path enforces, so a cell containing "blue  archive"
 *     (two spaces) produced a costume whose brand matched no "Brand" row: the
 *     UNIQUE index is built on the whitespace-collapsed nameLower that
 *     collapseWhitespace() produces, and brands.js / fandoms.js / costumes.js
 *     all collapse before writing. This script now imports the normalisers from
 *     src/routes/costumes.js (exported as `router.normalizers`) and the escaping
 *     helpers from src/services/sqlSafety.js, so an imported row and a
 *     dashboard-created row are byte-identical in shape. It also registers the
 *     brand/fandom references through the same INSERT OR IGNORE the route uses.
 *
 * (c) SAFETY. Dry run by default, `--apply` to write, duplicate detection by
 *     default. See the flag list above.
 *
 * PRICES ARE NEVER IMPORTED. The spreadsheet's price columns are read but
 * deliberately ignored: every "Costume".buyPrice / sellPrice / sellPriceMutual
 * is left NULL. Inventing or back-filling a price from a spreadsheet column that
 * may mean something else entirely (a shipping total, a year, a count) is worse
 * than an empty field, and the owner has explicitly decided to keep them NULL.
 * The columns are also deliberately absent from the INSERT below, so a price
 * can not reach the database even by accident.
 */

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} needs a value`);
  }
  return value;
}

const APPLY = argv.includes('--apply');
const ALLOW_DUPLICATES = argv.includes('--allow-duplicates');
const DRY_RUN = !APPLY;                       // dry run is the DEFAULT
const DB_FILE = path.resolve(REPO_ROOT, flagValue('--db') || 'data/db/cms.db');
const XLSX_FILE = path.resolve(REPO_ROOT, flagValue('--file') || 'imports/Costume Inventory List (1).xlsx');
const LIMIT_ROWS = flagValue('--limit-rows') ? parseInt(flagValue('--limit-rows'), 10) : null;

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Transport + normalisation. db.js is required AFTER DATABASE_PATH is set,
// because it resolves DB_FILE once at require time.
// ---------------------------------------------------------------------------
process.env.DATABASE_PATH = DB_FILE;
const db = require('../src/services/db');
const { esc, textParam, collapseWhitespace } = require('../src/services/sqlSafety');
const { normalizers } = require('../src/routes/costumes');
const {
  normalizeStatus,
  normalizeNotes,
  normalizeSize,
  normalizeReferenceName,
  MAX_CHARACTER_LENGTH
} = normalizers;

/**
 * Register a "Brand"/"Fandom" row, the same way the HTTP path does.
 *
 * WHY THIS IS NOT THE ROUTE'S ensureReferenceRow
 * That helper (src/routes/costumes.js) spawns `sqlite3 data/db/cms.db` with a
 * path RELATIVE TO THE PROCESS CWD, so it always writes the repo's real
 * database and ignores both DATABASE_PATH and this script's --db flag. Importing
 * it here would mean `--apply --db /tmp/scratch.db` silently registered its
 * brand/fandom references in the production database instead of the target. The
 * statement below is identical (same columns, same INSERT OR IGNORE against the
 * same UNIQUE nameLower index, same timestamps); only the transport is db.runSql,
 * which honours DATABASE_PATH. Reported, not fixed, in the route — see the note
 * at the top of src/services/db.js.
 */
async function ensureReferenceRow(table, name) {
  const now = new Date().toISOString();
  await db.runSql(
    `INSERT OR IGNORE INTO "${table}" (id, name, nameLower, createdAt, updatedAt)
     VALUES (${esc(randomUUID())}, ${esc(name.value)}, ${esc(name.lower)}, ${esc(now)}, ${esc(now)});`
  );
}

// ---------------------------------------------------------------------------
// Schema bootstrap (apply mode only).
// ---------------------------------------------------------------------------
// These are the same CREATE TABLE IF NOT EXISTS statements init_db.sql defines,
// and they are deliberately NOT run in dry-run mode: a dry run must not so much
// as create a table in a database it was only asked to look at.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "Costume" (
  id TEXT PRIMARY KEY,
  fandom TEXT NOT NULL,
  character TEXT NOT NULL,
  brand TEXT,
  size TEXT,
  isFullset INTEGER DEFAULT 0,
  doneCostest INTEGER DEFAULT 0,
  doneEvent INTEGER DEFAULT 0,
  donePhotoSession INTEGER DEFAULT 0,
  status TEXT DEFAULT 'IN_POSSESSION',
  buyPrice REAL,
  sellPrice REAL,
  sellPriceMutual REAL,
  notes TEXT,
  referenceUrl TEXT,
  imageUrls TEXT DEFAULT '[]',
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS "Brand" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nameLower TEXT NOT NULL,
  storeUrl TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_Brand_nameLower" ON "Brand"(nameLower);
CREATE TABLE IF NOT EXISTS "Fandom" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nameLower TEXT NOT NULL,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_Fandom_nameLower" ON "Fandom"(nameLower);
`;

// ---------------------------------------------------------------------------
// Spreadsheet column mapping.
//
// The sheet's header row is not the column names (several columns are blank and
// xlsx therefore names them __EMPTY / __EMPTY_1 …), so the original file probed
// a list of aliases. That is kept, but each extracted value is now pushed
// through the same normaliser the HTTP path uses.
// ---------------------------------------------------------------------------
function cell(row, ...aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (value === undefined || value === null) continue;
    const text = String(value);
    if (text.trim() === '') continue;
    return text;
  }
  return null;
}

/** SQLite booleans arrive as / are written as 0|1; a spreadsheet TRUE is "TRUE". */
function boolCell(row, ...aliases) {
  const raw = cell(row, ...aliases);
  if (!raw) return 0;
  return /^(true|yes|1|y)$/i.test(raw.trim()) ? 1 : 0;
}

/**
 * Turn one spreadsheet row into a fully normalised, validated Costume payload,
 * or into a `{ skip }` / `{ error }` outcome. Never throws for bad data: a bad
 * row is reported, not fatal, so one malformed cell cannot abort an import of
 * 90 good rows.
 */
function normaliseRow(row) {
  const rawCharacter = cell(row, '83', 'Character', 'Name');
  if (!rawCharacter) return { skip: 'no character value' };

  const character = collapseWhitespace(rawCharacter);
  if (character === '' || character.toLowerCase() === 'unknown' || character.toLowerCase() === 'character') {
    return { skip: 'placeholder character value' };
  }

  const rawFandom = cell(row, 'Costume count', 'Fandom', 'Series') || 'Uncategorized';
  const rawBrand = cell(row, '__EMPTY', 'Brand');
  const rawSize = cell(row, '__EMPTY_1', 'Size');
  const rawNotes = cell(row, '__EMPTY_6', 'Notes');
  // The sheet has NO status column and NO reference-url column. Because its
  // header row is not row 1, xlsx names the blank-ish header cells __EMPTY…,
  // and the last two of them are the COMPUTED "Complete (%)" and
  // "Complete (Bar)" columns. Reading those would hand the enum validator
  // "50%" and the URL validator a bar glyph, so neither is mapped here. An
  // imported costume therefore gets exactly the defaults POST /api/costumes
  // gives a new one: status IN_POSSESSION, no referenceUrl.
  const rawStatus = cell(row, 'Status');
  const rawReferenceUrl = cell(row, 'Reference URL', 'ReferenceUrl');

  // Every one of these is the SAME function the HTTP route calls, so a 120-char
  // limit or a '|' in a brand fails here exactly as it fails on POST /api/costumes.
  let fandom;
  let brand;
  let size;
  let notes;
  let status;
  let referenceUrl;
  try {
    fandom = normalizeReferenceName(rawFandom, 'fandom');
    brand = normalizeReferenceName(rawBrand, 'brand');
    size = normalizeSize(rawSize && collapseWhitespace(rawSize), undefined);
    notes = normalizeNotes(rawNotes && rawNotes.trim());
    status = normalizeStatus(rawStatus && collapseWhitespace(rawStatus).toUpperCase());
    referenceUrl = textParam(rawReferenceUrl, { name: 'referenceUrl', maxLength: 2048, noSeparator: true });
  } catch (error) {
    return { error: error.message };
  }

  if (!fandom) return { skip: 'fandom is empty after normalisation' };
  if (!character || character.length > MAX_CHARACTER_LENGTH) {
    return { error: `character must be 1..${MAX_CHARACTER_LENGTH} characters after normalisation` };
  }
  if (notes && /[|\r\n]/.test(notes)) {
    return { error: 'notes cannot contain the character | or a line break' };
  }
  if (referenceUrl && !/^https?:\/\//i.test(referenceUrl)) {
    return { error: 'referenceUrl must be an http(s) URL' };
  }

  return {
    value: {
      id: randomUUID(),
      character,
      fandom,
      brand,
      // `{persist, value}` from normalizeSize: a spreadsheet "One Size" is a
      // bespoke value and is preserved verbatim exactly as the HTTP path does.
      size: size.value,
      status: status || 'IN_POSSESSION',
      notes,
      referenceUrl,
      isFullset: boolCell(row, '__EMPTY_2', 'Fullset', 'isFullset'),
      doneCostest: boolCell(row, '__EMPTY_3', 'Costest', 'doneCostest'),
      doneEvent: boolCell(row, '__EMPTY_4', 'Event', 'doneEvent'),
      donePhotoSession: boolCell(row, '__EMPTY_5', 'Photo Session', 'donePhotoSession')
    }
  };
}

/**
 * Duplicate key: case-insensitive, whitespace-collapsed character + fandom.
 *
 * `fandom` is the { value, lower } OBJECT normalizeReferenceName returns, not
 * the raw string, so the `.value` matters: collapsing the object itself would
 * stringify it to "[object Object]", so every row would look unique and the
 * duplicate check would be silently dead.
 *
 * The separator is a NUL, which neither normaliser can produce.
 */
function duplicateKey(costume) {
  return `${collapseWhitespace(costume.character).toLowerCase()}\u0000${collapseWhitespace(costume.fandom.value).toLowerCase()}`;
}

async function existingKeys() {
  const output = await db.runSql('SELECT character, fandom FROM "Costume";');
  const keys = new Set();
  if (!output) return keys;
  for (const line of output.split('\n')) {
    const [character, fandom] = line.split('|');
    if (character === undefined) continue;
    keys.add(`${collapseWhitespace(character).toLowerCase()}\u0000${collapseWhitespace(fandom || '').toLowerCase()}`);
  }
  return keys;
}

async function main() {
  console.log('\n' + '='.repeat(64));
  console.log(APPLY
    ? '⚠️  EXCEL IMPORT — WRITE MODE (--apply)'
    : '🔍 EXCEL IMPORT — DRY RUN (nothing will be written)');
  console.log('='.repeat(64));
  console.log(`📄 Spreadsheet: ${XLSX_FILE}`);
  console.log(`🗄️  Database:    ${DB_FILE}`);
  console.log('');

  if (!fs.existsSync(XLSX_FILE)) {
    console.error(`❌ Spreadsheet not found: ${XLSX_FILE}`);
    process.exit(1);
  }
  if (!fs.existsSync(DB_FILE)) {
    console.error(`❌ Database not found: ${DB_FILE}`);
    console.error('   Run init_db.sql (or start the server once) to create it.');
    process.exit(1);
  }

  const workbook = XLSX.readFile(XLSX_FILE);
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    console.error('❌ The workbook contains no sheets.');
    process.exit(1);
  }
  console.log(`📑 Sheet: "${sheetName}"`);

  const allRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
  const rows = LIMIT_ROWS ? allRows.slice(0, LIMIT_ROWS) : allRows;
  console.log(`📊 Data rows in sheet: ${allRows.length}${LIMIT_ROWS ? ` (processing first ${rows.length})` : ''}\n`);

  if (APPLY) {
    await db.runSql(SCHEMA_SQL);
    console.log('✓ Schema ensured (CREATE TABLE IF NOT EXISTS — no-op on an existing DB)\n');
  }

  // Read-only, in both modes: the dry run reports how many rows are already
  // present, and apply mode needs the same set to decide what to skip.
  const seen = await existingKeys();
  const alreadyInDb = new Set(seen);

  const toInsert = [];
  const skipped = [];
  const invalid = [];
  const inSheetDuplicates = new Set();

  for (let i = 0; i < rows.length; i++) {
    const outcome = normaliseRow(rows[i]);
    if (outcome.skip) {
      skipped.push({ row: i + 2, reason: outcome.skip });
      continue;
    }
    if (outcome.error) {
      invalid.push({ row: i + 2, value: outcome.value, reason: outcome.error });
      continue;
    }

    const key = duplicateKey(outcome.value);
    if (inSheetDuplicates.has(key)) {
      skipped.push({ row: i + 2, reason: 'duplicate of an earlier row in this same spreadsheet' });
      continue;
    }
    inSheetDuplicates.add(key);

    if (alreadyInDb.has(key) && !ALLOW_DUPLICATES) {
      skipped.push({ row: i + 2, reason: 'a costume with this character + fandom already exists in the database' });
      continue;
    }
    toInsert.push(outcome.value);
  }

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const references = new Set();
  for (const value of toInsert) {
    if (value.fandom) references.add('fandom:' + value.fandom.value.toLowerCase());
    if (value.brand) references.add('brand:' + value.brand.value.toLowerCase());
  }

  console.log('─'.repeat(64));
  console.log('PLAN');
  console.log('─'.repeat(64));
  console.log(`  would insert            : ${toInsert.length}`);
  console.log(`  would skip              : ${skipped.length}`);
  console.log(`  rejected as invalid     : ${invalid.length}`);
  console.log(`  brand/fandom refs to register: ${references.size}`);
  console.log(`  buyPrice / sellPrice / sellPriceMutual: NEVER written (left NULL by design)`);
  console.log('');

  if (skipped.length) {
    console.log('  Skipped rows:');
    skipped.slice(0, 20).forEach(s => console.log(`    row ${s.row}: ${s.reason}`));
    if (skipped.length > 20) console.log(`    … and ${skipped.length - 20} more`);
    console.log('');
  }

  if (invalid.length) {
    console.log('  Rejected rows (NOT imported — the same values would be a 400 on the HTTP path):');
    invalid.slice(0, 20).forEach(s => console.log(`    row ${s.row}: ${s.reason}`));
    if (invalid.length > 20) console.log(`    … and ${invalid.length - 20} more`);
    console.log('');
  }

  console.log('  First 10 rows that would be written:');
  toInsert.slice(0, 10).forEach(v => {
    console.log(`    • ${v.character}  [${v.fandom.value}]`
      + `${v.brand ? '  brand=' + v.brand.value : ''}`
      + `${v.size ? '  size=' + v.size : ''}`
      + `  status=${v.status}`);
  });
  if (toInsert.length > 10) console.log(`    … and ${toInsert.length - 10} more`);
  console.log('');

  if (!APPLY) {
    console.log('='.repeat(64));
    console.log('🔍 DRY RUN COMPLETE — the database was not modified.');
    console.log(`   Re-run with --apply to perform the ${toInsert.length} inserts.`);
    console.log('='.repeat(64) + '\n');
    return;
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------
  if (toInsert.length === 0) {
    console.log('Nothing to do — no row survived normalisation and the duplicate check.\n');
    return;
  }

  const now = new Date().toISOString();
  const statements = [];

  for (const value of toInsert) {
    // Brand / Fandom first, exactly as the route does, so the managed list can
    // never be missing an entry a costume points at.
    if (value.fandom) await ensureReferenceRow('Fandom', value.fandom);
    if (value.brand) await ensureReferenceRow('Brand', value.brand);

    // buyPrice / sellPrice / sellPriceMutual are absent from this statement on
    // purpose — see the header comment. The columns keep their DEFAULT (NULL).
    statements.push(
      `INSERT INTO "Costume" (id, fandom, character, brand, size, isFullset, doneCostest, doneEvent, donePhotoSession, status, notes, referenceUrl, imageUrls, createdAt, updatedAt) VALUES (`
      + `${esc(value.id)}, ${esc(value.fandom.value)}, ${esc(value.character)}, `
      + `${value.brand ? esc(value.brand.value) : 'NULL'}, `
      + `${value.size ? esc(value.size) : 'NULL'}, `
      + `${value.isFullset}, ${value.doneCostest}, ${value.doneEvent}, ${value.donePhotoSession}, `
      + `${esc(value.status)}, `
      + `${value.notes ? esc(value.notes) : 'NULL'}, `
      + `${value.referenceUrl ? esc(value.referenceUrl) : 'NULL'}, `
      + `${esc('[]')}, ${esc(now)}, ${esc(now)});`
    );
  }

  // One transaction: a failure halfway through must not leave half an import.
  await db.runSql(`BEGIN;\n${statements.join('\n')}\nCOMMIT;`);

  console.log('='.repeat(64));
  console.log('✅ IMPORT COMPLETE');
  console.log('='.repeat(64));
  console.log(`  inserted                : ${toInsert.length}`);
  console.log(`  skipped                 : ${skipped.length}`);
  console.log(`  rejected as invalid     : ${invalid.length}`);
  console.log(`  database                : ${DB_FILE}`);
  console.log('  prices                  : left NULL (never imported)');
  console.log('='.repeat(64) + '\n');
}

main().catch((error) => {
  console.error('\n❌ Import failed:', error && (error.stack || error.message));
  process.exit(1);
});
