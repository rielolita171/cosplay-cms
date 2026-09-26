# Phase 3: Step 3 — Emergency Break-Glass Recovery Protocol

## Objective
Implement an emergency fail-safe that restores administrative server access when Telegram 2FA is unavailable (e.g., lost phone, rate-limited bot, SIM failure, network outage).

---

## 3.1 What is a Break-Glass Recovery Key?

A Break-Glass key is an emergency alphanumeric token formatted as:

```text
CMS-XXXXXXXX-XXXXXXXX
```

- **Format:** `CMS` prefix followed by two 4-byte random hexadecimal blocks (64 bits of entropy).
- **Storage:** The plain key is shown **once** to the user and never stored on disk. Only its cryptographic hash is kept in the database.
- **Single-Use Rule:** When a break-glass key is used, it is immediately destroyed. A fresh replacement key is generated and returned to the administrator.

---

## 3.2 Obtaining Your Initial Key

When you register a user account via `POST /api/auth/register`, the response includes your first emergency key:

```json
{
  "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
  "username": "admin",
  "email": "admin@example.com",
  "recoveryKey": "CMS-8A3F1B2C-9E04D71A",
  "message": "User registered successfully. Save your emergency recovery key in a secure location!"
}
```

> [!CAUTION]
> Save this key immediately in a secure vault (such as Bitwarden, 1Password, or an encrypted offline backup).

---

## 3.3 Executing Emergency Recovery

If you cannot receive your Telegram 2FA code, access the `/api/auth/break-glass` endpoint:

```bash
curl -X POST http://localhost:4001/api/auth/break-glass \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "recoveryKey": "CMS-8A3F1B2C-9E04D71A"
  }'
```

### Server Execution Logic:
1. Validates `recoveryKey` against `User.recoveryCodeHash`.
2. Invalidates the used key immediately.
3. Automatically generates a **NEW** recovery key.
4. Clears any pending 2FA sessions.
5. Issues a full administrative JWT token.

### Response (200 OK):
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
    "username": "admin",
    "email": "admin@example.com",
    "role": "user"
  },
  "newRecoveryKey": "CMS-3E5D7A9F-B1C4E820",
  "message": "🚨 Emergency break-glass recovery successful. A new emergency key has been generated; store it safely!"
}
```

---

## 3.4 Regenerating a Recovery Key

If you suspect your emergency key was compromised or you misplaced your backup, you can regenerate it anytime while logged in:

```bash
curl -X POST http://localhost:4001/api/auth/break-glass/generate \
  -H "Authorization: Bearer <jwt-token>"
```

**Response:**
```json
{
  "success": true,
  "recoveryKey": "CMS-F1B2C3D4-E5F67890",
  "message": "New break-glass emergency recovery key generated. Save it securely!"
}
```

---

## Next Step
Proceed to [Step 4: Testing & Verification](04-testing-verification.md).
