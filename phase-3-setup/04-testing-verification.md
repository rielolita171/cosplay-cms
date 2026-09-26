# Phase 3: Step 4 — Testing & Verification

## Objective
Verify the end-to-end functionality of the Auth Engine, Telegram 2FA challenge, and Emergency Break-Glass protocol using automated tests and manual inspections.

---

## 4.1 Running the Automated Test Suite

Ensure your Express server is running in your terminal:

```bash
cd ~/cosplay-cms
npm start
```

In a second terminal, execute the Phase 3 test runner:

```bash
cd ~/cosplay-cms
npm run test:phase3
```

---

## 4.2 Expected Test Output

```text
🔐 STARTING PHASE 3: AUTH ENGINE & TELEGRAM 2FA TEST SUITE

============================================================

--- 1. Registration with Break-Glass Key Generation ---
✅ PASS: Register user with 2FA & Break-Glass recovery key - Key: CMS-4A2D9E1B-7F03C58A

--- 2. Login Flow with Telegram 2FA Interception ---
✅ PASS: Login detects Telegram 2FA and requests OTP - TempToken received, Chat ID: ****4321

--- 3. OTP Validation: Invalid Code Handling ---
✅ PASS: Reject invalid OTP code - Status: 400

--- 4. Valid OTP Verification ---
✅ PASS: Verify valid 6-digit Telegram OTP and issue JWT session - Session token granted for user: phase3_user_1695780000

--- 5. Authenticated Profile & 2FA State ---
✅ PASS: Fetch profile with 2FA status - 2FA Enabled: true

--- 6. Emergency Break-Glass Account Recovery ---
✅ PASS: Execute Break-Glass Recovery (bypasses 2FA & rotates key) - New Recovery Key issued: CMS-B8C2D4E6-1F3A5970

--- 7. Single-Use Key Invalidation Check ---
✅ PASS: Reject previously used Break-Glass recovery key - Status: 401

--- 8. Verification of Rotated Key ---
✅ PASS: Authenticate successfully with rotated Break-Glass key - Recovery cycle validated

============================================================
📊 PHASE 3 TEST SUMMARY
✅ Passed: 8
❌ Failed: 0
📈 Success Rate: 100.0%

🎉 ALL PHASE 3 TESTS PASSED! Telegram 2FA & Break-Glass engine complete.
```

---

## 4.3 Database Integrity Inspection

You can inspect the encrypted recovery hashes and 2FA settings directly via SQLite CLI:

```bash
sqlite3 data/db/cms.db 'SELECT id, username, telegramChatId, telegram2FAEnabled, recoveryCodeHash FROM "User" LIMIT 3;'
```

Sample output:
```text
uuid-1234|admin|987654321|1|pbkdf2:a1b2c3...:d4e5f6...
```

---

## 4.4 Troubleshooting Reference

| Issue | Cause | Solution |
| :--- | :--- | :--- |
| **Telegram Message Not Arriving** | Bot token invalid or `/start` not sent to bot | Send `/start` to your bot in Telegram; check `TELEGRAM_BOT_TOKEN` in `.env`. Note that simulated delivery prints the OTP directly to the server terminal. |
| **"Verification code has expired"** | More than 5 minutes elapsed since login | Call `POST /api/auth/2fa/resend` to obtain a fresh OTP. |
| **"Invalid 2FA session token"** | `tempToken` expired or malformed | Re-authenticate at `POST /api/auth/login` to start a new 2FA session. |
| **"Invalid emergency recovery key"** | The key was already used or mistyped | Remember that break-glass keys are single-use; ensure you are using the rotated key generated from the last recovery. |

---

## Phase 3 Complete! 🎉
You are now ready to proceed to **Phase 4: n8n Workflow Integration & Lens Expiry Alerts**.
