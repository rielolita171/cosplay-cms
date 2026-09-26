# Phase 3: Step 2 — Two-Factor Authentication (2FA) Engine

## Objective
Implement an OTP-based Two-Factor Authentication mechanism that intercepts standard logins for protected accounts and issues time-limited verification codes.

---

## 2.1 API Endpoint Reference

| Method | Endpoint | Auth Required | Description |
| :--- | :--- | :---: | :--- |
| `POST` | `/api/auth/login` | No | Validates password. If 2FA enabled, dispatches OTP and returns `tempToken`. |
| `POST` | `/api/auth/2fa/verify` | No (requires `tempToken`) | Validates 6-digit OTP code and issues full JWT access token. |
| `POST` | `/api/auth/2fa/resend` | No (requires `tempToken`) | Dispatches a fresh 6-digit OTP code. |
| `POST` | `/api/auth/2fa/toggle` | Yes (Bearer Token) | Enables or disables Telegram 2FA for the authenticated user. |

---

## 2.2 Endpoint Usage & Examples

### 1. Initiating Login (2FA Challenge)
Submit your username and password:

```bash
curl -X POST http://localhost:4001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "cosplayer123",
    "password": "SecurePassword123!"
  }'
```

**Response (200 OK — 2FA Required):**
```json
{
  "require2FA": true,
  "tempToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "userId": "7f8b9c2a-1234-5678-90ab-cdef12345678",
  "telegramChatId": "****4321",
  "message": "2FA required. 6-digit verification code sent via Telegram."
}
```

> [!NOTE]
> The `tempToken` has a short expiration of 5 minutes and `type: "2fa_pending"`. It cannot be used to query regular API routes.

---

### 2. Verifying the 6-Digit OTP Code
Submit the code received on your phone:

```bash
curl -X POST http://localhost:4001/api/auth/2fa/verify \
  -H "Content-Type: application/json" \
  -d '{
    "tempToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "otp": "492817"
  }'
```

**Response (200 OK — Authentication Successful):**
```json
{
  "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "user",
  "message": "2FA verification successful"
}
```

---

### 3. Resending an OTP
If your code expired or was not received:

```bash
curl -X POST http://localhost:4001/api/auth/2fa/resend \
  -H "Content-Type: application/json" \
  -d '{
    "tempToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }'
```

---

### 4. Toggling 2FA On/Off
Protected by your standard JWT token:

```bash
curl -X POST http://localhost:4001/api/auth/2fa/toggle \
  -H "Authorization: Bearer <jwt-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "enabled": true,
    "telegramChatId": "987654321"
  }'
```

---

## Next Step
Proceed to [Step 3: Emergency Break-Glass Recovery Protocol](03-break-glass-recovery.md).
