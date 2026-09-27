require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const path = require('path');

const { rateLimit } = require('./middleware/rateLimit');
const { validateJwtSecret } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 4001;

// ============================================================================
// STARTUP SAFETY CHECKS
// ============================================================================
// We do NOT ship a hardcoded replacement secret. Instead the process refuses to
// boot in production with a placeholder/weak JWT_SECRET, and only warns in
// development so the current .env placeholder does not brick local work.
(function validateJwtSecretAtBoot() {
  const result = validateJwtSecret(process.env.JWT_SECRET);
  const isProduction = process.env.NODE_ENV === 'production';

  if (!result.ok) {
    if (isProduction) {
      console.error(`\n❌ FATAL: ${result.reason}`);
      console.error('   Set a strong JWT_SECRET before starting in production, e.g.:');
      console.error('     JWT_SECRET=$(openssl rand -hex 32)\n');
      process.exit(1);
    }
    console.warn(`\n⚠️  JWT_SECRET is not production-safe: ${result.reason}`);
    console.warn('   The server will start, but this MUST be fixed before deploying.\n');
  } else if (result.level === 'warning') {
    console.warn(`\n⚠️  ${result.reason}\n`);
  }
})();

// Behind a reverse proxy (nginx/traefik) so express-rate-limit style
// IP attribution and req.ip use X-Forwarded-For instead of the proxy socket.
app.set('trust proxy', 1);

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Security headers.
// TRADE-OFF NOTE: public/index.html ships its CSS in a <style> block and its
// JS in an inline <script> block, and that file is owned by another task, so a
// per-request nonce (the "correct" CSP for inline script) would require editing
// public/index.html and would break the app. We therefore keep
// script-src 'self' 'unsafe-inline' and style-src 'self' 'unsafe-inline' as the
// minimum relaxation that leaves the current frontend working. Once
// public/index.html is refactored to external /static assets, drop
// 'unsafe-inline' from script-src and switch to helmet's nonce support.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' },
  referrerPolicy: { policy: 'no-referrer' }
}));

// CORS — strict allowlist, admin-editable WITHOUT a restart.
//
// This used to be a boot-time `const` read once from process.env.CORS_ORIGIN,
// which meant changing an origin cost an SSH edit and a restart of a server
// that was actively serving the app. The allowlist now lives in the "ServerSetting"
// table and is resolved per src/services/settings.js, in the order
// database -> .env -> hardcoded default, so an admin can correct it from the
// Security tab and have it apply to the running process.
//
// The resolution helper is a synchronous, in-memory cached read (see its
// header comment for why it cannot be an await here, and why a short TTL still
// backs the cache up). DEFAULT_CORS_ORIGIN now lives in settings.js so the
// fallback has exactly one definition.
const settings = require('./services/settings');

app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);
    const allowed = settings.getCorsOriginsSync();
    if (allowed.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CMS-API-KEY']
}));

// Logging middleware
app.use(morgan(':method :url :status :response-time ms'));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// General API rate limit (loose). Auth routes apply their own, much tighter,
// per-route limits inside src/routes/auth.js.
const apiLimiter = rateLimit({
  name: 'api-general',
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests. Please slow down.'
});
app.use('/api', apiLimiter);

/**
 * Static files for uploaded images — GUARDED.
 *
 * This used to be a bare `express.static` mount, which meant every uploaded
 * costume photo was world-readable to anyone who could reach the server and
 * guess (or enumerate) its path. An `<img src>` cannot send an
 * `Authorization: Bearer` header, so the guard cannot simply be the data-route
 * `verifyToken` used elsewhere: the frontend fetches each image through api()
 * with the bearer header and paints it via an object URL instead (see
 * "Authenticated image delivery" in public/index.html). That is a CLIENT-SIDE
 * contract, so the server half of it is `requireUploadAccess` below, which
 * accepts an access token (or the X-CMS-API-KEY header, for n8n) and denies
 * everything else with 401/403 and a JSON body — never a redirect to the login
 * page, and never a fall-through to the SPA mount.
 *
 * The trailing 404 handler is part of the guard, not decoration: with
 * `fallthrough` left at its default, a request for a file that does not exist
 * would fall out of this mount and be answered by the public SPA mount at the
 * bottom of this file, handing the caller index.html with a 200.
 */
const { requireUploadAccess } = require('./middleware/uploadAccess');
app.use(
  '/uploads',
  requireUploadAccess,
  express.static(path.join(__dirname, '../data/uploads'), {
    index: false,
    dotfiles: 'deny',
    redirect: false
  }),
  (req, res) => res.status(404).json({ error: 'Image not found', code: 'NOT_FOUND' })
);

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint (public)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API version endpoint (public).
// Intentionally lists ONLY public + user-token routes. The n8n /
// X-CMS-API-KEY notification endpoints are internal machine-to-machine
// surface and are not advertised here.
app.get('/api/version', (req, res) => {
  res.json({
    api_version: '1.0.0',
    phase: 5,
    auth: {
      scheme: 'Bearer JWT (access) + rotating refresh token',
      access_token_ttl: '15m',
      two_factor: 'Telegram OTP, opt-in per user',
      note: 'This is NOT an OAuth 2.0 authorization server; it is a local JWT session flow.'
    },
    endpoints: [
      'POST /api/auth/register',
      'POST /api/auth/login',
      'POST /api/auth/2fa/verify',
      'POST /api/auth/2fa/resend',
      'PATCH /api/auth/2fa/toggle',
      'POST /api/auth/break-glass',
      'POST /api/auth/break-glass/generate',
      'POST /api/auth/refresh',
      'POST /api/auth/logout',
      'GET /api/auth/profile',
      'GET /api/costumes',
      'POST /api/costumes',
      'GET /api/costumes/:id',
      'PUT /api/costumes/:id',
      'DELETE /api/costumes/:id',
      'GET /api/brands',
      'POST /api/brands',
      'GET /api/brands/:id',
      'PUT /api/brands/:id',
      'DELETE /api/brands/:id',
      'GET /api/fandoms',
      'POST /api/fandoms',
      'GET /api/fandoms/:id',
      'PUT /api/fandoms/:id',
      'DELETE /api/fandoms/:id',
      'GET /api/props',
      'POST /api/props',
      'GET /api/props/:id',
      'PUT /api/props/:id',
      'DELETE /api/props/:id',
      'GET /api/lenses',
      'POST /api/lenses',
      'GET /api/lenses/:id',
      'PUT /api/lenses/:id',
      'PATCH /api/lenses/:id/open',
      'DELETE /api/lenses/:id',
      'POST /api/images/upload',
      'POST /api/images/upload-multiple',
      'GET /api/images/stats',
      'DELETE /api/costumes/:id/images',
      'GET /api/auth/users (admin)',
      'PATCH /api/auth/users/:id/role (admin)',
      'POST /api/auth/users/:id/password-reset (admin)',
      // Runtime CORS allowlist. Admin-only, and editable without a restart —
      // the whole point is that fixing an origin no longer needs SSH.
      'GET /api/settings/cors (admin)',
      'PUT /api/settings/cors (admin)',
      'POST /api/settings/cors/reset (admin)',
      // The two below are deliberately UNAUTHENTICATED. They are the only
      // unauthenticated write path in the app, and they have to be: the whole
      // point is to let someone who cannot sign in change a password. They
      // carry a bearer token instead, and are rate limited per-IP AND
      // per-token. Listed here so the public surface stays discoverable and
      // reviewable rather than being something you have to know to find.
      'POST /api/auth/password-reset/validate (public)',
      'POST /api/auth/password-reset (public)'
    ],
    roles: {
      note: 'Roles are a ladder. Read the first tier at or above your own to learn what you may do.',
      ladder: ['guest (0, no data access)', 'viewer (1, read-only)', 'user (2, full record CRUD)', 'curator (3)', 'admin (4, + user management)'],
      write_tier: 'user',
      read_only_error: '403 { code: "READ_ONLY_ROLE" } is returned to a viewer on any POST/PUT/PATCH/DELETE.'
    }
  });
});

// ---------------------------------------------------------------------------
// Auth routes — self-guarded (public login/2fa, verifyToken on the rest).
// ---------------------------------------------------------------------------
const authRoutes = require('./routes/auth');
app.use('/api', authRoutes);
app.use('/', authRoutes);

// Admin-editable server settings (currently the CORS allowlist). Each route
// carries its own verifyToken + authorize('admin'); mounted under /api only,
// because a security control that rewrites who may talk to the server has no
// business also being reachable on a second, un-prefixed path.
const settingsRoutes = require('./routes/settings');
app.use('/api', settingsRoutes);

// ---------------------------------------------------------------------------
// Data routes.
//
// IMPORTANT (this bit the project once already): the guard MUST be mounted on a
// PATH PREFIX, never on a broad prefix like '/' or '/api'.
//
//   app.use('/api', verifyToken, router)   // WRONG
//   app.use('/api/costumes', verifyToken, costumeRoutes)   // RIGHT
//
// With a broad prefix, any request that no route handles falls through to the
// next app.use, which re-runs verifyToken — so unrelated endpoints (even the
// public /health and the API-key notification routes) start returning 401.
// Scoping the mount to the resource keeps the guard applied to exactly the
// routes it protects, and no later edit can mount one ahead of it.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// THE READ/WRITE SPLIT
// ---------------------------------------------------------------------------
// requireWriteAccess is the second guard on every data mount. It reads the HTTP
// method: GET/HEAD/OPTIONS pass, and every mutating method (POST/PUT/PATCH/DELETE)
// requires the 'user' tier or above. That is what makes a `viewer` account
// read-only instead of merely labelled read-only.
//
// It is mounted PER RESOURCE, immediately after verifyToken, for the same reason
// the auth guard is (see the WARNING above): the order in this list is the order
// the request passes through, and there is exactly one line per resource so a
// route added later cannot accidentally be mounted without it.
//
//   verifyToken  ->  who are you          (401 if not)
//
//   requireWriteAccess -> may you change it (403 READ_ONLY_ROLE if a viewer)
//
// An API-key caller carries no role at all, so requireWriteAccess lets it through
// on the strength of the marker apiKeyAuth.js sets after verifying the key. That
// is deliberate: the n8n workflow is a server-to-server integration, not a person
// whose permissions should be a tier.
const authMiddleware = require('./middleware/auth');
const { verifyTokenOrApiKey } = require('./middleware/apiKeyAuth');
const { requireWriteAccess } = authMiddleware;

const costumeRoutes = require('./routes/costumes');
app.use('/api/costumes', authMiddleware.verifyToken, requireWriteAccess, costumeRoutes);
app.use('/costumes', authMiddleware.verifyToken, requireWriteAccess, costumeRoutes);

// Brand / Fandom reference lists. Same prefix-scoped guard as the other data
// routes — see the WARNING above about mounting on '/' or '/api'.
const brandRoutes = require('./routes/brands');
app.use('/api/brands', authMiddleware.verifyToken, requireWriteAccess, brandRoutes);
app.use('/brands', authMiddleware.verifyToken, requireWriteAccess, brandRoutes);

const fandomRoutes = require('./routes/fandoms');
app.use('/api/fandoms', authMiddleware.verifyToken, requireWriteAccess, fandomRoutes);
app.use('/fandoms', authMiddleware.verifyToken, requireWriteAccess, fandomRoutes);

const propsRoutes = require('./routes/props');
app.use('/api/props', authMiddleware.verifyToken, requireWriteAccess, propsRoutes);
app.use('/props', authMiddleware.verifyToken, requireWriteAccess, propsRoutes);

const lensesRoutes = require('./routes/lenses');
app.use('/api/lenses', authMiddleware.verifyToken, requireWriteAccess, lensesRoutes);
app.use('/lenses', authMiddleware.verifyToken, requireWriteAccess, lensesRoutes);

// Image endpoints are used by the browser SPA *and* by n8n (X-CMS-API-KEY), so
// they accept either credential. Uploading IS a write, so the same split applies —
// a viewer may keep looking at the photos but cannot add any.
const imageRoutes = require('./routes/images');
app.use('/api/images', verifyTokenOrApiKey, requireWriteAccess, imageRoutes);
app.use('/images', verifyTokenOrApiKey, requireWriteAccess, imageRoutes);

// Alias kept for the phase-5 frontend spec (`POST /api/upload`). Same handler,
// same guard, same response shape as the canonical /api/images/upload.
// Mounted with app.post (not app.use) so the guard is scoped to this one path.
app.post('/api/upload', verifyTokenOrApiKey, requireWriteAccess, imageRoutes.singleUploadChain);
app.post('/upload', verifyTokenOrApiKey, requireWriteAccess, imageRoutes.singleUploadChain);

// Notification endpoints are machine-to-machine only (n8n); they keep the
// stricter X-CMS-API-KEY guard defined inside the router.
const notificationRoutes = require('./routes/notifications');
app.use('/api', notificationRoutes);
app.use('/', notificationRoutes);

// Static frontend UI
app.use(express.static(path.join(__dirname, '../public')));

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

// 404 handler — no internals (no stack, no mounted-router internals) leaked.
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    code: 'NOT_FOUND'
  });
});

// Error handling middleware — logs server-side, returns a generic body.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.message === 'Origin not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed', code: 'CORS_DENIED' });
  }

  console.error('❌ Error:', err && (err.stack || err.message));

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: status >= 500 ? 'Internal server error' : (err.message || 'Request failed'),
    code: err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

// Create the Brand/Fandom tables and run the one-time backfill of the existing
// "Costume".brand/fandom values BEFORE the first request is served. initSchema()
// is idempotent and single-flight, so a DB that already has them is untouched;
// a genuinely fresh one converges on init_db.sql's schema.
const db = require('./services/db');
db.initSchema()
  .then(() => {
    // Warm the CORS allowlist cache so the very first request does not race
    // the first database read. Not fatal if this fails: getCorsOriginsSync()
    // falls back to the .env/default list and retries on the next request.
    return settings.primeCache();
  })
  .then(() => reportTelegram2FAConfig())
  .catch((error) => {
    console.error('❌ Schema initialisation failed:', error.message);
  });

/**
 * Loud, non-fatal startup check for the one misconfiguration that can lock a
 * real user out of their own account.
 *
 * THE MISCONFIGURATION
 * "User".telegram2FAEnabled is a per-account flag. If it is set but Telegram is
 * not configured, POST /api/auth/login answers 503 TELEGRAM_NOT_CONFIGURED
 * (src/routes/auth.js telegramUnconfigured) — which is the correct fail-closed
 * behaviour — but the account owner has no way to receive the OTP, and the only
 * remaining way back in is the break-glass recovery key.
 *
 * WHY THIS ONLY WARNS
 * The app is perfectly usable without 2FA, and this function runs against a
 * database that may legitimately hold no 2FA users at all. Refusing to boot over
 * a warning would take the whole CMS down to report a problem the operator can
 * fix in their .env, so this mirrors validateJwtSecretAtBoot()'s development
 * path: shout, then start.
 *
 * It never prints a chat id, a bot token, or any credential — only counts.
 */
async function reportTelegram2FAConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const configured = !!token && !token.includes('$(') && !token.includes('your_') && !token.includes('here');
  if (configured) return;

  try {
    const withChatId = await db.countUsersWith2FAEnabled(true);
    const withoutChatId = await db.countUsersWith2FAEnabled(false);
    if (withChatId + withoutChatId === 0) return;

    console.warn('\n' + '='.repeat(60));
    console.warn('⚠️  2FA IS ENABLED FOR AT LEAST ONE ACCOUNT, BUT TELEGRAM IS NOT CONFIGURED.');
    console.warn(`   Accounts with 2FA on: ${withChatId + withoutChatId}`
      + (withoutChatId > 0 ? ` (${withoutChatId} of them have no telegramChatId at all)` : ''));
    console.warn('   While TELEGRAM_BOT_TOKEN is a placeholder, POST /api/auth/login for those');
    console.warn('   accounts returns 503 TELEGRAM_NOT_CONFIGURED and no OTP can be sent.');
    console.warn('   Recovery: POST /api/auth/break-glass with { username, recoveryKey } —');
    console.warn('   this does NOT depend on Telegram, so those users are not locked out as');
    console.warn('   long as they still hold their emergency key.');
    console.warn('   Fix: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env, then set the');
    console.warn('   telegramChatId column on your own "User" row before enabling 2FA.');
    console.warn('='.repeat(60) + '\n');
  } catch (error) {
    // A missing "User" table is not this function's problem to report.
    console.warn('⚠️  Could not verify the 2FA / Telegram configuration:', error.message);
  }
}

// The host is explicit rather than relying on the no-host overload. Without it
// Node binds `::` (the unspecified IPv6 address, dual-stack), which is correct on
// a normal Linux host but is exactly the kind of implicit default that a
// container runtime, a hardened sysctl, or a future base-image change can turn
// into a listen-only-on-loopback. Naming 0.0.0.0 states the intent: reachable
// from outside this network namespace, which is what a published container port
// needs.
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Express Server Started');
  console.log(`${'='.repeat(60)}`);
  console.log(`🌐 Server running on: http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API version: http://localhost:${PORT}/api/version`);
  // The allowlist is resolved at runtime now, so this line reports the cached
  // value and says where it came from rather than printing a boot-time const.
  // NOTE: it used to interpolate the `corsOrigins` const directly, which is a
  // ReferenceError the moment that const is removed — and `node --check` does
  // NOT catch it, because it is a runtime error in a callback, not a syntax
  // error. It only shows up when the process actually listens.
  settings.getCorsOrigins()
    .then(effective => {
      const source = effective.source === 'database' ? ' (saved override)'
        : (effective.source === 'env' ? ' (CORS_ORIGIN in .env)' : ' (built-in default)');
      console.log(`🔒 CORS allowlist: ${effective.origins.join(', ')}${source}`);
      console.log('   Editable at runtime: PUT /api/settings/cors (admin) — no restart needed.');
    })
    .catch(() => {
      console.log(`🔒 CORS allowlist: ${settings.getCorsOriginsSync().join(', ')}`);
    });
  console.log(`${'='.repeat(60)}\n`);

  console.log('📡 Public endpoints:');
  console.log('   GET  /health');
  console.log('   GET  /api/version');
  console.log('   POST /api/auth/login  (2FA challenge or token pair)');
  console.log('   POST /api/auth/2fa/verify');
  console.log('');
  console.log('🔐 Bearer-token endpoints: /api/costumes, /api/brands, /api/fandoms, /api/props, /api/lenses, /api/images');
  console.log('🤖 API-key endpoints:     /api/notifications (X-CMS-API-KEY)');
  console.log('\nℹ️  Frontend SPA: public/index.html\n');
});

// ============================================================================
// PROCESS SAFETY NET
// ============================================================================
// Without these, Node's default behaviour on an unhandled rejection or an
// uncaught exception is to print an opaque stack and die, or — worse for a
// rejected promise nobody awaited — to print a warning and keep running with
// whatever half-applied state caused it. In a container neither is useful: the
// process must exit with a NON-ZERO code so the orchestrator's restart policy
// brings up a clean one, and the reason must be in the logs.
//
// uncaughtException is not recoverable by definition — the stack is in an
// unknown state — so that handler MUST terminate rather than swallow the error.
process.on('unhandledRejection', (reason) => {
  console.error('\n❌ UNHANDLED PROMISE REJECTION');
  console.error(reason instanceof Error ? (reason.stack || reason.message) : reason);
  console.error('   The process cannot be trusted to continue; exiting (code 1).\n');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('\n❌ UNCAUGHT EXCEPTION — process state is undefined');
  console.error(error && (error.stack || error.message) ? (error.stack || error.message) : error);
  console.error('   Terminating immediately (code 1). Any in-flight request is lost.\n');
  process.exit(1);
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================
// `docker stop` sends SIGTERM and then SIGKILLs after 10s. The old handlers
// called process.exit(0) the instant the signal arrived, which tore down sockets
// that in-flight requests were still writing to — the client sees a truncated
// response even though the work completed server-side.
//
// server.close() stops the listener and waits for existing connections to
// drain, which is what "graceful" means here. There is no connection pool or
// long-lived handle to close beyond the HTTP server: each query is its own
// short-lived `sqlite3` child process that has already exited by the time its
// promise settles, so there is nothing to close on that side.
//
// The 9s failsafe exists because server.close() waits forever if a client holds
// a keep-alive socket open. Without it the container would sit until Docker's
// 10s SIGKILL and be reported as a failed stop (exit 137) rather than a clean 0.
const SHUTDOWN_FAILSAFE_MS = 9000;

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n🛑 ${signal} received, draining connections (max ${SHUTDOWN_FAILSAFE_MS}ms)...`);

  const failsafe = setTimeout(() => {
    console.error(`   ⏱️  ${SHUTDOWN_FAILSAFE_MS}ms elapsed with connections still open, forcing exit (code 1).`);
    process.exit(1);
  }, SHUTDOWN_FAILSAFE_MS);

  // server.close() reports its error argument; there is no error to expect here,
  // but an explicit handler keeps a future failure from becoming an unhandled
  // 'error' event on the http.Server.
  server.close((err) => {
    clearTimeout(failsafe);
    if (err) {
      console.error('   Error while closing the server:', err.message || err);
      process.exit(1);
    }
    console.log('✅ All connections closed. Shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
