const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('../services/db');
const { send2FAOTP } = require('../services/telegramService');
const { generateBreakGlassRecoveryKey, verifyRecoveryKey } = require('../services/recoveryService');
const { rateLimit } = require('../middleware/rateLimit');
const { enumParam, idParam } = require('../services/sqlSafety');
const {
  generateToken,
  generateRefreshToken,
  generateTemp2FAToken,
  verifyJwt,
  verifyToken,
  authorize,
  ASSIGNABLE_ROLES,
  TOKEN_TYPE,
  TEMP_2FA_TTL_SECONDS
} = require('../middleware/auth');

// ============================================================================
// Constants
// ============================================================================
const OTP_TTL_MS = TEMP_2FA_TTL_SECONDS * 1000; // 5 minutes
const OTP_LENGTH = 6;

// Rate limits (per IP). Brute-force surfaces are deliberately aggressive.
const loginLimiter = rateLimit({
  name: 'auth-login',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many login attempts. Try again in 15 minutes.'
});
const otpLimiter = rateLimit({
  name: 'auth-2fa-verify',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many verification attempts. Try again in 15 minutes.'
});
const otpResendLimiter = rateLimit({
  name: 'auth-2fa-resend',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many resend requests. Try again in 15 minutes.'
});
const breakGlassLimiter = rateLimit({
  name: 'auth-break-glass',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many break-glass attempts. Try again in 15 minutes.'
});

// Single, indistinguishable error for every 2FA failure mode (wrong code, bad
// tempToken, expired code, replayed tempToken) — prevents enumeration/oracles.
const GENERIC_2FA_ERROR = 'Invalid or expired code';
const GENERIC_LOGIN_ERROR = 'Invalid username or password';

// ============================================================================
// Password hashing
// ============================================================================
// New passwords are bcrypt-hashed. `passwordHash` values that predate this
// change are unsalted SHA-256 hex digests, so those are still verified
// (constant-time) and transparently upgraded to bcrypt on successful login.
function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function legacySha256(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]?\$\d{2}\$/.test(value);
}

function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (isBcryptHash(storedHash)) {
    try {
      return bcrypt.compareSync(password, storedHash);
    } catch {
      return false;
    }
  }
  const candidate = legacySha256(password);
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(String(storedHash), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ============================================================================
// Telegram availability — fail SAFE and LOUD rather than pretending
// ============================================================================
/**
 * SQLite INTEGER columns arrive as strings over the CLI pipe, and the string
 * '0' is TRUTHY in JavaScript — so every boolean column must be normalised
 * explicitly or "2FA disabled" silently reads as "2FA enabled".
 */
function toBool(value) {
  return value === 1 || value === '1' || value === true;
}

function isTelegramConfigured() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes('$(') || token.includes('your_') || token.includes('here')) return false;
  return true;
}

function telegramUnconfigured(res) {
  return res.status(503).json({
    error: 'Telegram is not configured on this server; 2FA codes cannot be delivered',
    code: 'TELEGRAM_NOT_CONFIGURED'
  });
}

// ============================================================================
// OTP helpers
// ============================================================================
function generateOtp() {
  const max = 10 ** OTP_LENGTH;
  // Rejection sampling keeps the distribution uniform (no modulo bias).
  const limit = Math.floor(0xFFFFFFFF / max) * max;
  let value;
  do {
    value = crypto.randomBytes(4).readUInt32BE(0);
  } while (value >= limit);
  return String(value % max).padStart(OTP_LENGTH, '0');
}

/**
 * The OTP is never stored in plaintext: only an HMAC keyed with a per-user
 * server secret. Verification is a constant-time compare of HMACs.
 */
function otpPepper() {
  return process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
}

function hashOtp(userId, otp) {
  return crypto.createHmac('sha256', otpPepper()).update(`${userId}:${otp}`).digest('hex');
}

function otpMatches(userId, otp, storedHash) {
  if (!storedHash || !otp) return false;
  const a = Buffer.from(hashOtp(userId, String(otp).trim()), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function isOtpValid(user) {
  if (!user.twoFactorSecret) return false;
  if (!user.twoFactorExpiry) return true;
  const expiry = new Date(user.twoFactorExpiry).getTime();
  return !Number.isNaN(expiry) && Date.now() < expiry;
}

/**
 * Issue a fresh OTP, persist its HMAC + expiry, and push it via Telegram.
 * Returns { delivered, simulated }.
 */
async function issueOtp(user) {
  const otp = generateOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await db.updateUser(user.id, { twoFactorSecret: hashOtp(user.id, otp), twoFactorExpiry: expiresAt });

  const result = await send2FAOTP(user.telegramChatId, otp);
  return { delivered: !!result?.success, simulated: !!result?.simulated };
}

// ============================================================================
// Response shaping
// ============================================================================
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    // Own profile, so the chat id is acceptable to return — but never the
    // twoFactorSecret or recoveryCodeHash.
    telegramChatId: user.telegramChatId || null,
    telegram2FAEnabled: toBool(user.telegram2FAEnabled),
    role: user.role || 'user'
  };
}

async function authSuccessPayload(user) {
  const accessToken = generateToken(user.id, user.role || 'user');
  const refresh = await generateRefreshToken(user.id);
  return {
    token: accessToken,
    accessToken,
    refreshToken: refresh.token,
    tokenType: 'Bearer',
    expiresIn: 15 * 60, // seconds
    user: publicUser(user)
  };
}

// ============================================================================
// POST /auth/register - Create new user
// ============================================================================
router.post('/auth/register', rateLimit({
  name: 'auth-register', windowMs: 60 * 60 * 1000, max: 5,
  message: 'Too many accounts created from this address. Try again later.'
}), async (req, res) => {
  try {
    const { username, email, password } = req.body || {};

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const id = randomUUID();
    const passwordHash = hashPassword(password);

    let user;
    try {
      user = await db.createUser({ id, username, email, passwordHash, role: 'user' });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'Username or email already exists' });
      }
      throw error;
    }

    res.status(201).json({
      id,
      username,
      email,
      role: 'user',
      ...(await authSuccessPayload(user)),
      message: 'User registered successfully'
    });
  } catch (error) {
    console.error('❌ register error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// POST /auth/login - Authenticate user (two-step when 2FA is enabled)
// ============================================================================
router.post('/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }

    const user = await db.getUserByUsername(username);
    const ok = verifyPassword(password, user?.passwordHash);

    // Identical response and (roughly) identical work whether the user exists,
    // the password is wrong, or the account has no password set at all.
    if (!user || !ok) {
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR, code: 'INVALID_CREDENTIALS' });
    }

    // Opportunistic upgrade of legacy SHA-256 hashes.
    if (!isBcryptHash(user.passwordHash)) {
      await db.updateUser(user.id, { passwordHash: hashPassword(password) });
    }

    const twoFactorEnabled = toBool(user.telegram2FAEnabled);

    if (twoFactorEnabled) {
      if (!isTelegramConfigured() || !user.telegramChatId) {
        console.error('❌ 2FA is enabled for user', user.id, 'but Telegram is not configured / chat id missing');
        return telegramUnconfigured(res);
      }

      const temp = generateTemp2FAToken(user.id);
      const delivery = await issueOtp(user);
      if (!delivery.delivered) {
        console.error('❌ OTP delivery failed for user', user.id, delivery);
        return telegramUnconfigured(res);
      }

      // NOTE: no access token is issued at this stage.
      return res.json({
        require2FA: true,
        tempToken: temp.token,
        expiresIn: TEMP_2FA_TTL_SECONDS,
        expiresInSeconds: TEMP_2FA_TTL_SECONDS,
        delivery: delivery.simulated ? 'simulated' : 'telegram'
      });
    }

    res.json({ require2FA: false, ...(await authSuccessPayload(user)) });
  } catch (error) {
    console.error('❌ login error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// POST /auth/2fa/verify - Exchange tempToken + OTP for real tokens
// ============================================================================
router.post('/auth/2fa/verify', otpLimiter, async (req, res) => {
  const { tempToken, otp } = req.body || {};

  let claims;
  try {
    claims = verifyJwt(tempToken, TOKEN_TYPE.TEMP_2FA);
  } catch (error) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  // Replay protection: a consumed tempToken is dead even if the OTP matches.
  if (await db.isJtiConsumed(claims.jti)) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  const user = await db.getUserById(claims.id || claims.sub);
  if (!user) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  if (!toBool(user.telegram2FAEnabled) || !isOtpValid(user) || !otpMatches(user.id, otp, user.twoFactorSecret)) {
    // The tempToken stays usable after a wrong guess so a typo does not lock the
    // user out; brute force is bounded by otpLimiter (5 attempts / 15 min / IP)
    // and by the 5-minute tempToken lifetime.
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  // Single-use: only the first successful verify consumes the jti, and a
  // consumed jti is rejected above, so a captured tempToken cannot be replayed.
  if (!(await db.consumeJti(claims.jti, TOKEN_TYPE.TEMP_2FA, Date.now() + OTP_TTL_MS))) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  // OTP consumed — clear the stored hash so it cannot be replayed.
  await db.updateUser(user.id, { twoFactorSecret: null, twoFactorExpiry: null });

  res.json({ require2FA: false, ...(await authSuccessPayload(user)) });
});

// ============================================================================
// POST /auth/2fa/resend - Send a new OTP for a still-valid tempToken
// ============================================================================
router.post('/auth/2fa/resend', otpResendLimiter, async (req, res) => {
  const { tempToken } = req.body || {};

  let claims;
  try {
    claims = verifyJwt(tempToken, TOKEN_TYPE.TEMP_2FA);
  } catch (error) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  if (await db.isJtiConsumed(claims.jti)) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  const user = await db.getUserById(claims.id || claims.sub);
  if (!user || !toBool(user.telegram2FAEnabled)) {
    return res.status(401).json({ error: GENERIC_2FA_ERROR, code: 'INVALID_2FA' });
  }

  if (!isTelegramConfigured() || !user.telegramChatId) {
    return telegramUnconfigured(res);
  }

  const delivery = await issueOtp(user);
  if (!delivery.delivered) return telegramUnconfigured(res);

  res.json({
    message: 'A new verification code has been sent',
    expiresIn: TEMP_2FA_TTL_SECONDS,
    delivery: delivery.simulated ? 'simulated' : 'telegram'
  });
});

// ============================================================================
// PATCH|POST /auth/2fa/toggle - Enable or disable Telegram 2FA (auth required)
// ============================================================================
const toggle2FAHandler = async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const body = req.body || {};
    // Support both an explicit flag and a bare toggle.
    const nextEnabled = typeof body.enabled === 'boolean'
      ? body.enabled
      : !toBool(user.telegram2FAEnabled);

    if (nextEnabled && !isTelegramConfigured()) {
      return telegramUnconfigured(res);
    }

    await db.updateUser(user.id, { telegram2FAEnabled: nextEnabled ? 1 : 0 });
    const updated = await db.getUserById(user.id);

    res.json({
      user: publicUser(updated),
      telegram2FAEnabled: toBool(updated.telegram2FAEnabled),
      message: `2FA ${nextEnabled ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    console.error('❌ 2fa toggle error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
};

// The current frontend issues POST; phase-5 docs specify PATCH. Both work.
router.patch('/auth/2fa/toggle', verifyToken, toggle2FAHandler);
router.post('/auth/2fa/toggle', verifyToken, toggle2FAHandler);

// ============================================================================
// POST /auth/break-glass/generate - Rotate the emergency recovery key
// ============================================================================
router.post('/auth/break-glass/generate', verifyToken, breakGlassLimiter, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const { secretKey, keyHash } = generateBreakGlassRecoveryKey();
    await db.updateUser(user.id, { recoveryCodeHash: keyHash });

    // The plaintext key is returned exactly once — it cannot be recovered later.
    res.json({
      recoveryKey: secretKey,
      generatedAt: new Date().toISOString(),
      message: 'New emergency recovery key generated. Store it securely — it is not retrievable later.'
    });
  } catch (error) {
    console.error('❌ break-glass generate error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// POST /auth/break-glass - Log in with the emergency key instead of an OTP
// ============================================================================
router.post('/auth/break-glass', breakGlassLimiter, async (req, res) => {
  try {
    const { username, recoveryKey, key } = req.body || {};
    const provided = recoveryKey || key;

    if (!username || !provided) {
      return res.status(400).json({ error: 'username and recoveryKey are required' });
    }

    const user = await db.getUserByUsername(username);
    const valid = user?.recoveryCodeHash ? verifyRecoveryKey(String(provided).trim(), user.recoveryCodeHash) : false;

    if (!user || !valid) {
      return res.status(401).json({ error: 'Invalid recovery key', code: 'INVALID_RECOVERY_KEY' });
    }

    // Burn the used recovery key: break-glass is single-use per key.
    await db.updateUser(user.id, { recoveryCodeHash: null });

    res.json({
      require2FA: false,
      usedBreakGlass: true,
      ...(await authSuccessPayload(user))
    });
  } catch (error) {
    console.error('❌ break-glass error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// GET /auth/profile - Current user profile (requires access token)
// ============================================================================
router.get('/auth/profile', verifyToken, async (req, res) => {
  try {
    const user = await db.getUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const profile = {
      ...publicUser(user),
      createdAt: user.createdAt
    };

    // The frontend reads `data.user.*`; the flat fields are kept for API
    // consumers that read the profile object directly.
    res.json({ ...profile, user: profile });
  } catch (error) {
    console.error('❌ profile error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// POST /auth/refresh - Rotate a refresh token
// ============================================================================
// Body: { refreshToken }. A new access token AND a new refresh token are issued;
// the presented refresh token is invalidated. Presenting an already-rotated
// token is treated as theft and revokes the whole family.
router.post('/auth/refresh', rateLimit({
  name: 'auth-refresh', windowMs: 15 * 60 * 1000, max: 30,
  message: 'Too many refresh attempts. Try again in 15 minutes.'
}), async (req, res) => {
  try {
    const { refreshToken } = req.body || {};
    if (!refreshToken) {
      return res.status(400).json({ error: 'refreshToken is required' });
    }

    let claims;
    try {
      claims = verifyJwt(refreshToken, TOKEN_TYPE.REFRESH);
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'INVALID_REFRESH_TOKEN' });
    }

    const record = await db.getRefreshToken(claims.jti);
    const now = Date.now();

    if (!record || record.expiresAt < now || record.revokedAt) {
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'INVALID_REFRESH_TOKEN' });
    }

    if (record.usedAt) {
      // Reuse of a rotated token => assume the token leaked. Revoke the family.
      await db.revokeFamily(record.familyId);
      console.error('🚨 refresh token reuse detected for user', record.userId, '— family revoked');
      return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'REFRESH_TOKEN_REUSED' });
    }

    const user = await db.getUserById(record.userId);
    if (!user) return res.status(401).json({ error: 'Invalid or expired refresh token', code: 'INVALID_REFRESH_TOKEN' });

    await db.markRefreshTokenUsed(record.jti);
    const rotated = await generateRefreshToken(user.id, record.familyId);

    res.json({
      token: generateToken(user.id, user.role || 'user'),
      accessToken: generateToken(user.id, user.role || 'user'),
      refreshToken: rotated.token,
      tokenType: 'Bearer',
      expiresIn: 15 * 60,
      user: publicUser(user)
    });
  } catch (error) {
    console.error('❌ refresh error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// POST /auth/logout - Revoke the current session's refresh tokens
// ============================================================================
router.post('/auth/logout', verifyToken, async (req, res) => {
  try {
    const { refreshToken } = req.body || {};

    if (refreshToken) {
      try {
        const claims = verifyJwt(refreshToken, TOKEN_TYPE.REFRESH);
        const record = await db.getRefreshToken(claims.jti);
        if (record) await db.revokeFamily(record.familyId);
      } catch (error) {
        // Nothing to revoke — access tokens are stateless and expire in 15 min.
      }
    } else {
      await db.revokeAllForUser(req.user.id);
    }

    res.json({ message: 'Logged out successfully. Please discard the access token.' });
  } catch (error) {
    console.error('❌ logout error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// Housekeeping: drop expired refresh/consumed-token rows.
setInterval(() => {
  db.sweepExpired().catch((error) => {
    console.error('❌ token sweep failed:', error.message);
  });
}, 60 * 60 * 1000).unref();

// ============================================================================
// GET /auth/users — list accounts (ADMIN ONLY)
// ============================================================================
// WHY A DEDICATED PROJECTION RATHER THAN publicUser()
// publicUser() is the *own-profile* projection: it deliberately returns
// telegramChatId, which is acceptable to hand back to the person it belongs to
// but is nobody else's business. A user list is a different disclosure context,
// so this endpoint does not reuse it — db.listUsers() already selects an
// explicit column list that contains no passwordHash and no twoFactorSecret, and
// the rows are returned as-is. There is no code path here that can widen that
// projection, which is the property that matters: a future column added to the
// table cannot leak by default, because the SELECT names its columns.
router.get('/auth/users', verifyToken, authorize('admin'), async (req, res) => {
  try {
    const users = await db.listUsers();
    res.json({ users, assignableRoles: ASSIGNABLE_ROLES });
  } catch (error) {
    console.error('❌ list users error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// PATCH /auth/users/:id/role — change an account's role (ADMIN ONLY)
// ============================================================================
// Body: { role }
//
// Four rules, each of which exists because the obvious version of this endpoint
// has a way to permanently lock the instance out of its own user management:
//
//  1. ROLE IS ALLOWLISTED, NOT ESCAPED. The value lands in a SQL string literal
//     inside db.updateUser(). enumParam() rejects anything outside
//     ASSIGNABLE_ROLES with a 400 rather than sanitising it into something inert,
//     which is the strongest of the available defences for a genuinely finite
//     domain.
//  2. NO SELF-CHANGE. An admin demoting themselves would strand the account the
//     new panel needs; combined with (3) that is a one-click permanent lockout.
//  3. NO DEMOTING THE LAST ADMIN. countAdmins() is read BEFORE the write, so
//     "is this the last one" is answered against the state the change applies
//     to. Note it counts `role = 'admin'` as a string rather than via the
//     numeric ladder, because the ladder's floor-mapping would quietly disagree
//     with a literal comparison for any role value this code does not know.
//  4. A NON-EXISTENT TARGET IS A 404, not a silent 200, so the admin panel can
//     tell "applied" from "there was nothing to apply it to".
//
// Checks 1-3 are deliberately in the handler rather than in db.updateUser():
// updateUser() is also used for non-role fields, and baking admin-lockout policy
// into a generic column writer would either surprise its other callers or force
// them to pass a flag to opt out of a rule that does not apply to them.
router.patch('/auth/users/:id/role', verifyToken, authorize('admin'), async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid user id', code: 'INVALID_ID' });
    }

    // (1) allowlist — throws a 400-shaped error, caught below.
    const role = enumParam(req.body ? req.body.role : undefined, ASSIGNABLE_ROLES, 'role');
    if (!role) {
      return res.status(400).json({
        error: `role is required and must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
        code: 'INVALID_ROLE'
      });
    }

    const target = await db.getUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    // (2) no self-change. Compared on id, not username: a username can be
    // edited, and the token's id is the one thing that cannot be reassigned.
    if (target.id === req.user.id) {
      return res.status(400).json({
        error: 'You cannot change your own role. Ask another administrator to do it.',
        code: 'SELF_ROLE_CHANGE'
      });
    }

    const currentRole = target.role || 'user';
    if (currentRole === role) {
      // Idempotent no-op. Reported as a success so a double-submit from the
      // admin panel's <select> is not surfaced as an error.
      return res.json({ user: { ...publicUser(target), role }, changed: false });
    }

    // (3) never demote the last admin. Checked only when the change actually
    // removes an admin, so promoting or editing a non-admin is never blocked.
    if (currentRole === 'admin' && role !== 'admin') {
      const adminCount = await db.countAdmins();
      if (adminCount <= 1) {
        return res.status(400).json({
          error: 'Cannot demote the last remaining administrator. Promote another account first.',
          code: 'LAST_ADMIN'
        });
      }
    }

    await db.updateUser(id, { role });

    const updated = await db.getUserById(id);
    res.json({ user: { ...publicUser(updated), role }, changed: true });
  } catch (error) {
    if (error && error.status === 400) {
      return res.status(400).json({ error: error.message, code: 'INVALID_ROLE' });
    }
    console.error('❌ update role error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
