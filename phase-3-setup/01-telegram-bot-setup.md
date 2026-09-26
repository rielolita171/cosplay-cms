# Phase 3: Step 1 — Telegram Bot Setup & Integration

## Objective
Configure a private Telegram bot to deliver Two-Factor Authentication (2FA) verification codes to your mobile phone.

---

## Step 1.1: Create a Telegram Bot

1. Open Telegram on your phone or desktop and search for [@BotFather](https://t.me/botfather).
2. Start the chat and send the command:
   ```text
   /newbot
   ```
3. Follow the prompts:
   - **Name:** `Cosplay CMS Notifier` (or your preferred name)
   - **Username:** A unique username ending in `bot` (e.g. `my_cosplay_cms_bot`)
4. BotFather will provide an **HTTP API Token**. It looks like:
   ```text
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567
   ```
   Save this token.

---

## Step 1.2: Obtain Your Telegram Chat ID

Your bot needs to know your personal user ID to send direct messages:

1. Search for [@userinfobot](https://t.me/userinfobot) in Telegram.
2. Click **Start**. The bot will immediately reply with your numerical `Id` (e.g., `987654321`).
3. Send a greeting message (`/start` or `hello`) to your newly created bot so it has permission to message you.

---

## Step 1.3: Configure `.env`

Edit `~/cosplay-cms/.env`:

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567"
TELEGRAM_CHAT_ID="987654321"
```

> [!NOTE]
> In local development environments without an active internet connection or before configuring a real bot token, `src/services/telegramService.js` automatically simulates delivery by printing the OTP code directly to your terminal.

---

## Step 1.4: Service Implementation (`src/services/telegramService.js`)

The dispatch service handles message formatting and network calls:

```javascript
const https = require('https');

async function send2FAOTP(chatId, otp) {
  const message = `🔐 <b>Cosplay CMS Authentication</b>\n\nYour 6-digit verification code is:\n\n<code>${otp}</code>\n\n⏱️ This code is valid for <b>5 minutes</b>.`;
  return await sendTelegramMessage(chatId, message);
}
```

---

## Next Step
Proceed to [Step 2: Two-Factor Authentication Engine](02-2fa-engine.md).
