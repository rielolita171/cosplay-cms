# Phase 3 Architecture & Security Specification

This document details the security model, cryptographic workflows, and protocol state diagrams for Phase 3 of the Cosplay Management System (CMS).

---

## 1. System Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                          CLIENT APPLICATION                            │
│                 (Web UI / Mobile App / REST Client)                    │
└──────────────┬──────────────────────────────────────────┬──────────────┘
               │                                          │
    1. Credentials Request                     2. Submit 6-Digit OTP
               │                                          │
               ▼                                          ▼
┌────────────────────────────────────────────────────────────────────────┐
│                         EXPRESS.JS REST API                            │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                    Authentication Router                         │  │
│  │  • POST /api/auth/register    • POST /api/auth/2fa/verify        │  │
│  │  • POST /api/auth/login       • POST /api/auth/2fa/resend        │  │
│  │  • POST /api/auth/break-glass • POST /api/auth/2fa/toggle        │  │
│  └──────────────────────────────────┬───────────────────────────────┘  │
│                                     │                                  │
│                 ┌───────────────────┴───────────────────┐              │
│                 ▼                                       ▼              │
│  ┌─────────────────────────────┐         ┌───────────────────────────┐ │
│  │      Telegram Service       │         │     Recovery Service      │ │
│  │   (HTTPS Bot API Client)    │         │  (PBKDF2/Bcrypt Key Gen)  │ │
│  └──────────────┬──────────────┘         └──────────────┬────────────┘ │
└─────────────────┼───────────────────────────────────────┼──────────────┘
                  │                                       │
                  │ HTTPS POST                            │ SQL Read/Write
                  ▼                                       ▼
┌──────────────────────────────────┐    ┌────────────────────────────────┐
│       TELEGRAM BOT API           │    │        SQLITE DATABASE         │
│  (api.telegram.org/bot<token>)   │    │  User.twoFactorSecret          │
│                                  │    │  User.twoFactorExpiry          │
│                 │                │    │  User.recoveryCodeHash         │
│                 ▼                │    │  User.telegramChatId           │
│        User's Mobile Phone       │    │  User.telegram2FAEnabled       │
└──────────────────────────────────┘    └────────────────────────────────┘
```

---

## 2. Authentication Lifecycle Sequence

### Standard 2FA Login Flow

```
User Client                    CMS API Server                     Telegram API
    │                                │                                 │
    ├─── 1. POST /api/auth/login ───►│                                 │
    │    { username, password }      │                                 │
    │                                ├─ Verify credentials             │
    │                                ├─ Check 2FA enabled? (YES)       │
    │                                ├─ Generate 6-digit OTP           │
    │                                ├─ Store OTP + 5m Expiry in DB    │
    │                                ├─ Generate tempToken (2fa_pending)
    │                                │                                 │
    │                                ├─── 2. POST /sendMessage ───────►│
    │                                │    "🔐 Verification Code..."    │──► User Device
    │                                │◄── 3. 200 OK (Message sent) ────┤
    │◄── 4. 200 OK ──────────────────┤                                 │
    │    { require2FA: true,         │                                 │
    │      tempToken: "ey..." }      │                                 │
    │                                │                                 │
    │─── 5. POST /api/auth/2fa/verify│                                 │
    │    { tempToken, otp: "123456" }│                                 │
    │                                ├─ Decode tempToken               │
    │                                ├─ Check DB OTP match & not expired
    │                                ├─ Clear OTP from DB              │
    │                                ├─ Issue full session JWT         │
    │◄── 6. 200 OK (Session Granted)─┤                                 │
    │    { token: "ey...", user: {...} }                               │
```

---

## 3. Emergency Break-Glass Recovery Protocol

### Why Break-Glass Recovery?
In self-hosted home server environments, users may lose their phone, encounter Telegram API network blocks, or suffer device breakage. The Emergency Break-Glass mechanism provides a deterministic fail-safe that restores administrative access without opening security loopholes.

### Key Characteristics:
1. **High Entropy:** Keys follow format `CMS-XXXXXXXX-XXXXXXXX` (64-bit random hexadecimal, yielding $2^{64}$ combinations).
2. **One-Way Hashing:** The database never stores plain recovery keys; only one-way salts/hashes are saved.
3. **Single-Use Enforced (Forward Secrecy):** As soon as a recovery key is submitted and validated, it is instantly invalidated and destroyed in the database.
4. **Automatic Key Rotation:** The recovery response generates and issues a brand-new emergency key to the user immediately upon entry.

### State Diagram: Break-Glass Key Lifecycle

```
[ Account Registration ]
         │
         ▼
[ Generate Key CMS-XXXX-XXXX ] ──► Printed/Saved by User in Password Manager
         │
         ▼
[ Key Hash Stored in DB ]
         │
         ├─── Normal Login via Telegram 2FA (Key Remains Dormant)
         │
         ▼
[ Telegram Lost or Phone Damaged ]
         │
         ▼
[ POST /api/auth/break-glass ] (Submit recovery key)
         │
         ├──► Invalid Key? ──► 401 Unauthorized (Audit Logged)
         │
         └──► Valid Key Match?
                   │
                   ▼
      1. Invalidate Old Key
      2. Clear Pending 2FA Challenges
      3. Generate NEW Emergency Key
      4. Save New Key Hash to DB
      5. Issue Admin JWT Session
                   │
                   ▼
   [ User Receives New Key ]
```

---

## 4. SQLite Schema Implementation

The `User` table is extended to support Phase 3 without data loss:

```sql
ALTER TABLE "User" ADD COLUMN telegramChatId TEXT;
ALTER TABLE "User" ADD COLUMN telegram2FAEnabled INTEGER DEFAULT 0;
ALTER TABLE "User" ADD COLUMN twoFactorSecret TEXT;
ALTER TABLE "User" ADD COLUMN twoFactorExpiry TEXT;
ALTER TABLE "User" ADD COLUMN recoveryCodeHash TEXT;
ALTER TABLE "User" ADD COLUMN passwordHash TEXT;
ALTER TABLE "User" ADD COLUMN role TEXT DEFAULT 'user';
```

---

## 5. Security & Threat Mitigation

| Threat Vector | Mitigation Strategy |
| :--- | :--- |
| **Brute-Force OTP Guessing** | OTP expires in 300 seconds (5 minutes); OTP is cleared upon single failed session or successful login. |
| **Token Hijacking** | Temporary `2fa_pending` tokens cannot access standard API endpoints; they only grant access to `/api/auth/2fa/verify`. |
| **Telegram Network Outage** | Break-Glass recovery key bypasses Telegram network dependency completely. |
| **Database Compromise** | Recovery keys are hashed with PBKDF2/Bcrypt salts; plain keys cannot be extracted from database dumps. |
| **Replay Attacks** | Break-Glass keys rotate immediately upon usage; old keys are permanently rejected. |
