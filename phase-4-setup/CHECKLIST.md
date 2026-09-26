# Phase 4 Execution Checklist: n8n Integration & Alerts

Track the implementation and verification of Phase 4 automated notifications.

---

## Pre-Execution Verification
- [x] Phase 2 REST API and Contact Lenses endpoints active
- [x] Phase 3 Telegram configuration active
- [x] API key configured in `.env` (`API_KEY`)

---

## Step 1: Notification Endpoints & Security
- [x] Create `src/middleware/apiKeyAuth.js` enforcing `X-CMS-API-KEY`
- [x] Create `src/routes/notifications.js` with:
  - [x] `GET /api/notifications/contact-lenses/expiring` (dynamic threshold calculation)
  - [x] `GET /api/notifications/costumes/on-rent`
- [x] Register routes in `src/server.js`

---

## Step 2: n8n Workflow Construction
- [x] Create exportable workflow template `workflows/n8n_contact_lens_expiry_alert.json`
- [ ] Import workflow into local or cloud n8n instance
- [ ] Update `X-CMS-API-KEY` header parameter with your secret
- [ ] Update `chatId` parameter with your Telegram Chat ID
- [ ] Activate workflow in n8n

---

## Step 3: Verification & Automated Testing
- [x] Create test runner `scripts/test_phase4.js`
- [x] Execute automated tests: `node scripts/test_phase4.js`
  - [x] Reject missing API key (401)
  - [x] Reject invalid API key (403)
  - [x] Query default 14-day window (200)
  - [x] Query custom 60-day window (200)
  - [x] Query costumes on-rent (200)
- [x] Add `"test:phase4"` script to `package.json`
- [x] Fix `.env` `API_KEY` literal shell substitution → real hex value

---

## Post-Execution Verification
- [ ] Perform manual test run in n8n UI
- [ ] Verify test notification received on Telegram device

