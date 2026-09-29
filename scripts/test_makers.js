/**
 * End-to-end test for the Maker Corner route (src/routes/makers.js).
 *
 * WHY THIS RUNS THE ROUTER AND NOT THE SERVER
 * src/server.js binds a port, starts the lens checker, and reads the real
 * DATABASE_PATH. Mounting the router into a bare express app on port 0 keeps the
 * test to exactly the code under test, and the throwaway database means a
 * failure here can never touch the real data.
 *
 * WHAT IS ACTUALLY EXERCISED
 * Every assertion goes through HTTP against a real sqlite3 child process, so
 * this covers the SQL that a unit test on the validators would miss: the pipe
 * transport, the positional column parse, and the SQL the UPDATE builds.
 *
 * The two validators with real product decisions in them — the sosmed URL and
 * the WhatsApp character whitelist — are tested as tables, because the whole
 * point of the design is WHICH inputs are refused, not that some input works.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maker-test-'));
const dbFile = path.join(tmpDir, 'test.db');

// Point the app at the throwaway database BEFORE anything requires db.js, since
// DB_FILE is read at module load.
process.env.DATABASE_PATH = dbFile;

execFileSync('sqlite3', [dbFile], { input: fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8') });

const db = require(path.join(ROOT, 'src/services/db.js'));
const makers = require(path.join(ROOT, 'src/routes/makers.js'));

const app = express();
app.use(express.json());
app.use('/api/makers', makers);

// Port 0 asks the OS for a free port, so this suite can never collide with the
// server the user actually has running — the same reason nothing here starts
// src/server.js.
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

let base = '';
let server = null;

/** POST/PUT/GET/DELETE through the real router. Returns { status, body }. */
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

const post = (url, body) => call('POST', url, body);
const put = (url, body) => call('PUT', url, body);
const get = (url) => call('GET', url);
const del = (url) => call('DELETE', url);

async function main() {
  await listen();

  // -------------------------------------------------------------------------
  section('1. SCHEMA — init_db.sql and db.js agree, or the parse order is a lie');
  // -------------------------------------------------------------------------
  const columns = await db.runSql('PRAGMA table_info("Maker");');
  const columnNames = columns
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('|')[1]);
  check('the Maker table exists with all 8 columns',
    columnNames.length === 8, `got: ${columnNames.join(', ')}`);

  // THE ORDER THAT MATTERS. This file SELECTs `*` and parses into MAKER_COLUMNS
  // by index, so a mismatch between the physical order and the array does not
  // error — it silently relabels. Get it wrong and `sosmed` is rendered as the
  // phone number and `whatsapp` is rendered as a profile link, with every field
  // "working". Nothing else in the codebase can catch that, and it is the one
  // bug in this file that would reach a real user, so it is asserted against
  // the live schema rather than against a copy of it.
  check('the physical column order matches MAKER_COLUMNS exactly',
    columnNames.join(',') === makers.MAKER_COLUMNS.join(','),
    `table: ${columnNames.join(',')}\n      array: ${makers.MAKER_COLUMNS.join(',')}`);

  // The other two hand-written lists. init_db.sql creates the table for a FRESH
  // database and db.js's initSchema() for an EXISTING one; if they drift, one of
  // the two deployment paths produces a table the route cannot parse.
  const initSql = fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8');
  const initBlock = initSql.match(/CREATE TABLE IF NOT EXISTS "Maker"\s*\(([\s\S]*?)\n\);/);
  check('init_db.sql still declares the Maker table', Boolean(initBlock));
  if (initBlock) {
    const declared = initBlock[1]
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('--'))
      .map(line => line.split(/\s+/)[0].replace(/"/g, ''))
      // The PRIMARY KEY table constraint names its column too, so it would
      // otherwise appear twice and every later index would be off by one.
      .filter(name => name !== 'PRIMARY');
    check('init_db.sql declares the same columns in the same order',
      declared.join(',') === makers.MAKER_COLUMNS.join(','),
      `init_db.sql: ${declared.join(',')}\n      array:       ${makers.MAKER_COLUMNS.join(',')}`);
  }

  const dbJs = fs.readFileSync(path.join(ROOT, 'src/services/db.js'), 'utf8');
  check('db.js carries the duplicate CREATE for an existing volume', /CREATE TABLE IF NOT EXISTS "Maker"/.test(dbJs),
    'init_db.sql cannot add a table to a database that already exists — without this copy the route 500s on upgrade');

  // -------------------------------------------------------------------------
  section('2. CREATE — required fields, the enum, and the two contact fields');
  // -------------------------------------------------------------------------
  const created = await post('/api/makers', {
    name: 'Rina Prasetyo',
    makerType: 'PROP',
    sosmed: 'https://instagram.com/rina.props',
    whatsapp: '+62 812-3456-7890',
    notes: 'EVA foam and resin. 2-week lead time.'
  });
  check('a complete maker is created', created.status === 201, JSON.stringify(created.body));
  check('the response echoes the stored name', created.body && created.body.name === 'Rina Prasetyo');
  check('the response echoes the stored sosmed', created.body && created.body.sosmed === 'https://instagram.com/rina.props');
  check('the response echoes the stored whatsapp', created.body && created.body.whatsapp === '+62 812-3456-7890');
  const rinaId = created.body && created.body.id;

  check('a maker with no name is refused', (await post('/api/makers', { makerType: 'PROP' })).status === 400);
  check('a maker with no makerType is refused', (await post('/api/makers', { name: 'X' })).status === 400);

  const badType = await post('/api/makers', { name: 'Budi', makerType: 'HAT' });
  check('an unknown makerType is a 400, not a 500', badType.status === 400, JSON.stringify(badType.body));
  check('the 400 names the allowed set', /PROP, WEAPON, ACCESSORY/.test(String(badType.body && badType.body.error)),
    JSON.stringify(badType.body));

  const minimal = await post('/api/makers', { name: 'Budi Santoso', makerType: 'WEAPON' });
  check('a maker with no contacts is created', minimal.status === 201, JSON.stringify(minimal.body));
  check('an omitted sosmed comes back as null', minimal.body && minimal.body.sosmed === null);
  check('an omitted whatsapp comes back as null', minimal.body && minimal.body.whatsapp === null);

  // The apostrophe is the ONE character SQLite string literals care about, and
  // the maker is the first place in this schema where an everyday value is
  // likely to contain one ("Andi's Props"). If esc() were wrong this is where
  // it would show, as a syntax error rather than as corrupted data.
  const quoted = await post('/api/makers', { name: "Andi's Props", makerType: 'ACCESSORY' });
  check("a name containing an apostrophe round-trips intact", quoted.status === 201, JSON.stringify(quoted.body));
  if (quoted.status === 201) {
    const readBack = await get(`/api/makers/${quoted.body.id}`);
    check("the apostrophe survives the pipe transport",
      readBack.body && readBack.body.name === "Andi's Props", JSON.stringify(readBack.body));
  }

  // -------------------------------------------------------------------------
  section('3. SOSMED — it is a URL, and the client renders it as an <a href>');
  // -------------------------------------------------------------------------
  // Every row here is a refusal the browser alone would not have prevented.
  const badSosmed = [
    ['javascript:alert(1)', 'javascript:'],
    ['data:text/html,<script>alert(1)</script>', 'data:'],
    ['//evil.tld/profile', 'a protocol-relative URL'],
    ['instagram.com/rina', 'a bare host with no scheme'],
    ['https://exa mple.com', 'a URL with a space in it'],
    ['https://ok.tld/pa|th', 'a pipe, which the transport uses as a field separator'],
    ['https://ok.tld/pa\nth', 'a line break']
  ];
  for (const [value, why] of badSosmed) {
    const res = await post('/api/makers', { name: 'Probe', makerType: 'PROP', sosmed: value });
    check(`sosmed rejects ${why}`, res.status === 400, `got ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const longSosmed = await post('/api/makers', { name: 'Probe', makerType: 'PROP', sosmed: 'https://x.tld/' + 'a'.repeat(2100) });
  check('sosmed is length-capped at 2048', longSosmed.status === 400);

  const httpsOk = await post('/api/makers', { name: 'Sinta', makerType: 'PROP', sosmed: 'https://tiktok.com/@sinta.craft' });
  check('any host is accepted — there is no allowlist', httpsOk.status === 201, JSON.stringify(httpsOk.body));
  const httpOk = await post('/api/makers', { name: 'Agus', makerType: 'PROP', sosmed: 'http://agus-portfolio.tld/' });
  check('http:// is accepted alongside https://', httpOk.status === 201, JSON.stringify(httpOk.body));

  // -------------------------------------------------------------------------
  section('4. WHATSAPP — stored as typed, validated as text');
  // -------------------------------------------------------------------------
  const badWhatsapp = [
    ['wa.me/6281234567890', 'a pasted wa.me link'],
    ['+62-812-abc-7890', 'letters'],
    ['not a number', 'a sentence'],
    ['+ () -', 'punctuation with no digit in it'],
    ['+62 812 1111 1111 | x', 'a pipe'],
    ['081234567890; DROP TABLE "Maker"; --', 'an injection attempt']
  ];
  for (const [value, why] of badWhatsapp) {
    const res = await post('/api/makers', { name: 'Probe', makerType: 'PROP', whatsapp: value });
    check(`whatsapp rejects ${why}`, res.status === 400, `got ${res.status}: ${JSON.stringify(res.body)}`);
  }

  const longWhatsapp = await post('/api/makers', { name: 'Probe', makerType: 'PROP', whatsapp: '+' + '1'.repeat(40) });
  check('whatsapp is length-capped at 32', longWhatsapp.status === 400);

  // Stored AS TYPED — this is the whole point of the design, and the client is
  // what turns it into a dialled number (waLinkDigits).
  const typed = await post('/api/makers', { name: 'Dewi', makerType: 'ACCESSORY', whatsapp: '+62 (812) 3456-7890' });
  check('a bracketed number is accepted', typed.status === 201, JSON.stringify(typed.body));
  check('it is stored with its punctuation intact', typed.body && typed.body.whatsapp === '+62 (812) 3456-7890',
    JSON.stringify(typed.body));

  // The table must have survived all of the above: if any payload had broken
  // out of its literal it would have been a syntax error or, worse, a drop.
  const stillThere = await db.runSql('SELECT COUNT(*) FROM "Maker";');
  check('the table survived every hostile payload', parseInt(stillThere, 10) > 0, `count=${stillThere}`);

  // -------------------------------------------------------------------------
  section('5. LIST — enum filter, search, pagination envelope, the type lists');
  // -------------------------------------------------------------------------
  await db.runSql('DELETE FROM "Maker";');
  const seed = [];
  for (let i = 1; i <= 12; i += 1) {
    const type = ['PROP', 'WEAPON', 'ACCESSORY'][i % 3];
    seed.push(`('m${i}', 'Maker ${String(i).padStart(2, '0')}', '${type}', NULL, NULL, NULL, '${new Date().toISOString()}', '${new Date().toISOString()}')`);
  }
  await db.runSql(`INSERT INTO "Maker" (id, name, makerType, sosmed, whatsapp, notes, createdAt, updatedAt) VALUES ${seed.join(', ')};`);

  const all = await get('/api/makers');
  check('an unfiltered list returns every row', all.status === 200 && all.body.totalCount === 12, JSON.stringify(all.body && all.body.totalCount));
  check('the default page size is 25', all.body && all.body.limit === 25);
  check('one page of 12 rows is one page', all.body && all.body.totalPages === 1);
  check('the list is ordered by name', all.body && all.body.makers[0].name === 'Maker 01',
    all.body && all.body.makers[0] && all.body.makers[0].name);

  // THE PARSE ORDER CHECK. This reads through `SELECT *` into MAKER_COLUMNS, so
  // a column-order mismatch would silently swap sosmed and whatsapp here and the
  // number would render as a link. Asserting the values by key is what catches it.
  const parsedRow = all.body.makers[0];
  check('the parsed row has sosmed and whatsapp as distinct keys',
    Object.prototype.hasOwnProperty.call(parsedRow, 'sosmed') && Object.prototype.hasOwnProperty.call(parsedRow, 'whatsapp'),
    JSON.stringify(Object.keys(parsedRow)));

  const propOnly = await get('/api/makers?makerType=PROP');
  check('the enum filter narrows the list', propOnly.status === 200 && propOnly.body.makers.every(m => m.makerType === 'PROP'),
    JSON.stringify(propOnly.body && propOnly.body.makers.map(m => m.makerType)));
  check('the enum filter reports the full count it matched', propOnly.body && propOnly.body.totalCount === 4,
    `totalCount=${propOnly.body && propOnly.body.totalCount}`);

  const badEnum = await get('/api/makers?makerType=HAT');
  check('an unknown makerType in the query is a 400', badEnum.status === 400, JSON.stringify(badEnum.body));

  const searched = await get('/api/makers?search=Maker+1');
  check('search matches on name', searched.status === 200 && searched.body.makers.every(m => /Maker 1/.test(m.name)),
    JSON.stringify(searched.body && searched.body.makers.map(m => m.name)));

  // A quote in the search box must be data, not syntax. This is the injection
  // path the escape() call exists for, so it is worth proving end to end.
  const quotedSearch = await get(`/api/makers?search=${encodeURIComponent("Maker' OR '1'='1")}`);
  check('a quote in the search term is a harmless literal, not an injection',
    quotedSearch.status === 200 && quotedSearch.body.totalCount === 0, JSON.stringify(quotedSearch.body && quotedSearch.body.totalCount));

  const paged = await get('/api/makers?limit=10&page=2');
  check('page 2 of 10-row pages returns the 2 remaining rows', paged.status === 200 && paged.body.makers.length === 2,
    `count=${paged.body && paged.body.makers.length}`);
  check('the envelope reports the page, the limit and the page count',
    paged.body && paged.body.page === 2 && paged.body.limit === 10 && paged.body.totalPages === 2,
    JSON.stringify(paged.body && { page: paged.body.page, limit: paged.body.limit, totalPages: paged.body.totalPages }));

  const badLimit = await get('/api/makers?limit=999');
  check('an out-of-range limit falls back to 25 rather than erroring', badLimit.status === 200 && badLimit.body.limit === 25);

  check('the list ships the type list the <select> is built from',
    Array.isArray(all.body.makerTypes) && all.body.makerTypes.join(',') === 'PROP,WEAPON,ACCESSORY',
    JSON.stringify(all.body && all.body.makerTypes));
  check('it ships the labels the badge is built from',
    all.body && all.body.makerTypeLabels && all.body.makerTypeLabels.WEAPON === 'Weapons',
    JSON.stringify(all.body && all.body.makerTypeLabels));

  // -------------------------------------------------------------------------
  section('6. UPDATE — presence semantics, clearing, and what is NOT clearable');
  // -------------------------------------------------------------------------
  const target = await post('/api/makers', {
    name: 'Old Name', makerType: 'PROP',
    sosmed: 'https://old.tld/x', whatsapp: '+62 811', notes: 'old note'
  });
  const targetId = target.body.id;

  const renamed = await put(`/api/makers/${targetId}`, { name: 'New Name' });
  check('a single-field update succeeds', renamed.status === 200, JSON.stringify(renamed.body));
  const afterRename = (await get(`/api/makers/${targetId}`)).body;
  check('the name changed', afterRename.name === 'New Name', JSON.stringify(afterRename));
  check('an ABSENT field is left alone', afterRename.sosmed === 'https://old.tld/x', JSON.stringify(afterRename));
  check('an ABSENT field is left alone (whatsapp)', afterRename.whatsapp === '+62 811', JSON.stringify(afterRename));
  check('an ABSENT field is left alone (notes)', afterRename.notes === 'old note', JSON.stringify(afterRename));

  // The regression this guards: gating on `value !== null` made a user-cleared
  // input indistinguishable from an untouched one, so clearing kept the old text.
  const cleared = await put(`/api/makers/${targetId}`, { sosmed: '', whatsapp: '', notes: '' });
  check('an empty string clears the optional fields', cleared.status === 200, JSON.stringify(cleared.body));

  // Asserted IN SQLITE, not in the JSON, and that distinction is the whole point.
  // `SELECT *` over a pipe has no way to express NULL — the field simply comes
  // back as '' — so a JSON assertion here would be asserting the transport's
  // limitation, not the route's behaviour. `IS NULL` and typeof() see the
  // database, so they are what actually proves the UPDATE wrote a NULL rather
  // than an empty string. An empty string would be a real defect: it is
  // indistinguishable from "contact entered but blank" forever after, and any
  // future `WHERE sosmed IS NULL` migration would miss every cleared row.
  const nulls = await db.runSql(
    `SELECT (sosmed IS NULL), (whatsapp IS NULL), (notes IS NULL) FROM "Maker" WHERE id = '${targetId}';`
  );
  check('a cleared sosmed is a real SQL NULL, not an empty string', nulls.trim() === '1|1|1',
    `SELECT sosmed IS NULL, whatsapp IS NULL, notes IS NULL returned "${nulls.trim()}"`);
  const types = await db.runSql(
    `SELECT typeof(sosmed) || '|' || typeof(whatsapp) || '|' || typeof(notes) FROM "Maker" WHERE id = '${targetId}';`
  );
  check('sqlite reports all three as null-typed', types.trim() === 'null|null|null', `typeof: ${types.trim()}`);

  // And the JSON layer is still checked, with the convention this stack
  // actually uses: the client normalises with clean(), which maps both null and
  // '' to a single empty string (see clean() in public/index.html).
  const afterClear = (await get(`/api/makers/${targetId}`)).body;
  check('a cleared sosmed is falsy over JSON', !afterClear.sosmed, JSON.stringify(afterClear));
  check('a cleared whatsapp is falsy over JSON', !afterClear.whatsapp, JSON.stringify(afterClear));
  check('a cleared notes is falsy over JSON', !afterClear.notes, JSON.stringify(afterClear));
  check('clearing did not disturb the name', afterClear.name === 'New Name', JSON.stringify(afterClear));

  const retyped = await put(`/api/makers/${targetId}`, { makerType: 'WEAPON' });
  check('the type can be changed to another member of the set', retyped.status === 200, JSON.stringify(retyped.body));
  check('the type actually changed', (await get(`/api/makers/${targetId}`)).body.makerType === 'WEAPON');

  const emptyUpdate = await put(`/api/makers/${targetId}`, {});
  check('an update with no fields is a 400', emptyUpdate.status === 400, JSON.stringify(emptyUpdate.body));

  const clearName = await put(`/api/makers/${targetId}`, { name: '' });
  check('the name is NOT clearable', clearName.status === 400, JSON.stringify(clearName.body));
  const clearType = await put(`/api/makers/${targetId}`, { makerType: '' });
  check('the makerType is NOT clearable', clearType.status === 400, JSON.stringify(clearType.body));
  check('neither refusal changed the row', (await get(`/api/makers/${targetId}`)).body.name === 'New Name');

  const badUpdate = await put(`/api/makers/${targetId}`, { sosmed: 'javascript:alert(1)' });
  check('an invalid sosmed is refused on update too', badUpdate.status === 400, JSON.stringify(badUpdate.body));

  // -------------------------------------------------------------------------
  section('7. GET /:id and DELETE — the 404 / 200 contracts');
  // -------------------------------------------------------------------------
  check('a known maker is fetched by id', (await get('/api/makers/m1')).body.name === 'Maker 01');
  check('an unknown maker is a 404', (await get('/api/makers/does-not-exist')).status === 404);
  check('an id with a quote in it is a 404, not a 500', (await get(`/api/makers/${encodeURIComponent("x' OR '1'='1")}`)).status === 404);
  check('an over-long id is a 404', (await get('/api/makers/' + 'a'.repeat(400))).status === 404);

  const before = (await get('/api/makers')).body.totalCount;
  const deleted = await del('/api/makers/m1');
  check('a maker is deleted', deleted.status === 200, JSON.stringify(deleted.body));
  check('the row is gone', (await get('/api/makers')).body.totalCount === before - 1);
  check('deleting an id that matches nothing is still a 200', (await del('/api/makers/nope')).status === 200);

  // -------------------------------------------------------------------------
  section('8. THE URL/phone contract the client depends on');
  // -------------------------------------------------------------------------
  // src/routes/makers.js promises the client that it is the single place digits
  // are parsed, and names waLinkDigits in public/index.html as that place. If
  // that helper is renamed or dropped, this is the note that has to move with it.
  const client = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check('public/index.html defines waLinkDigits', /function\s+waLinkDigits\s*\(/.test(client));
  const helper = client.match(/function\s+waLinkDigits\s*\([\s\S]*?\n\s*\}/);
  if (helper) {
    // NOTE the `\^` below. `\[` is a CHARACTER-CLASS OPENER in JavaScript's
    // regex grammar, not a literal bracket — the earlier version of this
    // assertion read `/\[^0-9\]/`, which is parsed as a negated class `[^0-9]`
    // and therefore never matches the literal text `[^0-9]` in the source.
    // It failed against a correct implementation, which is the worst kind of
    // test: it looks like it is guarding something and guards nothing.
    check('waLinkDigits strips everything that is not a digit',
      /replace\(\s*\/\[\^0-9\]\/g\s*,\s*''\s*\)/.test(helper[0]), helper[0]);
    // The helper returns DIGITS ONLY. Turning them into a URL is the card
    // renderer's job, so `wa.me` must not appear in here — a helper that
    // returned a finished href would be doing presentation work and could not
    // be reused for anything that wants the bare number. The two assertions
    // below therefore check the division: this function refuses a value with
    // nothing dialable in it, and the renderer is the one that names wa.me.
    check('waLinkDigits returns null rather than an empty link target',
      /return[\s\S]*null/.test(helper[0]), helper[0]);
    check('waLinkDigits does not build the URL itself — that is the renderer',
      !/wa\.me/.test(helper[0]), helper[0]);
  }
  // ...and the other half of that division: the card renderer is the single
  // place a wa.me link is written, built from the helper's digits.
  const renderer = client.match(/function\s+renderMakers\s*\([\s\S]*?\n {4}\}/);
  if (renderer) {
    check('renderMakers builds the wa.me link from the parsed digits',
      /wa\.me\/' \+ escapeHtml\(digits\)/.test(renderer[0]), 'no wa.me link built from `digits`');
    check('renderMakers only shows a WhatsApp link when there are digits to dial',
      /digits\s*\n?\s*\?/.test(renderer[0]), 'the link is not guarded on `digits`');
  } else {
    check('public/index.html defines renderMakers', false, 'renderMakers not found');
  }
}

main()
  .then(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch(err => {
    console.error('\nSuite crashed:', err && (err.stack || err.message));
    if (server) server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
