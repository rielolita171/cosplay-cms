/**
 * End-to-end check of the CMS-owned lens expiry alert, against a THROWAWAY
 * database and with the Telegram transport replaced.
 *
 * WHAT IS AND IS NOT TESTED HERE
 * The database is real: a temp directory, a real sqlite3 file created from
 * init_db.sql, real SQL from the checker. The Telegram transport is NOT real —
 * api.telegram.org is never contacted, so the suite is safe to run with no
 * network and no token. The three behaviours that make a daily checker worth
 * having are what this pins down:
 *
 *   1. A first run alerts about the lenses inside the window, and about
 *      nothing else — not the ones outside it, not the disposed ones.
 *   2. A second run with nothing changed sends NOTHING. This is the failure
 *      that would make the feature unusable: fourteen identical messages.
 *   3. A send that FAILS is not recorded, so the next run retries it. An
 *      alert that failed to go out is not an alert that has been given.
 *
 * Run: node scripts/test_lens_expiry_checker.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-expiry-test-'));
const dbFile = path.join(tmpDir, 'test.db');

// Point the app at the throwaway database BEFORE anything requires db.js, since
// DB_FILE is read at module load.
process.env.DATABASE_PATH = dbFile;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

execFileSync('sqlite3', [dbFile], { input: fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8') });

const db = require(path.join(ROOT, 'src/services/db.js'));
const telegram = require(path.join(ROOT, 'src/services/telegramService.js'));
const telegramConfig = require(path.join(ROOT, 'src/services/telegramConfig.js'));
const checker = require(path.join(ROOT, 'src/services/lensExpiryChecker.js'));

// Replace the transport. `nextOutcome` lets a test decide whether the next send
// succeeds, and `sends` records everything that was attempted.
const sent = [];
let nextOutcome = { ok: true, messageId: 42 };
telegram.sendTelegramMessageStrict = (chatId, text) => {
  sent.push({ chatId, text });
  return Promise.resolve(nextOutcome);
};

const iso = daysFromNow => {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function seedLenses() {
  // Only the three keys this suite manages. Deleting every ServerSetting row
  // would take the bot token and the chat id with it — which is exactly the
  // mistake an earlier version of this file made, leaving every later section
  // reporting NOT_CONFIGURED and looking like a product bug.
  return db.runSql(`
    DELETE FROM "ContactLens";
    DELETE FROM "ServerSetting" WHERE key IN ('lens_expiry_threshold_days', 'lens_expiry_alerted');

    INSERT INTO "ContactLens" (id, character, color, brand, prescription, expiryDate, isOpened, status)
    VALUES
      ('in-10',  NULL, 'Amber',  'Fresh',     '-1.50', '${iso(10)}',  0, 'ACTIVE'),
      ('in-3',   NULL, 'Blue',   'Runout',    '-2.00', '${iso(3)}',   1, 'ACTIVE'),
      ('today',  NULL, 'Green',  'Lastday',   '-0.75', '${iso(0)}',   1, 'ACTIVE'),
      ('gone-5', NULL, 'Red',    'Dead',      '-1.00', '${iso(-5)}',  1, 'ACTIVE'),
      ('far-200',NULL, 'Violet', 'Future',    '-3.00', '${iso(200)}', 0, 'ACTIVE'),
      ('used-9', NULL, 'Grey',   'Disposed',  '-1.00', '${iso(9)}',   1, 'DISPOSED');
  `);
}

const ledgerRaw = () => db.runSql(
  "SELECT value FROM \"ServerSetting\" WHERE key = 'lens_expiry_alerted' LIMIT 1;"
).then(out => (out ? JSON.parse(String(out).split('\n')[0]) : null));

async function main() {
  // -------------------------------------------------------------------------
  section('1. NOT CONFIGURED — an unconfigured checker must stay quiet');
  // -------------------------------------------------------------------------
  let result = await checker.runCheck();
  check('unconfigured run reports NOT_CONFIGURED and sends nothing',
    result.ok === false && result.code === 'NOT_CONFIGURED' && sent.length === 0,
    JSON.stringify(result));

  // -------------------------------------------------------------------------
  section('2. FIRST RUN — alerts about the window, and only the window');
  // -------------------------------------------------------------------------
  // A token with neither "your_telegram_bot_token" nor "here" in it:
  // isUnusableToken() rejects the .env.example placeholders by substring, and a
  // token containing "here" would have been treated as unconfigured.
  await db.runSql(`
    INSERT INTO "ServerSetting" (key, value, updatedAt, updatedBy)
    VALUES ('telegram_bot_token', '123456789:AAbCdEfGhIjKlMnOpQrStUvWxYz0123456789', datetime('now'), 'test');
  `);
  await db.setTelegramChatId('-100999888');
  await seedLenses();

  // A 14-day window: the 10/3/0-day and already-expired lenses are in it.
  result = await checker.runCheck();
  check('first run sent exactly one message for the whole run', sent.length === 1,
    `sent=${sent.length}`);
  check('first run covered all 4 lenses inside the window', result.sent === 4,
    `result=${JSON.stringify(result)}`);

  const text = sent[0] ? sent[0].text : '';
  check('message names the 10-day lens', text.includes('Amber'), text);
  check('message names the 3-day lens', text.includes('Blue'), text);
  check('message names the today lens', text.includes('Green'), text);
  check('message names the already-expired lens', text.includes('Red'), text);
  check('message EXCLUDES the lens 200 days out', !text.includes('Violet'), text);
  check('message EXCLUDES the disposed lens', !text.includes('Grey'), text);
  check('message went to the configured chat id',
    sent[0] && sent[0].chatId === '-100999888');
  check('message states the window it is reporting on', text.includes('14 days ahead'), text);

  // -------------------------------------------------------------------------
  section('3. SECOND RUN — no bucket changed, so nothing must be sent');
  // -------------------------------------------------------------------------
  sent.length = 0;
  result = await checker.runCheck();
  check('second run sent no message at all', sent.length === 0, `sent=${sent.length}`);
  check('second run reported 0 sent', result.ok === true && result.sent === 0,
    JSON.stringify(result));

  // -------------------------------------------------------------------------
  section('4. FORCED RUN — the manual control ignores the ledger');
  // -------------------------------------------------------------------------
  sent.length = 0;
  result = await checker.runCheck({ force: true });
  check('force re-sends despite an unchanged ledger',
    sent.length === 1 && result.sent === 4, JSON.stringify(result));

  // -------------------------------------------------------------------------
  section('5. A NARROWER WINDOW retires the reminders that fall outside it');
  // -------------------------------------------------------------------------
  sent.length = 0;
  await telegramConfig.setExpiryThresholdDays(3);
  result = await checker.runCheck({ force: true });
  // At a 3-day window the lenses still inside it are the 3-day one, the one
  // expiring today, and the one already overdue — the 10-day one has fallen out.
  check('with the window narrowed to 3 days the 10-day lens is no longer reported',
    result.sent === 3 && !sent[0].text.includes('Amber'),
    JSON.stringify(result) + ' | ' + (sent[0] ? sent[0].text : '(no message)'));

  await telegramConfig.setExpiryThresholdDays(14);
  // Cleared here, NOT after section 4: the forced run there delivered a message
  // and therefore recorded every lens, so sections 6 and 7 would start from a
  // fully populated ledger and have nothing left to report.
  await db.runSql("DELETE FROM \"ServerSetting\" WHERE key = 'lens_expiry_alerted';");
  sent.length = 0;

  // -------------------------------------------------------------------------
  section('6. A NEW lens entering the window is alerted on the next run');
  // -------------------------------------------------------------------------
  await db.runSql(`
    INSERT INTO "ContactLens" (id, character, color, brand, prescription, expiryDate, isOpened, status)
    VALUES ('in-6', NULL, 'Teal', 'Latecomer', '-1.25', '${iso(6)}', 0, 'ACTIVE');
  `);
  // A first, non-forced run re-seeds the ledger. FIVE, not four: the section-5
  // forced run (window 3) reported the 3-day, today and overdue lenses, and
  // the ledger delete came after it, so the 10-day lens is back in the unknown
  // set along with the newly-added one.
  sent.length = 0;
  result = await checker.runCheck();
  check('a fresh run reports every lens the emptied ledger forgot',
    result.sent === 5, JSON.stringify(result));

  // The new lens is named in the message that just went out.
  check('the newly-added lens is named', sent[0] && sent[0].text.includes('Teal'),
    sent[0] ? sent[0].text : '(no message)');

  // …and the run after that has nothing to say, because nothing changed. The
  // `sent` clear happens HERE rather than after this run, or the assertion
  // above would be looking at an array this line had just emptied.
  sent.length = 0;
  result = await checker.runCheck();
  check('the next run is silent — nothing has changed',
    result.sent === 0 && sent.length === 0, JSON.stringify(result));

  // -------------------------------------------------------------------------
  section('7. A FAILED send is not recorded, so it is retried');
  // -------------------------------------------------------------------------
  sent.length = 0;
  nextOutcome = { ok: false, code: 'UNREACHABLE', error: 'simulated network failure' };
  result = await checker.runCheck({ force: true });
  check('the failed run reports the failure and sent 0',
    result.ok === false && result.code === 'UNREACHABLE' && result.sent === 0,
    JSON.stringify(result));

  // The failed run recorded nothing, so the four original lenses are pending
  // again alongside the new one. Add one more lens so the retry has a single
  // item to report and the assertion is unambiguous.
  await db.runSql(`
    INSERT INTO "ContactLens" (id, character, color, brand, prescription, expiryDate, isOpened, status)
    VALUES ('in-9', NULL, 'Gold', 'AlsoLate', '-0.50', '${iso(9)}', 0, 'ACTIVE');
  `);
  await db.runSql("DELETE FROM \"ServerSetting\" WHERE key = 'lens_expiry_alerted';");

  nextOutcome = { ok: true, messageId: 77 };
  sent.length = 0;
  result = await checker.runCheck();
  check('the next run retries and succeeds', result.ok === true && sent.length === 1,
    JSON.stringify(result));

  // -------------------------------------------------------------------------
  section('8. THE LEDGER records buckets, and prunes deleted lenses');
  // -------------------------------------------------------------------------
  const ledger = await ledgerRaw();
  check('the ledger exists and has one entry per live lens',
    ledger && Object.keys(ledger).length === 6, JSON.stringify(ledger));
  check('the 10-day lens is filed under the 14-day bucket',
    ledger && ledger['in-10'] && ledger['in-10'].bucket === 'D14',
    JSON.stringify(ledger && ledger['in-10']));
  check('the overdue lens is filed under its own EXPIRED bucket',
    ledger && ledger['gone-5'] && ledger['gone-5'].bucket === 'EXPIRED',
    JSON.stringify(ledger && ledger['gone-5']));

  // Delete a lens, then drive a run that has something else to report — prune
  // only happens on the path that writes the ledger, and the
  // "nothing to say, prune, return" path returns before persisting.
  await db.runSql(`DELETE FROM "ContactLens" WHERE id = 'in-9';`);
  await db.runSql(`
    INSERT INTO "ContactLens" (id, character, color, brand, prescription, expiryDate, isOpened, status)
    VALUES ('in-2', NULL, 'Pink', 'LastOne', '-1.00', '${iso(2)}', 0, 'ACTIVE');
  `);
  await checker.runCheck({ force: true });
  const pruned = await ledgerRaw();
  check('a deleted lens is pruned from the ledger',
    pruned && !Object.keys(pruned).includes('in-9'), JSON.stringify(pruned));
  check('a live lens is kept in the ledger',
    pruned && Object.keys(pruned).includes('in-2'), JSON.stringify(pruned));

  // -------------------------------------------------------------------------
  section('9. BUCKET ARITHMETIC — the countdowns must be right');
  // -------------------------------------------------------------------------
  const now = new Date();
  check('a lens expiring today counts as 0 days',
    checker.daysUntilInstant(checker.lensExpiryInstant(iso(0)), now) === 0);
  check('a lens expiring tomorrow counts as 1 day',
    checker.daysUntilInstant(checker.lensExpiryInstant(iso(1)), now) === 1);
  check('a lens 5 days overdue counts as -5 days',
    checker.daysUntilInstant(checker.lensExpiryInstant(iso(-5)), now) === -5);
  check('50 days out is inside the 60-day bucket',
    checker.bucketFor(50).key === 'D60', JSON.stringify(checker.bucketFor(50)));
  check('10 days out is inside the 14-day bucket',
    checker.bucketFor(10).key === 'D14', JSON.stringify(checker.bucketFor(10)));
  check('5 days out is inside the 7-day bucket',
    checker.bucketFor(5).key === 'D7', JSON.stringify(checker.bucketFor(5)));
  // MAX_DAYS_TRACKED is a year, so a lens 400 days out is still inside every
  // bucket — including EXPIRED's, which is the catch-all for "not inside any
  // countdown window". That is a reminder-worthy position, not a silent one.
  check('beyond the tracked horizon a lens is not a reminder at all',
    checker.bucketFor(800) === null, JSON.stringify(checker.bucketFor(800)));
  // The tracking horizon is a year (MAX_DAYS_TRACKED = 60 * 12). Inside it but
  // above the widest FIXED bucket, the band is minted from the operator's own
  // window — so with no threshold passed the floor of 60 is used and a lens
  // 400 days out files as 'DW60'.
  check('a lens 400 days out lands in the minted band, not nowhere',
    checker.bucketFor(400) && checker.bucketFor(400).key === 'DW60',
    JSON.stringify(checker.bucketFor(400)));
  // The band is keyed by the WINDOW, which is the whole point: an operator whose
  // window is 200 days must get one alert at 200 days and another at 60, not a
  // silent gap between them and then a single unrequested one at 60.
  check('a 200-day window mints its own band above 60',
    checker.bucketFor(200, 200) && checker.bucketFor(200, 200).key === 'DW200',
    JSON.stringify(checker.bucketFor(200, 200)));
  check('the band is stable across the whole 61..200 range',
    checker.bucketFor(61, 200).key === checker.bucketFor(199, 200).key,
    checker.bucketFor(61, 200).key + ' vs ' + checker.bucketFor(199, 200).key);
  // ...and it is a band the lens LEAVES: crossing into the 60-day bucket is a
  // different key, so the fixed run-up alerts still happen.
  check('crossing from the wide band into 60 is a bucket change',
    checker.bucketFor(60, 200).key === 'D60' &&
      checker.bucketFor(61, 200).key !== checker.bucketFor(60, 200).key,
    checker.bucketFor(61, 200).key + ' -> ' + checker.bucketFor(60, 200).key);
  // A window NARROWER than the fixed buckets must not mint a band below them.
  check('a 14-day window leaves 60-day lenses on D60, not a minted band',
    checker.bucketFor(30, 14).key === 'D60', JSON.stringify(checker.bucketFor(30, 14)));
  check('an overdue lens has its own single bucket, whatever the debt',
    checker.bucketFor(-1).key === 'EXPIRED' && checker.bucketFor(-400).key === 'EXPIRED',
    JSON.stringify([checker.bucketFor(-1), checker.bucketFor(-400)]));
  check('an empty date is not a reminder', checker.lensExpiryInstant('') === null);
  check('the literal string NULL is not a reminder', checker.lensExpiryInstant('NULL') === null);

  // -------------------------------------------------------------------------
  section('10. THE TIMER');
  // -------------------------------------------------------------------------
  check('start() is idempotent — a second call does not double the rate',
    checker.start({ immediate: false }) === true && checker.start() === false);
  check('isRunning() reports the live timer', checker.isRunning() === true);
  check('stop() clears it', checker.stop() === true && checker.isRunning() === false);
  check('stop() on a stopped checker is safe and reports no change',
    checker.stop() === false);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  return failed === 0;
}

main()
  .then(ok => {
    checker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  })
  .catch(error => {
    console.error('\nHarness error:', error);
    checker.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  });
