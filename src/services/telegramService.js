const https = require('https');
const fs = require('fs');

// ---------------------------------------------------------------------------
// TEST-ONLY TRANSPORT STUB (default OFF — Phase 5 automated suite)
//
// Telegram is not configured in this environment, so the real send path can
// never report success and the whole 2FA happy path would be untestable. When
// BOTH of these hold:
//   NODE_ENV === 'test'  AND  CMS_TEST_TELEGRAM_CAPTURE=<path>
// the OTP is appended to that file (JSON lines) and reported as a simulated
// success, WITHOUT any network call. Inert in dev/production.
// ---------------------------------------------------------------------------
const TEST_CAPTURE_FILE = process.env.NODE_ENV === 'test'
  ? (process.env.CMS_TEST_TELEGRAM_CAPTURE || null)
  : null;

// ---------------------------------------------------------------------------
// RUNTIME TOKEN OVERRIDE
//
// WHY THIS EXISTS
// A bot token is the API key for the notification channel, and until now the
// only place one could live was process.env — which in a container means editing
// .env and restarting the server to fix a typo in a 46-character secret. This
// module holds the admin-saved token in memory so telegramConfig.js can swap it
// at runtime, and every existing caller picks it up with no change at all.
//
// WHY IT LIVES HERE AND NOT IN telegramConfig.js
// Because of exactly that "no change at all". The alternative — passing the
// token down as an argument — would mean every call site (send2FAOTP below, the
// n8n alert paths, anything added later) has to remember to thread it through,
// and the first one that forgets silently falls back to the env token, or worse,
// to the "no token configured, pretending it worked" branch below. A single
// resolution point that everything shares cannot be bypassed by forgetting.
//
// RESOLUTION ORDER: the saved token, then process.env.TELEGRAM_BOT_TOKEN.
// ---------------------------------------------------------------------------
let runtimeToken = null;

/**
 * True when a token is absent or is one of the placeholder values that ship in
 * .env.example and in older copies of it.
 *
 * The `includes('here')` test is loose on purpose: it is the ORIGINAL predicate
 * from the send path below and is kept verbatim so this refactor cannot change
 * which installations end up on the simulated branch. It only ever causes a
 * token containing the letters "here" to be treated as unset, which fails safe
 * (a no-op) rather than open.
 */
function isUnusableToken(token) {
  return !token || token.includes('your_telegram_bot_token') || token.includes('here');
}

/** The token from the environment, or null when there is no usable one. */
function getEnvToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return isUnusableToken(token) ? null : token;
}

/**
 * The effective token: the admin-saved one if there is one, else the env one.
 *
 * The saved value is consulted FIRST, not the other way round. That ordering is
 * the whole point of the Settings form — an admin who pastes a fresh token into
 * the UI must not be silently overruled by a stale value left in .env, which is
 * exactly the state an existing install is in when they go looking for this
 * menu in the first place.
 */
function getResolvedToken() {
  return runtimeToken || getEnvToken();
}

/** Called by telegramConfig.js when an admin saves a token. */
function setRuntimeToken(token) {
  runtimeToken = isUnusableToken(token) ? null : String(token);
  return runtimeToken;
}

/** Called on boot when no token is saved, and when an admin clears the saved one. */
function clearRuntimeToken() {
  runtimeToken = null;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Outer timeout. Telegram is a handful of round-trips away; past this it is down. */
const TELEGRAM_TIMEOUT_MS = 8000;

/**
 * Strip a bot token out of any text that is about to be logged or returned.
 *
 * Every error string produced by this module — an https transport error, a
 * timeout, a non-JSON body — is handed back to a browser, and the token is the
 * single credential the app has. A blanket string replace is crude, but it is
 * the difference between "the test button echoed my secret into the page" and
 * not, and a mistake here is unrecoverable for the user (the token must be
 * regenerated). Cheap insurance on an unbounded number of error sources.
 */
function scrubToken(text, token) {
  const value = String(text === null || text === undefined ? '' : text);
  if (!token) return value;
  return value.split(token).join('***');
}

/**
 * Escape text for Telegram's HTML parse_mode.
 *
 * A custom test message is operator-supplied, and Telegram rejects a whole
 * message with 400 "can't parse entities" if the tag count is unbalanced — so a
 * message containing a stray `<` or an unclosed <b> fails to send for a reason
 * that has nothing to do with the token or the chat id being under test, and
 * the test then diagnoses the wrong thing.
 */
function escapeHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

/**
 * One HTTPS round-trip to the Bot API.
 *
 * ALWAYS RESOLVES, never rejects, and never reports success on its own: it
 * hands back a description of what happened and leaves the verdict to the
 * caller. That separation is what lets the two very different send paths below
 * share it — the notification path treats "offline" as a non-event and carries
 * on, while the test path must be able to say "this did not arrive".
 *
 * @param {string} token   bot token (never logged, scrubbed from any message)
 * @param {string} method  Bot API method, e.g. 'sendMessage' / 'getMe'
 * @param {object|null} payload  null for a GET, otherwise the JSON body
 * @returns {Promise<{ok, body, transportError, timedOut}>}
 */
function telegramRequest(token, method, payload) {
  return new Promise((resolve) => {
    const hasBody = payload !== null && payload !== undefined;
    const body = hasBody ? JSON.stringify(payload) : null;

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      // The token is part of the PATH — that is how the Bot API authenticates.
      path: `/bot${token}/${method}`,
      method: hasBody ? 'POST' : 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: TELEGRAM_TIMEOUT_MS
    };
    if (hasBody) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    // A destroyed socket fires BOTH 'timeout' and 'error'. Without this guard the
    // promise is settled twice and which verdict wins depends on listener
    // ordering — the kind of thing that makes a flaky test look like a
    // credential problem.
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let req;
    try {
      req = https.request(options, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_parseError) {
            finish({ ok: false, body: null, transportError: `unreadable response from Telegram: ${scrubToken(data.slice(0, 200), token)}` });
            return;
          }
          finish({ ok: parsed && parsed.ok === true, body: parsed });
        });
      });
    } catch (error) {
      finish({ ok: false, body: null, transportError: scrubToken(error.message, token) });
      return;
    }

    req.on('error', (err) => {
      finish({ ok: false, body: null, transportError: scrubToken(err.message, token) });
    });

    req.on('timeout', () => {
      req.destroy();
      finish({ ok: false, body: null, timedOut: true });
    });

    if (hasBody) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Strict API — the honest one, used by the Settings test buttons
// ---------------------------------------------------------------------------

/**
 * Record a simulated send in the test-harness capture file.
 *
 * Returns the shape the strict senders answer with, so a caller cannot tell the
 * difference without reading `simulated` — which it is expected to do, because
 * the whole point of the strict API is that it never claims a delivery it
 * cannot vouch for.
 */
function captureInstead(text, chatId) {
  if (!TEST_CAPTURE_FILE) return null;
  try {
    fs.appendFileSync(TEST_CAPTURE_FILE, JSON.stringify({ chatId, text }) + '\n');
  } catch (error) {
    console.warn('⚠️  test capture write failed:', error.message);
  }
  return { ok: true, simulated: true, captured: true };
}

/**
 * Verify a bot token against Telegram's getMe, WITHOUT sending anything.
 *
 * This is the more informative half of "is my setup working", and it is the one
 * to press first. A send-message test has two independent ways to fail — a bad
 * token and a bad chat id — and Telegram reports both as a flat 400, so a
 * failing send tells you almost nothing about which of the two to fix. getMe
 * isolates the token: if this succeeds, the credential is good and anything the
 * send then complains about is the chat id.
 *
 * Never simulated. Under the test harness it reports NOT_CONFIGURED_TEST_ENV
 * rather than pretending, because "the token is valid" is exactly the claim a
 * test button must not make without having asked Telegram.
 */
async function getBotInfo(options) {
  const opts = options || {};
  const token = opts.token || getResolvedToken();
  if (!token) {
    return {
      ok: false,
      code: 'TOKEN_MISSING',
      error: 'No bot token is configured. Save one in Settings first.'
    };
  }
  if (TEST_CAPTURE_FILE) {
    // Deliberately NOT a success: this path never contacted Telegram, so it has
    // no basis to report that the token works.
    return {
      ok: false,
      code: 'NOT_CONFIGURED_TEST_ENV',
      error: 'This server is running under the automated test harness, which does not reach Telegram. The token check was skipped.'
    };
  }

  const result = await telegramRequest(token, 'getMe', null);
  if (result.timedOut) {
    return { ok: false, code: 'TIMEOUT', error: `Telegram did not answer within ${TELEGRAM_TIMEOUT_MS / 1000} seconds.` };
  }
  if (result.transportError) {
    return { ok: false, code: 'UNREACHABLE', error: 'Could not reach Telegram: ' + result.transportError };
  }
  if (!result.ok) {
    const description = (result.body && result.body.description) || 'Telegram rejected the token.';
    // 401/404 here is nearly always the token, so it is labelled as such.
    const code = /not found|unauthorized|invalid/i.test(description) ? 'TOKEN_REJECTED' : 'API_ERROR';
    return { ok: false, code, error: description };
  }

  const bot = (result.body && result.body.result) || {};
  return {
    ok: true,
    code: 'OK',
    bot: {
      id: bot.id || null,
      username: bot.username || null,
      firstName: bot.first_name || null,
      canJoinGroups: bot.can_join_groups === true,
      supportsInlineQueries: bot.supports_inline_queries === true
    }
  };
}

/**
 * Send a message and report truthfully whether it was delivered.
 *
 * THE WHOLE POINT OF THIS FUNCTION IS THAT IT DOES NOT SIMULATE.
 *
 * sendTelegramMessage() below reports `success: true` when the token is
 * unconfigured, when the network is down, and when the request times out. That
 * is correct for its callers — a failed alert must not be able to break the 2FA
 * flow or an expiry sweep — but it is exactly wrong for a "Send test" button.
 * An operator who presses it, sees green, and concludes their token works has
 * been told a falsehood, and will only discover the channel is dead when the
 * alert that mattered never arrives. So the test path gets its own sender that
 * can only say what it actually observed.
 *
 * @param {string} chatId
 * @param {string} text
 * @param {{token?: string}} [options]
 * @returns {Promise<{ok, code, error?, simulated?, messageId?}>}
 */
async function sendTelegramMessageStrict(chatId, text) {
  const token = getResolvedToken();
  if (!token) {
    return {
      ok: false,
      code: 'TOKEN_MISSING',
      error: 'No bot token is configured. Save one in Settings first.'
    };
  }
  if (!chatId) {
    return {
      ok: false,
      code: 'CHAT_MISSING',
      error: 'No chat id is configured. Save one in Settings first.'
    };
  }

  const captured = captureInstead(String(text), chatId);
  if (captured) return captured;

  const result = await telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text: escapeHtml(text),
    parse_mode: 'HTML'
  });

  if (result.timedOut) {
    return {
      ok: false,
      code: 'TIMEOUT',
      error: `Telegram did not answer within ${TELEGRAM_TIMEOUT_MS / 1000} seconds. The message may or may not have been delivered.`
    };
  }
  if (result.transportError) {
    return {
      ok: false,
      code: 'UNREACHABLE',
      error: 'Could not reach Telegram: ' + result.transportError
    };
  }
  if (!result.ok) {
    const description = (result.body && result.body.description) || 'Telegram rejected the message.';
    let code = 'API_ERROR';
    // Telegram's own wording is the only reliable way to tell the two failures
    // apart, and they need opposite fixes: a wrong token is a Settings problem,
    // an unreachable chat is a "the bot has not been started there" problem.
    if (/chat not found|bot can't initiate|bot was blocked|kicked/i.test(description)) code = 'CHAT_UNREACHABLE';
    else if (/not found|unauthorized|invalid/i.test(description)) code = 'TOKEN_REJECTED';
    else if (/not enough rights|have no rights|forbidden/i.test(description)) code = 'CHAT_FORBIDDEN';
    return { ok: false, code, error: description };
  }

  const sent = (result.body && result.body.result) || {};
  return { ok: true, code: 'OK', messageId: sent.message_id || null, simulated: false };
}

// ---------------------------------------------------------------------------
// Notification path — unchanged semantics, now sharing the transport above
// ---------------------------------------------------------------------------

/**
 * Send message to Telegram Chat ID
 * Supports simulated delivery in development when bot token is unconfigured or offline.
 *
 * NOTE the three `simulated: true` success returns. They are preserved from the
 * original implementation on purpose — this path is called by the 2FA engine and
 * the expiry sweeps, where an offline network must not turn into a hard
 * failure. The Settings test button must NOT use this function; use
 * sendTelegramMessageStrict() above, which reports what actually happened.
 */
async function sendTelegramMessage(chatId, text) {
  if (TEST_CAPTURE_FILE) {
    try {
      fs.appendFileSync(TEST_CAPTURE_FILE, JSON.stringify({ chatId, text }) + '\n');
    } catch (error) {
      console.warn('⚠️  test capture write failed:', error.message);
    }
    return { success: true, simulated: true };
  }

  const token = getResolvedToken();

  // Check if token is placeholder or unset
  if (!token) {
    console.log(`\n💬 [Telegram Simulated] To: ${chatId}`);
    console.log(`💬 Message: ${text}\n`);
    return { success: true, simulated: true };
  }

  const result = await telegramRequest(token, 'sendMessage', {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  });

  if (result.timedOut) {
    console.warn('⚠️ Telegram request timed out (simulating delivery)');
    return { success: true, simulated: true, timedOut: true };
  }
  if (result.transportError) {
    console.warn('⚠️ Telegram connection failed (simulating delivery):', result.transportError);
    return { success: true, simulated: true, error: result.transportError };
  }

  const data = result.body || {};
  if (data.ok) {
    return { success: true, messageId: (data.result || {}).message_id };
  }
  console.warn('⚠️ Telegram API returned error:', data.description);
  return { success: false, error: data.description, simulated: true };
}

/**
 * Send 6-digit OTP code to Telegram chat
 */
async function send2FAOTP(chatId, otp) {
  const message = `🔐 <b>Cosplay CMS Authentication</b>\n\nYour 6-digit verification code is:\n\n<code>${otp}</code>\n\n⏱️ This code is valid for <b>5 minutes</b>. Do not share this code with anyone.`;
  return await sendTelegramMessage(chatId, message);
}

module.exports = {
  sendTelegramMessage,
  sendTelegramMessageStrict,
  getBotInfo,
  send2FAOTP,
  // Exported rather than kept private because telegramConfig.js resolves the
  // environment token through it: the Settings screen has to say whether the
  // token in force came from .env or from the database, and an unexported
  // getEnvToken() made getTelegramConfig() throw a TypeError on every call —
  // which is to say, on every page load of Settings and on every expiry check.
  getEnvToken,
  getResolvedToken,
  setRuntimeToken,
  clearRuntimeToken,
  isUnusableToken
};
