require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const helmet = require('helmet');
const path = require('path');

const { rateLimit } = require('./middleware/rateLimit');

const app = express();
const PORT = process.env.PORT || 4001;

// The interface the listener binds to.
//
// DEFAULT 0.0.0.0 IS DELIBERATE AND UNCHANGED — see the no-authentication note
// at the top of this file. The container is meant to publish the port onto a
// trusted network, which requires binding every interface.
//
// It is overridable because a DESKTOP build must not do that. This app has no
// authentication whatsoever (every data route is open), so binding 0.0.0.0 on a
// laptop would put full read AND write access to the entire costume collection
// behind a plain TCP port on the operator's office or home LAN — a strictly
// larger blast radius than the same app has inside a container network.
// electron/main.js sets this to 127.0.0.1, which is the correct boundary for a
// single-user desktop app whose only client is its own window.
//
// Set in .env only if you genuinely want a container exposed off-box.
const BIND_ADDRESS = process.env.BIND_ADDRESS || '0.0.0.0';

// ============================================================================
// NO AUTHENTICATION — READ THIS BEFORE EXPOSING THE PORT
// ============================================================================
// This app has no accounts, no login, and no role tiers. Every data route is
// reachable by anything that can open a TCP connection to PORT, and the server
// binds 0.0.0.0 so it is reachable from outside its network namespace.
//
// THAT IS A DELIBERATE DEPLOYMENT DECISION, not an oversight. This is a private
// single-operator CMS and the trust boundary is the network: it belongs behind a
// reverse proxy, a VPN, or a firewall rule that admits only the operator's own
// hosts. The process deliberately does not implement authentication as a second,
// weaker layer — a shared secret in this code would be one more thing to leak and
// would not make an exposed port safe.
//
// CONSEQUENCE: do not publish this port to the internet. There is nothing here
// that would stop a scanner that reaches it. Put it behind the network boundary
// FIRST, and only then start the container.

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
const telegramConfig = require('./services/telegramConfig');
const lensExpiryChecker = require('./services/lensExpiryChecker');
const desktopToken = require('./services/desktopToken');

app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);

    // ESCAPE HATCH, OFF BY DEFAULT: CMS_ALLOW_ANY_ORIGIN=1 accepts every origin.
    // `callback(null, true)` with a boolean reflects the request origin back,
    // which is what a permissive mode needs — returning a literal '*' would
    // instead be rejected by the browser because `credentials: true` is set
    // below. It also permits the opaque origin "null", which file://, data: and
    // sandboxed iframes all send.
    //
    // This used to be the DESKTOP BUILD'S NORMAL MODE, back when a migrated
    // `cors_origins` row could lock the app out of its own Settings tab with no
    // in-app way back. That hole is closed: CMS_SELF_ORIGIN is merged in AFTER
    // the whole database -> .env -> default chain by withSelfOrigin(), so the
    // app's own origin can never be the one that gets dropped. The desktop build
    // therefore enforces a real allowlist now, and only the desktop build is
    // expected to ever set this escape hatch — on the container it would expose
    // the collection to the whole network instead of just this machine.
    if (settings.isCorsDisabled()) return callback(null, true);

    // One path for every platform. On desktop the list contains the serving
    // origin (appended by withSelfOrigin()); on a self-hosted server it is the
    // admin-editable allowlist. There is no longer a desktop branch, so the
    // allowlist cannot silently stop being enforced there.
    const allowed = settings.getCorsOriginsSync();
    if (allowed.indexOf(origin) !== -1) return callback(null, true);
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CMS-API-KEY']
}));

/**
 * DESKTOP TOKEN GUARD — desktop build only.
 *
 * This is what actually makes the desktop app reachable only from its own
 * window. The CORS check above closes cross-origin JavaScript, but a browser
 * NAVIGATION to http://127.0.0.1:4101/ sends no Origin header at all, so it walks
 * straight past CORS and then reads every /api route. CORS cannot close that gap:
 * it governs fetch(), not the address bar.
 *
 * So the desktop build requires a per-launch 256-bit token that only the Electron
 * process holds (see src/services/desktopToken.js and electron/preload.js). A
 * browser that types the URL gets the HTML shell — which contains no collection
 * data — and 403 on everything that returns data.
 *
 * INERT EVERYWHERE ELSE. Docker and `npm start` set neither CMS_SELF_ORIGIN nor
 * CMS_DESKTOP_TOKEN, so isGuarded() is false and this is a straight pass-through.
 * That is deliberate and load-bearing: the n8n notification endpoints and any
 * curl-based workflow on a self-hosted server must keep working unchanged, and
 * they cannot present a token they have no way to receive.
 *
 * ORDER MATTERS. This sits after cors() so a rejected-origin response still wins
 * (there is no point minting a token error for a request that was already refused
 * for being foreign), and before every route so nothing is served ahead of it.
 *
 * SCOPE — DATA ROUTES ONLY, AND THIS IS LOAD-BEARING
 *
 * Only /api and /uploads are guarded. The HTML shell is NOT, and it cannot be:
 * Electron's very first page load is a top-level NAVIGATION, and browsers send no
 * custom headers on navigation — there is no mechanism by which the shell could
 * present the token. Guarding it would mean the app could never start. The shell
 * is index.html, which contains no collection data: no costumes, no props, no
 * images, nothing. A browser loading it gets an empty shell that renders nothing,
 * because every request it then makes comes back 403. That is precisely the
 * intended behaviour, and it is why "serve the shell unguarded, guard everything
 * that returns data" is the design rather than a compromise.
 *
 * /health is unguarded too, so an operator can still tell "is the server up" from
 * "is the app working" without holding the token.
 *
 * WHY NOT A HEADER-BASED ALTERNATIVE
 *
 * Restricting the shell to a `Sec-Fetch-Site: same-origin` check was rejected: it
 * is trivially satisfied by any browser request, so it would guard nothing while
 * looking like it did.
 */
const GUARDED_PREFIXES = ['/api', '/uploads'];

function requireDesktopToken(req, res, next) {
  if (!desktopToken.isGuarded()) return next();
  if (!GUARDED_PREFIXES.some(prefix => req.path === prefix || req.path.startsWith(prefix + '/'))) {
    return next();
  }

  if (desktopToken.matches(req.get(desktopToken.TOKEN_HEADER))) return next();

  // 403, not 401: the caller is not asking to log in, and there is no login to
  // perform. The body deliberately names the expected header so a developer
  // debugging the desktop build is not left guessing, but it reveals nothing an
  // attacker does not already know — the token itself is never echoed, and its
  // absence is the whole point.
  return res.status(403).json({
    error: 'This server only answers requests from the Cosplay CMS desktop app.',
    code: 'DESKTOP_TOKEN_REQUIRED'
  });
}

app.use(requireDesktopToken);

// Logging middleware
app.use(morgan(':method :url :status :response-time ms'));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// General API rate limit (loose). It exists to keep a runaway client or a bored
// scanner from saturating the process, not to authenticate anything — see the
// no-authentication note at the top of this file.
const apiLimiter = rateLimit({
  name: 'api-general',
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests. Please slow down.'
});
app.use('/api', apiLimiter);

/**
 * Static files for uploaded images.
 *
 * This mount was previously guarded by requireUploadAccess, which demanded a JWT
 * or the API key. That guard is gone with the account system. It is deliberately
 * NOT replaced with anything: the whole trust model is now the network boundary
 * (see the top of this file), and a half-guard here would be worse than none —
 * it would suggest the images are protected while the data routes beside them
 * are wide open.
 *
 * The trailing 404 handler is load-bearing and is NOT decoration: with
 * `fallthrough` left at its default, a request for a file that does not exist
 * falls out of this mount and is answered by the public SPA mount at the bottom
 * of this file, handing the caller index.html with a 200 — an image tag that
 * silently renders a web page.
 */
app.use(
  '/uploads',
  express.static(require('./services/paths').UPLOAD_DIR, {
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
//
// This endpoint used to advertise the full auth scheme, a 40-line endpoint
// list including every /auth/* route, and the whole role ladder. All of that is
// gone, and the endpoint now says so explicitly rather than just quietly
// omitting it — an operator reading this output is looking for exactly the
// question "does this thing still need a login?", and "no" is the answer.
//
// The n8n / X-CMS-API-KEY notification endpoints are still not listed: they are
// machine-to-machine surface, not part of the browser app.
app.get('/api/version', (req, res) => {
  res.json({
    api_version: '1.1.0',
    phase: 5,
    authentication: {
      required: false,
      scheme: 'none',
      note: 'This deployment is unauthenticated by design. It is intended for a private network; do not expose this port to the internet.'
    },
    endpoints: [
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
      'GET /api/makers',
      'POST /api/makers',
      'GET /api/makers/:id',
      'PUT /api/makers/:id',
      'DELETE /api/makers/:id',
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
      // Runtime CORS allowlist, editable without a restart — the whole point is
      // that fixing an origin no longer needs SSH.
      'GET /api/settings/cors',
      'PUT /api/settings/cors',
      'POST /api/settings/cors/reset'
    ]
  });
});

// Runtime server settings (currently the CORS allowlist). Mounted under /api
// only, because a control that rewrites who may talk to the server has no
// business also being reachable on a second, un-prefixed path.
const settingsRoutes = require('./routes/settings');
app.use('/api', settingsRoutes);

// ---------------------------------------------------------------------------
// Data routes. These carry NO authentication middleware: verifyToken and
// requireWriteAccess were removed along with the account system, and nothing
// replaced them. That is the intended end state for a private-network
// deployment (see the warning at the top of this file) — but it is the single
// most important thing to understand before changing anything here.
//
// The routers themselves still own their input validation, their parameter
// whitelists and their SQL safety, so an unauthenticated caller is still bound
// by every check the handlers make. What is gone is *who* is calling, not what
// they can send.
const costumeRoutes = require('./routes/costumes');
app.use('/api/costumes', costumeRoutes);
app.use('/costumes', costumeRoutes);

const brandRoutes = require('./routes/brands');
app.use('/api/brands', brandRoutes);
app.use('/brands', brandRoutes);

const fandomRoutes = require('./routes/fandoms');
app.use('/api/fandoms', fandomRoutes);
app.use('/fandoms', fandomRoutes);

const propsRoutes = require('./routes/props');
app.use('/api/props', propsRoutes);
app.use('/props', propsRoutes);

const lensesRoutes = require('./routes/lenses');
app.use('/api/lenses', lensesRoutes);
app.use('/lenses', lensesRoutes);

// Maker Corner — the maker directory. Mounted on the same double path as the
// other data routers (the un-prefixed alias is how the rest of this server is
// wired, so a Maker link should not be the odd one out).
const makerRoutes = require('./routes/makers');
app.use('/api/makers', makerRoutes);
app.use('/makers', makerRoutes);

// Image endpoints. The browser app and n8n both use these, and the API key is
// still accepted where the router asks for it.
const imageRoutes = require('./routes/images');
app.use('/api/images', imageRoutes);
app.use('/images', imageRoutes);

// Alias kept for the phase-5 frontend spec (`POST /api/upload`). Same handler,
// same response shape as the canonical /api/images/upload.
app.post('/api/upload', imageRoutes.singleUploadChain);
app.post('/upload', imageRoutes.singleUploadChain);

// Export / import of the whole collection. Mounted under /api only, like the
// settings router and for the same reason: an import replaces the operator's
// data, and it has no business also being reachable on a second, un-prefixed
// path that a caller could stumble into. The router carries its own
// confirmation requirement and its own tight rate limit.
const transferRoutes = require('./routes/transfer');
app.use('/api', transferRoutes);

// Notification endpoints are the ONE surface that still requires a credential:
// machine-to-machine callers only, gated on X-CMS-API-KEY inside the router.
const notificationRoutes = require('./routes/notifications');
app.use('/api', notificationRoutes);
app.use('/', notificationRoutes);

// Static frontend UI. PUBLIC_DIR rather than a __dirname-relative literal: it
// stays read-only in every deployment, so the main process needs no override,
// but routing it through the shared module keeps all five path resolutions in
// one place.
app.use(express.static(require('./services/paths').PUBLIC_DIR));

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
  .then(() => {
    // Push the admin-saved Telegram token into the transport. This MUST run
    // before the first notification is attempted: a token saved through the
    // Settings form is in the database, not in process.env, so without this
    // the server would keep using the .env token (or none) until the next
    // restart — a setting the UI reports as "saved" that quietly is not in
    // force. primeTelegramConfig() is chained rather than raced so the startup
    // report below can trust its result.
    return telegramConfig.primeTelegramConfig();
  })
  .then(source => {
    reportTelegramConfig(source);
  })
  .then(() => {
    // The daily expiry check starts LAST, and only once the token it will send
    // with is already in the transport. Starting it earlier would mean the
    // first tick could read a stale token; starting it unconditionally at all
    // would mean a process that is only being used as an API keeps a timer it
    // never needs.
    //
    // A missing token or chat id does NOT stop the timer. That is deliberate:
    // the operator may paste a token into Settings minutes after the server
    // booted, and a checker that had switched itself off at boot would need a
    // restart to come back — which is exactly the thing the settings screen
    // promises never to require. The check re-reads the config every run, so it
    // simply does nothing until there is something to send with.
    lensExpiryChecker.start();
  })
  .catch((error) => {
    console.error('❌ Schema initialisation failed:', error.message);
  });

/**
 * Loud, non-fatal startup check for a half-configured Telegram bot.
 *
 * This used to be a much more serious check: it warned that 2FA was enabled for
 * an account whose OTP could not be delivered, which would have LOCKED THAT USER
 * OUT of the app. There is no account and no login any more, so a missing bot
 * token is now an ordinary misconfiguration — notifications simply will not
 * arrive — and refusing to boot over it would be the wrong trade.
 *
 * It never prints a chat id, a bot token, or any credential.
 *
 * `source` is the resolution result handed back by primeTelegramConfig(). This
 * check used to read process.env directly, which was the only place a token
 * could live. Now that one can also come from "ServerSetting", reading the env
 * here would print a loud "NOT CONFIGURED" warning at the top of every boot
 * for an installation whose token was perfectly well saved in the UI — teaching
 * the operator to ignore this banner, which is the opposite of its purpose.
 */
function reportTelegramConfig(source) {
  if (source === 'database' || source === 'env') return;

  console.warn('\n' + '='.repeat(60));
  console.warn('⚠️  NO TELEGRAM BOT TOKEN IS CONFIGURED.');
  console.warn('   Notification messages will NOT be delivered — the service falls back');
  console.warn('   to printing them to the log instead of sending them.');
  console.warn('   Fix: paste a token from @BotFather into Settings → Telegram, or set');
  console.warn('        TELEGRAM_BOT_TOKEN in .env. Both work; the UI wins if both are set.');
  console.warn('='.repeat(60) + '\n');
}

// The host is explicit rather than relying on the no-host overload. Without it
// Node binds `::` (the unspecified IPv6 address, dual-stack), which is correct on
// a normal Linux host but is exactly the kind of implicit default that a
// container runtime, a hardened sysctl, or a future base-image change can turn
// into a listen-only-on-loopback. Naming 0.0.0.0 states the intent: reachable
// from outside this network namespace, which is what a published container port
// needs.
const server = app.listen(PORT, BIND_ADDRESS, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Express Server Started');
  console.log(`${'='.repeat(60)}`);
  console.log(`🌐 Server running on: http://localhost:${PORT}`);
  console.log(`   Bound to: ${BIND_ADDRESS === '0.0.0.0' ? '0.0.0.0 (all interfaces)' : BIND_ADDRESS}`);
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
      console.log('   Editable at runtime: PUT /api/settings/cors — no restart needed.');
    })
    .catch(() => {
      console.log(`🔒 CORS allowlist: ${settings.getCorsOriginsSync().join(', ')}`);
    });
  console.log(`${'='.repeat(60)}\n`);

  console.log('📡 Endpoints:');
  console.log('   GET  /health');
  console.log('   GET  /api/version');
  console.log('');
  console.log('🔓 Data routes: /api/costumes, /api/brands, /api/fandoms, /api/props,');
  console.log('               /api/lenses, /api/makers, /api/images  — NO AUTHENTICATION REQUIRED');
  console.log('🤖 API-key routes: /api/notifications (X-CMS-API-KEY required)');
  console.log('🔔 Lens expiry alerts: checked daily by this server itself — no external');
  console.log('   scheduler, no n8n. Window and credentials: Settings → Telegram.');
  console.log('\n⚠️  This server does not authenticate anyone. Anyone who can reach this');
  console.log('   port has full read AND write access to every record. Keep it on a');
  console.log('   trusted network only — do not publish it to the internet.\n');
  console.log('ℹ️  Frontend SPA: public/index.html\n');
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

  // Stop the daily check before draining. The timer is already unref'd so it
  // cannot hold the process open by itself, but clearing it here means a
  // shutdown never has an in-flight alert racing the exit.
  lensExpiryChecker.stop();

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
