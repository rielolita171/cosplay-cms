const crypto = require('crypto');

/**
 * API Key Authentication Middleware for Server-to-Server Webhooks (n8n, Cron Jobs)
 * Header: X-CMS-API-KEY
 *
 * SCOPE: this is the ONLY credential left in the app. The human-facing routes are
 * unauthenticated by design (see the security note at the top of src/server.js) —
 * the operator secures the network, not this process. What this middleware still
 * guards is the machine-to-machine surface: the n8n notification endpoints, which
 * are not part of the browser app and would otherwise be writable by anything that
 * can reach the port.
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

  // Mark the request as machine-authenticated. Set ONLY here, i.e. only after the
  // key has passed the constant-time comparison above, so it cannot be obtained by
  // merely sending the header. Nothing reads this marker any more now that the role
  // ladder is gone, but it stays because it is the honest record of how the request
  // authenticated, and a future machine-only route can gate on it.
  req.apiKeyAuth = true;

  next();
}

module.exports = {
  requireApiKey,
  isValidApiKey,
  safeCompare
};
