const crypto = require('crypto');

/**
 * API Key Authentication Middleware for Server-to-Server Webhooks (n8n, Cron Jobs)
 * Header: X-CMS-API-KEY
 *
 * NOTE: the key comparison is constant-time. A plain `===` short-circuits on the
 * first differing byte, which leaks the key length/prefix through response timing.
 */
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  // Hash both sides so unequal lengths do not throw and still compare in fixed time.
  const hashA = crypto.createHash('sha256').update(bufA).digest();
  const hashB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * Extracts a valid API key without short-circuiting, so callers can do
 * `if (!isValidApiKey(...)) return res.status(403)...`.
 */
function isValidApiKey(providedKey) {
  const configuredKey = process.env.API_KEY;
  // Handle case where .env has a literal shell placeholder or clean key
  const validKey = configuredKey ? configuredKey.trim() : null;
  if (!validKey || !providedKey) return false;
  if (validKey.includes('$(') || validKey.includes('your_') || validKey.includes('here')) {
    return false; // placeholder key — refuse rather than accept a literal placeholder
  }
  return safeCompare(providedKey.trim(), validKey);
}

function requireApiKey(req, res, next) {
  const providedKey = req.headers['x-cms-api-key'] || req.query.apiKey;

  if (!providedKey) {
    return res.status(401).json({
      error: 'API key required',
      message: 'Please provide X-CMS-API-KEY header'
    });
  }

  if (!isValidApiKey(providedKey)) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key provided'
    });
  }

  next();
}

/**
 * Accepts EITHER a valid user JWT (Authorization: Bearer) OR a valid API key.
 * Used for endpoints consumed by both the browser SPA and n8n.
 */
function verifyTokenOrApiKey(req, res, next) {
  if (req.headers['x-cms-api-key'] || req.query.apiKey) {
    return requireApiKey(req, res, next);
  }
  return require('../middleware/auth').verifyToken(req, res, next);
}

module.exports = {
  requireApiKey,
  verifyTokenOrApiKey,
  isValidApiKey,
  safeCompare
};
