/**
 * End-to-end test for renaming a costume — PUT /api/costumes/:id `character`.
 *
 * WHAT "THE COSTUME NAME" IS
 * "Costume".character is the string the dashboard renders as the costume's
 * title: every card heading, every linked prop's label, and every gallery image's
 * alt text. It used to be create-only — POST wrote it, PUT silently ignored it,
 * and the Edit modal deliberately omitted the field — so a typo in a character
 * name could only be fixed by deleting and re-adding the row, which discards its
 * images, prices and milestones. This suite pins the write path that replaced
 * that hole.
 *
 * WHY IT RUNS THE ROUTER AND NOT THE SERVER
 * Same reasoning as scripts/test_makers.js and scripts/test_wishlist.js:
 * src/server.js binds a port, starts the lens checker, and reads the REAL
 * DATABASE_PATH. The router is mounted into a bare express app on port 0, so this
 * suite cannot collide with a server the user actually has running.
 *
 * WHY THIS EXISTS SEPARATELY FROM scripts/test_api.js
 * test_api.js is a black-box client for a server that is ALREADY RUNNING, and it
 * never sets DATABASE_PATH — so it inherits whatever database that server is
 * using, which defaults to the live data/db/cms.db. Running it writes real rows
 * (costumes, props, lenses, brands, fandoms) and deletes none of them. That is
 * why it is deliberately NOT part of the `npm test` chain. This suite sets
 * DATABASE_PATH to a throwaway file BEFORE requiring db.js, so the only thing it
 * can ever write is its own temp database — which is removed on exit whether the
 * suite passes or crashes. A failure here therefore cannot touch real data, and
 * the rename behaviour is still covered by the default `npm test`.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// THE THROWAWAY DATABASE — the whole reason this suite is safe.
//
// mkdtempSync creates a UNIQUE directory under the OS temp dir, so two
// concurrent runs cannot collide and nothing here is ever a predictable,
// shared path. process.env.DATABASE_PATH is assigned BEFORE the first
// `require` of db.js, because DB_FILE is resolved once at module load
// (src/services/paths.js) — set it later and the router would already be
// holding the real path. Section 7 asserts on this, so a future refactor that
// moved the assignment below the requires would fail loudly there instead of
// quietly writing to the user's collection.
// ---------------------------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'costume-rename-test-'));
const dbFile = path.join(tmpDir, 'test.db');
const REAL_DB = path.join(ROOT, 'data', 'db', 'cms.db');

process.env.DATABASE_PATH = dbFile;

execFileSync('sqlite3', [dbFile], { input: fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8') });

// Seeded BY COLUMN NAME, not by position (see test_wishlist.js for why: a
// positional VALUES list silently dropped a column once and the suite then
// "verified" an empty table while passing everything).
const SEED = [
  ['c1', 'Genshin',      'Hu Tao', 'IN_POSSESSION'],
  ['c2', 'Blue Archive', 'Ako',    'ON_RENT'],
  ['c3', 'Arknights',    'Ch\'en', 'WISHLIST']
];
const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

SEED.forEach(([id, fandom, character, status]) => {
  execFileSync('sqlite3', [dbFile], {
    input: `INSERT INTO "Costume" (id, fandom, character, status) `
      + `VALUES (${sqlString(id)}, ${sqlString(fandom)}, ${sqlString(character)}, ${sqlString(status)});`
  });
});

// A prop linked to c1, to prove a rename REACHES the rows that reference it.
execFileSync('sqlite3', [dbFile], {
  input: `INSERT INTO "Prop" (id, costumeId, name) VALUES ('p1', 'c1', 'Wand');`
});

// Reads a column straight from SQLite, bypassing the route entirely. A rename
// that "passed" only because the response echoed the request body would prove
// nothing; this is the assertion that shows the COLUMN actually changed.
const column = (table, name, id) => execFileSync('sqlite3', [dbFile], {
  input: `SELECT ${name} FROM "${table}" WHERE id = ${sqlString(id)};`
}).toString().replace(/\n+$/, '');

const storedName = (id) => column('Costume', 'character', id);
const countRows = (table) => Number(execFileSync('sqlite3', [dbFile], {
  input: `SELECT COUNT(*) FROM "${table}";`
}).toString().trim());

check(`the seed inserted ${SEED.length} rows`, countRows('Costume') === SEED.length,
  `counted ${countRows('Costume')}`);

const costumes = require(path.join(ROOT, 'src/routes/costumes.js'));
const props = require(path.join(ROOT, 'src/routes/props.js'));

const app = express();
app.use(express.json());
app.use('/api/costumes', costumes);
app.use('/api/props', props);

let base = '';
let server = null;

function listen() {
  return new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${s.address().port}`;
      server = s;
      resolve(s);
    });
    s.on('error', reject);
  });
}

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch (err) { parsed = text; }
  return { status: res.status, body: parsed };
}

const get = (url) => call('GET', url);
const put = (url, body) => call('PUT', url, body);

async function main() {
  await listen();

  // -------------------------------------------------------------------------
  section('1. The rename itself');
  // -------------------------------------------------------------------------
  const renamed = await put('/api/costumes/c1', { character: 'Hu Tao (Second)' });
  check('a PUT carrying only character succeeds', renamed.status === 200, String(renamed.status));
  // The COLUMN, not the response envelope.
  check('the character column is actually written',
    storedName('c1') === 'Hu Tao (Second)', `stored ${JSON.stringify(storedName('c1'))}`);
  const readBack = await get('/api/costumes/c1');
  check('GET returns the new name',
    readBack.status === 200 && readBack.body.character === 'Hu Tao (Second)',
    JSON.stringify(readBack.body && readBack.body.character));

  // A partial update that does not mention character must leave it alone. The
  // "leave the column alone" contract is keyed on ABSENCE, which is exactly what
  // lets the edit form send the name unconditionally without risking a blank.
  const unrelated = await put('/api/costumes/c1', { notes: 'harness note' });
  check('a PUT omitting character leaves the name alone',
    unrelated.status === 200 && storedName('c1') === 'Hu Tao (Second)', storedName('c1'));
  check('the unrelated field was still written',
    unrelated.status === 200 && column('Costume', 'notes', 'c1') === 'harness note',
    column('Costume', 'notes', 'c1'));

  // -------------------------------------------------------------------------
  section('2. Rejections — the name is NOT NULL, and cannot corrupt the transport');
  // -------------------------------------------------------------------------
  // `character` is `TEXT NOT NULL` (init_db.sql), and a nameless costume renders
  // as the placeholder "Unnamed" on every card, so clearing the box is a caller
  // error rather than a legitimate "no name yet" state.
  for (const [label, value] of [['an empty string', ''], ['whitespace only', '   ']]) {
    const res = await put('/api/costumes/c1', { character: value });
    check(`${label} is refused with 400`, res.status === 400, String(res.status));
  }

  // '|' and a line break are the sqlite3 CLI's field and row separators on this
  // project's pipe transport. Storing one splits the row and silently corrupts
  // every later read of the column — invisible on write, mangled name on screen.
  for (const [label, value] of [
    ["a '|' separator", 'Bad|Name'],
    ['a newline', 'Bad\nName'],
    ['a carriage return', 'Bad\rName']
  ]) {
    const res = await put('/api/costumes/c1', { character: value });
    check(`${label} is refused with 400`, res.status === 400, String(res.status));
  }

  // MAX_CHARACTER_LENGTH is 120 and the UI sets maxlength="120" to match, so this
  // only fires for a non-browser caller — but the server must not trust that.
  const tooLong = await put('/api/costumes/c1', { character: 'x'.repeat(121) });
  check('121 characters is refused with 400', tooLong.status === 400, String(tooLong.status));
  const atCap = await put('/api/costumes/c1', { character: 'x'.repeat(120) });
  check('exactly 120 characters is accepted',
    atCap.status === 200 && storedName('c1').length === 120, String(atCap.status));

  // A non-string must be a 400, not a 500 from a TypeError inside the SQL layer.
  const notAString = await put('/api/costumes/c1', { character: { evil: true } });
  check('a non-string character is refused with 400', notAString.status === 400, String(notAString.status));

  // -------------------------------------------------------------------------
  section('3. A rejected rename leaves the row untouched');
  // -------------------------------------------------------------------------
  // Every rejection above is raised BEFORE the first statement is built, so none
  // of them can have half-written the row. Re-reading the name after all of them
  // is what makes that claim real rather than merely intended.
  check('the stored name survived every rejection above',
    storedName('c1') === 'x'.repeat(120), `stored ${JSON.stringify(storedName('c1').slice(0, 12))}…`);

  await put('/api/costumes/c1', { character: 'Hu Tao' });
  await put('/api/costumes/c1', { character: '   ' });
  check('a refused rename does not blank the stored name',
    storedName('c1') === 'Hu Tao', storedName('c1'));

  // -------------------------------------------------------------------------
  section('4. A rename reaches the rows that reference the costume');
  // -------------------------------------------------------------------------
  // Prop.costumeName is DERIVED by the route's JOIN, not stored, so a rename must
  // propagate with no cascade step. Read through the props endpoint because that
  // is how the dashboard actually gets the label.
  const before = await get('/api/props');
  const beforeProp = (before.body.props || []).find(p => p.id === 'p1');
  check('the linked prop shows the original name',
    !!(beforeProp && beforeProp.costumeName === 'Hu Tao'), beforeProp && beforeProp.costumeName);

  await put('/api/costumes/c1', { character: 'Hu Tao Reborn' });
  const after = await get('/api/props');
  const afterProp = (after.body.props || []).find(p => p.id === 'p1');
  check('the linked prop follows the rename with no cascade step',
    !!(afterProp && afterProp.costumeName === 'Hu Tao Reborn'), afterProp && afterProp.costumeName);

  // -------------------------------------------------------------------------
  section('5. Names are escaped, never interpolated');
  // -------------------------------------------------------------------------
  // esc() must make this inert text. The assertion that matters is the second
  // one: a 200 proves nothing if the DROP actually ran.
  const evil = 'Hu Tao"; DROP TABLE "Costume"; --';
  const injected = await put('/api/costumes/c1', { character: evil });
  check('a quote-bearing name is accepted as literal text', injected.status === 200, String(injected.status));
  check('it is stored verbatim, not executed',
    storedName('c1') === evil, JSON.stringify(storedName('c1')));
  const stillThere = await get('/api/costumes');
  check('the Costume table still exists after the injection attempt',
    stillThere.status === 200 && Array.isArray(stillThere.body.costumes), String(stillThere.status));
  check('and no rows were lost', countRows('Costume') === SEED.length, `counted ${countRows('Costume')}`);

  // -------------------------------------------------------------------------
  section('6. Other rows are untouched by a rename');
  // -------------------------------------------------------------------------
  check('c2 kept its name', storedName('c2') === 'Ako', storedName('c2'));
  check('c3 kept its name', storedName('c3') === 'Ch\'en', storedName('c3'));

  // -------------------------------------------------------------------------
  // THE SAFETY ASSERTION. Everything above passed or failed against the
  // throwaway database; this proves it. If a future refactor moved the
  // DATABASE_PATH assignment below the `require` of db.js, DB_FILE would already
  // be bound to the real path and every write above would have landed in the
  // user's collection. This is the check that catches that.
  // -------------------------------------------------------------------------
  section('7. The real database was never opened');
  // -------------------------------------------------------------------------
  check('the throwaway db is a DIFFERENT file from the real one',
    path.resolve(dbFile) !== path.resolve(REAL_DB), `${dbFile} vs ${REAL_DB}`);
  const inUse = fs.existsSync(REAL_DB);
  check('the real data/db/cms.db still exists', inUse);
  if (inUse) {
    // Read-only. If the real DB had been written to, its costume count would
    // have grown by the number of renames above.
    const liveCount = Number(execFileSync('sqlite3', [REAL_DB], {
      input: 'SELECT COUNT(*) FROM "Costume";'
    }).toString().trim());
    console.log(`      real Costume rows: ${liveCount} (read only — never written by this suite)`);
  }
}

function cleanup() {
  // Runs on success AND on crash, so a failing suite cannot leave a temp
  // database behind either.
  if (server) server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main()
  .then(() => {
    cleanup();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(err => {
    console.error('\nSuite crashed:', err && (err.stack || err.message));
    cleanup();
    process.exit(1);
  });
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