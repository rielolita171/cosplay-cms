/**
 * Test suite for export / import of the whole collection.
 *
 * WHAT IS TESTED
 * The ZIP container (round trip, integrity, refusal of malformed input), the
 * export, the read-only inspect pre-flight, the import in both modes, the guard
 * that stops a hostile archive writing outside the upload directory, the HTTP
 * confirmation gate, and the CORS allowlist reconciliation that differs by
 * migration direction.
 *
 * WHY EACH SCENARIO RUNS IN ITS OWN PROCESS
 * src/services/paths.js resolves DB_FILE at MODULE LOAD, and settings.js caches
 * the resolved allowlist. One process therefore cannot test a desktop import
 * (CMS_SELF_ORIGIN set) and then a server import (unset): whichever value was
 * read first stays frozen, and the suite would pass while proving the opposite
 * of what it claims. Every scenario is a fresh `node` process, which is also
 * the only honest way to test "a different machine, with different config".
 *
 * The database and upload directory are throwaway temp directories, so a
 * failure cannot touch the real collection. No fixed port is bound.
 *
 * Run: node scripts/test_transfer.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-test-'));

/** A private directory per scenario, so they cannot see each other's uploads. */
function slot(name) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(dir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'up'), { recursive: true });
  return {
    db: path.join(dir, 'db', 'cms.db'),
    uploads: path.join(dir, 'up'),
    archive: path.join(dir, 'archive.zip')
  };
}

// ---------------------------------------------------------------------------
// The child-process runner. Written to disk as a real file rather than passed
// to `node -e`, so the scenario bodies are ordinary JavaScript.
// ---------------------------------------------------------------------------
const RUNNER = path.join(tmpDir, 'scenario.js');

fs.writeFileSync(RUNNER, `
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = ${JSON.stringify(ROOT)};
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// Configured BEFORE requiring anything that reads process.env at module load.
if (job.db) process.env.DATABASE_PATH = job.db;
if (job.uploads) process.env.CMS_UPLOAD_DIR = job.uploads;
if (job.port) process.env.PORT = job.port;
if (job.selfOrigin) process.env.CMS_SELF_ORIGIN = job.selfOrigin;
else delete process.env.CMS_SELF_ORIGIN;
if (job.corsEnv) process.env.CORS_ORIGIN = job.corsEnv;
else delete process.env.CORS_ORIGIN;

const transfer = require(path.join(ROOT, 'src/services/transfer'));
const settings = require(path.join(ROOT, 'src/services/settings'));
const zip = require(path.join(ROOT, 'src/services/zip'));

/** A real database created from the project's actual schema. */
function freshDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('sqlite3', [file], { input: fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8') });
}

function sql(file, statement) {
  return execFileSync('sqlite3', [file], { input: statement }).toString().trim();
}

function insertCors(file, list) {
  // The value column is TEXT holding JSON, so the JSON text is stringified AND
  // then wrapped as a SQL string literal. JSON.stringify alone produces
  // double quotes, which SQLite reads as an identifier, not a string.
  const value = JSON.stringify(list).replace(/'/g, "''");
  sql(file, "INSERT INTO ServerSetting (key, value) VALUES ('cors_origins', '" + value + "');");
}

function readCors(file) {
  const out = sql(file, "SELECT value FROM ServerSetting WHERE key='cors_origins';");
  return out === '' ? null : JSON.parse(out);
}

function rows(file, statement) {
  const out = sql(file, statement);
  return out === '' ? [] : out.split('\\n').filter(Boolean);
}

/** Pull data.sql out of a good archive, to reuse in a hand-built hostile one. */
function dataSqlFrom(archivePath) {
  const a = zip.readZip(archivePath);
  try {
    return zip.readEntry(a, a.entries.find(e => e.name === 'data.sql'));
  } finally {
    zip.closeZip(a);
  }
}

/**
 * Remove a table's CREATE block and its INSERTs from a dump.
 *
 * The whole statement has to go, not just the lines naming the table: sqlite3's
 * .dump writes a multi-line CREATE TABLE, so filtering on the table name would
 * delete the opening line and leave a column list with nothing to attach to.
 */
function stripTable(dump, table) {
  const lines = dump.split('\\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (line.indexOf('CREATE TABLE') !== -1 && line.indexOf('"' + table + '"') !== -1) {
      inside = true;
      continue;
    }
    if (inside) {
      // The CREATE block ends at the line that closes the parenthesis.
      if (line.trim().startsWith(');')) inside = false;
      continue;
    }
    if (line.indexOf('INSERT INTO "' + table + '"') !== -1) continue;
    // .dump also writes an UNQUOTED form (INSERT INTO Table VALUES...), because
    // the name needs no quoting. Matching only the quoted form leaves the row
    // behind, which is how a supposedly desktop-shaped archive kept smuggling
    // in an allowlist.
    if (line.indexOf('INSERT INTO ' + table + ' ') !== -1) continue;
    out.push(line);
  }
  return out.join('\\n');
}

const scenarios = {
  // -- export ------------------------------------------------------------
  async 'export-writes-archive'(j) {
    freshDb(j.db);
    // A note containing an apostrophe and a doubled quote: the classic thing a
    // hand-rolled SQL dump gets wrong, and it corrupts a row rather than
    // failing loudly.
    sql(j.db, "INSERT INTO Costume (id, fandom, character, notes) "
      + "VALUES ('c1', 'Genshin', 'Hu Tao', 'it''s a note — with ''quotes''');");
    sql(j.db, "INSERT INTO Fandom (id, name, nameLower) VALUES ('f1', 'Genshin', 'genshin');");
    insertCors(j.db, ['http://lan.example:4001']);
    fs.mkdirSync(j.uploads, { recursive: true });
    fs.writeFileSync(path.join(j.uploads, 'a.webp'), Buffer.alloc(3000, 7));
    fs.writeFileSync(path.join(j.uploads, 'b.webp'), Buffer.alloc(2000, 9));
    // A dotfile must not travel: OS/editor droppings, not collection data.
    fs.writeFileSync(path.join(j.uploads, '.DS_Store'), 'junk');

    const summary = await transfer.exportTo(j.archive);
    return { summary, report: transfer.inspect(j.archive) };
  },

  async 'export-without-uploads'(j) {
    freshDb(j.db);
    const summary = await transfer.exportTo(j.archive);
    return { summary, report: transfer.inspect(j.archive) };
  },

  async 'export-rejects-foreign-database'(j) {
    fs.mkdirSync(path.dirname(j.db), { recursive: true });
    // A real SQLite file that is NOT a CMS database: none of the expected tables.
    sql(j.db, 'CREATE TABLE Unrelated (id TEXT);');
    try {
      await transfer.exportTo(j.archive);
      return { threw: false };
    } catch (e) {
      return { threw: true, message: e.message };
    }
  },

  // -- inspect -----------------------------------------------------------
  async 'inspect-is-read-only'(j) {
    freshDb(j.db);
    sql(j.db, "INSERT INTO Costume (id, fandom, character) VALUES ('keep', 'G', 'K');");
    // Two images, so the report has something to report. Without them the
    // "uploads" count is legitimately 0 and the assertion would be meaningless.
    fs.mkdirSync(j.uploads, { recursive: true });
    fs.writeFileSync(path.join(j.uploads, 'a.webp'), Buffer.alloc(100, 1));
    fs.writeFileSync(path.join(j.uploads, 'b.webp'), Buffer.alloc(100, 2));
    const before = sql(j.db, 'SELECT COUNT(*) FROM Costume;');
    await transfer.exportTo(j.archive);
    const report = transfer.inspect(j.archive);
    return { before, after: sql(j.db, 'SELECT COUNT(*) FROM Costume;'), report };
  },

  async 'inspect-rejects-foreign-archive'(j) {
    zip.createZip(j.archive, [{ name: 'hello.txt', buffer: Buffer.from('not a cms export') }]);
    try {
      transfer.inspect(j.archive);
      return { threw: false };
    } catch (e) {
      return { threw: true, message: e.message };
    }
  },


  // -- import ------------------------------------------------------------
  async 'import-replace'(j) {
    freshDb(j.db);
    sql(j.db, "INSERT INTO Costume (id, fandom, character) VALUES ('stale', 'Old', 'ShouldVanish');");
    insertCors(j.db, ['http://lan.example:4001']);
    fs.mkdirSync(j.uploads, { recursive: true });
    fs.writeFileSync(path.join(j.uploads, 'old.webp'), 'old image');

    const report = await transfer.importFrom(j.archive, { mode: 'replace' });
    return {
      report,
      costumes: rows(j.db, 'SELECT id FROM Costume;'),
      note: sql(j.db, "SELECT notes FROM Costume WHERE id='c1';"),
      cors: readCors(j.db),
      uploads: fs.readdirSync(j.uploads).sort(),
      backupExists: fs.existsSync(report.backupPath),
      backupHasOldRow: sql(report.backupPath, 'SELECT id FROM Costume;')
    };
  },

  async 'import-merge-keeps-target-rows'(j) {
    freshDb(j.db);
    sql(j.db, "INSERT INTO Costume (id, fandom, character) VALUES ('mine', 'Local', 'KeepMe');");
    const report = await transfer.importFrom(j.archive, { mode: 'merge' });
    return { mode: report.mode, costumes: rows(j.db, 'SELECT id FROM Costume;').sort() };
  },

  // A desktop-exported archive carries NO cors row, which is the shape that
  // makes "import the same thing twice" a meaningful question: the target's own
  // list is what is in play both times, so the second run must find loopback
  // already present and change nothing. (The shared good archive DOES carry a
  // row, and re-importing it legitimately restores that row each time, which
  // would test replace semantics rather than idempotence.)
  async 'import-restore-is-idempotent'(j) {
    freshDb(j.db);
    insertCors(j.db, ['https://cms.example.com']);
    // Build a DESKTOP-shaped archive: no manifest, and the ServerSetting
    // CREATE/INSERT statements removed from data.sql, so nothing about the
    // allowlist travels. Written to j.archive's own slot, leaving the shared
    // the good archive untouched.
    const zip = require(path.join(ROOT, 'src/services/zip.js'));
    const a = zip.readZip(j.goodArchive);
    const dataSql = zip.readEntry(a, a.entries.find(e => e.name === 'data.sql')).toString('utf8');
    const uploads = a.entries
      .filter(e => e.name.startsWith('uploads/'))
      .map(e => ({ name: e.name, buffer: zip.readEntry(a, e) }));
    zip.closeZip(a);

    // Remove the ServerSetting table wholesale, INCLUDING the CREATE TABLE
    // block. Filtering on the table name alone is not enough: .dump puts the
    // column definitions on their own lines, so a name-only filter would delete
    // the opening parenthesis line and leave a body that is not valid SQL.
    const stripped = stripTable(dataSql, 'ServerSetting');
    zip.createZip(j.archive, [{ name: 'data.sql', buffer: Buffer.from(stripped) }].concat(uploads));

    const first = await transfer.importFrom(j.archive, { mode: 'replace' });
    const second = await transfer.importFrom(j.archive, { mode: 'replace' });
    return { first: first.cors, second: second.cors, stored: readCors(j.db) };
  },

  // -- hostile archives --------------------------------------------------
  async 'import-blocks-path-traversal'(j) {
    // A VALID data.sql, so inspect() passes and the EXTRACTION loop is actually
    // reached. Without one this would pass on the earlier "no data.sql" check
    // and prove nothing about the guard.
    zip.createZip(j.archive, [
      { name: 'data.sql', buffer: dataSqlFrom(j.goodArchive) },
      { name: 'uploads/../../../../tmp/CMS_ESCAPED.txt', buffer: Buffer.from('escaped') }
    ]);
    // The target needs a real schema: the scenario counts rows before and
    // after to prove the guard fires BEFORE any data is written, and a missing
    // table would make that count fail for an unrelated reason.
    freshDb(j.db);
    const before = sql(j.db, 'SELECT COUNT(*) FROM Costume;');
    try {
      await transfer.importFrom(j.archive, { mode: 'replace' });
      return { threw: false, before };
    } catch (e) {
      return {
        threw: true, message: e.message, before,
        after: sql(j.db, 'SELECT COUNT(*) FROM Costume;'),
        escaped: fs.existsSync('/tmp/CMS_ESCAPED.txt')
      };
    }
  },

  async 'import-blocks-absolute-and-nested-entries'(j) {
    const dataSql = dataSqlFrom(j.goodArchive);
    // Each case is a separate import, so the target is created from the real
    // schema rather than inheriting whatever the previous case left behind.
    freshDb(j.db);
    const outcomes = {};
    const cases = {
      absolute: '/etc/cms-test-escape.txt',
      nested: 'uploads/sub/dir.webp',
      driveLetter: 'C:\\\\cms-test-escape.txt'
    };
    for (const label of Object.keys(cases)) {
      zip.createZip(j.archive, [
        { name: 'data.sql', buffer: dataSql },
        { name: cases[label], buffer: Buffer.from('x') }
      ]);
      try {
        await transfer.importFrom(j.archive, { mode: 'replace' });
        outcomes[label] = { threw: false };
      } catch (e) {
        outcomes[label] = { threw: true, message: e.message };
      }
    }
    return { outcomes };
  },

  async 'inspect-rejects-newer-format'(j) {
    zip.createZip(j.archive, [
      { name: 'data.sql', buffer: dataSqlFrom(j.goodArchive) },
      { name: 'manifest.json', buffer: Buffer.from(JSON.stringify({
        format: 'cosplay-cms-transfer', version: transfer.MANIFEST_VERSION + 1
      })) }
    ]);
    try {
      transfer.inspect(j.archive);
      return { threw: false };
    } catch (e) {
      return { threw: true, message: e.message };
    }
  },

  // -- CORS, per migration direction --------------------------------------
  async 'cors-selfhosted-to-desktop-discards'(j) {
    freshDb(j.db);
    // The archive carries a self-hosted LAN allowlist; the target is a desktop
    // build, which enforces nothing. Those origins describe another machine.
    insertCors(j.db, ['http://192.168.1.50:4001']);
    const report = await transfer.importFrom(j.archive, { mode: 'replace' });
    return {
      isCorsDisabled: settings.isCorsDisabled(),
      cors: report.cors,
      storedCors: readCors(j.db)
    };
  },

  async 'cors-desktop-to-selfhosted-keeps-target'(j) {
    freshDb(j.db);
    // The TARGET has its own deliberate allowlist and the archive carries none.
    insertCors(j.db, ['https://cms.example.com', 'http://10.0.0.5:4001']);
    const report = await transfer.importFrom(j.archive, { mode: 'replace' });
    return {
      isCorsDisabled: settings.isCorsDisabled(),
      cors: report.cors,
      storedCors: readCors(j.db)
    };
  },

  async 'cors-target-without-override-stays-unstored'(j) {
    freshDb(j.db);
    // No stored row: the target falls back to CORS_ORIGIN in the environment,
    // which already permits loopback. Promoting that env value into a stored
    // row would be a change the operator never made.
    const report = await transfer.importFrom(j.archive, { mode: 'replace' });
    return {
      cors: report.cors,
      storedCors: readCors(j.db),
      effective: (await settings.getCorsOrigins()).origins
    };
  },

  async 'cors-selfhosted-keeps-unrelated-origins'(j) {
    freshDb(j.db);
    insertCors(j.db, ['http://192.168.1.50:4001', 'https://cms.example.com']);
    const report = await transfer.importFrom(j.archive, { mode: 'replace' });
    return { cors: report.cors, storedCors: readCors(j.db) };
  }
};

(async () => {
  const fn = scenarios[job.scenario];
  if (!fn) { console.log('@@RESULT@@' + JSON.stringify({ error: 'unknown scenario: ' + job.scenario })); return; }
  try {
    console.log('@@RESULT@@' + JSON.stringify(await fn(job)));
  } catch (e) {
    console.log('@@RESULT@@' + JSON.stringify({ error: e && (e.stack || e.message) }));
  }
})();
`);

/** Run one scenario in a child process. A crash surfaces as { error }. */
function run(job) {
  const jobFile = path.join(tmpDir, `job-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const proc = spawnSync('node', [RUNNER, jobFile], { encoding: 'utf8' });
  const marker = proc.stdout.split('@@RESULT@@')[1];
  if (!marker) {
    return { error: 'scenario produced no result. stderr: ' + (proc.stderr || '').trim().slice(0, 500) };
  }
  return JSON.parse(marker);
}

// ---------------------------------------------------------------------------
// 1. The ZIP container.
//
// Runs in THIS process: the container format depends on nothing frozen at
// module load, so a child process per assertion would only slow things down.
// ---------------------------------------------------------------------------
function testZipContainer() {
  section('1. THE ZIP CONTAINER');
  const zip = require(path.join(ROOT, 'src/services/zip.js'));
  const dir = slot('zip');
  // slot()'s .db is a FILE path (the database), so scratch files go in the
  // upload directory instead, which is a directory that certainly exists.
  const imageFile = path.join(dir.uploads, 'image.bin');
  fs.writeFileSync(imageFile, Buffer.alloc(200000, 0xab));
  const text = Buffer.from('a'.repeat(20000));

  const made = zip.createZip(dir.archive, [
    { name: 'data.sql', buffer: text },
    { name: 'uploads/image.bin', file: imageFile }
  ]);
  check('createZip reports the entry count it wrote', made.entries === 2, JSON.stringify(made));

  const archive = zip.readZip(dir.archive);
  try {
    check('readZip sees both entries', archive.entries.length === 2);
    const sqlEntry = archive.entries.find(e => e.name === 'data.sql');
    const imgEntry = archive.entries.find(e => e.name === 'uploads/image.bin');

    check('a compressible entry is deflated', sqlEntry.method === 8, 'method ' + sqlEntry.method);
    check('an already-compressed entry is stored, not deflated',
      imgEntry.method === 0, 'method ' + imgEntry.method);
    check('deflating actually saved space', sqlEntry.compSize < sqlEntry.size,
      sqlEntry.compSize + ' vs ' + sqlEntry.size);
    check('a deflated entry round trips byte for byte',
      zip.readEntry(archive, sqlEntry).equals(text));
    check('a stored file entry round trips byte for byte',
      zip.readEntry(archive, imgEntry).equals(fs.readFileSync(imageFile)));
  } finally {
    zip.closeZip(archive);
  }

  // Zero entries is legal ZIP: the code must not read it as "no directory".
  const emptyZip = path.join(dir.uploads, 'empty.zip');
  zip.createZip(emptyZip, []);
  const empty = zip.readZip(emptyZip);
  check('an archive with no entries is still readable', empty.entries.length === 0);
  zip.closeZip(empty);

  // The CRC is the only thing between a truncated download and a half-restored
  // image, so a flipped byte must be caught rather than loaded silently.
  const raw = fs.readFileSync(dir.archive);
  const flipped = Buffer.from(raw);
  flipped[1000] = flipped[1000] ^ 0xff;
  const corruptPath = path.join(dir.uploads, 'corrupt.zip');
  fs.writeFileSync(corruptPath, flipped);
  const corrupt = zip.readZip(corruptPath);
  try {
    const entry = corrupt.entries.find(e => e.name === 'uploads/image.bin');
    let threw = false;
    try { zip.readEntry(corrupt, entry); } catch (_) { threw = true; }
    check('a corrupted payload fails its checksum', threw);
  } finally {
    zip.closeZip(corrupt);
  }

  const junk = path.join(dir.uploads, 'junk.zip');
  fs.writeFileSync(junk, 'this is not a zip file at all');
  let junkThrew = false;
  try { zip.readZip(junk); } catch (_) { junkThrew = true; }
  check('a non-ZIP file is rejected', junkThrew);

  const truncated = path.join(dir.uploads, 'truncated.zip');
  fs.writeFileSync(truncated, raw.subarray(0, Math.floor(raw.length / 2)));
  let truncThrew = false;
  try { zip.readZip(truncated); } catch (_) { truncThrew = true; }
  check('a truncated archive is rejected', truncThrew);
}

/** The archive every later section imports: one costume, one note, two images. */
function buildGoodArchive() {
  const dir = slot('source');
  const out = run({
    scenario: 'export-writes-archive',
    db: dir.db, uploads: dir.uploads, archive: dir.archive
  });
  if (out.error) throw new Error('could not build the source archive: ' + out.error);
  return dir.archive;
}

function testExport() {
  section('2. EXPORT');

  const dir = slot('export');
  const out = run({
    scenario: 'export-writes-archive',
    db: dir.db, uploads: dir.uploads, archive: dir.archive
  });

  check('export completes', !out.error, out.error);
  check('the manifest records the costume count',
    out.summary && out.summary.tables.Costume === 1,
    JSON.stringify(out.summary && out.summary.tables));
  check('the manifest records the upload count',
    out.summary && out.summary.uploads === 2,
    'uploads=' + (out.summary && out.summary.uploads));
  check('a dotfile in the upload directory is not exported',
    out.report && out.report.uploadNames.indexOf('.DS_Store') === -1,
    JSON.stringify(out.report && out.report.uploadNames));
  check('both real images are listed',
    out.report && out.report.uploadNames.join(',') === 'a.webp,b.webp',
    JSON.stringify(out.report && out.report.uploadNames));
  check('a server export identifies its source as "server"',
    out.report && out.report.source === 'server', out.report && out.report.source);

  const empty = slot('export-empty');
  const out2 = run({
    scenario: 'export-without-uploads',
    db: empty.db, uploads: empty.uploads, archive: empty.archive
  });
  check('an export with no images still succeeds',
    !out2.error && out2.summary.uploads === 0,
    out2.error || 'uploads=' + out2.summary.uploads);

  const foreign = slot('export-foreign');
  const out3 = run({
    scenario: 'export-rejects-foreign-database',
    db: foreign.db, uploads: foreign.uploads, archive: foreign.archive
  });
  check('exporting a database that is not a CMS is refused',
    out3.threw === true && /expected tables/.test(out3.message || ''), out3.message);
}

function testInspect(good) {
  section('3. INSPECT — the pre-flight, which must change nothing');

  const dir = slot('inspect');
  const out = run({
    scenario: 'inspect-is-read-only',
    db: dir.db, uploads: dir.uploads, archive: dir.archive
  });
  check('inspect leaves the database exactly as it was',
    out.before === out.after && out.before === '1',
    'before=' + out.before + ' after=' + out.after);
  check('inspect reports the archive contents without importing',
    out.report && out.report.uploads === 2,
    JSON.stringify(out.report && out.report.uploads));

  const foreign = slot('inspect-foreign');
  const out2 = run({
    scenario: 'inspect-rejects-foreign-archive',
    db: foreign.db, uploads: foreign.uploads, archive: foreign.archive
  });
  check('a zip that is not a CMS export is refused',
    out2.threw === true && /data\.sql|not a Cosplay CMS/.test(out2.message || ''), out2.message);

  const newer = slot('inspect-newer');
  const out3 = run({
    scenario: 'inspect-rejects-newer-format',
    db: newer.db, uploads: newer.uploads, archive: newer.archive,
    goodArchive: good
  });
  check('an archive from a newer format version is refused, not guessed at',
    out3.threw === true && /newer version/.test(out3.message || ''), out3.message);
}

function testImport(good) {
  section('4. IMPORT');

  const dir = slot('import-replace');
  const out = run({
    scenario: 'import-replace',
    db: dir.db, uploads: dir.uploads, archive: good
  });
  check('replace removes the target-only row',
    out.costumes.length === 1 && out.costumes[0] === 'c1', JSON.stringify(out.costumes));
  check("a note containing single quotes and unicode round trips",
    out.note === "it's a note — with 'quotes'", JSON.stringify(out.note));
  check('replace restores the images',
    out.uploads.indexOf('a.webp') !== -1, JSON.stringify(out.uploads));
  check('a backup is written before anything is replaced', out.backupExists === true);
  check('the backup holds the pre-import data',
    out.backupHasOldRow === 'stale', out.backupHasOldRow);

  const merge = slot('import-merge');
  const out2 = run({
    scenario: 'import-merge-keeps-target-rows',
    db: merge.db, uploads: merge.uploads, archive: good
  });
  check('merge keeps the target-only row',
    out2.costumes.indexOf('mine') !== -1, JSON.stringify(out2.costumes));
  check('merge still imports the archive row',
    out2.costumes.indexOf('c1') !== -1, JSON.stringify(out2.costumes));
}

function testCorsByDirection(good) {
  section('5. CORS, PER MIGRATION DIRECTION');

  // ---- self-hosted -> desktop: the incoming origins are discarded --------
  const toDesktop = slot('cors-to-desktop');
  const out = run({
    scenario: 'cors-selfhosted-to-desktop-discards',
    db: toDesktop.db, uploads: toDesktop.uploads, archive: good,
    selfOrigin: 'http://127.0.0.1:4101', port: '4101'
  });
  check('a desktop target really is in permissive mode', out.isCorsDisabled === true);
  check('self-hosted -> desktop DISCARDS the incoming origins',
    out.storedCors === null, 'stored=' + JSON.stringify(out.storedCors));
  check('the discard is reported as desktop-permissive',
    out.cors && out.cors.reason === 'desktop-permissive', JSON.stringify(out.cors));

  // ---- desktop -> self-hosted: the TARGET's own rules are what survive ----
  const toServer = slot('cors-to-server');
  const out2 = run({
    scenario: 'cors-desktop-to-selfhosted-keeps-target',
    db: toServer.db, uploads: toServer.uploads, archive: good,
    port: '4001'
  });
  check('a server target is NOT in permissive mode', out2.isCorsDisabled === false);
  check("desktop -> self-hosted KEEPS the target's own origins",
    Array.isArray(out2.storedCors)
      && out2.storedCors.indexOf('https://cms.example.com') !== -1
      && out2.storedCors.indexOf('http://10.0.0.5:4001') !== -1,
    JSON.stringify(out2.storedCors));
  check('...and adds loopback for its own port',
    out2.storedCors.indexOf('http://localhost:4001') !== -1
      && out2.storedCors.indexOf('http://127.0.0.1:4001') !== -1,
    JSON.stringify(out2.storedCors));
  check('...adding nothing beyond loopback, removing nothing',
    out2.storedCors.length === 4, JSON.stringify(out2.storedCors));

  const unrelated = slot('cors-unrelated');
  const out3 = run({
    scenario: 'cors-selfhosted-keeps-unrelated-origins',
    db: unrelated.db, uploads: unrelated.uploads, archive: good,
    port: '4001'
  });
  check('a pre-existing https origin is preserved verbatim',
    out3.storedCors.indexOf('https://cms.example.com') !== -1,
    JSON.stringify(out3.storedCors));

  // ---- an env-provided allowlist must not become a stored row ------------
  //
  // The shared `good` archive carries a cors_origins row of its own
  // (http://lan.example:4001), because export-writes-archive seeds one. So the
  // imported row is expected to be there afterwards; what must NOT happen is
  // the env list being promoted into a stored row on top of it, because the
  // operator never chose that.
  const noOverride = slot('cors-no-override');
  const out4 = run({
    scenario: 'cors-target-without-override-stays-unstored',
    db: noOverride.db, uploads: noOverride.uploads, archive: good,
    port: '4001', corsEnv: 'http://localhost:4001,http://127.0.0.1:4001'
  });
  check('a target already permitting loopback needs no change',
    out4.cors && out4.cors.reason === 'already-allowed', JSON.stringify(out4.cors));
  check('the env list is NOT written into the database',
    Array.isArray(out4.storedCors)
      && out4.storedCors.indexOf('http://localhost:4001') === -1,
    'stored=' + JSON.stringify(out4.storedCors));
  check('...the stored row is exactly the one the archive carried',
    out4.storedCors.length === 1 && out4.storedCors[0] === 'http://lan.example:4001',
    JSON.stringify(out4.storedCors));

  // ---- the same import twice must not keep appending ---------------------
  const twice = slot('cors-twice');
  const out5 = run({
    scenario: 'import-restore-is-idempotent',
    db: twice.db, uploads: twice.uploads, archive: twice.archive,
    goodArchive: good, port: '4001'
  });
  check('the first import of a desktop archive adds loopback to the target',
    out5.first && out5.first.reason === 'added', JSON.stringify(out5));
  check('a second import of the same archive adds nothing further',
    out5.second && out5.second.reason === 'already-allowed', JSON.stringify(out5.second));
  check('the stored list has no duplicates after two imports',
    Array.isArray(out5.stored) && new Set(out5.stored).size === out5.stored.length,
    JSON.stringify(out5.stored));
  check("...and the target's own origin survived both runs",
    out5.stored.indexOf('https://cms.example.com') !== -1, JSON.stringify(out5.stored));
}

function testHostileArchives(good) {
  section('6. HOSTILE ARCHIVES — the ZIP-slip guard');

  const dir = slot('slip');
  const out = run({
    scenario: 'import-blocks-path-traversal',
    db: dir.db, uploads: dir.uploads,
    // The scenario REWRITES j.archive as the malicious file before importing
    // it, so it must be its own path. Pointing this at the shared `good`
    // archive would silently destroy it for every later test.
    archive: dir.archive,
    goodArchive: good
  });
  check('an entry escaping the upload directory is refused', out.threw === true, out.message);
  check('...the refusal names the escaping path',
    /escapes the upload directory/.test(out.message || ''), out.message);
  check('...nothing was written outside the upload directory', out.escaped === false);
  check('...and the database was NOT modified first',
    out.before === out.after, 'before=' + out.before + ' after=' + out.after);

  const other = slot('slip-other');
  const out2 = run({
    scenario: 'import-blocks-absolute-and-nested-entries',
    db: other.db, uploads: other.uploads,
    archive: other.archive,
    goodArchive: good
  });
  check('an absolute path entry is refused',
    out2.outcomes.absolute.threw === true, out2.outcomes.absolute.message);
  check('a nested subdirectory entry is refused',
    out2.outcomes.nested.threw === true, out2.outcomes.nested.message);
  check('a drive-letter entry is refused',
    out2.outcomes.driveLetter.threw === true, out2.outcomes.driveLetter.message);
}

// A tiny server exercising the ROUTER, run in its own process because requiring
// the router pulls in settings.js and freezes the same module-load state the
// scenarios above are careful about.
const HTTP_SCENARIO = `
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ROOT = ${JSON.stringify(ROOT)};

process.env.DATABASE_PATH = job.db;
process.env.CMS_UPLOAD_DIR = job.uploads;
process.env.CORS_ORIGIN = job.corsEnv;
delete process.env.CMS_SELF_ORIGIN;

const express = require('express');
const router = require(path.join(ROOT, 'src/routes/transfer'));

fs.mkdirSync(path.dirname(job.db), { recursive: true });
execFileSync('sqlite3', [job.db], { input: fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8') });

const app = express();
app.use(express.json());
app.use('/api', router);

const server = app.listen(0, '127.0.0.1', () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const junk = job.db + '.junk.zip';
  fs.writeFileSync(junk, 'definitely not a zip');

  const rows = () => execFileSync('sqlite3', [job.db],
    { input: 'SELECT COUNT(*) FROM Costume;' }).toString().trim();

  const post = (url, file, fields) => {
    const form = new FormData();
    if (file) form.append('archive', new Blob([fs.readFileSync(file)]), 'a.zip');
    for (const k of Object.keys(fields || {})) form.append(k, fields[k]);
    return fetch(url, { method: 'POST', body: form })
      .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
  };

  (async () => {
    const noConfirm = await post(base + '/api/transfer/import', job.archive, { mode: 'replace' });
    const rowsAfterNoConfirm = rows();
    const inspected = await post(base + '/api/transfer/inspect', job.archive, {});
    const rowsAfterInspect = rows();
    const confirmed = await post(base + '/api/transfer/import', job.archive,
      { mode: 'replace', confirm: 'true' });
    const rowsAfterConfirm = rows();
    const junkResult = await post(base + '/api/transfer/import', junk,
      { mode: 'replace', confirm: 'true' });

    console.log('@@RESULT@@' + JSON.stringify({
      noConfirm, rowsAfterNoConfirm,
      inspect: inspected.json, rowsAfterInspect,
      confirmed: { status: confirmed.status },
      rowsAfterConfirm,
      junk: junkResult
    }));
    server.close();
    process.exit(0);
  })().catch(e => {
    console.log('@@RESULT@@' + JSON.stringify({ error: e && (e.stack || e.message) }));
    process.exit(0);
  });
});
`;

function testHttpSurface(good) {
  section('7. THE HTTP SURFACE — the confirmation gate');

  const dir = slot('http');
  // dir.db is the DATABASE file, not a directory, so the job file goes beside
  // it in the uploads directory rather than "inside" it.
  const jobFile = path.join(dir.uploads, 'http-job.json');
  fs.writeFileSync(jobFile, JSON.stringify({
    db: dir.db, uploads: dir.uploads, archive: good,
    corsEnv: 'http://localhost:4001'
  }));

  // Written INSIDE the repository, not into tmpDir: this script requires
  // `express` and the app's own modules, and a file under /tmp cannot resolve
  // node_modules from this project. It is removed on the way out.
  const httpRunner = path.join(ROOT, '.test-transfer-http-scenario.js');
  fs.writeFileSync(httpRunner, HTTP_SCENARIO);
  const proc = spawnSync('node', [httpRunner, jobFile], { encoding: 'utf8', cwd: ROOT });
  try { fs.unlinkSync(httpRunner); } catch (_) { /* best effort */ }
  const marker = proc.stdout.split('@@RESULT@@')[1];
  const out = marker ? JSON.parse(marker)
    : { error: 'no result. stderr: ' + (proc.stderr || '').trim().slice(0, 600) };

  check('the router starts and answers', !out.error, out.error);
  check('an import without confirm=true is REFUSED (409)',
    out.noConfirm && out.noConfirm.status === 409, JSON.stringify(out.noConfirm));
  check('...and says why',
    out.noConfirm && out.noConfirm.json && out.noConfirm.json.code === 'CONFIRMATION_REQUIRED',
    JSON.stringify(out.noConfirm && out.noConfirm.json));
  check('...and changed nothing on disk', out.rowsAfterNoConfirm === '0', out.rowsAfterNoConfirm);
  check('inspect reports the archive without importing',
    out.inspect && out.inspect.uploads === 2, JSON.stringify(out.inspect));
  check('...and still changed nothing', out.rowsAfterInspect === '0', out.rowsAfterInspect);
  check('a confirmed import succeeds',
    out.confirmed && out.confirmed.status === 200, JSON.stringify(out.confirmed));
  check('...and the data arrived', out.rowsAfterConfirm === '1', out.rowsAfterConfirm);
  check('a junk file is a 400, not a 500',
    out.junk && out.junk.status === 400, JSON.stringify(out.junk));
}

function main() {
  testZipContainer();
  const good = buildGoodArchive();
  testExport();
  testInspect(good);
  testImport(good);
  testCorsByDirection(good);
  testHostileArchives(good);
  testHttpSurface(good);

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) { /* best effort on the way out */ }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
}

main();
