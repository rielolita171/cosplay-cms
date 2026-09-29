/**
 * Runtime Telegram configuration — the bot token and the delivery chat id.
 *
 * WHY THIS IS A SEPARATE MODULE FROM settings.js
 * settings.js is, despite the name, specifically the CORS allowlist: it holds
 * the synchronous in-memory cache that cors()'s origin callback has to read,
 * which is an unusual shape that exists for one consumer only. Telegram has no
 * such constraint — every read of it can be a plain await — so bolting a second
 * settings domain onto that module would mean inheriting the cache, the TTL and
 * the deferred-swap-on-'finish' machinery for no benefit. What it does share is
 * the RESOLUTION ORDER, which is the part that has to be right:
 *
 *   1. the "ServerSetting" row, if an admin has saved one   (source: 'database')
 *   2. process.env.TELEGRAM_BOT_TOKEN                        (source: 'env')
 *   3. nothing                                               (source: 'none')
 *
 * Same reason CORS does it: the row is ABSENT until an admin saves an override,
 * so "reset" is a delete and the .env value resumes by itself. No row is ever
 * seeded with a default.
 *
 * WHY THE TOKEN IS STORED AT ALL
 * Editing .env and restarting is the wrong workflow for the one credential that
 * stops working quietly: a rotated or mistyped token produces no error at boot,
 * it just silently stops delivering alerts. Being able to paste a new token and
 * see it verified in the UI is the difference between finding that out in a
 * minute and finding out weeks later.
 *
 * THE ONE THING THIS MODULE WILL NOT DO
 * It will never return the saved token. Not to a route, not to the browser, not
 * in an error message. Every read here returns a token-shaped ANSWER ABOUT the
 * token — whether one is set, where it came from, a masked fingerprint — and the
 * raw value only ever crosses back to telegramService.setRuntimeToken(). That is
 * the reason a single module owns the database read as well as the API
 * surface: it makes "return the secret to whoever asked" not a decision any
 * individual route has to get right.
 */

const { runSql, esc, parseRows, initSchema, getTelegramChatId, setTelegramChatId } = require('./db');
const telegram = require('./telegramService');

const TOKEN_SETTING_KEY = 'telegram_bot_token';

// The alert window, in days — the setting the user asked to control from the CMS
// ("the expiry threshold will be setup on my cms"). It lives here, next to the
// token, because it is the same kind of thing: runtime configuration an operator
// must be able to change without editing .env and restarting a running server.
const THRESHOLD_SETTING_KEY = 'lens_expiry_threshold_days';

// 14 matches the value the n8n workflow had hardcoded in its URL, so an install
// that has never opened Settings behaves exactly as it did before this setting
// existed. The upper bound is not arbitrary: a contact lens is a 1-day-to-2-year
// product, so a window beyond a year warns about everything forever and stops
// meaning anything.
const DEFAULT_THRESHOLD_DAYS = 14;
const MAX_THRESHOLD_DAYS = 400;

// Telegram bot tokens are `NNNNNNNN:35-40 alphanumerics`. The cap is set well
// above that so a future token format is not rejected outright, and well below
// "anything" so a pasted HTML page or a whole .env file is not silently stored
// and then handed to api.telegram.org in a request path.
const MAX_TOKEN_LENGTH = 256;

/**
 * Check a candidate bot token's SHAPE.
 *
 * Deliberately only shape, never validity. The only authority on whether a token
 * works is Telegram itself (getBotInfo), and pretending to be a second opinion
 * here would produce exactly the failure this feature exists to remove: a
 * locally-passing check that says nothing about the real credential. What the
 * shape check does catch is the case where sending would be pointless anyway —
 * an empty box, or a 4 KB paste that would bloat the ServerSetting row.
 *
 * @returns {{ok: true, token: string} | {ok: false, reason: string}}
 */
function validateToken(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'must be a text token' };
  }
  const value = raw.trim();

  if (!value) {
    return { ok: false, reason: 'is empty' };
  }
  if (telegram.isUnusableToken(value)) {
    return {
      ok: false,
      reason: 'still holds the placeholder from .env.example — paste the real token BotFather gave you'
    };
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: `is longer than ${MAX_TOKEN_LENGTH} characters` };
  }
  if (/\s/.test(value)) {
    // A token never contains whitespace, and one that does is nearly always a
    // token pasted along with its surrounding quotes or a trailing newline that
    // .trim() could not reach because a character was pasted instead.
    return { ok: false, reason: 'contains whitespace — paste only the token itself' };
  }
  if (value.indexOf(':') === -1) {
    return { ok: false, reason: "is missing the ':' that separates the bot id from the secret" };
  }
  return { ok: true, token: value };
}

/**
 * A non-reversible description of a token, safe to show in a browser.
 *
 * The bot id (the part before the colon) is public — it appears in @username
 * links — and is what makes the field identifiable at a glance. The secret tail
 * is reduced to its LENGTH and a fixed-width fingerprint instead of being shown,
 * printed or stored anywhere the page can be read back.
 */
function tokenFingerprint(token) {
  const value = String(token || '');
  const separator = value.indexOf(':');
  const botId = separator === -1 ? '' : value.slice(0, separator);
  const secret = separator === -1 ? value : value.slice(separator + 1);

  // FNV-1a, rendered as 6 hex digits. Not a security primitive and not used as
  // one — there is nothing to protect here, because the value it digests is
  // never transmitted. Its only job is to let a human tell "the token I saved
  // is still the token in force" from "something replaced it" without the
  // secret ever leaving the server.
  let hash = 0x811c9dc5;
  for (let i = 0; i < secret.length; i++) {
    hash ^= secret.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const fingerprint = hash.toString(16).toUpperCase().padStart(8, '0').slice(0, 6);

  return {
    botId: botId || null,
    secretLength: secret.length,
    fingerprint
  };
}

/**
 * Read the saved token out of "ServerSetting".
 *
 * The two failure modes are handled differently on purpose:
 *   - NO TABLE / no row is the NORMAL state of a fresh install and on a cold
 *     boot, where the app can accept a request before the async initSchema()
 *     chain has run. It answers null, rather than logging a scary error for
 *     something that is not wrong.
 *   - A row that is present but holds something that is no longer a valid token
 *     is logged and ignored. A hand-edited or truncated value must not be able
 *     to become the live credential; falling back to .env is strictly safer
 *     than sending a mangled token.
 */
function readStoredToken() {
  return initSchema()
    .then(() => runSql(`SELECT value FROM "ServerSetting" WHERE key = ${esc(TOKEN_SETTING_KEY)} LIMIT 1;`))
    .then(output => {
      const row = parseRows(output, ['value'])[0];
      if (!row || row.value === null || row.value === undefined) return null;
      const stored = String(row.value);
      if (!stored) return null;
      const check = validateToken(stored);
      if (!check.ok) {
        console.warn(`⚠️  Stored Telegram bot token ${check.reason} — ignoring it and using TELEGRAM_BOT_TOKEN from the environment.`);
        return null;
      }
      return check.token;
    })
    .catch(error => {
      if (error && /no such table/i.test(error.message || '')) return null;
      throw error;
    });
}

/** Write (or clear) the saved token. The value is stored, never returned. */
function writeStoredToken(token) {
  return initSchema().then(() => {
    const value = (token === null || token === undefined) ? null : String(token);
    const now = new Date().toISOString();
    // upsert rather than INSERT OR REPLACE, so createdAt is not reset on every
    // save. updatedBy is NULL because there is no account to name.
    return runSql(
      `INSERT INTO "ServerSetting" (key, value, updatedAt, updatedBy)
       VALUES (${esc(TOKEN_SETTING_KEY)}, ${value === null ? 'NULL' : esc(value)}, ${esc(now)}, NULL)
       ON CONFLICT(key) DO UPDATE SET value = ${value === null ? 'NULL' : esc(value)}, updatedAt = ${esc(now)};`
    );
  });
}

/**
 * The effective configuration, WITHOUT the secret.
 *
 * @returns {Promise<{token: {configured, source, botId, secretLength, fingerprint},
 *                    chatId: string|null}>}
 */
function getTelegramConfig() {
  return Promise.all([readStoredToken(), getTelegramChatId()])
    .then(([stored, chatId]) => {
      // The `source` label is what lets the UI say "you are on the token from
      // .env" versus "an admin saved this one", which is the difference between
      // a config that is working and a config that looks like it is.
      const token = stored
        ? { configured: true, source: 'database', ...tokenFingerprint(stored) }
        : (telegram.getEnvToken()
          ? { configured: true, source: 'env', ...tokenFingerprint(telegram.getEnvToken()) }
          : { configured: false, source: 'none', botId: null, secretLength: 0, fingerprint: null });

      return { token, chatId: chatId || null };
    });
}

/**
 * Save a token, validate the shape, and put it in force immediately.
 *
 * The write and the in-memory swap are a single awaited unit, unlike the CORS
 * route's deliberate persist-then-defer swap. The reason is that this token
 * guards nothing at request time: it is only ever read when a notification is
 * actually being sent, which is always on a later request. There is no current
 * request whose verdict could be changed by the swap, so the machinery CORS
 * needs to avoid a self-inflicted 403 has no counterpart here, and deferring
 * would only mean the admin saves a token and the very next Send test still
 * uses the old one.
 *
 * @returns {Promise<{ok: boolean, error?: string, code?: string, config: object}>}
 */
function saveTelegramToken(raw) {
  const check = validateToken(raw);
  if (!check.ok) {
    return getTelegramConfig().then(config => ({
      ok: false,
      code: 'VALIDATION_ERROR',
      error: `The bot token ${check.reason}.`,
      config
    }));
  }

  return writeStoredToken(check.token)
    .then(() => {
      telegram.setRuntimeToken(check.token);
      return getTelegramConfig();
    })
    .then(config => ({ ok: true, code: 'OK', config }));
}

/** Drop the saved token so the .env value takes over again. */
function clearTelegramToken() {
  return writeStoredToken(null)
    .then(() => {
      telegram.clearRuntimeToken();
      return getTelegramConfig();
    })
    .then(config => ({ ok: true, code: 'OK', config }));
}

/**
 * Save the delivery chat id, with the same "an empty box clears it" rule the
 * database helper already applies.
 */
function saveTelegramChatId(raw) {
  return initSchema()
    .then(() => {
      const value = (raw === null || raw === undefined) ? '' : String(raw);
      return setTelegramChatId(value.trim());
    })
    .then(() => getTelegramConfig())
    .then(config => ({ ok: true, code: 'OK', config }));
}

/**
 * Called once at boot: push the persisted token into the transport.
 *
 * Without this, a token saved through the Settings form would work until the
 * next restart, which is the single most confusing possible behaviour for a
 * setting the UI presents as saved.
 */
function primeTelegramConfig() {
  return readStoredToken()
    .then(stored => {
      // Only set when there IS a stored one. Otherwise clearRuntimeToken() would
      // wipe a perfectly good env token, and clearing an unset variable to unset
      // reads as a change that nobody asked for.
      if (stored) telegram.setRuntimeToken(stored);
      return stored ? 'database' : (telegram.getEnvToken() ? 'env' : 'none');
    })
    .catch(error => {
      console.warn('⚠️  Could not read the saved Telegram token at boot:', error.message);
      return 'none';
    });
}

/**
 * The alert window, resolved the same way the token is: saved row, else the
 * default. Absent an override this returns the default rather than null, so
 * every caller gets a usable number and none of them has to invent a fallback —
 * which is how a 14 and a 30 end up disagreeing between the endpoint and the UI.
 *
 * The value is re-validated on READ, exactly as the token is, because the row
 * can be hand-edited and this number decides whether a real lens gets an alert.
 * A corrupt row degrades to the default instead of going quiet.
 */
function getExpiryThresholdDays() {
  return initSchema()
    .then(() => runSql(`SELECT value FROM "ServerSetting" WHERE key = ${esc(THRESHOLD_SETTING_KEY)} LIMIT 1;`))
    .then(output => {
      const row = parseRows(output, ['value'])[0];
      if (!row || row.value === null || row.value === undefined) return DEFAULT_THRESHOLD_DAYS;
      const parsed = Number(String(row.value).trim());
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_THRESHOLD_DAYS) {
        console.warn(`⚠️  Stored lens expiry threshold is not a usable number — using ${DEFAULT_THRESHOLD_DAYS}.`);
        return DEFAULT_THRESHOLD_DAYS;
      }
      return parsed;
    })
    .catch(error => {
      // "no such table" is the normal cold-boot / fresh-install state, and the
      // default is a perfectly good answer for it — so it is not an error.
      if (error && /no such table/i.test(error.message || '')) return DEFAULT_THRESHOLD_DAYS;
      // Any other database trouble also degrades to the default rather than
      // propagating: failing this read would take the notification endpoint
      // down entirely, and no alert at all is strictly worse than an alert at
      // the wrong window.
      console.warn('⚠️  Could not read the lens expiry threshold:', error.message);
      return DEFAULT_THRESHOLD_DAYS;
    });
}

/** Write (or clear) the threshold. A null/empty restores the default. */
function setExpiryThresholdDays(days) {
  return initSchema().then(() => {
    const value = (days === null || days === undefined || days === '') ? null : String(days);
    const now = new Date().toISOString();
    return runSql(
      `INSERT INTO "ServerSetting" (key, value, updatedAt, updatedBy)
       VALUES (${esc(THRESHOLD_SETTING_KEY)}, ${value === null ? 'NULL' : esc(value)}, ${esc(now)}, NULL)
       ON CONFLICT(key) DO UPDATE SET value = ${value === null ? 'NULL' : esc(value)}, updatedAt = ${esc(now)};`
    );
  }).then(() => getExpiryThresholdDays());
}

module.exports = {
  TOKEN_SETTING_KEY,
  THRESHOLD_SETTING_KEY,
  DEFAULT_THRESHOLD_DAYS,
  MAX_THRESHOLD_DAYS,
  MAX_TOKEN_LENGTH,
  validateToken,
  tokenFingerprint,
  getTelegramConfig,
  saveTelegramToken,
  clearTelegramToken,
  saveTelegramChatId,
  getExpiryThresholdDays,
  setExpiryThresholdDays,
  primeTelegramConfig
};
