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
  TEMP_2FA_TTL_SECONDS,
  JWT_SECRET
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

// ---------------------------------------------------------------------------
// Password-reset limiters.
//
// The two public reset endpoints below are the ONLY unauthenticated WRITE path
// in this application. Everything else that changes state requires a verified
// token, so these two carry the whole unauthenticated attack surface: an
// attacker who can reach them can overwrite any account's password, given a
// token, and can enumerate token space without a session. They are therefore
// held at or below breakGlassLimiter's strictness (5 / 15 min) rather than at
// the login limiter's, because a token is a bearer credential and a password
// guess is not.
//
// EACH of the two public endpoints is limited on TWO axes:
//
//   PER IP   — bounds a single host's total attempts.
//   PER TOKEN — bounds attempts against ONE token, across all hosts.
//
// The per-token axis is not redundant. An attacker on a botnet (or simply a
// proxy provider) is one IP per attempt, so the per-IP bucket never fills and
// the only limit that still bites is the per-token one. The key is a SHA-256 of
// the token rather than the token itself: the limiter's bucket map is a plain
// in-memory Map, so keying it on the raw token would hold every token anyone
// ever tried in process memory for the length of the window, and the keys
// would be visible in a heap dump. Hashing keeps the map keyed on something
// that reveals nothing, while still partitioning attempts per token.
// ---------------------------------------------------------------------------
const RESET_TOKEN_BYTES = 32;                 // 256 bits of entropy
const RESET_TTL_MINUTES = 60;                // a file left lying about is a liability
const RESET_TOKEN_MAX_LENGTH = 200;          // generous; a real token is 43 chars

/** A composite limiter key: the caller's IP plus a hash of the presented token. */
function perTokenKey(req) {
  const raw = req.body && typeof req.body.token === 'string' ? req.body.token : '';
  // No token in the body (a malformed request) still gets a bucket, keyed on the
  // IP alone — otherwise an attacker could dodge the limiter by omitting it.
  const digest = raw
    ? crypto.createHash('sha256').update(raw).digest('hex')
    : 'no-token';
  return `${req.ip || req.connection?.remoteAddress || 'unknown'}|${digest}`;
}

const resetValidateIpLimiter = rateLimit({
  name: 'auth-password-reset-validate-ip',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many reset-file checks. Try again in 15 minutes.'
});
const resetValidateTokenLimiter = rateLimit({
  name: 'auth-password-reset-validate-token',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many reset-file checks. Try again in 15 minutes.',
  keyGenerator: perTokenKey
});

const resetApplyIpLimiter = rateLimit({
  name: 'auth-password-reset-apply-ip',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many password reset attempts. Try again in 15 minutes.'
});
const resetApplyTokenLimiter = rateLimit({
  name: 'auth-password-reset-apply-token',
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many password reset attempts. Try again in 15 minutes.',
  keyGenerator: perTokenKey
});

// The mint endpoint is admin-authenticated, so a cheap limiter is genuinely
// just a guard against a runaway client (a render loop, a double-submit
// handler) rather than an anti-brute-force control.
const resetMintLimiter = rateLimit({
  name: 'auth-password-reset-mint',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many reset files generated. Try again in 15 minutes.'
});

// Single, indistinguishable error for every 2FA failure mode (wrong code, bad
// tempToken, expired code, replayed tempToken) — prevents enumeration/oracles.
const GENERIC_2FA_ERROR = 'Invalid or expired code';
const GENERIC_LOGIN_ERROR = 'Invalid username or password';

// ONE message for EVERY password-reset failure — unknown token, malformed
// token, expired token, already-used token, and a token whose claim was lost to
// a concurrent request. All five answer 400 with this exact string and this
// exact code, having done the same work to get there.
//
// WHY IT MATTERS: the alternative is telling an attacker which tokens ever
// existed. A reset token is a 256-bit random value, so a leaked database dump
// plus this endpoint would otherwise let an attacker replay every historical
// token and learn the account each belonged to — turning "expired" into an
// oracle for "this token was real, for this user, and is dead". Collapsing the
// cases means the response reveals nothing beyond "this does not work now".
const GENERIC_RESET_ERROR = 'This reset file is invalid, expired, or already used.';

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
// Password policy
// ============================================================================
const MIN_PASSWORD_LENGTH = 8;
// bcrypt silently truncates its input at 72 BYTES. Without a cap, a 200-char
// passphrase is accepted, the first 72 bytes are what actually get hashed, and
// the account is really protected by a far shorter secret than the user
// believes. Rejecting an over-long password is the only way to make what the
// user chose and what is stored agree.
const MAX_PASSWORD_BYTES = 72;

/**
 * The single definition of "strong enough to be an account password".
 *
 * It is a function rather than an inline `if` so that /auth/register and
 * POST /auth/password-reset CANNOT drift apart. The naive version of this
 * feature writes its own weaker check in the new route ("at least 8
 * characters", say) and leaves the real rule in the register handler; a reset
 * then becomes a way to set a password that registration would have refused.
 * One rule, two callers, no weaker path.
 *
 * Returns an error message string, or null when the password is acceptable —
 * the shape the callers already use for a 400 body.
 */
function validateNewPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    return 'Password is required';
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  // Measured in BYTES, not characters: the limit exists because of a byte
  // oriented algorithm, so 'é' costs 2 and must count as 2.
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  return null;
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
 *
 * The pepper is the same secret the JWT layer uses, so it is resolved through
 * src/middleware/auth.js rather than re-read from the environment here. That
 * module already throws in production when JWT_SECRET is missing instead of
 * falling back to a public literal — re-reading process.env.JWT_SECRET with a
 * second `||` fallback would silently reintroduce that exact hole, since this
 * pepper protects the stored OTP hash. Outside production the dev placeholder
 * is still used, so local dev and the test suites are unaffected.
 */
function otpPepper() {
  return JWT_SECRET;
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

    // The shared policy, not a second copy of the rule. The 8-character
    // message is byte-for-byte what this route always returned, so no client
    // can tell the two paths apart.
    const passwordProblem = validateNewPassword(password);
    if (passwordProblem) {
      return res.status(400).json({ error: passwordProblem });
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

// ============================================================================
// PASSWORD RESET — admin-minted, single-use, one-time-FILE (Jellyfin-style)
//
// THE MODEL, AND WHY IT IS THIS ONE
// There is no mail server on this box, so the usual "email me a reset link" is
// not available. What an admin CAN do is hand the user a file. The flow is:
//
//   1. an admin opens the Users tab, presses "Reset password" for an account,
//      and the server mints a 256-bit random token;
//   2. the admin downloads a .txt file and gives it to that user out of band;
//   3. the user pastes the file into the login screen's reset box and chooses a
//      new password;
//   4. the token is dead the moment it is used, and every existing session for
//      that account is destroyed.
//
// This is a DIFFERENT mechanism from the break-glass recovery key in
// src/services/recoveryService.js, and the two are deliberately not merged:
//   * break-glass is self-service. The user must already be logged in to mint
//     the key, and the key lives on their own row — so it cannot help someone
//     who has lost their password, which is the only case that matters here.
//   * a reset token is minted by an ADMIN for someone who cannot self-serve.
//     That is the whole reason this endpoint exists, and it is why the mint
//     route is behind authorize('admin') while the two consume routes are
//     deliberately public.
// ============================================================================

/**
 * SHA-256 hex of a reset token. THIS IS NOT BCRYPT, on purpose.
 *
 * bcrypt exists because its input is something a HUMAN CHOSE. A password is
 * drawn from a small, heavily-reused space, so the attacker is assumed to have
 * a dictionary or a precomputed table and the defence is to make each guess
 * cost ~100ms. A reset token is 32 bytes from crypto.randomBytes — 256 bits
 * from a CSPRNG, with no dictionary, no structure, and no feasible precomputed
 * table. Against that input, a fast hash is cryptographically equivalent to
 * bcrypt: an attacker who recovers the digest still cannot invert it, because
 * the preimage is not drawn from anything enumerable.
 *
 * So bcrypt's only remaining effect here is latency — ~100ms of CPU per
 * attempt on an endpoint that is UNAUTHENTICATED. That is a free denial-of-
 * service gift: it is CPU the server spends on requests anyone can make, and it
 * is paid before the request is even known to be valid. SHA-256 of a 43-byte
 * string is microseconds. The stored value is still useless on its own: a
 * database disclosure yields digests, not tokens, and the plaintext exists only
 * in the one response that mints it and in the file the admin hands over.
 *
 * (This is the same reasoning as the OTP below, which uses an HMAC for the
 * same reason — the value is machine-generated, so the work factor buys nothing.)
 */
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Pull a token out of whatever the user pasted.
 *
 * The paste box will usually receive the ENTIRE .txt file, because that is
 * what people do with a file — nobody highlights the last line on purpose. So
 * when the input contains a newline, the token is taken to be the last
 * non-empty line, and everything above it (the header, the account name, the
 * expiry, the blank lines) is discarded. A single-line paste is used as-is.
 *
 * Being forgiving here is a USABILITY decision and is deliberately not a
 * security one: everything after this point is validated against the database,
 * so a wrong guess is simply the same generic failure as a forged token. There
 * is no parsing path that can make an invalid token valid.
 */
function extractResetToken(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.indexOf('\n') === -1 && trimmed.indexOf('\r') === -1) return trimmed;
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

/** A token shape check that is cheap and does the one thing that matters. */
function isPlausibleResetToken(token) {
  return typeof token === 'string'
    && token.length > 0
    && token.length <= RESET_TOKEN_MAX_LENGTH
    // base64url alphabet only. Rejecting early on a character that could never
    // appear keeps junk out of the rate limiter's per-token key space and out
    // of the SQL, rather than relying on esc() further down.
    && /^[A-Za-z0-9_-]+$/.test(token);
}

/**
 * The single validity predicate, used by BOTH public endpoints.
 *
 * One function, so "valid" cannot mean one thing to /validate and another to
 * the route that actually spends the token. It returns the row or null, and the
 * caller has no way to tell WHICH of the three conditions failed — see
 * GENERIC_RESET_ERROR for why that distinction is suppressed.
 */
function lookupUsableResetToken(token) {
  return db.findPasswordResetTokenByHash(hashResetToken(token)).then((row) => {
    if (!row) return null;                       // never existed
    if (row.usedAt) return null;                 // already spent
    const expiry = Date.parse(row.expiresAt);
    if (Number.isNaN(expiry) || Date.now() >= expiry) return null;
    return row;
  });
}

/** The human-readable .txt body. Plain text, and the token is the only secret. */
function resetFileContents({ username, token, expiresAt }) {
  return [
    'Cosplay CMS - one-time password reset',
    'Account:  ' + username,
    'Expires:  ' + expiresAt,
    '',
    'Paste the token below into the app\'s "Reset password" box.',
    'This file works once and then stops working. Delete it afterwards.',
    '',
    token
  ].join('\n');
}

// ---------------------------------------------------------------------------
// POST /auth/users/:id/password-reset — mint a token (ADMIN ONLY)
//
// The plaintext token is in the response and nowhere else. It is never logged
// (not even on an error path), never written to disk by the server, and never
// stored: only its SHA-256 digest goes in the database. A second press issues
// a NEW token and deletes the previous one, because "Generate" in the panel is
// labelled as issuing a brand-new one everywhere else in this app (see the
// break-glass UI) and silently keeping the old one alive would contradict that.
// ---------------------------------------------------------------------------
router.post('/auth/users/:id/password-reset', verifyToken, authorize('admin'), resetMintLimiter, async (req, res) => {
  try {
    const id = idParam(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid user id', code: 'INVALID_ID' });
    }

    const target = await db.getUserById(id);
    if (!target) {
      return res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
    }

    // One live token per user. Revoking FIRST means a crash between the revoke
    // and the insert leaves the account with no live token — an inconvenience
    // the admin fixes by pressing the button again — rather than two, which
    // would be the actual vulnerability.
    await db.revokeUnusedPasswordResetTokens(target.id);

    const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('base64url');
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000).toISOString();

    await db.createPasswordResetToken({
      id: randomUUID(),
      userId: target.id,
      tokenHash: hashResetToken(token),
      // The minting admin's id, for the audit trail. Not exposed in the
      // response: the caller already knows who they are.
      createdBy: req.user.id,
      createdAt,
      expiresAt
    });

    res.json({
      username: target.username,
      // THE ONCE-ONLY MOMENT. This is the only time the plaintext exists
      // outside the admin's own hands; it cannot be recovered afterwards.
      token,
      fileName: 'cosplay-cms-reset-' + target.username.replace(/[^A-Za-z0-9_-]/g, '_') + '.txt',
      fileContents: resetFileContents({ username: target.username, token, expiresAt }),
      expiresAt,
      message: 'One-time reset file generated. It is not retrievable later — download it now.'
    });
  } catch (error) {
    console.error('❌ mint password reset error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/password-reset/validate — is this file still good? (PUBLIC)
//
// WHY POST AND NOT GET, AND NEVER A QUERY STRING — this is the whole reason
// this endpoint is not a GET:
//
//   * a GET puts the token in the request line, which lands in EVERY access log
//     (nginx, a reverse proxy, a browser history, an APM trace);
//   * a GET's URL is what the browser puts in the Referer header of every
//     subsequent navigation, leaking the token to whatever page the user goes
//     to next, plus any third-party resource on it;
//   * a GET is trivially cacheable, and a cached 200 on a token URL is a
//     credential sitting in a shared cache.
//
// A POST body appears in none of those places. The same reasoning is why the
// response is `Cache-Control: no-store`.
//
// It is a two-step handshake purely so the UI can show "you are resetting
// <username>" before asking for a new password. It confers no authority by
// itself: the token is not consumed, and the password is not set until the
// second call. An attacker who skips straight to the second call gains nothing
// they did not already have.
// ---------------------------------------------------------------------------
router.post('/auth/password-reset/validate', resetValidateIpLimiter, resetValidateTokenLimiter, async (req, res) => {
  // A token is a credential; it must not be cached by anything in the path.
  res.setHeader('Cache-Control', 'no-store');
  try {
    const token = extractResetToken(req.body ? req.body.token : null);
    if (!isPlausibleResetToken(token)) {
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    const row = await lookupUsableResetToken(token);
    if (!row) {
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    const user = await db.getUserById(row.userId);
    if (!user) {
      // A token whose user has since been deleted is treated exactly like an
      // unknown one, for the same reason: its existence is not the caller's
      // business.
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    res.json({ valid: true, username: user.username, expiresAt: row.expiresAt });
  } catch (error) {
    console.error('❌ validate password reset error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ---------------------------------------------------------------------------
// POST /auth/password-reset — spend the token, set the new password (PUBLIC)
//
// ACCEPTED BODY FIELDS: `token` and `newPassword`. NOTHING ELSE.
//
// This endpoint reads those two properties by name and ignores every other key
// in the request. That is not a stylistic choice and it is load-bearing. This
// codebase uses partial-update semantics elsewhere — PATCH /auth/users/:id/
// role takes a body and the costume routes merge a body onto an existing row —
// which makes "read the fields I need out of whatever arrived" a genuinely easy
// habit to pick up by accident here. If this handler forwarded its body to
// db.updateUser() the way those routes do, then `{ token, newPassword, role:
// 'admin' }` would be a complete unauthenticated privilege-escalation: no
// account, no session, no token, just a 256-bit value and a field name. So the
// body is destructured to exactly two names and there is no path from a request
// body to any other column of "User".
//
// NO SESSION IS ISSUED. The response carries no access token, no refresh token
// and no user object. A password reset is a credential-recovery operation, and
// auto-signing-in would mean the person who walked up to an unlocked machine
// (or who found a token left in a chat log) ends up authenticated. The user is
// returned to the login screen and signs in themselves, which is also the only
// way to prove the new password actually works.
// ---------------------------------------------------------------------------
router.post('/auth/password-reset', resetApplyIpLimiter, resetApplyTokenLimiter, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    // Exactly two names are read. See the privilege-escalation note above.
    const { token: rawToken, newPassword } = req.body || {};

    const token = extractResetToken(rawToken);
    if (!isPlausibleResetToken(token)) {
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    // The SAME rule /auth/register uses, via the same function. A reset must
    // not be a way to set a password registration would have refused.
    const passwordProblem = validateNewPassword(newPassword);
    if (passwordProblem) {
      return res.status(400).json({ error: passwordProblem, code: 'WEAK_PASSWORD' });
    }

    const row = await lookupUsableResetToken(token);
    if (!row) {
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    const user = await db.getUserById(row.userId);
    if (!user) {
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    // The stamp is this request's own value. It is written as `usedAt` AND
    // used to gate the two dependent writes inside the transaction, so a
    // concurrent request that LOST the single-use claim cannot drive them —
    // see completePasswordReset() in src/services/db.js.
    const claimStamp = new Date().toISOString();
    const result = await db.completePasswordReset({
      tokenHash: hashResetToken(token),
      passwordHash: hashPassword(newPassword),
      claimStamp
    });

    // Losing the race is not an error the caller can act on, and telling them
    // apart would leak whether the token was real. Same generic answer.
    if (!result.ok) {
      return res.status(400).json({ error: GENERIC_RESET_ERROR, code: 'INVALID_RESET_TOKEN' });
    }

    // Number only — never which user, never the token, nothing usable.
    console.log(`🔑 password reset completed for user ${user.id} (${result.sessionsRevoked} session(s) revoked)`);

    res.json({
      success: true,
      // Deliberately no token / refreshToken / user here. See the header note.
      message: 'Password reset. Sign in with your new password.'
    });
  } catch (error) {
    console.error('❌ password reset error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
