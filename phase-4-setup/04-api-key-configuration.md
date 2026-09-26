# Phase 4 Step 4: API Key Configuration & Security

This guide covers how the `X-CMS-API-KEY` header authentication is configured and how to rotate or regenerate the key.

---

## Overview

Phase 4 notification endpoints (`/api/notifications/*`) are **not** protected by JWT. They are designed to be called by automated systems (n8n, cron jobs, webhooks) that don't maintain user sessions.

Instead, they use a **static API key** passed via the `X-CMS-API-KEY` HTTP header. This key is stored in `.env` and validated server-side by the `apiKeyAuth` middleware.

---

## Files Involved

| File | Role |
|------|------|
| `src/middleware/apiKeyAuth.js` | Reads `API_KEY` from env, validates header |
| `.env` | Stores the actual key value |
| `workflows/n8n_contact_lens_expiry_alert.json` | Must include the key in its HTTP node header |

---

## Generating a New API Key

```bash
# Generate a cryptographically secure 32-character hex key
openssl rand -hex 16

# Example output: 6511836fa298c453de5a11ae0b633e35
```

Then set it in `.env`:

```env
API_KEY=REPLACE_WITH_YOUR_API_KEY
```

> [!IMPORTANT]  
> After changing `API_KEY` in `.env`, you must also update the value in your n8n workflow's HTTP Request node header (`X-CMS-API-KEY`). The server must be restarted to pick up the new value.

---

## Middleware Behavior

**File:** [`src/middleware/apiKeyAuth.js`](file:///home/natanieldt/cosplay-cms/src/middleware/apiKeyAuth.js)

```
Request Arrives
     │
     ▼
Is X-CMS-API-KEY header present?
     │ NO → 401 Unauthorized
     │ YES
     ▼
Does header value === process.env.API_KEY?
     │ NO → 403 Forbidden
     │ YES
     ▼
next() — proceed to route handler
```

**Response codes:**

| Code | Condition | Message |
|------|-----------|---------|
| `401` | Header completely missing | `"X-CMS-API-KEY header required"` |
| `403` | Header present but wrong | `"Invalid API key"` |
| `200` | Key matches | Route handler runs normally |

---

## Applying the Key in n8n

In your imported workflow, find the **HTTP Request** node:

1. Open the node → **Headers** tab
2. Find `X-CMS-API-KEY` entry
3. Replace the placeholder value with your actual key from `.env`

```json
{
  "name": "X-CMS-API-KEY",
  "value": "REPLACE_WITH_YOUR_API_KEY"
}
```

---

## Applying the Key via curl (Manual Test)

```bash
# Test without key — expect 401
curl http://localhost:4001/api/notifications/contact-lenses/expiring

# Test with wrong key — expect 403
curl -H "X-CMS-API-KEY: wrong-key" \
     http://localhost:4001/api/notifications/contact-lenses/expiring

# Test with correct key — expect 200
curl -H "X-CMS-API-KEY: REPLACE_WITH_YOUR_API_KEY" \
     http://localhost:4001/api/notifications/contact-lenses/expiring

# With custom threshold (60 days)
curl -H "X-CMS-API-KEY: REPLACE_WITH_YOUR_API_KEY" \
     "http://localhost:4001/api/notifications/contact-lenses/expiring?days=60"
```

---

## Security Notes

> [!WARNING]
> The API key is a **shared secret**. Anyone who obtains it can query all notification endpoints without a user account. Keep it out of version control.

- Add `.env` to `.gitignore` (already done)
- Rotate the key if you suspect it was exposed
- For production deployments, consider using an environment variable manager (e.g., Vault, Docker Secrets) instead of `.env` files
- The key is compared with strict equality — no timing-safe comparison is implemented; this is acceptable for a home server but note it for future hardening

---

## Key Rotation Procedure

```bash
# 1. Generate new key
NEW_KEY=$(openssl rand -hex 16)
echo "New key: cms_dev_$NEW_KEY"

# 2. Update .env
sed -i "s|API_KEY=.*|API_KEY=cms_dev_$NEW_KEY|" .env

# 3. Restart server
npm run dev   # or: pm2 restart cosplay-cms

# 4. Update n8n workflow header with new key value

# 5. Run tests to confirm everything still works
npm run test:phase4
```
