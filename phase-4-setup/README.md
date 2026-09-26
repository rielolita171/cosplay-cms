# Phase 4: n8n Workflow Integration & Lens Expiry Alerts — Complete Guide

## Overview
Phase 4 implements proactive inventory automation for the Cosplay Management System (CMS). By linking an automated backend notification query endpoint with a self-hosted **n8n** workflow, your server scans for contact lenses nearing expiration and issues formatted warning alerts directly to your personal Telegram account.

---

## 🧭 Learning Path: 3 Steps

### 1. [Step 1: Notification Endpoints & API Key Security](01-notification-endpoints.md)
- **Duration:** ~10 minutes
- **What You'll Do:**
  - Secure webhook endpoints using the `X-CMS-API-KEY` header.
  - Implement `/api/notifications/contact-lenses/expiring?days=14` with dynamic day calculation.
  - Query costumes currently on rent via `/api/notifications/costumes/on-rent`.
- **Files Created/Used:** `src/middleware/apiKeyAuth.js`, `src/routes/notifications.js`

---

### 2. [Step 2: n8n Workflow Configuration & Import](02-n8n-workflow-setup.md)
- **Duration:** ~15 minutes
- **What You'll Do:**
  - Import the pre-configured workflow JSON (`workflows/n8n_contact_lens_expiry_alert.json`).
  - Configure the daily Cron schedule trigger (default: 08:00 AM).
  - Configure the HTTP Request node to point to your CMS server.
  - Set up the conditional IF filter and Telegram notification formatting.
- **Files Created/Used:** `workflows/n8n_contact_lens_expiry_alert.json`

---

### 3. [Step 3: Testing & Verification](03-testing-verification.md)
- **Duration:** ~10 minutes
- **What You'll Do:**
  - Run the Phase 4 automated test runner (`scripts/test_phase4.js`).
  - Test authentication enforcement (401/403 responses).
  - Test threshold variations (`?days=7`, `?days=30`, `?days=60`).
  - Trigger manual test executions in n8n.
- **Files Created/Used:** `scripts/test_phase4.js`

---

## 🔄 Automation Architecture Flow

```
┌────────────────────────────────────────────────────────┐
│                   n8n AUTOMATION ENGINE                │
│                                                        │
│  ┌───────────────────────┐                             │
│  │ Schedule Trigger Node │  Runs Daily at 08:00 AM     │
│  └───────────┬───────────┘                             │
│              │                                         │
│              ▼                                         │
│  ┌───────────────────────┐  GET /notifications/expiring│
│  │   HTTP Request Node   │  Header: X-CMS-API-KEY      │
│  └───────────┬───────────┘                             │
│              │                                         │
│              ▼                                         │
│  ┌───────────────────────┐                             │
│  │        IF Node        │  Are items.length > 0?      │
│  └─────┬───────────┬─────┘                             │
│        │           │                                   │
│    YES │           │ NO                                │
│        ▼           ▼                                   │
│  ┌───────────┐  [Silent Finish]                        │
│  │ Telegram  │                                         │
│  │   Node    │  Formatted HTML alert with items        │
│  └─────┬─────┘                                         │
└────────┼───────────────────────────────────────────────┘
         │
         ▼
 📱 Cosplayer's Phone
 "⚠️ Contact Lens Expiry Warning: Raiden Shogun (Purple) expires in 12 days!"
```

---

## 🚀 Quick Execution Guide

```bash
# Run Phase 4 automated tests
node scripts/test_phase4.js
```
