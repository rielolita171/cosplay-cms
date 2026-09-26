# Phase 4 Architecture & Integration Specification

This document details the communication protocols, payload schemas, and n8n node topology for Phase 4.

---

## 1. Integration Topology

```
┌─────────────────────────┐                     ┌─────────────────────────┐
│     n8n ORCHESTRATOR    │                     │     COSPLAY CMS API     │
│   (Port 5678 / Cloud)   │                     │     (Port 4001/3000)    │
│                         │                     │                         │
│  ┌───────────────────┐  │  HTTP GET + API Key │  ┌───────────────────┐  │
│  │ Schedule Trigger  │  │────────────────────►│  │ Notification API  │  │
│  │ (Cron: 08:00 AM)  │  │                     │  │ Router            │  │
│  └───────────────────┘  │                     │  └─────────┬─────────┘  │
│                         │                     │            │            │
│  ┌───────────────────┐  │  JSON Response      │            ▼            │
│  │ Telegram Node     │◄─┼─────────────────────│  ┌───────────────────┐  │
│  └─────────┬─────────┘  │  { threshold, items}│  │ SQLite Database   │  │
└────────────┼────────────┘                     │  │ (cms.db)          │  │
             │                                  │  └───────────────────┘  │
             │ HTTPS POST                       └─────────────────────────┘
             ▼
┌─────────────────────────┐
│   TELEGRAM BOT API      │
│ (api.telegram.org)      │
└─────────────────────────┘
```

---

## 2. API Contract & Payload Schema

### Endpoint: `GET /api/notifications/contact-lenses/expiring`
- **Security:** Requires header `X-CMS-API-KEY: <server_api_key>`
- **Query Parameter:** `days` (integer, default: 14)

### Response JSON Schema:
```json
{
  "thresholdDays": 14,
  "count": 2,
  "items": [
    {
      "id": "c1d2e3f4-5678-90ab-cdef-1234567890ab",
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

## 3. n8n Node Breakdown

1. **Schedule Trigger (`n8n-nodes-base.scheduleTrigger`)**:
   - Fires at user-defined intervals (recommended: once daily at 08:00 AM).
2. **HTTP Request (`n8n-nodes-base.httpRequest`)**:
   - Performs `GET http://cosplay-cms:4001/api/notifications/contact-lenses/expiring?days=14`
   - Injects custom header `X-CMS-API-KEY`.
3. **Condition Filter (`n8n-nodes-base.if`)**:
   - Assesses: `{{ $json.count > 0 }}`.
   - Prevents spamming empty messages when all lenses are safely within lifespan.
4. **Telegram Dispatcher (`n8n-nodes-base.telegram`)**:
   - Formats items into a clean HTML bulletin.
   - Dispatches alert directly to user's Telegram Chat ID.
