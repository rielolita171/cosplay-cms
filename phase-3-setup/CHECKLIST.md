# Phase 3 Execution Checklist: Auth Engine & Telegram 2FA

Print or review this checklist to track the implementation and verification of Phase 3.

---

## Pre-Execution Verification

- [x] Phase 2 complete (Express REST API with costumes, props, lenses, images active)
- [x] Database file online (`~/cosplay-cms/data/db/cms.db`)
- [x] Environment configuration file present (`~/cosplay-cms/.env`)
- [x] Node.js v18+ and npm installed

---

## Step 1: Telegram Bot Configuration (10 minutes)

### 1.1: Obtain Bot Credentials
- [ ] Open Telegram and message [@BotFather](https://t.me/botfather)
- [ ] Create new bot with `/newbot` and save the HTTP API Token
- [ ] Obtain numerical Chat ID (message [@userinfobot](https://t.me/userinfobot) or read bot update)
- [ ] Update `.env` with:
  ```env
  TELEGRAM_BOT_TOKEN="your_token_here"
  TELEGRAM_CHAT_ID="your_chat_id_here"
  ```

### 1.2: Implement Dispatch Service
- [x] Create `src/services/telegramService.js`
- [x] Implement `sendTelegramMessage(chatId, text)`
- [x] Implement `send2FAOTP(chatId, otp)`
- [x] Include offline/simulated delivery fallback for dev and testing environments

---

## Step 2: 2FA Authentication Engine (20 minutes)

### 2.1: SQLite Database Migration
- [x] Extend SQLite `User` table dynamically:
  - `telegramChatId`
  - `telegram2FAEnabled`
  - `twoFactorSecret` (holds pending OTP)
  - `twoFactorExpiry` (holds timestamp)
  - `recoveryCodeHash`
  - `passwordHash`
  - `role`

### 2.2: Implement 2FA Routes
- [x] Update `POST /api/auth/register` to store 2FA preferences and return Break-Glass key
- [x] Update `POST /api/auth/login` to intercept 2FA users and dispatch 6-digit OTP
- [x] Create `POST /api/auth/2fa/verify` to validate OTP and issue full JWT token
- [x] Create `POST /api/auth/2fa/resend` to regenerate and re-dispatch OTP
- [x] Create `POST /api/auth/2fa/toggle` to enable/disable 2FA per user account

---

## Step 3: Emergency Break-Glass Recovery Protocol (15 minutes)

### 3.1: Cryptographic Recovery Service
- [x] Create `src/services/recoveryService.js`
- [x] Implement `generateBreakGlassRecoveryKey()` formatting `CMS-XXXXXXXX-XXXXXXXX`
- [x] Implement `hashKey(secretKey)` with PBKDF2/Bcrypt
- [x] Implement timing-safe `verifyRecoveryKey(plainKey, storedHash)`

### 3.2: Break-Glass Routes
- [x] Create `POST /api/auth/break-glass` emergency login endpoint
- [x] Enforce single-use invalidation of recovery keys upon entry
- [x] Implement automatic key rotation (issue fresh emergency key immediately)
- [x] Create `POST /api/auth/break-glass/generate` to manually regenerate keys

---

## Step 4: Verification & Automated Testing Suite (15 minutes)

### 4.1: Test Suite Construction
- [x] Create `scripts/test_phase3.js`
- [x] Configure npm script `"test:phase3": "node scripts/test_phase3.js"`

### 4.2: Run Automated Tests
- [ ] Start server: `npm start`
- [ ] Run test suite: `npm run test:phase3`
- [ ] Verify all 8 test cases pass:
  - [ ] User registration with break-glass key generation
  - [ ] Login 2FA detection and OTP issuance
  - [ ] Invalid OTP code rejection (400)
  - [ ] Valid 6-digit OTP verification and session token grant
  - [ ] Authenticated profile inspection
  - [ ] Break-Glass emergency recovery login
  - [ ] Single-use enforcement (old key rejection)
  - [ ] Rotated key validation

---

## Post-Execution Summary

| Component | Status | Notes |
| :--- | :---: | :--- |
| **Telegram Dispatch** | ✅ Ready | Live API delivery + simulated test mode |
| **2FA Challenge Engine** | ✅ Ready | 6-digit OTP, 5-minute lifespan |
| **Break-Glass Fail-Safe** | ✅ Ready | Single-use rotation, PBKDF2/Bcrypt salted |
| **Automated Test Suite** | ✅ Ready | 8 comprehensive security checks |

---

## Sign-Off

**Phase 3 Completion Date**: __________________  
**Admin / Tester**: __________________  
**Status**: ☐ Complete & Verified | ☐ Follow-up Required
