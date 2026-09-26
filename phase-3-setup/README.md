# Phase 3: Auth Engine, Telegram 2FA & Break-Glass Recovery — Complete Guide

## Overview

Phase 3 implements an enterprise-grade security layer for the Cosplay Management System (CMS), tailored for private home servers. It integrates **Telegram-based Two-Factor Authentication (2FA)** and a cryptographic **Emergency Break-Glass Recovery Protocol** to prevent total server lockout if Telegram or mobile devices are inaccessible.

---

## 🧭 Learning Path: 4 Sequential Steps

### 1. [Step 1: Telegram Bot Configuration & Integration](01-telegram-bot-setup.md)
- **Duration:** ~10 minutes
- **What You'll Do:**
  - Create a dedicated private Telegram bot via [@BotFather](https://t.me/botfather).
  - Obtain your unique numerical Telegram `Chat ID`.
  - Configure `.env` with `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
  - Implement dispatch service with automatic simulation fallback for offline/development environments.
- **Files Created/Used:** `src/services/telegramService.js`, `.env`

---

### 2. [Step 2: Two-Factor Authentication (2FA) Engine](02-2fa-engine.md)
- **Duration:** ~20 minutes
- **What You'll Do:**
  - Extend the login flow to intercept accounts with 2FA enabled.
  - Dynamically generate cryptographically random 6-digit OTP codes with 5-minute expiry windows.
  - Dispatch verification codes to your private Telegram chat.
  - Issue temporary `2fa_pending` JWT tokens and authenticate via `/api/auth/2fa/verify`.
  - Provide endpoints to toggle 2FA on/off and resend verification codes.
- **Files Created/Used:** `src/routes/auth.js`, `src/middleware/auth.js`

---

### 3. [Step 3: Emergency Break-Glass Recovery Protocol](03-break-glass-recovery.md)
- **Duration:** ~15 minutes
- **What You'll Do:**
  - Automatically generate a high-entropy emergency recovery key during account registration (`CMS-XXXXXXXX-XXXXXXXX`).
  - Securely hash and store recovery keys using `bcryptjs` / `crypto.pbkdf2`.
  - Implement the `/api/auth/break-glass` emergency bypass endpoint.
  - Enforce single-use key invalidation and automatic key rotation upon recovery usage.
- **Files Created/Used:** `src/services/recoveryService.js`, `src/routes/auth.js`

---

### 4. [Step 4: Comprehensive Testing & Verification](04-testing-verification.md)
- **Duration:** ~15 minutes
- **What You'll Do:**
  - Run the dedicated Phase 3 automated test suite (`scripts/test_phase3.js`).
  - Validate registration, 2FA interception, OTP verification, invalid code rejection, key rotation, and break-glass recovery.
  - Audit database state in SQLite `cms.db`.
- **Files Created/Used:** `scripts/test_phase3.js`

---

## 📊 Phase 3 Security Architecture

```
                       [ User Login: POST /api/auth/login ]
                                       │
                                       ▼
                         Credentials Validated?
                                       │
                        ┌──────────────┴──────────────┐
                       YES                            NO
                        │                              │
                        ▼                              ▼
             Is Telegram 2FA Active?               401 Unauthorized
                        │
         ┌──────────────┴──────────────┐
        YES                            NO
         │                              │
         ▼                              ▼
  1. Generate 6-Digit OTP        Issue Standard JWT Token
  2. Set 5-Min Expiration       (Full Access Granted)
  3. Send OTP to Telegram
  4. Issue `2fa_pending` Token
         │
         ▼
  [ POST /api/auth/2fa/verify ]
         │
    Valid OTP? ───► YES ──► Issue Standard JWT Token
         │
         NO
         │
         ▼
  400 Invalid / Expired OTP
```

### 🚨 Emergency Break-Glass Path (If Phone / Telegram Lost):
```
  [ POST /api/auth/break-glass ]
  Payload: { username, recoveryKey: "CMS-XXXXXXXX-XXXXXXXX" }
         │
         ▼
  Verify Cryptographic Hash in SQLite
         │
    Valid Key? ───► YES ──► 1. Invalidate used key
         │                   2. Generate NEW recovery key & output to user
         │                   3. Bypass 2FA & grant full JWT access
         NO
         │
         ▼
  401 Invalid Recovery Credentials
```

---

## 📁 Files Created & Modified in Phase 3

| File | Type | Purpose |
| :--- | :--- | :--- |
| [`src/services/telegramService.js`](file:///home/natanieldt/cosplay-cms/src/services/telegramService.js) | Service | Telegram Bot API dispatch with simulated development mode |
| [`src/services/recoveryService.js`](file:///home/natanieldt/cosplay-cms/src/services/recoveryService.js) | Service | High-entropy key generation (`CMS-XXXX-XXXX`) and hash verification |
| [`src/routes/auth.js`](file:///home/natanieldt/cosplay-cms/src/routes/auth.js) | Routes | 2FA challenge, verification, resend, toggle, and break-glass endpoints |
| [`scripts/test_phase3.js`](file:///home/natanieldt/cosplay-cms/scripts/test_phase3.js) | Script | Automated test suite verifying 2FA lifecycle & emergency recovery |
| [`package.json`](file:///home/natanieldt/cosplay-cms/package.json) | Config | Registered `test:phase3` script and `bcryptjs` dependency |

---

## 🚀 Quick Execution Guide

```bash
# Start server
npm start

# Run Phase 3 test suite
npm run test:phase3
```
