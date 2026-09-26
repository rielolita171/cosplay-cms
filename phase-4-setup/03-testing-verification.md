# Phase 4: Step 3 — Testing & Verification

## Objective
Verify that the notification query API and n8n webhook integration function accurately, respect security boundaries, and handle date math properly.

---

## 3.1 Running the Automated Test Suite

Ensure the server is running on port 4001:

```bash
cd ~/cosplay-cms
node scripts/test_phase4.js
```

### Expected Output:
```text
📬 STARTING PHASE 4: NOTIFICATIONS & N8N WEBHOOK TEST SUITE

============================================================

--- 1. API Key Security Enforcement ---
✅ PASS: Reject request without X-CMS-API-KEY header - Status: 401
✅ PASS: Reject request with invalid X-CMS-API-KEY - Status: 403

--- 2. Contact Lens Expiry Query ---
✅ PASS: Fetch expiring lenses with valid API key (default 14 days) - Threshold: 14, Count: 0

--- 3. Custom Threshold Parameter Validation ---
✅ PASS: Query with custom threshold (?days=60) - Threshold: 60, Count: 0

--- 4. Costumes On-Rent Query ---
✅ PASS: Query costumes currently on rent - Count: 0

============================================================
📊 PHASE 4 TEST SUMMARY
✅ Passed: 5
❌ Failed: 0
📈 Success Rate: 100.0%

🎉 ALL PHASE 4 TESTS PASSED! Notification endpoints ready for n8n.
```

---

## 3.2 Manual Testing with a Seeded Expiring Lens

To verify that an expiring lens triggers a notification alert, insert a temporary lens with an expiration date 5 days from now:

```bash
sqlite3 data/db/cms.db << 'EOF'
INSERT INTO "ContactLens" (id, character, color, brand, prescription, expiryDate, status)
VALUES ('test-expiring-1', 'Test Character', 'Amber Red', 'GEO Lens', '-1.50', datetime('now', '+5 days'), 'ACTIVE');
EOF
```

Query the endpoint:
```bash
curl -H "X-CMS-API-KEY: $(grep API_KEY .env | cut -d '=' -f2 | tr -d '\"')" \
  "http://localhost:4001/api/notifications/contact-lenses/expiring?days=14"
```

Verify output shows `count: 1` and `daysRemaining: 5`.

Clean up test data:
```bash
sqlite3 data/db/cms.db 'DELETE FROM "ContactLens" WHERE id = "test-expiring-1";'
```

---

## Phase 4 Complete! 🎉
You are now ready to proceed to **Phase 5: Frontend UI Construction**.
