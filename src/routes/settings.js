/**
 * Runtime server settings — currently the CORS allowlist.
 *
 * A SEPARATE ROUTER from the data routes on purpose: a control that rewrites who
 * may talk to the server should never be edited as a side effect of changing a
 * costume.
 *
 * These routes used to be admin-only via verifyToken + authorize('admin'). With
 * the account system removed there is no role to check, so the per-route guard is
 * gone and the write limiter is all that remains. That is consistent with the
 * rest of the app: the operator is trusted, and the network is the boundary.
 */
const express = require('express');
const router = express.Router();

const settings = require('../services/settings');
const { rateLimit } = require('../middleware/rateLimit');

/**
 * Write limiter. Generous compared to the auth brute-force limits (30 changes
 * per 15 minutes) because a legitimate admin may tidy a list several times in
 * a row, but still bounded: this endpoint rewrites the single control that
 * decides who may talk to the app with credentials, so it should not be
 * hammerable by anything that has got hold of a token.
 */
const corsWriteLimiter = rateLimit({
  name: 'settings-cors-write',
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many CORS setting changes. Please slow down.'
});

/**
 * GET /api/settings/cors — the effective allowlist, and where it came from.
 *
 * `source` lets the UI say "you are currently on the .env value" versus "an
 * admin has overridden this in the database", which is the difference between a
 * surprising allowlist and an expected one.
 *
 * `currentRequestOrigin` is the caller's OWN Origin header. It is echoed back so
 * the UI can mark the chip the admin is actually using, and so the self-lockout
 * warning can be specific rather than generic.
 *
 * NOTE on that header: browsers only send `Origin` on CROSS-origin requests.
 * An admin using the app same-origin sends none, so this is null — and that is
 * correct rather than a gap, because a same-origin session is not subject to
 * CORS at all and therefore cannot be locked out by editing this list. The
 * check below and the warning in the UI fire exactly when CORS is in play.
 */
router.get('/settings/cors', async (req, res) => {
  try {
    const effective = await settings.getCorsOrigins();
    const envDefault = settings.getEnvOrigins() || settings.getDefaultOrigins();

    res.json({
      origins: effective.origins,
      source: effective.source,
      envDefault: envDefault,
      currentRequestOrigin: req.get('origin') || null,
      limits: {
        maxOrigins: settings.MAX_ORIGINS,
        maxOriginLength: settings.MAX_ORIGIN_LENGTH
      }
    });
  } catch (error) {
    console.error('❌ read CORS settings error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PUT /api/settings/cors — replace the allowlist.
 *
 * Body: { origins: string[], confirmSelfRemoval?: boolean }
 *
 * SELF-LOCKOUT POLICY (the deliberate choice this endpoint makes)
 *
 * The failure mode that actually matters here is not a hostile admin — this is
 * a single-admin instance — it is a careful admin removing the one origin their
 * own browser is using, and being locked out of the UI with no way back except
 * SSH. That is the exact afternoon-losing scenario this whole feature exists to
 * eliminate, so the protection has to be a guard rail, not a locked door.
 *
 * The choice made here is: REFUSE BY DEFAULT, ALLOW ON EXPLICIT CONFIRM.
 *
 *   - Without `confirmSelfRemoval: true`, a change that would drop the calling
 *     request's own origin is rejected with 400 LOCKOUT_RISK. The default is
 *     the safe one, so a scripted or careless caller cannot lock the instance
 *     out by omission.
 *   - With the flag, it is allowed. There is a legitimate case for it: an admin
 *     who has genuinely moved to a different hostname needs to be able to drop
 *     the old one, and a permanent refusal would force them back to SSH — the
 *     very thing being removed. Refusing outright would make the escape hatch
 *     for a locked-out instance the ONLY way to fix a wrong entry, which is a
 *     worse trade than a deliberate, audited, second-flagged action.
 *
 * The alternative (flat refusal) was rejected for exactly that reason: it is
 * marginally safer in the abstract and operationally worse in practice. The
 * flag is never set implicitly anywhere in this codebase — the UI puts a
 * confirm dialog in front of it (see resetCorsSettings / saveCorsSettings in
 * public/index.html), so the unsafe path always costs a second, visible action.
 *
 * NOTE the empty list is refused unconditionally, with no flag to override:
 * there is no "I really mean it" for a configuration that denies every
 * cross-origin request and can only be undone over SSH.
 */
router.put('/settings/cors', corsWriteLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const validation = settings.validateCorsOrigins(body.origins);

    if (!validation.ok) {
      // Fail loud and name the offending entry. Silently dropping a bad origin
      // would leave an admin staring at a list that looks saved and is not.
      return res.status(400).json({
        error: validation.error,
        code: validation.code
      });
    }

    const requestOrigin = req.get('origin') || null;
    const removesOwnOrigin = !!requestOrigin && validation.origins.indexOf(requestOrigin) === -1;
    const confirmed = body.confirmSelfRemoval === true;

    if (removesOwnOrigin && !confirmed) {
      return res.status(400).json({
        error: `This change would remove the origin you are using right now (${requestOrigin}), which would lock you out of this page. Re-send with confirmSelfRemoval: true if that is intended.`,
        code: 'LOCKOUT_RISK',
        currentRequestOrigin: requestOrigin
      });
    }

    // PERSIST FIRST, SWAP THE CACHE LAST.
    //
    // The row is written now, but the in-memory allowlist the cors middleware
    // reads is NOT updated until this response has been fully sent (the
    // 'finish' handler below). Two reasons, both of which are easy to break by
    // "tidying" this up:
    //
    //  1. A client may legitimately re-send a request. A repeat re-runs the entire
    //     middleware chain, including cors. If the cache were swapped before this
    //     response went out, that repeat would be judged against the NEW list —
    //     and if the caller just removed their own origin, the repeat comes back
    //     403 CORS_DENIED and the very request that saved the setting appears to
    //     have failed.
    //  2. Writing the cache before the response means a crash between the two
    //     leaves the process enforcing something the operator never saw a
    //     success for. Persist-first-then-swap keeps the cache a follower of
    //     the durable state rather than a parallel one.
    //
    // Because cors() runs at the START of the request and has already chosen
    // this response's Access-Control-Allow-Origin header by the time this
    // handler runs, the swap genuinely cannot affect THIS response. That is
    // the property being relied on.
    //
    // The second argument is the "who changed this" audit field. There is no
    // account to name any more, so it is recorded as NULL rather than
    // inventing an actor.
    await settings.setCorsOrigins(validation.origins, null, {
      cacheImmediately: false
    });

    res.on('finish', () => {
      settings.applyCorsOriginsCache(validation.origins);
    });

    res.json({
      ok: true,
      origins: validation.origins,
      source: 'database',
      removedOwnOrigin: removesOwnOrigin
    });
  } catch (error) {
    console.error('❌ write CORS settings error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/settings/cors/reset — drop the database override.
 *
 * The row is deleted, so resolution falls back to process.env.CORS_ORIGIN (or
 * the hardcoded default) again. This is the recovery path: whatever an admin
 * saved can always be undone from the UI, which is the other half of why the
 * lockout guard above is safe to make non-permanent.
 */
router.post('/settings/cors/reset', corsWriteLimiter, async (req, res) => {
  try {
    // Same deferred swap as PUT, for the same reason.
    await settings.resetCorsOrigins({ cacheImmediately: false });

    res.on('finish', () => {
      settings.applyFallbackCache();
    });

    // THIS RESPONSE IS BUILT FROM THE FALLBACK, NOT FROM THE CACHE — ON PURPOSE.
    // The swap above is deliberately deferred until after the response is sent
    // (see the PUT handler for the full reason it has to stay there), which
    // means the in-memory cache is INTENTIONALLY still holding the pre-reset
    // list at this point. Reading it here — the old `await getCorsOrigins()` —
    // therefore reported the origin that was just deleted, and because the UI
    // renders this body verbatim, an admin pressing "Reset to configured
    // default" was shown the old list and had every reason to conclude the reset
    // had failed. Enforcement was never wrong; only the description of it was.
    //
    // The DELETE has already run, so the .env / hardcoded-default chain IS the
    // post-reset state, and asking that chain directly is the only thing here
    // that is guaranteed to be true at the moment the body is written.
    const fallback = settings.getFallbackCorsOrigins();

    res.json({
      ok: true,
      origins: fallback.origins,
      source: fallback.source
    });
  } catch (error) {
    console.error('❌ reset CORS settings error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
