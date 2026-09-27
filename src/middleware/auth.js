const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../services/db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';

// Token type claims — every token we issue carries exactly one of these.
const TOKEN_TYPE = {
  ACCESS: 'access',
  REFRESH: 'refresh',
  TEMP_2FA: '2fa_pending'
};

const ISSUER = 'cosplay-cms';
const AUDIENCE = 'cosplay-cms-client';

// Short-lived access tokens (OAuth 2.0 / OIDC best practice: minimize the
// window in which a leaked bearer token is useful).
const ACCESS_TTL = '15m';
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const TEMP_2FA_TTL_SECONDS = 5 * 60;           // 5 minutes

// Pinned algorithm. Passing this explicitly is what rejects `alg: none` and
// any algorithm-confusion attempt (e.g. RS256 -> HS256).
const VERIFY_OPTIONS = {
  algorithms: ['HS256'],
  issuer: ISSUER,
  audience: AUDIENCE
};

// ============================================================================
// Startup secret validation
// ============================================================================
const WEAK_SECRETS = [
  'dev-secret-key-change-in-production',
  'secret',
  'change-me',
  'jwt_secret',
  'your_jwt_secret'
];

/**
 * Returns { ok, level: 'fatal'|'warning', reason }.
 * Called from server.js at boot. Never throws so it can be unit-reasoned about.
 */
function validateJwtSecret(secret = JWT_SECRET) {
  if (!secret) {
    return { ok: false, level: 'fatal', reason: 'JWT_SECRET is not set' };
  }
  if (secret.includes('$(') || secret.toLowerCase().includes('your_') || secret.toLowerCase().includes('here')) {
    return { ok: false, level: 'fatal', reason: 'JWT_SECRET is still the unexpanded shell placeholder from .env' };
  }
  if (WEAK_SECRETS.includes(secret)) {
    return { ok: false, level: 'fatal', reason: 'JWT_SECRET matches a known placeholder value' };
  }
  if (secret.length < 32) {
    return { ok: false, level: 'fatal', reason: `JWT_SECRET is too short (${secret.length} chars, need >= 32)` };
  }
  // ENTROPY, NOT CHARSET.
  //
  // This used to be a pair of charset regexes, and both branches were wrong in
  // a way that made the check advisory noise:
  //   /^[a-f0-9]{16,}$/i  fires on the output of `openssl rand -hex 32` — the
  //                      very command the warning message tells you to run. A
  //                      64-hex-char secret is 256 bits of entropy and was
  //                      reported as low-entropy.
  //   /^[a-z0-9]{16,}$/i  is a strict superset of the first (hex ⊂ alphanumeric),
  //                      so it additionally fired on essentially EVERY real
  //                      random secret that happened to contain no `-` or `_`,
  //                      which is the common case for a base64url encoding.
  // Character-set shape cannot distinguish "aaaaaaaa…", which is ~4 bits of
  // entropy, from a 43-character base64url string, which is 256. What can is the
  // observed diversity of the characters, so that is what is measured now.
  //
  // This does NOT weaken the check. A short secret is still FATAL above (which
  // is what actually catches `openssl rand -hex 8` and a 16-hex-char value), the
  // placeholder and known-weak-list checks above are untouched, and a long
  // repeating pattern — the only shape this warning is for — is still surfaced.
  if (new Set(secret).size < 8) {
    return { ok: true, level: 'warning', reason: 'JWT_SECRET is built from fewer than 8 distinct characters and looks repetitive — replace it with 32+ bytes from a CSPRNG (openssl rand -hex 32)' };
  }
  return { ok: true, level: 'ok', reason: 'JWT_SECRET looks acceptable' };
}

// ============================================================================
// Token generation
// ============================================================================
function signToken(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn,
    issuer: ISSUER,
    audience: AUDIENCE
  });
}

/**
 * Access token — short lived, carries identity only.
 */
function generateToken(userId, role = 'user') {
  return signToken({ sub: String(userId), id: userId, role, type: TOKEN_TYPE.ACCESS }, ACCESS_TTL);
}

/**
 * Refresh token — long lived, single use, tracked server-side for rotation.
 * Returns { token, jti, familyId, expiresAt }.
 */
async function generateRefreshToken(userId, familyId = null) {
  const jti = crypto.randomUUID();
  const fam = familyId || crypto.randomUUID();
  const expiresAt = Date.now() + REFRESH_TTL_SECONDS * 1000;
  const token = signToken(
    { sub: String(userId), id: userId, jti, familyId: fam, type: TOKEN_TYPE.REFRESH },
    REFRESH_TTL_SECONDS
  );
  await db.insertRefreshToken({ jti, userId: String(userId), familyId: fam, expiresAt });
  return { token, jti, familyId: fam, expiresAt };
}

/**
 * Temporary "2FA pending" token — proves the password step succeeded but
 * grants NO data access. 5 minute lifetime, type-pinned.
 */
function generateTemp2FAToken(userId) {
  const jti = crypto.randomUUID();
  const token = signToken(
    { sub: String(userId), id: userId, jti, type: TOKEN_TYPE.TEMP_2FA },
    TEMP_2FA_TTL_SECONDS
  );
  return { token, jti, expiresAt: Date.now() + TEMP_2FA_TTL_SECONDS * 1000 };
}

// ============================================================================
// Token verification
// ============================================================================
/**
 * Strict verification. Throws on: bad signature, expired, wrong alg, wrong
 * issuer/audience, or a mismatched `type` claim.
 */
function verifyJwt(token, expectedType) {
  const decoded = jwt.verify(token, JWT_SECRET, VERIFY_OPTIONS);
  if (expectedType && decoded.type !== expectedType) {
    throw new jwt.JsonWebTokenError('Unexpected token type');
  }
  return decoded;
}

function extractBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

// ============================================================================
// Verify JWT Token Middleware (access tokens only)
// ============================================================================
function verifyToken(req, res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  let decoded;
  try {
    decoded = verifyJwt(token, TOKEN_TYPE.ACCESS);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = { id: decoded.id || decoded.sub, role: decoded.role || 'user' };
  next();
}

// ============================================================================
// ROLES AND THE WRITE GUARD
// ============================================================================
/**
 * THE ROLE LADDER
 * ---------------
 *   guest   0  no data access at all (cannot authenticate; kept for the ladder's
 *              floor so an unknown role fails closed rather than throwing)
 *   viewer  1  READ-ONLY. Every GET works; every write is 403. This is the tier
 *              added for "can see the records but must not change them".
 *   user    2  the default every self-registration gets; full CRUD on records.
 *   curator 3  unchanged by the viewer work — kept so existing curator accounts
 *              keep whatever they could already do.
 *   admin   4  + user management (GET /auth/users, PATCH /auth/users/:id/role).
 *
 * WHY `viewer` SITS BELOW `user` AND NOT INSTEAD OF IT
 * `authorize()` existed from the start but was never mounted on a single route, so
 * before this change the ladder was decorative: every authenticated account could
 * write everything. `viewer` is therefore not a rename of `user`, it is a strictly
 * weaker tier, and the write guard below is what actually gives it teeth.
 *
 * WHY AN UNKNOWN ROLE MAPS TO 0
 * `role` is a TEXT column that pre-dates this ladder, so a row can hold any string
 * at all (and `createUser` defaults to 'user', but a hand-edited or imported row
 * need not). Mapping an unrecognised value to the FLOOR means a role this code
 * does not understand can never accidentally satisfy a `>= 'user'` check. The
 * lookup uses hasOwnProperty rather than a `||` fallback so a role literally named
 * 'toString' cannot resolve to a function off the prototype.
 */
const ROLE_LEVELS = Object.freeze({
  guest: 0,
  viewer: 1,
  user: 2,
  curator: 3,
  admin: 4
});

// The roles a client may be told about. Ordered weakest-first so the admin panel's
// <select> can be generated from it without hardcoding the ladder a second time.
const ASSIGNABLE_ROLES = Object.freeze(['viewer', 'user', 'curator', 'admin']);

// The tier at which an account may change data. `viewer` is deliberately below it.
const WRITE_ROLE = 'user';

function roleLevel(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_LEVELS, role) ? ROLE_LEVELS[role] : 0;
}

function hasRoleAtLeast(role, minimumRole) {
  return roleLevel(role) >= roleLevel(minimumRole);
}

/**
 * Authorization Middleware - Check User Role
 *
 * Kept as the general-purpose "at least this tier" guard. The ladder it reads is
 * the shared ROLE_LEVELS above, so it can no longer drift from requireWriteAccess.
 */
function authorize(requiredRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!hasRoleAtLeast(req.user.role, requiredRole)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${requiredRole}`
      });
    }

    next();
  };
}

/**
 * The read/write split, as one METHOD-based middleware.
 *
 * WHY METHOD-BASED RATHER THAN ONE MOUNT PER WRITE ROUTE
 * A viewer has to be stopped from POST, PUT, PATCH and DELETE on five routers plus
 * the two upload endpoints. Enumerating those per route is the shape of bug this
 * project has already been bitten by once (see the prefix-scoped-guard warning in
 * server.js: a guard mounted too broadly starts 401ing unrelated routes). Deciding
 * from `req.method` instead means the guard covers every mutating handler that
 * exists NOW and every one added to the same router later, with nothing to remember
 * and no per-route list to fall out of date.
 *
 * Safe methods pass through untouched — a viewer must be able to READ everything,
 * which is the whole point of the tier.
 *
 * WHY req.apiKeyAuth IS AN EXPLICIT PASS
 * The image endpoints accept EITHER a user JWT OR the X-CMS-API-KEY header (n8n).
 * An API-key request never populates req.user, so "no req.user" is ambiguous
 * between "machine caller" and "somebody forgot to authenticate". apiKeyAuth.js
 * sets the marker only after the key has been verified in constant time, so this
 * check cannot be satisfied by merely sending the header.
 *
 * MOUNT ORDER MATTERS: this must come AFTER an authentication guard. Mounted on its
 * own it would 401 every anonymous request, which is correct, but it would also
 * 403 a legitimate viewer on a route that never authenticated them — the 401
 * branch below is a fail-closed safety net, not the primary check.
 */
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requireWriteAccess(req, res, next) {
  if (READ_ONLY_METHODS.has(req.method)) return next();
  if (req.apiKeyAuth) return next();

  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!hasRoleAtLeast(req.user.role, WRITE_ROLE)) {
    return res.status(403).json({
      error: 'Your account has read-only access. Editing records requires an editor account.',
      code: 'READ_ONLY_ROLE',
      role: req.user.role,
      requiredRole: WRITE_ROLE
    });
  }

  next();
}

// ============================================================================
// Optional Auth Middleware (doesn't fail if no token)
// ============================================================================
function optionalAuth(req, res, next) {
  const token = extractBearerToken(req);

  if (token) {
    try {
      const decoded = verifyJwt(token, TOKEN_TYPE.ACCESS);
      req.user = { id: decoded.id || decoded.sub, role: decoded.role || 'user' };
    } catch (error) {
      // Silently continue without user context
    }
  }

  next();
}

module.exports = {
  generateToken,
  generateRefreshToken,
  generateTemp2FAToken,
  verifyJwt,
  verifyToken,
  authorize,
  requireWriteAccess,
  hasRoleAtLeast,
  roleLevel,
  optionalAuth,
  ROLE_LEVELS,
  ASSIGNABLE_ROLES,
  WRITE_ROLE,
  validateJwtSecret,
  extractBearerToken,
  TOKEN_TYPE,
  ACCESS_TTL,
  REFRESH_TTL_SECONDS,
  TEMP_2FA_TTL_SECONDS
};
