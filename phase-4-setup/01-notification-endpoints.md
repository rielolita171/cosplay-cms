# Phase 4: Step 1 — Notification Endpoints & API Key Security

## Objective
Provide dedicated, authenticated webhook query endpoints that n8n or external automation tools can poll to detect expiring inventory and active loans.

---

## 1.1 API Key Authentication (`src/middleware/apiKeyAuth.js`)

All notification endpoints are secured with a server-to-server API key passed via the `X-CMS-API-KEY` header:

```http
GET /api/notifications/contact-lenses/expiring HTTP/1.1
Host: localhost:4001
X-CMS-API-KEY: your_api_key_from_env
```

---

## 1.2 Endpoints Reference

### 1. `GET /api/notifications/contact-lenses/expiring`
Queries colored contact lenses approaching expiration.

**Query Parameters:**
- `days` (number, optional, default: `14`): Filter lenses expiring within this many days.

**Example Request:**
```bash
curl "http://localhost:4001/api/notifications/contact-lenses/expiring?days=14" \
  -H "X-CMS-API-KEY: your_api_key"
```

**Response (200 OK):**
```json
{
  "thresholdDays": 14,
  "count": 1,
  "items": [
    {
      "id": "7f8b9c2a-1234-5678-90ab-cdef12345678",
      "character": "Raiden Shogun",
      "color": "Purple",
      "brand": "Sweety Spata",
      "prescription": "-1.50",
      "expiryDate": "2026-10-10T00:00:00.000Z",
      "daysRemaining": 13,
      "status": "EXPIRING_SOON"
    }
  ]
}
```

---

### 2. `GET /api/notifications/costumes/on-rent`
Lists all costumes currently marked as `ON_RENT` to monitor ongoing loans.

**Example Request:**
```bash
curl "http://localhost:4001/api/notifications/costumes/on-rent" \
  -H "X-CMS-API-KEY: your_api_key"
```

---

## Next Step
Proceed to [Step 2: n8n Workflow Setup](02-n8n-workflow-setup.md).
