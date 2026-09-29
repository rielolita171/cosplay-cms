/**
 * End-to-end test for the Wishlist tab's server contract.
 *
 * THE WISHLIST IS A VIEW, NOT A COLLECTION
 * There is no Wishlist table and no wishlist route. A wishlist entry is a
 * Costume row whose status is WISHLIST, so everything this tab needs is two
 * things the existing list endpoint has to provide:
 *
 *   1. `statusCounts` — the per-status counts, UNFILTERED and UNPAGED. This is
 *      what the tab badge is written from, and the whole reason this suite
 *      exists: a badge computed from the returned rows would be correct on an
 *      unfiltered first page and quietly wrong under every search, every filter
 *      and every page after the first. A wrong count on a badge is worse than
 *      no badge, because the user acts on it.
 *
 *   2. `status=WISHLIST` as a filter — which already existed, and is re-asserted
 *      here because the tab depends on it and a regression there would empty
 *      the tab while leaving the badge reading "13".
 *
 * WHY IT RUNS THE ROUTER AND NOT THE SERVER
 * Same reasoning as scripts/test_makers.js: src/server.js binds a port, starts
 * the lens checker and reads the real DATABASE_PATH. The router is mounted into
 * a bare express app on port 0, so this suite can never collide with the
 * server the user actually has running, and the throwaway database means a
 * failure here cannot touch real data.
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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wishlist-test-'));
const dbFile = path.join(tmpDir, 'test.db');

// Point the app at the throwaway database BEFORE anything requires db.js, since
// DB_FILE is read at module load.
process.env.DATABASE_PATH = dbFile;

execFileSync('sqlite3', [dbFile], { input: fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8') });

// Seeded BY COLUMN NAME, not position. An earlier draft used positional VALUES
// and silently supplied one value too few; sqlite rejected the INSERT and the
// suite went on to "verify" an empty table, which passed every assertion while
// proving nothing. Naming the columns means the seed cannot drift from the
// schema again, and the row count is asserted before any behaviour is checked.
const SEED = [
  ['a', 'Blue Archive', 'Ako',  'IN_POSSESSION', 100],
  ['b', 'Blue Archive', 'Biru', 'WISHLIST',      null],
  ['c', 'Arknights',    'Chen', 'WISHLIST',       50],
  ['d', 'Arknights',    'Degen', 'ON_RENT',       null],
  ['e', 'Genshin',      'Eula',  'TO_BE_SOLD',     25]
];
SEED.forEach(([id, fandom, character, status, price]) => {
  execFileSync('sqlite3', [dbFile], {
    input: `INSERT INTO Costume (id, fandom, character, brand, status, buyPrice) `
      + `VALUES ('${id}', '${fandom}', '${character}', 'B', '${status}', ${price === null ? 'NULL' : price});`
  });
});

// Extra WISHLIST rows so the paging assertions are REAL. The route only accepts
// 10, 25 and 50 as page sizes and silently falls back to 25 for anything else,
// so a "paged" assertion written against limit=2 proved nothing: the query was
// never paged, the page was never smaller than the collection, and the
// assertion passed without exercising the thing it claimed to. Sixteen rows
// against limit=10 is the smallest honest setup — page 1 is genuinely short
// and page 2 genuinely exists.
const GENERATED_WISHLIST = 11;
for (let i = 1; i <= GENERATED_WISHLIST; i++) {
  execFileSync('sqlite3', [dbFile], {
    input: `INSERT INTO Costume (id, fandom, character, brand, status) `
      + `VALUES ('w${i}', 'Genshin', 'W${i}', 'B', 'WISHLIST');`
  });
}

const TOTAL = SEED.length + GENERATED_WISHLIST;         // 16
const WISHLIST_TOTAL = 2 + GENERATED_WISHLIST;          // 13
// Only IN_POSSESSION rows contribute to the collection worth, and only when
// they have a price: 'a' is the single such row. 'c' has a price but is a
// wishlist entry, which is the whole reason the worth total must not be summed
// from the rows a filtered request returns.
const OWNED_WORTH = 100;
const OWNED_PRICED = 1;

const counted = () => Number(execFileSync('sqlite3', [dbFile], {
  input: 'SELECT COUNT(*) FROM "Costume";'
}).toString().trim());

check(`the seed actually inserted ${TOTAL} rows`, counted() === TOTAL, `counted ${counted()}`);

const costumes = require(path.join(ROOT, 'src/routes/costumes.js'));

const app = express();
app.use(express.json());
app.use('/api/costumes', costumes);

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

// The expected counts, compared ORDER-INSENSITIVELY. A JSON.stringify equality
// against a literal would also be asserting key insertion order, which is not a
// contract the route makes — the object is built by pre-seeding the enum and
// then overwriting from the GROUP BY, so a refactor that changed which key
// landed first would fail a string comparison while the response stayed
// completely correct. That is the same class of mistake as the `\[` regex
// earlier in this project: a test that fails on correct code.
// Takes a RESPONSE BODY, not the {status, body} wrapper. Half of this suite's
// first draft passed the wrapper, which read `.statusCounts` off an object that
// only has `.status` and `.body` and so always reported MISSING — against a
// route that was returning the right counts on every single request. The tell
// was one assertion whose CONDITION read MISSING while its own DETAIL line
// printed the correct counts, because the condition and the detail disagreed
// about which of the two to pass. `Object.prototype.hasOwnProperty.call` on the
// wrapper's own keys below makes that class of mistake fail loudly in future.
function countsOf(body) {
  const c = (body && typeof body === 'object' && body.statusCounts) || null;
  if (!c) return 'MISSING';
  return Object.keys(c).sort().map(k => `${k}=${c[k]}`).join(' ');
}
const COUNTS = `IN_POSSESSION=1 ON_RENT=1 TO_BE_SOLD=1 WISHLIST=${WISHLIST_TOTAL}`;

async function main() {
  await listen();

  // -------------------------------------------------------------------------
  section('1. statusCounts is present, and every status is keyed even at zero');
  // -------------------------------------------------------------------------
  const all = await get('/api/costumes');
  check('the list responds', all.status === 200, String(all.status));
  check('the envelope carries statusCounts', !!(all.body && all.body.statusCounts),
    JSON.stringify(Object.keys(all.body || {})));
  check('the counts match the seed', countsOf(all.body) === COUNTS, countsOf(all.body));

  // A status with no rows must be a real 0 rather than an absent key. The
  // client treats `undefined` as "the server has not told us yet" and hides the
  // badge, so an omitted zero would make the badge disappear instead of
  // correctly showing there is nothing to click. 'e' is emptied here and
  // restored immediately after, so the rest of the suite still runs against the
  // seed as described.
  const emptied = await put('/api/costumes/e', { status: 'ON_RENT' });
  check('a status can be emptied for the zero-count case', emptied.status === 200, JSON.stringify(emptied.body));
  const withZero = await get('/api/costumes');
  check('an emptied status is a real 0, not a missing key',
    !!(withZero.body.statusCounts
      && withZero.body.statusCounts.TO_BE_SOLD === 0
      && Object.prototype.hasOwnProperty.call(withZero.body.statusCounts, 'TO_BE_SOLD')),
    countsOf(withZero.body));
  await put('/api/costumes/e', { status: 'TO_BE_SOLD' });
  check('restoring the row restores the count',
    (await get('/api/costumes')).body.statusCounts.TO_BE_SOLD === 1, 'not restored');

  // -------------------------------------------------------------------------
  section('2. THE BADGE CONTRACT — counts must ignore search, filter and page');
  // -------------------------------------------------------------------------
  // Each of these is a case where a naive implementation (deriving the counts
  // from the returned rows) would produce a DIFFERENT number, and a different
  // number on a tab badge is a wrong answer rather than a stale one.
  const searched = await get('/api/costumes?fandom=Arknights');
  check('a search that matches 2 of 16 rows does not shrink the counts',
    searched.body.costumes.length === 2 && countsOf(searched.body) === COUNTS,
    `rows ${searched.body.costumes.length}, ${countsOf(searched.body)}`);

  const noMatch = await get('/api/costumes?fandom=zzzz');
  check('a search matching NOTHING leaves the counts completely unchanged',
    countsOf(noMatch.body) === COUNTS, countsOf(noMatch.body));
  check('...while the rows themselves do go to zero, so the two are independent',
    noMatch.body.totalCount === 0, `totalCount ${noMatch.body.totalCount}`);

  const statusFiltered = await get('/api/costumes?status=WISHLIST');
  check('a status filter does not shrink the counts either',
    countsOf(statusFiltered.body) === COUNTS, countsOf(statusFiltered.body));

  const page1 = await get('/api/costumes?limit=10&page=1');
  check('page 1 of 10-row pages holds 10 of 16 rows',
    page1.body.costumes.length === 10 && page1.body.totalCount === TOTAL,
    `rows ${page1.body.costumes.length}, total ${page1.body.totalCount}`);
  check('...and the counts still describe the whole collection',
    countsOf(page1.body) === COUNTS, countsOf(page1.body));

  const page2 = await get('/api/costumes?limit=10&page=2');
  check('the LAST page holds the remaining 6 rows',
    page2.body.costumes.length === 6, `rows ${page2.body.costumes.length}`);
  check('...and the counts are identical there, which is the whole point',
    countsOf(page2.body) === COUNTS, countsOf(page2.body));

  // A page past the end is not an error, so this pins the behaviour the badge
  // depends on: the response is still a well-formed envelope, not a 500.
  const beyond = await get('/api/costumes?limit=10&page=99');
  check('a page past the end is empty but still carries the full counts',
    beyond.status === 200 && beyond.body.costumes.length === 0 && countsOf(beyond.body) === COUNTS,
    `status ${beyond.status}, rows ${beyond.body && beyond.body.costumes && beyond.body.costumes.length}, ${countsOf(beyond.body)}`);

  // Pins the fallback that made an earlier draft of this suite meaningless.
  const badLimit = await get('/api/costumes?limit=2');
  check('an unsupported page size falls back to 25 rather than erroring',
    badLimit.status === 200 && badLimit.body.limit === 25,
    `status ${badLimit.status}, limit ${badLimit.body && badLimit.body.limit}`);

  // -------------------------------------------------------------------------
  section('3. The list the Wishlist tab actually fetches');
  // -------------------------------------------------------------------------
  // loadWishlist() asks for status=WISHLIST&limit=50. These are the two halves
  // of the tab agreeing with its own badge: the rows are exactly the wishlist
  // entries, and totalCount equals the number on the badge.
  const wishlist = await get('/api/costumes?status=WISHLIST&limit=50');
  check('the tab fetch returns only wishlist rows',
    wishlist.body.costumes.length === WISHLIST_TOTAL
    && wishlist.body.costumes.every(c => c.status === 'WISHLIST'),
    JSON.stringify(wishlist.body.costumes.map(c => c.character + '/' + c.status).slice(0, 4)));
  check('the row count on the tab matches the badge exactly',
    wishlist.body.totalCount === wishlist.body.statusCounts.WISHLIST,
    `totalCount ${wishlist.body.totalCount} vs badge ${wishlist.body.statusCounts.WISHLIST}`);
  check('limit=50 is accepted rather than silently falling back to 25',
    wishlist.body.limit === 50, `limit ${wishlist.body.limit}`);

  // The Collection Worth total must ALSO stay unfiltered here. The wishlist
  // fetch is a filtered request and the worth card is painted from it too; if
  // worth were filtered it would read 0 on this tab, which is the exact failure
  // the worth card's own comment warned about. The interesting datum is that
  // 'c' has a price of 50 and IS returned by this query — so summing the rows
  // would give 50 instead of the correct 100.
  check('the collection worth total is whole-collection even on a filtered fetch',
    wishlist.body.totals && wishlist.body.totals.totalBuyPrice === OWNED_WORTH,
    JSON.stringify(wishlist.body.totals));
  check('the counted-costumes note agrees with it',
    wishlist.body.totals && wishlist.body.totals.countedCostumes === OWNED_PRICED,
    JSON.stringify(wishlist.body.totals));
  const pricedWishlistRows = wishlist.body.costumes.filter(c => Number(c.buyPrice) > 0).length;
  check('and a filtered response really does contain priced rows, so summing them would be wrong',
    pricedWishlistRows > 0, `${pricedWishlistRows} priced rows in the filtered result`);

  // -------------------------------------------------------------------------
  section('4. A write moves an entry on and off the wishlist, and the badge follows');
  // -------------------------------------------------------------------------
  // This is the whole point of the tab: an Edit changes a status and the entry
  // appears in or disappears from the wishlist. The badge is asserted after
  // each write because a badge that lags a write is worse than none.
  const promoted = await put('/api/costumes/a', { status: 'WISHLIST' });
  check('a costume can be moved onto the wishlist', promoted.status === 200, JSON.stringify(promoted.body));
  const afterPromote = await get('/api/costumes?status=WISHLIST&limit=50');
  check('the badge went up by one', afterPromote.body.statusCounts.WISHLIST === WISHLIST_TOTAL + 1,
    `badge ${afterPromote.body.statusCounts.WISHLIST}`);
  check('and the tab now returns one more row to match',
    afterPromote.body.costumes.length === WISHLIST_TOTAL + 1
    && afterPromote.body.totalCount === WISHLIST_TOTAL + 1,
    `rows ${afterPromote.body.costumes.length}`);

  const demoted = await put('/api/costumes/a', { status: 'IN_POSSESSION' });
  check('a costume can be moved off the wishlist', demoted.status === 200, JSON.stringify(demoted.body));
  const afterDemote = await get('/api/costumes');
  check('the badge went back down', afterDemote.body.statusCounts.WISHLIST === WISHLIST_TOTAL,
    `badge ${afterDemote.body.statusCounts.WISHLIST}`);
  check('and the tab no longer returns it',
    (await get('/api/costumes?status=WISHLIST&limit=50')).body.costumes
      .every(c => c.id !== 'a'), 'row a is still on the wishlist');

  // -------------------------------------------------------------------------
  section('5. Refusals the tab relies on');
  // -------------------------------------------------------------------------
  const badQuery = await get('/api/costumes?status=NONSENSE');
  check('an unknown status in the query is a 400', badQuery.status === 400, JSON.stringify(badQuery.body));
  const badWrite = await put('/api/costumes/a', { status: 'NONSENSE' });
  check('an unknown status on write is a 400', badWrite.status === 400, JSON.stringify(badWrite.body));
  const afterRefusal = await get('/api/costumes');
  check('...and the refused write changed no counts at all',
    countsOf(afterRefusal.body) === COUNTS, countsOf(afterRefusal.body));

  // -------------------------------------------------------------------------
  section('6. limit=all — the "show me everything" option');
  // -------------------------------------------------------------------------
  // Added because the live collection is 86 rows against a default page of 25,
  // so 61 of them were on screen nowhere and unreachable. The fix is an
  // explicit WORD rather than a large number, so the unlimited case stays
  // deliberate and `limit=1000000` cannot be used as a query-string DoS
  // against a server that authenticates nobody.
  const allRows = await get('/api/costumes?limit=all');
  check('limit=all returns every row', allRows.body.costumes.length === TOTAL,
    `rows ${allRows.body.costumes.length} of ${TOTAL}`);
  check('...and reports exactly one page', allRows.body.totalPages === 1,
    `totalPages ${allRows.body.totalPages}`);
  check('...and echoes the word back so the client can keep showing "All"',
    allRows.body.limit === 'all', `limit ${allRows.body.limit}`);
  check('...while the counts still describe the whole collection',
    countsOf(allRows.body) === COUNTS, countsOf(allRows.body));

  // It must compose with every other query parameter, or "All" would be an
  // option that quietly ignores the search box and the filters.
  //
  // COMPARED AGAINST THE SAME QUERY AT limit=25 RATHER THAN AGAINST A HAND-
  // COUNTED EXPECTATION. An earlier draft asserted `search=W1` returns 2 rows;
  // it returns 3, because 'W1', 'W10' and 'W11' all contain the substring 'W1'.
  // The count was never the property under test — the property is that "All"
  // returns exactly the rows the filtered list would, and nothing more.
  const allSearch = await get('/api/costumes?limit=all&search=W1');
  const pagedSearch = await get('/api/costumes?limit=25&search=W1');
  check('limit=all composes with search, returning the same rows as a paged search',
    allSearch.body.limit === 'all'
    && allSearch.body.totalCount === pagedSearch.body.totalCount
    && allSearch.body.costumes.length === pagedSearch.body.costumes.length
    && allSearch.body.costumes.length > 0,
    `all: ${allSearch.body.costumes.length} rows, paged: ${pagedSearch.body.costumes.length} rows`);
  const allFilter = await get('/api/costumes?limit=all&fandom=Arknights');
  check('limit=all composes with a filter', allFilter.body.costumes.length === 2
    && allFilter.body.costumes.every(c => c.fandom === 'Arknights'),
    `rows ${allFilter.body.costumes.length}`);

  // A big number is NOT the same thing. This is the property that keeps the
  // server's own default at 25 rather than letting any caller ask for anything.
  // The row count is TOTAL, not 25: the seed has 16 rows, so a 25-row page
  // legitimately returns 16 of them. An earlier draft asserted 25 rows and
  // failed against correct code for exactly that reason.
  const huge = await get('/api/costumes?limit=1000000');
  check('a large numeric limit is refused and falls back to 25, never to "all"',
    huge.body.limit === 25 && huge.body.costumes.length === TOTAL,
    `limit ${huge.body.limit}, rows ${huge.body.costumes.length}`);

  // There is only one page under "all", so echoing a stale page number would
  // briefly render "page 3 of 1" before the client clamped it.
  const allPaged = await get('/api/costumes?limit=all&page=3');
  check('limit=all forces page 1 rather than echoing a page that cannot exist',
    allPaged.body.page === 1, `page ${allPaged.body.page}`);

  // -------------------------------------------------------------------------
  section('7. collectionStats — the metric cards count the COLLECTION');
  // -------------------------------------------------------------------------
  // These were `state.costumes.length` and friends on the client, which is
  // correct only while the whole collection is in memory. Under paging that
  // made a wardrobe of 86 display as "Total Costumes: 25".
  const stats = allRows.body.collectionStats;
  check('the envelope carries collectionStats', !!(stats && typeof stats === 'object'),
    JSON.stringify(Object.keys(allRows.body)));
  check('totalCostumes is the whole collection, not the page',
    stats && stats.totalCostumes === TOTAL, JSON.stringify(stats));

  // One assertion per query shape, because the bug only appears on SOME of
  // them: a page of 10 and a page of 25 both "look fine" for a total, and it is
  // the filtered zero-row response where a derived number would collapse to 0.
  const statShapes = [
    ['/api/costumes?limit=25&page=1', 'a normal first page'],
    ['/api/costumes?limit=10&page=4', 'the last page'],
    ['/api/costumes?search=W1', 'a narrowed search'],
    ['/api/costumes?fandom=Arknights', 'a filtered fandom'],
    ['/api/costumes?status=WISHLIST', 'a status filter']
  ];
  for (const [url, label] of statShapes) {
    const r = await get(url);
    check(`collectionStats is unchanged for ${label}`,
      r.body.collectionStats && r.body.collectionStats.totalCostumes === TOTAL,
      `${url} -> ${JSON.stringify(r.body.collectionStats)} (${r.body.costumes.length} rows)`);
  }
  // SUMMED FROM THE OBJECT, NOT FROM countsOf()'S FORMATTED STRING. The first
  // version of this assertion re-parsed "WISHLIST=13 ON_RENT=1 ..." and
  // disagreed for reasons that had nothing to do with the code under test.
  const statusSum = Object.keys(allRows.body.statusCounts || {})
    .reduce((sum, k) => sum + Number(allRows.body.statusCounts[k]), 0);
  check('the total agrees with the sum of the per-status counts',
    stats && stats.totalCostumes === statusSum,
    `totalCostumes ${stats && stats.totalCostumes} vs statusCounts sum ${statusSum}`);

  // -------------------------------------------------------------------------
  section('8. The dropdown options are page- and filter-independent');
  // -------------------------------------------------------------------------
  // These used to be derived from the loaded rows. With paging that offers only
  // the fandoms that sort into the current page, so a filter for any other
  // fandom would be missing from the very control that exists to provide it.
  const page3 = await get('/api/costumes?page=3&limit=10');
  check('the option lists come from the whole collection',
    page3.body.filterOptions
    && page3.body.filterOptions.fandoms.length > 0
    && page3.body.filterOptions.brands.length > 0,
    page3.body.filterOptions
      ? `${page3.body.filterOptions.fandoms.length} fandoms`
      : 'no filterOptions');
  const zeroRows = await get('/api/costumes?fandom=NoSuchFandomAtAll');
  check('even a zero-row result offers the full dropdown',
    zeroRows.body.costumes.length === 0
    && zeroRows.body.filterOptions.fandoms.length === page3.body.filterOptions.fandoms.length,
    `${zeroRows.body.filterOptions.fandoms.length} vs ${page3.body.filterOptions.fandoms.length}`);
  const searchedDropdowns = await get('/api/costumes?search=Suisei');
  check('a search does not shrink the dropdown options',
    searchedDropdowns.body.filterOptions.fandoms.length === page3.body.filterOptions.fandoms.length,
    `${searchedDropdowns.body.filterOptions.fandoms.length} vs ${page3.body.filterOptions.fandoms.length}`);

  // -------------------------------------------------------------------------
  section('9. The client contract this tab depends on');
  // -------------------------------------------------------------------------
  // Read the HTML rather than trusting a comment. These are the wiring that has
  // to exist for the server contract above to mean anything.
  const client = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  check('the wishlist tab button exists', /data-tab="wishlist"/.test(client));
  check('the badge element exists with its own id', /id="wishlist-tab-count"/.test(client));
  check('the tab section and its grid exist',
    /id="tab-wishlist"/.test(client) && /id="wishlist-grid"/.test(client));
  check('loadWishlist() is defined', /async function loadWishlist\s*\(/.test(client));

  // THE ONE THAT MATTERS: the badge must be written from the server's counts.
  // updateWishlistCount() reading state.costumes.length, or filtering the
  // loaded rows, is the exact bug this whole server-side change exists to
  // prevent — and it is invisible in a screenshot of a small collection, which
  // is why it needs an assertion rather than a review.
  const updater = client.match(/function updateWishlistCount\s*\([\s\S]*?\n {4}\}/);
  if (updater) {
    check('the badge is written from costumeStatusCounts, not from the loaded rows',
      /costumeStatusCounts/.test(updater[0]) && /counts\.WISHLIST/.test(updater[0]),
      updater[0]);
    check('the badge treats "no counts yet" as unknown rather than as zero',
      /return;/.test(updater[0]), updater[0]);
  } else {
    check('updateWishlistCount is defined', false, 'not found');
  }

  check('the tab is bound for delegated card actions', /'wishlist-grid'/.test(client));

  // The `edit` dispatcher's LAST branch is openEditLens, so a wishlist card
  // without its own branch opens a contact-lens dialog. Asserted explicitly
  // because it is an OMISSION bug, not a typo — nothing in the file would look
  // wrong to a reader, and nothing else would fail.
  const editBranch = client.match(/if \(action === 'edit'\)[\s\S]*?openEditLens\(id\);/);
  check('wishlist cards dispatch edit to the COSTUME modal, not the lens one',
    !!(editBranch && /wishlist-grid'\)\s*openEditCostume/.test(editBranch[0])),
    editBranch ? editBranch[0] : 'edit branch not found');
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
