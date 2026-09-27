/**
 * Admin-editable, runtime CORS allowlist.
 *
 * WHY THIS EXISTS
 * The allowlist used to be a boot-time `const` built from process.env.CORS_ORIGIN.
 * Changing it meant an SSH session, an edit to .env, and a restart of a server
 * that was actively serving the app. That is an awful way to fix a typo in an
 * origin, and the whole point of this module is to make the common case — "this
 * origin is wrong / this new hostname is not on the list" — a change an admin
 * can make from the Security tab, applied to the running process immediately.
 *
 * RESOLUTION ORDER (highest priority first)
 *   1. the "ServerSetting" row, if an admin has saved one  (source: 'database')
 *   2. process.env.CORS_ORIGIN                             (source: 'env')
 *   3. the hardcoded DEFAULT_CORS_ORIGIN                    (source: 'default')
 *
 * The .env value stays authoritative until an admin explicitly saves an
 * override, and "reset" simply deletes the row so the fallback resumes. That
 * means the blast radius of a bad admin save is bounded by the reset button,
 * not by a restart.
 *
 * WHY THE CACHE EXISTS, AND WHY THERE IS STILL A TTL
 * `cors()`'s `origin` callback is SYNCHRONOUS — it must return a verdict
 * before the request continues. That makes a per-request database read
 * impossible: the callback cannot await. So the effective list is resolved
 * asynchronously at most once per CACHE_TTL_MS and held in memory, and the
 * middleware reads the in-memory copy synchronously.
 *
 * The TTL is not redundant belt-and-braces, it covers two real cases that an
 * in-process "set the cache on write" update cannot:
 *   - an OUT-OF-BAND edit. Someone edits the ServerSetting row directly with
 *     the sqlite3 CLI, or restores a backup, or a second process writes it.
 *     Nothing in this process would ever learn about it. The TTL makes the
 *     cache self-heal within CACHE_TTL_MS instead of pinning the old value
 *     until the next restart.
 *   - a failed or lost cache update. If the write path throws between the
 *     database write and the cache swap, the TTL recovers on its own.
 * 5 seconds is short enough to be irrelevant to a human and long enough that
 * it is one query per 5s rather than one per request.
 */

const { runSql, esc, parseRows } = require('./db');

const CORS_SETTING_KEY = 'cors_origins';

// Kept identical to the value server.js used before this module existed, so an
// install with no CORS_ORIGIN and no saved override behaves exactly as it did.
const DEFAULT_CORS_ORIGIN = 'http://localhost:4001';

// Caps. An allowlist is a short list of origins a human recognises; anything
// much larger is a sign of a mistake (or of someone pasting a whole log in),
// and an unbounded list makes the UI unusable.
const MAX_ORIGINS = 20;
const MAX_ORIGIN_LENGTH = 200;

const CACHE_TTL_MS = 5000;

// In-memory cache. `origins` is the resolved allowlist, `source` records where
// it came from so GET /api/settings/cors can tell the admin why the effective
// list is what it is.
let cache = null;        // { origins, source, loadedAt }
let refreshInFlight = null; // single-flight guard for the async refresh

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Normalise and check ONE candidate origin.
 *
 * Every rule below exists because of a specific way an allowlist entry can
 * turn a strict-origin check into a wide-open one, or into a silent no-op that
 * looks like a save that "didn't take".
 *
 * @returns {{ok: true, origin: string} | {ok: false, reason: string}}
 */
function validateOneOrigin(raw) {
  // Rule: must be a non-empty string. `origins: [null]`, `origins: [42]` and
  // `origins: [["a"]]` are all things a careless client sends.
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'must be a text origin' };
  }
  const value = raw.trim();
  if (!value) {
    return { ok: false, reason: 'is empty' };
  }

  // Rule: reject the wildcard outright, before anything else looks at it.
  // WHY: with `credentials: true`, `Access-Control-Allow-Origin: *` is
  // actually rejected by browsers, so the wildcard does not even "work" here —
  // but the real danger is that it reads as "allow everything" to whoever set
  // it, and any future change that made the header reflect the request origin
  // (a very common refactor) would turn it into exactly that. The point of
  // rejecting it here is that `*` becomes UNREPRESENTABLE in the database
  // rather than merely ignored when the list is read back.
  if (value === '*') {
    return {
      ok: false,
      reason: 'is the wildcard "*", which cannot be combined with credentialed CORS'
    };
  }

  // Rule: reject the literal string "null" — the opaque origin.
  // WHY: a page served from a sandboxed iframe, a data: URL, or a local file
  // opened with file:// sends `Origin: null`. Every one of those is a context
  // an attacker can get a victim to run their page in, and allowing "null"
  // hands all of them credentialed access to this API in a single stroke.
  if (value.toLowerCase() === 'null') {
    return {
      ok: false,
      reason: 'is the opaque origin "null", which sandboxed and file:// pages can send'
    };
  }

  // Rule: cap the length. A multi-KB "origin" is not an origin.
  if (value.length > MAX_ORIGIN_LENGTH) {
    return {
      ok: false,
      reason: `is longer than ${MAX_ORIGIN_LENGTH} characters`
    };
  }

  // Rule: must parse as an absolute URL. This is what rejects bare hostnames
  // ("example.com") and relative junk, which would otherwise be stored and
  // never match anything.
  let url;
  try {
    url = new URL(value);
  } catch (_e) {
    return { ok: false, reason: 'is not a valid absolute URL (include http:// or https://)' };
  }

  // Rule: http/https only.
  // WHY: `file:`, `data:`, `javascript:`, `chrome-extension:` and friends are
  // all schemes a hostile page could otherwise register, and a browser happily
  // sends an Origin header naming them.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `uses the "${url.protocol.replace(':', '')}" scheme; only http and https are allowed`
    };
  }

  // Rule: no embedded credentials.
  // WHY: `http://user:pass@host` puts a secret in a database row and in every
  // UI that renders the allowlist, and no real origin ever contains one.
  if (url.username || url.password) {
    return { ok: false, reason: 'must not embed credentials (user:pass@)' };
  }

  // Rule: no path, query or fragment.
  // WHY: none of these are part of an origin — the Origin header a browser
  // sends is scheme://host[:port] and nothing else. A value carrying a path
  // can therefore NEVER match, so storing it produces a setting that looks
  // saved, appears in the UI, and silently grants nothing. That is the worst
  // possible outcome for this control: a typo that is quietly ignored looks
  // exactly like a setting that "didn't save". Note that a bare trailing "/"
  // is accepted and dropped, because that is the one form people actually type
  // and it is unambiguously the same origin.
  if (url.pathname && url.pathname !== '/') {
    return { ok: false, reason: 'must not include a path' };
  }
  if (url.search) {
    return { ok: false, reason: 'must not include a query string' };
  }
  if (url.hash) {
    return { ok: false, reason: 'must not include a fragment (#...)' };
  }
  if (!url.hostname) {
    return { ok: false, reason: 'has no host' };
  }

  // Normalise. Host is lowercased because DNS is case-insensitive and the
  // browser sends the host lowercased, so keeping the case as typed would make
  // a correct entry fail to match. The default port is dropped by the URL
  // parser (":80" on http, ":443" on https), which also collapses the
  // duplicate-looking pair http://a:80/ and http://a/.
  const origin = `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? ':' + url.port : ''}`;
  return { ok: true, origin };
}

/**
 * Validate a whole submitted allowlist.
 *
 * Deliberately FAIL-LOUD: a single bad entry rejects the entire request with a
 * message naming that entry. Bad entries are never silently dropped, for the
 * reason spelled out above — a dropped typo is indistinguishable from a
 * setting that failed to save, and an admin who cannot tell those apart will
 * trust a list that does not do what they think it does.
 *
 * @returns {{ok: true, origins: string[]}
 *          |{ok: false, code: string, error: string, entry?: string}}
 */
function validateCorsOrigins(input) {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      code: 'INVALID_ORIGINS',
      error: 'origins must be an array of origin strings'
    };
  }

  if (input.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_ALLOWLIST',
      error: 'The allowlist cannot be empty. An empty list denies every cross-origin request, which would lock the UI out.'
    };
  }

  if (input.length > MAX_ORIGINS) {
    return {
      ok: false,
      code: 'TOO_MANY_ORIGINS',
      error: `Too many origins: ${input.length}. The maximum is ${MAX_ORIGINS}.`
    };
  }

  const seen = new Set();
  const origins = [];

  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    const label = `origins[${i}]`;
    const result = validateOneOrigin(raw);
    if (!result.ok) {
      const shown = typeof raw === 'string' ? `"${raw}"` : String(raw);
      return {
        ok: false,
        code: 'INVALID_ORIGIN',
        error: `Invalid origin at ${label}: ${shown} ${result.reason}.`,
        entry: shown
      };
    }
    // De-duplicate AFTER normalising, so `HTTP://Example.com` and
    // `http://example.com/` collapse to one entry instead of two.
    if (!seen.has(result.origin)) {
      seen.add(result.origin);
      origins.push(result.origin);
    }
  }

  return { ok: true, origins };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The list derived from process.env.CORS_ORIGIN, or null when there is not a
 * usable one (unset, blank, or a wildcard).
 *
 * The wildcard case preserves the pre-existing behaviour: `CORS_ORIGIN="*"`
 * fell back to the localhost default with a warning rather than opening the
 * app up. The DB write path refuses a wildcard outright, but .env is not
 * something this module can refuse, so the same guard is applied here.
 */
function getEnvOrigins() {
  const raw = process.env.CORS_ORIGIN;
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;

  const list = String(raw)
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

  if (list.indexOf('*') !== -1) {
    console.warn('⚠️  CORS_ORIGIN="*" is not allowed with credentials — falling back to localhost only.');
    return null;
  }
  return list.length ? list : null;
}

function getDefaultOrigins() {
  return [DEFAULT_CORS_ORIGIN];
}

/**
 * The "no database override" answer, as a { origins, source } pair.
 *
 * This is the one place that knows how the fallback chain resolves, so the cache
 * swap after a reset and the reset route's own response body cannot drift apart.
 *
 * It is deliberately INDEPENDENT of the cache, which is what makes it safe to
 * call from a request handler. `getCorsOrigins()` is the wrong tool there: the
 * PUT and POST routes swap the cache in a res.on('finish') handler, i.e. after
 * the response body has been composed, so anything read through the cache during
 * the handler is stale by construction. Reading the fallback chain directly
 * answers the question that is actually being asked — "what will the list be
 * once this row is gone?" — and it is true at the instant it is computed.
 *
 * A fresh object and array are returned every call, so a caller can never hand
 * out a reference that the cache is also holding and later mutating.
 *
 * @returns {{origins: string[], source: 'env'|'default'}}
 */
function getFallbackCorsOrigins() {
  const env = getEnvOrigins();
  return env
    ? { origins: env.slice(), source: 'env' }
    : { origins: getDefaultOrigins().slice(), source: 'default' };
}

/** Read the stored override, or null when there is none / it is unusable. */
function readStoredOrigins() {
  // The stored value is JSON.stringify() of a string array. JSON escapes any
  // newline inside a string as \n (two characters), so the payload is always a
  // single line — which is what makes the pipe-delimited row parsing in db.js
  // safe for it.
  return runSql(`SELECT value FROM "ServerSetting" WHERE key = ${esc(CORS_SETTING_KEY)} LIMIT 1;`)
    .then(output => {
      const row = parseRows(output, ['value'])[0];
      if (!row) return null;
      try {
        const parsed = JSON.parse(row.value);
        if (!Array.isArray(parsed) || !parsed.length) return null;
        // Re-validate on READ as well as on write. The row can be edited out
        // of band, and the read path is what the cors middleware trusts; a
        // defence-in-depth check here means a hand-edited bad row degrades to
        // the env/default list instead of becoming the live allowlist.
        const check = validateCorsOrigins(parsed);
        if (!check.ok) {
          console.warn(`⚠️  Stored CORS allowlist is invalid (${check.error}) — falling back to the configured default.`);
          return null;
        }
        return check.origins;
      } catch (_e) {
        console.warn('⚠️  Stored CORS allowlist is not valid JSON — falling back to the configured default.');
        return null;
      }
    })
    .catch(error => {
      // A MISSING ServerSetting table is not an error condition at all — it
      // simply means no admin has ever saved an override, which is the normal
      // state of a fresh install.
      //
      // This is reached on a cold boot: the app.listen() callback can run
      // before the async initSchema() chain has created the table, so the
      // first read races the migration. Treating that as a failure printed a
      // scary "no such table: ServerSetting" warning on every single boot
      // while behaving perfectly correctly underneath. Answering "no
      // override" makes this read independent of the boot ORDER rather than
      // merely complaining about it; the TTL picks up the real row a few
      // seconds later either way.
      if (error && /no such table/i.test(error.message || '')) {
        return null;
      }
      throw error;
    });
}

/**
 * Re-resolve from the database and refresh the cache.
 * On ANY database problem this degrades to the env/default list and logs,
 * rather than throwing: a CORS settings read must never be able to take the
 * whole server down.
 */
function refresh() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = readStoredOrigins()
    .then(stored => {
      if (stored) {
        cache = { origins: stored, source: 'database', loadedAt: Date.now() };
        return cache;
      }
      const env = getEnvOrigins();
      cache = env
        ? { origins: env, source: 'env', loadedAt: Date.now() }
        : { origins: getDefaultOrigins(), source: 'default', loadedAt: Date.now() };
      return cache;
    })
    .catch(error => {
      console.warn('⚠️  Could not read the stored CORS allowlist:', error.message);
      const env = getEnvOrigins();
      cache = env
        ? { origins: env, source: 'env', loadedAt: Date.now() }
        : { origins: getDefaultOrigins(), source: 'default', loadedAt: Date.now() };
      return cache;
    })
    .then(result => {
      refreshInFlight = null;
      return result;
    });

  return refreshInFlight;
}

/**
 * SYNCHRONOUS accessor for the cors() origin callback.
 *
 * Returns the cached list immediately. If the cache has never been filled
 * (the very first request arriving before any refresh completed) it returns the
 * env/default list, which is exactly the behaviour of the old boot-time
 * `const`, and kicks off the async load for subsequent requests. If the cache
 * is older than CACHE_TTL_MS it still returns the STALE list (the only thing
 * it can do synchronously) and triggers a background refresh — so an
 * out-of-band DB edit takes effect within one TTL, not instantly, which is the
 * deliberate trade for never blocking the hot path.
 */
function getCorsOriginsSync() {
  if (!cache) {
    const env = getEnvOrigins();
    const fallback = env || getDefaultOrigins();
    refresh();
    return fallback;
  }
  if (Date.now() - cache.loadedAt > CACHE_TTL_MS) {
    refresh();
  }
  return cache.origins;
}

/**
 * ASYNC accessor — the effective list plus where it came from.
 * Used by GET /api/settings/cors, which is not on a hot path and can wait.
 *
 * @returns {Promise<{origins: string[], source: string}>}
 */
function getCorsOrigins() {
  if (cache && Date.now() - cache.loadedAt <= CACHE_TTL_MS) {
    return Promise.resolve({ origins: cache.origins.slice(), source: cache.source });
  }
  return refresh().then(c => ({ origins: c.origins.slice(), source: c.source }));
}

/** Force the next read to hit the database. */
function invalidate() {
  cache = null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Swap the in-memory cache to a specific list, immediately.
 *
 * Split out from setCorsOrigins() because the HTTP route needs to persist FIRST
 * and swap the cache LATER — see the comment on the PUT handler in
 * src/routes/settings.js for why that ordering is load-bearing and not merely
 * tidy.
 */
function applyCorsOriginsCache(origins) {
  cache = { origins: origins.slice(), source: 'database', loadedAt: Date.now() };
  return cache;
}

/** Recompute the cache from .env / the hardcoded default, for use after a reset. */
function applyFallbackCache() {
  const fallback = getFallbackCorsOrigins();
  cache = { origins: fallback.origins, source: fallback.source, loadedAt: Date.now() };
  return cache;
}

/**
 * Persist a validated allowlist, then update the cache.
 *
 * @param {string[]} list already-validated, normalised origins
 * @param {string|null} adminId who made the change (audit column)
 * @param {{cacheImmediately?: boolean}} [options]
 *   Pass `cacheImmediately: false` to write the row and return WITHOUT
 *   touching the cache, so the caller can swap it at a moment of its own
 *   choosing (the PUT route defers it until the response has been sent).
 *   The cache is never updated before the database write has actually
 *   succeeded, so a failed write can never leave the process enforcing a list
 *   that is not in the database.
 */
function setCorsOrigins(list, adminId, options) {
  const opts = options || {};
  const serialised = JSON.stringify(list);
  return runSql(`
    INSERT INTO "ServerSetting" (key, value, updatedAt, updatedBy)
    VALUES (${esc(CORS_SETTING_KEY)}, ${esc(serialised)}, ${esc(new Date().toISOString())}, ${esc(adminId || null)})
    ON CONFLICT(key) DO UPDATE SET
      value    = excluded.value,
      updatedAt = excluded.updatedAt,
      updatedBy = excluded.updatedBy;
  `).then(() => {
    if (opts.cacheImmediately === false) {
      return { origins: list.slice(), source: 'database', deferred: true };
    }
    return applyCorsOriginsCache(list);
  });
}

/**
 * Delete the override so resolution falls back to .env / the default again.
 * @param {{cacheImmediately?: boolean}} [options] see setCorsOrigins()
 */
function resetCorsOrigins(options) {
  const opts = options || {};
  return runSql(`DELETE FROM "ServerSetting" WHERE key = ${esc(CORS_SETTING_KEY)};`)
    .then(() => (opts.cacheImmediately === false ? { deferred: true } : applyFallbackCache()));
}

/** Warm the cache at boot so the first request does not race the first read. */
function primeCache() {
  return refresh();
}

module.exports = {
  CORS_SETTING_KEY,
  DEFAULT_CORS_ORIGIN,
  MAX_ORIGINS,
  MAX_ORIGIN_LENGTH,
  CACHE_TTL_MS,
  validateCorsOrigins,
  validateOneOrigin,
  getCorsOriginsSync,
  getCorsOrigins,
  getEnvOrigins,
  getDefaultOrigins,
  getFallbackCorsOrigins,
  setCorsOrigins,
  resetCorsOrigins,
  applyCorsOriginsCache,
  applyFallbackCache,
  invalidate,
  primeCache
};
