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
const telegramConfig = require('../services/telegramConfig');
const telegram = require('../services/telegramService');
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

// ============================================================================
// TELEGRAM NOTIFICATION SETTINGS
// ============================================================================
//
// The Telegram block below lives in THIS router rather than in a new file for
// one reason: it is the same class of thing. Both are runtime configuration the
// container has no other way to edit, both persist to "ServerSetting", and both
// are edited from the same Settings tab. A separate file would be a separate
// mount point for no separation in threat model — and the note at the top of
// this file, that a control which rewrites runtime configuration should never be
// edited as a side effect of changing a costume, applies verbatim.
//
// The routes are UNAUTHENTICATED, consistent with the CORS routes above and
// with the rest of the browser-facing app: authn is the reverse proxy's job
// (see src/server.js). What that makes essential here — and the reason the
// read endpoint is shaped the way it is — is that the token must not be
// retrievable through it. Nothing in the response body is the secret.
//
// The limiter below is deliberately much tighter than the CORS one. The CORS
// list is worth at most 30 edits an hour. This is a credential that can be used
// to send arbitrary messages to arbitrary chats, and the two test buttons make
// a NETWORK CALL to Telegram on every press, so an unbounded endpoint here would
// be both a brute-force surface and a way to spend the operator's rate limit.
const telegramWriteLimiter = rateLimit({
  name: 'settings-telegram-write',
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many Telegram setting changes. Please slow down.'
});

/**
 * Test-send limiter. Separate from the write limiter and far tighter, because
 * this endpoint does not change anything: it just makes the server talk to
 * Telegram. Ten an hour is well above a human debugging a token and well below
 * anything that should be able to use this as a relay.
 */
const telegramTestLimiter = rateLimit({
  name: 'settings-telegram-test',
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many test messages. Telegram testing is limited to 10 an hour.'
});

/**
 * GET /api/settings/telegram — the effective config, never the token itself.
 *
 * The shape is deliberately a DESCRIPTION of the token rather than the token:
 *
 *   { configured: bool, source: 'database'|'env'|'none',
 *     botId, secretLength, fingerprint }
 *
 * `source` answers "why is this not the one I saved", `botId` (the public half,
 * the one in an @username link) makes the right token identifiable at a glance,
 * and `fingerprint` lets an admin confirm the in-force token is still the one
 * they pasted without the secret ever being readable from the page. An endpoint
 * that echoed the token back would make the whole thing a credential exfiltration
 * surface for anyone who can reach the port, which on this app is anyone who
 * reached the CORS allowlist at all.
 */
router.get('/settings/telegram', async (req, res) => {
  try {
    const [config, thresholdDays] = await Promise.all([
      telegramConfig.getTelegramConfig(),
      telegramConfig.getExpiryThresholdDays()
    ]);
    res.json({
      token: config.token,
      chatId: config.chatId,
      // The window the daily lens-expiry check will use.
      thresholdDays,
      limits: {
        maxTokenLength: telegramConfig.MAX_TOKEN_LENGTH,
        maxThresholdDays: telegramConfig.MAX_THRESHOLD_DAYS,
        defaultThresholdDays: telegramConfig.DEFAULT_THRESHOLD_DAYS
      }
    });
  } catch (error) {
    console.error('❌ read Telegram settings error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PUT /api/settings/telegram/token — save a bot token.
 *
 * Body: { token: string }
 *
 * The token is validated, persisted, and pushed into the transport in one
 * awaited unit, so it is live for the very next test button press. See
 * saveTelegramToken() in services/telegramConfig.js for why this deliberately
 * does NOT use the CORS route's defer-the-swap-until-after-the-response trick.
 *
 * An invalid token answers 400 with the reason and the CURRENT config attached,
 * so the form can redraw itself without a second round trip. That is not a leak:
 * the config is the same description GET returns, and it is what stops a failed
 * save from blanking the fields the admin had already filled in.
 */
router.put('/settings/telegram/token', telegramWriteLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await telegramConfig.saveTelegramToken(body.token);
    if (!result.ok) {
      return res.status(400).json({
        error: result.error,
        code: result.code,
        config: { token: result.config.token, chatId: result.config.chatId }
      });
    }
    res.json({
      ok: true,
      token: result.config.token,
      chatId: result.config.chatId
    });
  } catch (error) {
    console.error('❌ write Telegram token error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/settings/telegram/token/clear — drop the saved token.
 *
 * A delete rather than a write of "", so that "there is no override" and "the
 * override is blank" cannot become the same state — the absence of the row IS
 * the mechanism by which the .env value resumes, and the same one CORS uses.
 */
router.post('/settings/telegram/token/clear', telegramWriteLimiter, async (req, res) => {
  try {
    const result = await telegramConfig.clearTelegramToken();
    res.json({ ok: true, token: result.config.token, chatId: result.config.chatId });
  } catch (error) {
    console.error('❌ clear Telegram token error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PUT /api/settings/telegram/chat — save the delivery chat id.
 *
 * Body: { chatId: string }   (an empty string CLEARS it)
 *
 * A chat id is validated as a signed integer because that is the only shape
 * Telegram has. Rejecting "not a number" here turns a confusing 400 from
 * api.telegram.org ("chat not found") into a clear message at the point of
 * entry, and it also means the value is never pasted into a request body with
 * whatever the operator's clipboard happened to contain.
 */
router.put('/settings/telegram/chat', telegramWriteLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const raw = (body.chatId === null || body.chatId === undefined) ? '' : String(body.chatId).trim();

    if (raw) {
      if (!/^-?\d+$/.test(raw)) {
        const current = await telegramConfig.getTelegramConfig();
        return res.status(400).json({
          error: 'A Telegram chat id is a whole number, optionally starting with a minus for a group. Get it by messaging @userinfobot.',
          code: 'VALIDATION_ERROR',
          config: { token: current.token, chatId: current.chatId }
        });
      }
      // Telegram ids are 32-bit-ish; anything past this is a pasted error page
      // or a conversation id in a newer format, and would only fail at send time.
      if (raw.replace('-', '').length > 20) {
        const current = await telegramConfig.getTelegramConfig();
        return res.status(400).json({
          error: 'That is not a Telegram chat id — it is too long to be one.',
          code: 'VALIDATION_ERROR',
          config: { token: current.token, chatId: current.chatId }
        });
      }
    }

    const result = await telegramConfig.saveTelegramChatId(raw);
    res.json({ ok: true, token: result.config.token, chatId: result.config.chatId });
  } catch (error) {
    console.error('❌ write Telegram chat id error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/settings/telegram/verify-token — is this token real?
 *
 * Runs getMe, which asks Telegram who the bot is WITHOUT sending a message.
 *
 * This is the test to press first, and the reason is diagnostic: a send-message
 * test has two independent ways to fail — a bad token and a bad chat id — and
 * Telegram reports both as a flat 400, so a failing send cannot tell them
 * apart. getMe isolates the credential. If this passes and the send still
 * fails, the token is fine and the problem is the chat.
 *
 * Answered 200 with `ok: false` for an expected outcome (a rejected token) and
 * 4xx/5xx only for genuine server trouble, so the UI can show the reason as a
 * result rather than as an error. There is no 200-with-ok:false trap for the
 * caller to have to remember to check — the field is named `ok` precisely so it
 * reads the same as the {ok:true} every other write in this file returns.
 */
router.post('/settings/telegram/verify-token', telegramTestLimiter, async (req, res) => {
  try {
    const result = await telegram.getBotInfo();
    res.json(result);
  } catch (error) {
    console.error('❌ verify Telegram token error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * POST /api/settings/telegram/test-message — send a real test message.
 *
 * Body: { text?: string }   (an omitted or empty text uses a default)
 *
 * The ONE place in this codebase where a deliberately-written message is sent
 * by hand, so the honest sender is used rather than sendTelegramMessage() — see
 * the long note on sendTelegramMessageStrict(). The difference that matters:
 * sendTelegramMessage() reports success when the token is missing, when the
 * network is down, and when the request times out, which is right for the 2FA
 * path and catastrophic for a button labelled "Send test".
 *
 * The message is NOT written into the ServerSetting table. It is a diagnostic
 * message, and a persisted copy of whatever was last typed into a test box is
 * not state the app needs — nothing reads it back.
 */
router.post('/settings/telegram/test-message', telegramTestLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const chatId = await telegramConfig.getTelegramConfig().then(cfg => cfg.chatId);
    const text = (typeof body.text === 'string' && body.text.trim())
      ? body.text.trim()
      : '✅ <b>Cosplay CMS</b> — this is a test notification. If you can read this, Telegram delivery is working.';

    if (!chatId) {
      return res.status(400).json({
        error: 'No chat id is configured yet, so there is nowhere to send the test. Save one first.',
        code: 'CHAT_MISSING'
      });
    }

    const result = await telegram.sendTelegramMessageStrict(chatId, text);
    // A Telegram refusal is a real, expected answer — the whole purpose of this
    // button — so it is 200 with ok:false and the reason, not a 5xx.
    res.json(result);
  } catch (error) {
    console.error('❌ send Telegram test message error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

/**
 * PUT /api/settings/telegram/threshold — how many days ahead to alert.
 *
 * Body: { days: number|string }   (an omitted, null or empty value RESETS to the
 *                                  built-in default rather than storing a blank)
 *
 * This is the setting the alert window lives in, and it is the reason the whole
 * Telegram block exists. The daily lens-expiry check in this same process asks
 * "what is expiring?" once a day; the ANSWER to that question is this number.
 * The window used to be hardcoded in an external scheduler's URL, which meant
 * changing it meant editing a file in another application by hand. Now it is
 * here, in the app, editable without a restart — the checker re-reads it on
 * every run, so a change takes effect on the next check, not the next boot.
 *
 * Accepted as a number or a numeric string, because an <input type="number">
 * still hands the DOM a string and a JSON client may legitimately send either.
 * Anything that is not a whole number in [0, MAX_THRESHOLD_DAYS] is a 400 that
 * NAMES the range, because a threshold of -3 or 9999 is not a value to be
 * silently rounded into something plausible — the operator would then wonder
 * why their lenses are not being flagged.
 */
router.put('/settings/telegram/threshold', telegramWriteLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const raw = (body.days === null || body.days === undefined) ? '' : String(body.days).trim();
    const current = await telegramConfig.getTelegramConfig();
    const reject = (message) => res.status(400).json({
      error: message,
      code: 'VALIDATION_ERROR',
      config: { token: current.token, chatId: current.chatId }
    });

    // '' means "no override" -> back to the default. A blank box must not store a
    // blank, for the same reason a blank token does not: the ABSENCE of the row
    // is what makes the default apply.
    let days = null;
    if (raw !== '') {
      if (!/^\d+$/.test(raw)) {
        return reject('The alert window must be a whole number of days, 0 or more.');
      }
      days = Number(raw);
      if (days > telegramConfig.MAX_THRESHOLD_DAYS) {
        return reject('The alert window cannot be more than ' + telegramConfig.MAX_THRESHOLD_DAYS +
          ' days — beyond that you would be warned about every lens you own, every day.');
      }
    }

    const saved = await telegramConfig.setExpiryThresholdDays(days);
    res.json({
      ok: true,
      thresholdDays: saved,
      isDefault: days === null,
      token: current.token,
      chatId: current.chatId
    });
  } catch (error) {
    console.error('❌ write Telegram threshold error:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
