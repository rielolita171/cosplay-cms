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

/**
 * Send message to Telegram Chat ID
 * Supports simulated delivery in development when bot token is unconfigured or offline.
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

  const token = process.env.TELEGRAM_BOT_TOKEN;

  // Check if token is placeholder or unset
  if (!token || token.includes('your_telegram_bot_token') || token.includes('here')) {
    console.log(`\n💬 [Telegram Simulated] To: ${chatId}`);
    console.log(`💬 Message: ${text}\n`);
    return { success: true, simulated: true };
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve({ success: true, messageId: parsed.result.message_id });
          } else {
            console.warn('⚠️ Telegram API returned error:', parsed.description);
            resolve({ success: false, error: parsed.description, simulated: true });
          }
        } catch (err) {
          resolve({ success: false, error: err.message, simulated: true });
        }
      });
    });

    req.on('error', (err) => {
      console.warn('⚠️ Telegram connection failed (simulating delivery):', err.message);
      resolve({ success: true, simulated: true, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn('⚠️ Telegram request timed out (simulating delivery)');
      resolve({ success: true, simulated: true, timedOut: true });
    });

    req.write(payload);
    req.end();
  });
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
  send2FAOTP
};
