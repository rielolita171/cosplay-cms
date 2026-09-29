// ============================================================================
// LENS EXPIRY CHECKER — the CMS sends its own Telegram alert
// ============================================================================
//
// WHAT THIS IS
// A setInterval inside the CMS process that wakes up once a day, asks the
// database which contact lenses are expiring inside the window the operator
// configured in Settings, and sends them a Telegram message. There is no n8n,
// no cron on the host, and no second application to keep in step with this one.
//
// WHY IT EXISTS RATHER THAN THE n8n WORKFLOW
// The n8n workflow this replaces had the alert window baked into its own URL
// (`?days=14`). Changing how early you wanted to hear about a lens meant
// opening a JSON file in a different application, and forgetting to re-import
// it. The window is the operator's decision and it now lives next to the data
// it applies to, in the same screen, editable without a restart.
//
// THE ONE THING THAT MAKES A DAILY CHECKER SAFE TO LEAVE RUNNING
// "Notify me about lenses expiring within 14 days" is a *state*, not an
// *event*. A checker that re-sent on every run would message the user every
// single day for two weeks about the same two lenses, and would keep doing it
// after they were already expired. Every lens is therefore bucketed by how many
// days are left — 14, 7, 3, 1, 0, and a bucket for "already expired" — and a
// lens is only messaged about when it ENTERS one of those buckets. The bucket
// it was last messaged about is remembered per lens, so the second run has
// nothing to say and stays silent.
//
// A lens is NOT recorded until its message actually went out. That ordering is
// the difference between "the reminder exists" and "the reminder was
// delivered", and it is why a send that fails is retried on the next run
// instead of being silently swallowed as already-done.
//
// The record lives in the ServerSetting table as JSON rather than in a new
// table, for the same reason the token does: the app already has a key/value
// table with a schema this service does not have to migrate, and the state is
// genuinely a small per-lens map.
//
// A STALE RECORD IS PRUNED rather than left to grow forever. A lens that gets
// deleted, or that is replaced by a new row when it is opened again, would
// otherwise leave its key behind forever.
// ============================================================================

const db = require('./db');
const telegram = require('./telegramService');
const telegramConfig = require('./telegramConfig');

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;   // once a day
const DEFAULT_STARTUP_DELAY_MS = 10 * 1000;      // let boot finish first

// The run-up buckets: the countdowns a lens is messaged about on its way down.
// 60 is the widest, 0 is "expires today", and negative is the EXPIRED bucket
// handled separately in bucketFor().
//
// THE WIDEST ENTRY IS A FLOOR, NOT THE WINDOW. The operator's actual alert
// window is a separate setting (the telegram expiry threshold, which goes up to
// 400 days) and can be WIDER than 60; the band above 60 is not spelled out here
// because its size depends on that setting, so bucketFor() mints it. See there.
const ALERT_BUCKETS = [60, 14, 7, 3, 1, 0];

// Beyond this a "day remaining" is a date that is simply not set (or is a year
// away), not something the user needs reminding about. It is a backstop against
// a nonsense or hand-edited date, not the ceiling on the alert window: the
// operator's own threshold is capped separately at MAX_THRESHOLD_DAYS.
const MAX_DAYS_TRACKED = 60 * 12;

const LEDGER_SETTING_KEY = 'lens_expiry_alerted';

// Set when the module is loaded with no token available yet, so the startup log
// can say so. The check itself re-reads the token every run, so pasting one
// into Settings needs no restart.
let timer = null;
let running = false;

// ---------------------------------------------------------------------------
// TIME HELPERS
// ---------------------------------------------------------------------------
//
// The whole feature turns on "how many days are left", and a timezone mistake
// here is not cosmetic: UTC parsing turns a lens expiring at midnight into one
// that expires the previous afternoon, which is enough to put a lens in the
// wrong bucket and either warn a day early or not at all.

/**
 * The given instant floored to its own local midnight, as a Date.
 *
 * The floor is by CALENDAR fields rather than by subtracting a number of
 * milliseconds, because 24h is not the length of a day: on a DST boundary the
 * two differ by an hour, and that hour is enough to push a lens that expires
 * tonight into yesterday's bucket.
 *
 * Called with no argument it means "today", which is how the countdowns below
 * are measured.
 */
function startOfDay(value) {
  const d = value || new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * The instant this lens actually expires.
 *
 * A `YYYY-MM-DD` column is a CALENDAR day — the lenses in it are good through
 * the end of that day — so it is read as local midnight. A value that already
 * carries a time is a timestamp and is read as it stands. Both are then
 * advanced to the END of that day, which is what "expiry date" means for a
 * product you use up until it is finished.
 *
 * @returns {Date|null} null when the value is absent or unparseable.
 */
function lensExpiryInstant(value) {
  const raw = (value === null || value === undefined) ? '' : String(value).trim();
  if (!raw || raw.toUpperCase() === 'NULL') return null;

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly ? (raw + 'T00:00:00') : raw);
  if (isNaN(parsed.getTime())) return null;

  if (dateOnly) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999);
  }
  return parsed;
}

/** Whole days from today until `instant`; negative once it has passed. */
function daysUntilInstant(instant, now) {
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.round((startOfDay(instant) - startOfDay(now)) / dayMs);
}

/**
 * The countdown bucket this lens has entered, or null when it is not one the
 * user should be reminded about.
 *
 * ALREADY EXPIRED is its own bucket, not bucket 0, because a lens that is ten
 * days overdue and one that expires today need different wording and must not
 * be re-alerted on the same schedule.
 *
 * `thresholdDays` is the operator's configured window. It is what makes the
 * wide-window case work, so it is a parameter rather than something read from
 * settings inside here: bucketFor() is a pure function, and the caller already
 * has the threshold in hand.
 *
 * @param {number} days whole days remaining; negative once expired.
 * @param {number} [thresholdDays] the configured window, defaulting to the
 *   widest bucket when not supplied.
 * @returns {{key: string, days: number}|null}
 */
function bucketFor(days, thresholdDays) {
  if (!Number.isFinite(days)) return null;
  if (days > MAX_DAYS_TRACKED) return null;

  // A COUNTDOWN, not a debt: this is tested first, before the windows below,
  // because a negative number satisfies `days > 0` and would otherwise be
  // filed as "expires today" — telling the user a lens that died last week is
  // fine until it is still there a month later, never re-alerted, because its
  // bucket never changes again. One stable EXPIRED bucket for the whole of
  // "already gone" is what stops the reminder dying with the thing it is
  // reminding about.
  if (days < 0) return { key: 'EXPIRED', days };

  // THE BAND ABOVE THE WIDEST FIXED BUCKET.
  //
  // ALERT_BUCKETS tops out at 60, but the operator's window goes up to 400 days,
  // so the list alone cannot express a window wider than 60. Falling off the
  // end of it and returning null here would mean a user who asks for a 200-day
  // warning is sent NOTHING between 200 and 60 days out, and then gets a single
  // unrequested alert at 60 — the setting silently becoming a 60-day one, which
  // is the exact failure the fixed bucket list exists to prevent.
  //
  // So the band is minted instead, and keyed by the window it belongs to: with
  // a 200-day setting, everything from 200 days out down to 61 shares the key
  // 'DW200', which the lens ENTERS once and then leaves — at 60 it becomes 'D60'
  // and is messaged about again. A key that contains the window is what keeps
  // that behaviour honest: editing the window changes the key, so the lens is
  // legitimately "newly in a bucket" and the user hears about their new setting
  // rather than the alert going quiet because the bucket silently moved under
  // a remembered key.
  const widest = ALERT_BUCKETS[0];
  const top = Number.isFinite(thresholdDays) && thresholdDays > widest ? Math.floor(thresholdDays) : widest;
  if (days > widest) return { key: 'DW' + top, days };

  // Otherwise: the bucket the lens is INSIDE, working from the tightest window
  // inwards. 10 days out is inside 14 but not inside 7, so the answer is the
  // 14-day bucket. Reading the list the other way round (matching the widest
  // window first) makes every lens inside 60 days a "60 day" bucket, which
  // throws the countdown away and quietly turns the operator's 14-day setting
  // into a 60-day one.
  for (let i = ALERT_BUCKETS.length - 1; i >= 0; i--) {
    const limit = ALERT_BUCKETS[i];
    if (days > limit) continue;
    return { key: 'D' + limit, days };
  }

  // Unreachable while ALERT_BUCKETS holds a 0 as its last entry — every
  // non-negative whole number is inside one of them — but returned rather than
  // falling off the end, so that adding a bucket which stopped short of today
  // degrades to "no alert" instead of to a crash.
  return null;
}

// ---------------------------------------------------------------------------
// LEDGER
// ---------------------------------------------------------------------------

/**
 * Read the "last bucket this lens was alerted about" map.
 *
 * A corrupt or absent record reads as an EMPTY map rather than throwing. The
 * cost of that is one duplicate reminder; the cost of throwing would be no
 * reminders at all, which is the failure the user would actually notice.
 */
function readLedger() {
  // The key goes in as a SQL IDENTIFIER, written literally, never through
  // db.esc(). The escaping helper's job is to quote a *value*, so passing an
  // already-quoted literal to it produces ''key'' — two quote characters
  // rather than one escaped quote, and SQLite rejects the statement outright
  // with a syntax error. Every call then fell back to the empty ledger, which
  // is the one outcome that makes the checker re-alert about everything.
  return db.runSql(`SELECT value FROM "ServerSetting" WHERE key = "${LEDGER_SETTING_KEY}" LIMIT 1;`)
    .then(output => {
      if (!output) return {};
      const first = String(output).split('\n')[0];
      if (!first) return {};
      const parsed = JSON.parse(first);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const clean = {};
      Object.keys(parsed).forEach(key => {
        const entry = parsed[key];
        if (entry && typeof entry === 'object' && typeof entry.bucket === 'string') {
          clean[key] = { bucket: entry.bucket, date: typeof entry.date === 'string' ? entry.date : '' };
        }
      });
      return clean;
    })
    .catch(error => {
      console.warn('⚠️  Could not read the expiry alert ledger (starting empty):', error.message);
      return {};
    });
}

function writeLedger(ledger) {
  return db.runSql(`
    INSERT INTO "ServerSetting" (key, value, updatedAt, updatedBy)
    VALUES ("${LEDGER_SETTING_KEY}", ${db.esc(JSON.stringify(ledger))}, datetime('now'), 'lens-expiry-checker')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt, updatedBy = excluded.updatedBy;
  `).catch(error => {
    console.warn('⚠️  Could not persist the expiry alert ledger:', error.message);
  });
}

/**
 * Forget lenses that no longer exist.
 *
 * A deleted lens, and a lens replaced by a fresh row when it is opened again,
 * would otherwise leave a key behind that nothing ever reads again. The ledger
 * is small, but "small" is not a reason to let it grow without bound.
 */
function pruneLedger(ledger, liveIds) {
  let removed = 0;
  Object.keys(ledger).forEach(key => {
    if (!liveIds.has(key)) {
      delete ledger[key];
      removed++;
    }
  });
  if (removed) console.log(`   🧹 Pruned ${removed} stale entr${removed === 1 ? 'y' : 'ies'} from the alert ledger.`);
  return removed;
}

// ---------------------------------------------------------------------------
// THE CHECK
// ---------------------------------------------------------------------------

/** The active, undiposed lenses, oldest expiry first. */
function loadLenses() {
  const columns = ['id', 'color', 'brand', 'prescription', 'expiryDate', 'status', 'openedDate'];
  const sql = `SELECT id, color, brand, prescription, expiryDate, status, openedDate FROM "ContactLens" WHERE status != 'DISPOSED' ORDER BY expiryDate ASC;`;
  return db.runSql(sql).then(output => db.parseRows(output, columns));
}

/**
 * One pass: find the lenses that have newly entered a warning window, message
 * the user, and record only the ones that were actually delivered.
 *
 * Split out of start() and exported so a test — or a future "check now" button
 * — can drive a run without waiting for the timer.
 *
 * @param {{now?: Date, force?: boolean}} [options]
 *   `force` ignores the ledger and messages about every qualifying lens. It
 *   exists for the Settings "Check now" control; the daily run never sets it.
 * @returns {Promise<object>} a summary, never throws.
 */
async function runCheck(options) {
  const opts = options || {};
  const now = opts.now || new Date();
  const force = opts.force === true;

  // Both reads degrade on their own (getTelegramConfig -> null token,
  // getExpiryThresholdDays -> the built-in default), so this cannot reject for
  // a database reason. It is still a promise, and an unhandled rejection here
  // would take the process down, so it is awaited inside the try.
  const config = await telegramConfig.getTelegramConfig();
  const thresholdDays = await telegramConfig.getExpiryThresholdDays();

  if (!config.chatId || !config.token || !config.token.configured) {
    return { ok: false, code: 'NOT_CONFIGURED', error: 'The bot token or chat id is not set yet.', sent: 0 };
  }

  const lenses = await loadLenses();
  const ledger = await readLedger();
  const liveIds = new Set(lenses.map(lens => String(lens.id)));

  const fresh = [];
  lenses.forEach(lens => {
    const id = String(lens.id);
    const instant = lensExpiryInstant(lens.expiryDate);
    if (!instant) return;

    const days = daysUntilInstant(instant, now);
    const bucket = bucketFor(days, thresholdDays);
    if (!bucket) return;

    // Only lenses inside the CONFIGURED window are considered at all. A user
    // who narrows the window to 3 days must not keep receiving the 30-day
    // reminder they used to get.
    if (days > thresholdDays) return;

    // The rule the whole feature rests on: silent unless the bucket changed.
    const known = ledger[id];
    if (!force && known && known.bucket === bucket.key) return;

    fresh.push({ lens, id, days, bucket });
  });

  if (!fresh.length) {
    pruneLedger(ledger, liveIds);
    return { ok: true, sent: 0, thresholdDays, total: lenses.length, alreadyNotified: liveIds.size - fresh.length };
  }

  const text = composeMessage(fresh, thresholdDays, now);
  const result = await telegram.sendTelegramMessageStrict(config.chatId, text);

  if (!result.ok) {
    // Deliberately NOT recorded. The next run will try again, which is the
    // behaviour a reminder is supposed to have — an alert that failed to send
    // is not an alert that has been given.
    return { ok: false, code: result.code, error: result.error, sent: 0, thresholdDays, pending: fresh.length };
  }

  fresh.forEach(entry => {
    ledger[entry.id] = { bucket: entry.bucket.key, date: entry.lens.expiryDate || '' };
  });
  pruneLedger(ledger, liveIds);
  await writeLedger(ledger);

  return {
    ok: true,
    sent: fresh.length,
    thresholdDays,
    total: lenses.length,
    simulated: result.simulated === true,
    messageId: result.messageId || null
  };
}

/**
 * The message body.
 *
 * One message for the whole run, not one per lens: a user with five lenses
 * expiring this month should get one notification they read once, not five
 * that flood the chat over the course of an afternoon.
 *
 * HTML is used because it is what the sender's parse_mode expects; every
 * interpolated value goes through escapeHtml() in the transport, so a lens
 * colour of `<b>` is shown as those characters rather than as bold markup.
 */
function composeMessage(entries, thresholdDays, now) {
  const stamp = now || new Date();
  const lines = entries.map(entry => {
    const lens = entry.lens;
    const name = [lens.color, lens.brand].map(part => String(part || '').trim()).filter(Boolean).join(' · ') || 'Unnamed lens';

    let when;
    if (entry.bucket.key === 'EXPIRED') {
      const overdue = Math.abs(entry.days);
      when = `expired <b>${overdue} day${overdue === 1 ? '' : 's'} ago</b>`;
    } else if (entry.days === 0) {
      when = 'expires <b>today</b>';
    } else if (entry.days === 1) {
      when = 'expires <b>tomorrow</b>';
    } else {
      when = `expires in <b>${entry.days} days</b>`;
    }

    const power = String(lens.prescription || '').trim();
    return `• <b>${name}</b> — ${when}${power ? ` (${power})` : ''}`;
  });

  const head = entries.length === 1
    ? '1 contact lens needs attention'
    : entries.length + ' contact lenses need attention';
  const plural = thresholdDays === 1 ? '' : 's';

  return [
    '👁 <b>Cosplay CMS — contact lenses</b>',
    '',
    head + ' (alerted ' + thresholdDays + ' day' + plural + ' ahead):',
    '',
    lines.join('\n'),
    '',
    `Checked ${stamp.toLocaleString('en-GB')}.`
  ].join('\n');
}

// ---------------------------------------------------------------------------
// TIMER
// ---------------------------------------------------------------------------

/**
 * Begin the daily check.
 *
 * Idempotent: a second call while a timer is live is ignored rather than
 * doubling the rate, because start() is reachable from a re-import and a
 * second interval would silently mean two daily messages.
 *
 * @param {{immediate?: boolean}} [options] `immediate` runs one check on the
 *   spot instead of waiting out the startup delay. Used by the Settings
 *   "Check now" button.
 */
function start(options) {
  const opts = options || {};
  if (timer) return false;

  const delay = opts.immediate ? 0 : DEFAULT_STARTUP_DELAY_MS;
  timer = setTimeout(function tick() {
    runOnce();
    // Re-armed inside the callback rather than by setInterval, so a slow run
    // cannot stack: the next tick is a day after THIS one finished.
    timer = setTimeout(tick, CHECK_INTERVAL_MS);
  }, delay);
  // A pending alert is the only reason this process must stay alive, and an
  // idle timer should never be a reason it cannot exit.
  if (timer.unref) timer.unref();

  return true;
}

/** Stop the daily check. Safe to call when it was never started. */
function stop() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    return true;
  }
  return false;
}

function isRunning() {
  return timer !== null;
}

/**
 * Run one check, with the in-flight guard and the logging.
 *
 * runCheck() is written to resolve rather than reject, so this wrapper exists
 * for the two things it cannot: logging, and making sure a rejection never
 * reaches the timer callback as an unhandled one.
 */
async function runOnce(options) {
  if (running) {
    console.log('⏳ Expiry check already running; skipping this tick.');
    return { ok: false, code: 'ALREADY_RUNNING' };
  }
  running = true;
  try {
    const result = await runCheck(options);

    if (result.ok) {
      if (result.sent) {
        console.log(`🔔 Expiry alert sent for ${result.sent} contact lens${result.sent === 1 ? '' : 'es'}.`);
      } else {
        console.log('🔕 Nothing newly expiring — no message sent.');
      }
    } else if (result.code === 'NOT_CONFIGURED') {
      // The expected state before the token is pasted in, so this is a log
      // line and not a warning; the boot banner already says it once.
      console.log('🔕 Expiry check skipped: ' + result.error);
    } else {
      console.warn('⚠️  Expiry check failed:', result.error || result.code);
    }
    return result;
  } catch (error) {
    console.warn('⚠️  Expiry check crashed:', (error && error.message) || error);
    return { ok: false, code: 'CRASHED', error: (error && error.message) || String(error) };
  } finally {
    running = false;
  }
}

module.exports = {
  start,
  stop,
  isRunning,
  runCheck,
  // Exported for the unit test and for the "what would you send me?" preview.
  composeMessage,
  bucketFor,
  lensExpiryInstant,
  daysUntilInstant,
  ALERT_BUCKETS,
  CHECK_INTERVAL_MS,
  LEDGER_SETTING_KEY
};
