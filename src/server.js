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

// CORS — strict allowlist. NEVER combine a wildcard origin with credentials.
const DEFAULT_CORS_ORIGIN = 'http://localhost:4001';
const corsOrigins = (process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN)
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

if (corsOrigins.includes('*')) {
  console.warn('⚠️  CORS_ORIGIN="*" is not allowed with credentials — falling back to localhost only.');
  corsOrigins.length = 0;
  corsOrigins.push(DEFAULT_CORS_ORIGIN);
}

app.use(cors({
  origin(origin, callback) {
    // Same-origin / curl / server-to-server requests have no Origin header.
    if (!origin) return callback(null, true);
    if (corsOrigins.includes(origin)) return callback(null, true);
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

// Static files for uploaded images
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

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
      'GET /api/images/stats'
    ]
  });
});

// ---------------------------------------------------------------------------
// Auth routes — self-guarded (public login/2fa, verifyToken on the rest).
// ---------------------------------------------------------------------------
const authRoutes = require('./routes/auth');
app.use('/api', authRoutes);
app.use('/', authRoutes);

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
const authMiddleware = require('./middleware/auth');
const { verifyTokenOrApiKey } = require('./middleware/apiKeyAuth');

const costumeRoutes = require('./routes/costumes');
app.use('/api/costumes', authMiddleware.verifyToken, costumeRoutes);
app.use('/costumes', authMiddleware.verifyToken, costumeRoutes);

// Brand / Fandom reference lists. Same prefix-scoped guard as the other data
// routes — see the WARNING above about mounting on '/' or '/api'.
const brandRoutes = require('./routes/brands');
app.use('/api/brands', authMiddleware.verifyToken, brandRoutes);
app.use('/brands', authMiddleware.verifyToken, brandRoutes);

const fandomRoutes = require('./routes/fandoms');
app.use('/api/fandoms', authMiddleware.verifyToken, fandomRoutes);
app.use('/fandoms', authMiddleware.verifyToken, fandomRoutes);

const propsRoutes = require('./routes/props');
app.use('/api/props', authMiddleware.verifyToken, propsRoutes);
app.use('/props', authMiddleware.verifyToken, propsRoutes);

const lensesRoutes = require('./routes/lenses');
app.use('/api/lenses', authMiddleware.verifyToken, lensesRoutes);
app.use('/lenses', authMiddleware.verifyToken, lensesRoutes);

// Image endpoints are used by the browser SPA *and* by n8n (X-CMS-API-KEY), so
// they accept either credential.
const imageRoutes = require('./routes/images');
app.use('/api/images', verifyTokenOrApiKey, imageRoutes);
app.use('/images', verifyTokenOrApiKey, imageRoutes);

// Alias kept for the phase-5 frontend spec (`POST /api/upload`). Same handler,
// same guard, same response shape as the canonical /api/images/upload.
// Mounted with app.post (not app.use) so the guard is scoped to this one path.
app.post('/api/upload', verifyTokenOrApiKey, imageRoutes.singleUploadChain);
app.post('/upload', verifyTokenOrApiKey, imageRoutes.singleUploadChain);

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
db.initSchema().catch((error) => {
  console.error('❌ Schema initialisation failed:', error.message);
});

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Express Server Started');
  console.log(`${'='.repeat(60)}`);
  console.log(`🌐 Server running on: http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API version: http://localhost:${PORT}/api/version`);
  console.log(`🔒 CORS allowlist: ${corsOrigins.join(', ')}`);
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

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Server interrupted, shutting down...');
  process.exit(0);
});

module.exports = app;
