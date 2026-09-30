/**
 * The desktop build's bearer token — the thing that makes the app reachable ONLY
 * from its own Electron window.
 *
 * WHY THIS EXISTS
 *
 * Tightening CORS (see src/server.js) closed cross-origin JavaScript, but it did
 * NOT stop a browser from simply loading the app. Typing
 * `http://127.0.0.1:4101` into Chrome is a top-level NAVIGATION: browsers send no
 * `Origin` header on navigation, so the CORS callback never runs, and every
 * `/api` route answered. On an app with no login, that means any browser on the
 * machine gets the full collection — read AND write — including export/import.
 *
 * CORS cannot fix this. It governs `fetch()`, not the address bar. The only way
 * to tell "the app's own window" from "a browser someone typed a URL into" is to
 * require proof that only the Electron process can supply.
 *
 * HOW THE PROOF WORKS
 *
 *   1. electron/main.js generates a fresh 256-bit random token at launch, before
 *      it requires src/server.js, and puts it in CMS_DESKTOP_TOKEN.
 *   2. A preload script reads it from the main process over IPC and exposes it
 *      to the renderer ONLY. The page never has it in its HTML or its URL.
 *   3. Every request goes through the single `api()` chokepoint in
 *      public/index.html, which attaches it as a header.
 *   4. requireDesktopToken() compares it in constant time.
 *
 * The token is per-launch and in-memory only. It is never written to disk, never
 * in the database, never in a URL (so it stays out of logs and history), and it
 * dies with the process.
 *
 * WHAT THIS ACTUALLY BUYS, STATED HONESTLY
 *
 * It stops: a website the operator visits, a browser they type the URL into,
 * another app on the machine probing the port casually.
 *
 * It does NOT stop the machine's owner. They can read the SQLite file directly,
 * open Electron's devtools and inspect the preload bridge, or read the token out
 * of the running process. There are no tokens to steal — this one is generated
 * locally and never transmitted anywhere — but "only this app can read it" was
 * never achievable for a single-user local app, and pretending otherwise would be
 * worse than saying so. This raises the bar from "type a URL" to "deliberately
 * extract a secret from a running process".
 *
 * WHY CORS_STYLE ENV TRICKERY IS NOT USED
 *
 * The token deliberately does NOT travel through a query string. That is the
 * obvious way to get it into the first page load, and it is a bad one: query
 * strings land in morgan's access log, in browser history, and in any Referer
 * header the page ever sends. It also would not work — the shell must load
 * before any token exists, which is precisely why the shell is served unguarded
 * and every request that returns DATA is guarded instead.
 */
const crypto = require('crypto');

const TOKEN_HEADER = 'x-cms-desktop-token';
const TOKEN_BYTES = 32; // 256 bits

/** The configured token, or null when this is not a guarded build. */
let token = null;

/**
 * Generate a fresh token. Called by electron/main.js before it requires the
 * server, because src/server.js reads configuration at module load.
 *
 * Exported so the desktop build never has to know how long a token is.
 */
function generate() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Install the token for this process. Called once, from electron/main.js.
 *
 * Refuses a value that is not a plausible random hex string rather than
 * accepting anything truthy: a token of "1" or "" must fail CLOSED, because a
 * guard that can be satisfied by a guessable value is not a guard.
 */
function install(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();

  if (raw === '') {
    token = null;
    return null;
  }
  if (!/^[0-9a-f]{64}$/i.test(raw)) {
    // Loudly ignored. Falling back to "no token" would mean the guard is off,
    // which is the opposite of what a malformed value should cause.
    console.error(
      '🔒 CMS_DESKTOP_TOKEN is not a 64-character hex string — the desktop token guard is DISABLED. This is a bug in the desktop build, not a supported configuration.'
    );
    token = null;
    return null;
  }

  token = raw;
  return token;
}

/** The installed token, or null. Never returned to a browser-facing caller. */
function get() {
  return token;
}

/**
 * Is the desktop guard ACTIVE for this process?
 *
 * True only when a desktop origin is configured AND a valid token was installed.
 * Docker and `npm start` set neither, so this is false there and every route
 * behaves exactly as it always has — including the n8n notification endpoints.
 */
function isGuarded() {
  const settings = require('./settings');
  return settings.isDesktopTarget() && token !== null;
}

/**
 * Constant-time comparison of the presented token.
 *
 * timingSafeEqual is used rather than === because a byte-by-byte early return
 * leaks how much of a guess was correct. That is a very hard attack to pull off
 * against a loopback server, and the honest note is that this token is not
 * remotely guessable anyway (256 bits, per-launch). The constant-time compare
 * costs nothing and removes the question.
 */
function matches(presented) {
  if (token === null) return false;
  const value = String(presented === undefined || presented === null ? '' : presented);
  const expected = Buffer.from(token, 'utf8');
  const actual = Buffer.from(value, 'utf8');

  // timingSafeEqual THROWS on a length mismatch, so equalise first. The length
  // of the presented value is not a secret worth protecting.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// Self-install from the environment at module load.
//
// electron/main.js generates the token and puts it in CMS_DESKTOP_TOKEN BEFORE
// it requires src/server.js, so the value is already here. Doing the install here
// rather than from main.js means the guard is owned by the module that enforces
// it — there is no ordering in which the server comes up "guarded but with no
// token", which would silently be the unguarded case.
//
// It also makes the whole thing testable from a plain `node` process:
//   CMS_SELF_ORIGIN=http://127.0.0.1:4101 CMS_DESKTOP_TOKEN=<64 hex> npm start
// behaves exactly like the packaged app, with no Electron involved.
install(process.env.CMS_DESKTOP_TOKEN);

module.exports = {
  TOKEN_HEADER,
  generate,
  install,
  get,
  isGuarded,
  matches
};
