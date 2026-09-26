/**
 * Hand-rolled in-memory rate limiter.
 *
 * `express-rate-limit` is not a dependency of this project and installing a new
 * package for one middleware is a larger change than warranted, so this is a
 * minimal fixed-window limiter with the same external contract:
 *
 *   rateLimit({ windowMs, max, keyGenerator?, message? }) -> middleware
 *
 * NOTE: the store is per-process and in-memory. Behind a multi-instance /
 * clustered deployment this must be swapped for a shared store (Redis), and
 * `app.set('trust proxy', 1)` must be configured so the client IP is derived
 * from X-Forwarded-For rather than the proxy's own socket address.
 */
// ---------------------------------------------------------------------------
// TEST-ONLY BYPASS (default OFF — Phase 5 automated suite)
//
// The Phase 5 suite has to exercise the login / 2fa-verify / resend /
// break-glass flows many times over, and every one of those surfaces is capped
// at 5-10 requests per IP per 15 minutes. The limits are CORRECT for
// production and are deliberately NOT raised here.
//
// This bypass is honoured only when BOTH conditions hold:
//   NODE_ENV === 'test'  AND  CMS_TEST_DISABLE_RATE_LIMIT === '1'
// i.e. it is inert in dev and in production no matter how it is configured.
// It is the only supported way to run the suite without waiting 15 minutes
// between sections.
// ---------------------------------------------------------------------------
const RATE_LIMIT_DISABLED =
  process.env.NODE_ENV === 'test' && process.env.CMS_TEST_DISABLE_RATE_LIMIT === '1';

const buckets = new Map();

// Periodic sweep so abandoned keys cannot grow the map without bound.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60 * 1000);
sweep.unref();

function defaultKeyGenerator(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function rateLimit(options = {}) {
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const max = options.max || 300;
  const keyGenerator = options.keyGenerator || defaultKeyGenerator;
  const message = options.message || 'Too many requests, please try again later.';
  const code = options.code || 'RATE_LIMITED';
  const name = options.name || 'default';

  return function rateLimitMiddleware(req, res, next) {
    if (RATE_LIMIT_DISABLED) return next();

    const key = `${name}:${keyGenerator(req)}`;
    const now = Date.now();
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message, code });
    }

    next();
  };
}

/** Reset a key's counter — used by the login route after a successful auth. */
function resetLimit(name, req, keyGenerator = defaultKeyGenerator) {
  buckets.delete(`${name}:${keyGenerator(req)}`);
}

module.exports = { rateLimit, resetLimit };
