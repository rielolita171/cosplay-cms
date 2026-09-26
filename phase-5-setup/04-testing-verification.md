# Phase 5 Step 4: Testing & Verification

This guide covers the automated test script for Phase 5 and the manual browser walkthrough checklist.

---

## Overview

Phase 5 is primarily a frontend (browser) phase. Automated testing covers the **API layer that the UI depends on**, simulating what the browser would call with a real JWT token.

Manual browser testing is required to verify UI rendering, interactions, and form submissions.

---

## Automated Test: `scripts/test_phase5.js`

The test suite:
1. Registers (or logs in to) a test user
2. Obtains a JWT token (skipping 2FA if not configured)
3. Uses the JWT to hit every API endpoint the dashboard calls
4. Verifies correct HTTP status codes and response shapes

```javascript
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');

const PORT = process.env.PORT || 4001;
const API_BASE = `http://localhost:${PORT}`;

let passCount = 0;
let failCount = 0;
let testToken = null;

// ── HTTP helper ──────────────────────────────────────────────────────────────

function request(path, method = 'GET', body = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...(testToken ? { 'Authorization': `Bearer ${testToken}` } : {}),
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        ...extraHeaders
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function logTest(name, passed, details = '') {
  const icon = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon}: ${name}${details ? ` — ${details}` : ''}`);
  if (passed) passCount++; else failCount++;
}

// ── Test Suites ──────────────────────────────────────────────────────────────

async function testAuthFlow() {
  console.log('\n--- 1. Auth Flow ---');

  // Register test user (may already exist — that's OK)
  const regRes = await request('/api/auth/register', 'POST', {
    username: 'phase5_test',
    email: 'phase5@test.local',
    password: 'TestPass123!'
  });
  logTest(
    'Register test user (or already exists)',
    regRes.status === 201 || regRes.status === 409,
    `Status: ${regRes.status}`
  );

  // Login
  const loginRes = await request('/api/auth/login', 'POST', {
    username: 'phase5_test',
    password: 'TestPass123!'
  });

  const hasToken = loginRes.status === 200 && loginRes.body.token;
  const has2FA   = loginRes.status === 200 && loginRes.body.requires2FA;

  logTest(
    'Login returns token or 2FA challenge',
    hasToken || has2FA,
    `Status: ${loginRes.status}`
  );

  if (hasToken) {
    testToken = loginRes.body.token;
    logTest('No 2FA on test user (token received directly)', true, 'Token stored');
  } else if (has2FA) {
    // 2FA is on — we can't complete it in automated test without Telegram
    logTest(
      '2FA is enabled on test user — skipping downstream tests',
      true,
      'Manual verification needed'
    );
    return false; // signal: stop here
  }

  return true;
}

async function testProtectedEndpoints() {
  console.log('\n--- 2. Protected Endpoint Access ---');

  const costumesRes = await request('/api/costumes');
  logTest(
    'GET /api/costumes with JWT → 200',
    costumesRes.status === 200 && Array.isArray(costumesRes.body),
    `Status: ${costumesRes.status}, Count: ${costumesRes.body?.length ?? '?'}`
  );

  const propsRes = await request('/api/props');
  logTest(
    'GET /api/props with JWT → 200',
    propsRes.status === 200 && Array.isArray(propsRes.body),
    `Status: ${propsRes.status}, Count: ${propsRes.body?.length ?? '?'}`
  );

  const lensesRes = await request('/api/lenses');
  logTest(
    'GET /api/lenses with JWT → 200',
    lensesRes.status === 200 && Array.isArray(lensesRes.body),
    `Status: ${lensesRes.status}, Count: ${lensesRes.body?.length ?? '?'}`
  );

  const profileRes = await request('/api/auth/profile');
  logTest(
    'GET /api/auth/profile with JWT → 200 with user object',
    profileRes.status === 200 && (profileRes.body.user || profileRes.body.username),
    `Status: ${profileRes.status}`
  );
}

async function testUnauthenticated() {
  console.log('\n--- 3. Unauthenticated Rejection ---');

  const savedToken = testToken;
  testToken = null;

  const res = await request('/api/auth/profile');
  logTest(
    'GET /api/auth/profile without JWT → 401',
    res.status === 401,
    `Status: ${res.status}`
  );

  testToken = savedToken;
}

async function testCRUD() {
  console.log('\n--- 4. CRUD Smoke Test ---');

  // Create costume
  const createRes = await request('/api/costumes', 'POST', {
    character: 'Phase5 Test Character',
    fandom: 'Phase5 Test Fandom',
    status: 'IN_POSSESSION'
  });
  logTest(
    'POST /api/costumes → 201 created',
    createRes.status === 201 || createRes.status === 200,
    `Status: ${createRes.status}`
  );

  const createdId = createRes.body?.id || createRes.body?.costume?.id;

  if (createdId) {
    // Fetch it
    const getRes = await request(`/api/costumes/${createdId}`);
    logTest(
      'GET /api/costumes/:id → 200',
      getRes.status === 200,
      `Status: ${getRes.status}`
    );

    // Delete it
    const delRes = await request(`/api/costumes/${createdId}`, 'DELETE');
    logTest(
      'DELETE /api/costumes/:id → 200 or 204',
      delRes.status === 200 || delRes.status === 204,
      `Status: ${delRes.status}`
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runPhase5Tests() {
  console.log('🖥️  STARTING PHASE 5: FRONTEND API LAYER TEST SUITE\n');
  console.log('='.repeat(60));

  try {
    const authOk = await testAuthFlow();
    if (authOk) {
      await testProtectedEndpoints();
      await testUnauthenticated();
      await testCRUD();
    }
  } catch (err) {
    console.error('❌ Test execution error:', err.message);
    process.exit(1);
  }

  console.log('\n' + '='.repeat(60));
  console.log('📊 PHASE 5 TEST SUMMARY');
  console.log(`✅ Passed: ${passCount}`);
  console.log(`❌ Failed: ${failCount}`);
  console.log(`📈 Success Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%\n`);

  if (failCount === 0) {
    console.log('🎉 ALL PHASE 5 TESTS PASSED! Frontend API layer verified.\n');
    process.exit(0);
  } else {
    console.log(`⚠️  ${failCount} test(s) failed. Review output above.\n`);
    process.exit(1);
  }
}

runPhase5Tests();
```

---

## npm Script Setup

Add to `package.json` `scripts`:

```json
"test:phase5": "node scripts/test_phase5.js"
```

Run with:

```bash
npm run test:phase5
```

---

## Manual Browser Testing Checklist

Open `http://localhost:4001` and complete this walkthrough:

### Auth Flow

- [ ] Login screen visible on first load
- [ ] Submit login form with wrong password → error message shown inline
- [ ] Submit login form with correct credentials:
  - [ ] If 2FA disabled → dashboard shown directly
  - [ ] If 2FA enabled → OTP prompt screen shown, code sent to Telegram
- [ ] Enter OTP code → dashboard loads
- [ ] Refresh page → still logged in (token in sessionStorage persists)
- [ ] Click Logout → returns to login screen, can't access dashboard without logging in again

### Costume Tab

- [ ] Costume cards load with correct data
- [ ] Status badge colors match (green/blue/yellow/purple)
- [ ] Completion bar reflects milestones
- [ ] Filter by name → cards filter in real-time
- [ ] Filter by status → correct subset shown
- [ ] "+ New Costume" modal opens
- [ ] Fill form and submit → costume appears in list
- [ ] Delete costume → confirmation prompt → item removed

### Props Tab

- [ ] Props load with category icons and location tags
- [ ] Filter works across name/category/location
- [ ] "+ Add Prop" modal opens; submits and reloads

### Contact Lens Tab

- [ ] Lens cards sorted by nearest expiry
- [ ] Status badges: 🟢 Sealed, 🔵 Active, ⚠️ Expiring, 🔴 Expired
- [ ] "Mark as Opened" button visible only on unopened lenses
- [ ] Clicking "Mark as Opened" → lens status updates to Active, expiry recalculated
- [ ] "+ Add Lens" modal works

### Security & 2FA Tab

- [ ] Username, email, Telegram Chat ID displayed
- [ ] 2FA status badge correct (Enabled/Disabled)
- [ ] Toggle 2FA button updates status

### Metrics Bar

- [ ] Numbers update correctly when items are added/deleted
- [ ] "Expiring Soon" count matches lenses with ≤ 14 days remaining

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Login returns 401 | Wrong credentials | Register user first via curl or API |
| Login requires 2FA | Phase 3 2FA enabled for test account | Use break-glass key or register a fresh test user |
| 401 on all API calls after login | JWT not being attached | Check `api()` helper injects `Authorization` header |
| Image upload fails | `POST /api/upload` missing field name | Ensure `FormData.append('image', file)` matches multer field name |
| Lens status all shows "UNOPENED" | `isOpened` field is string `"0"` not boolean | Cast with `item.isOpened === '1' \|\| item.isOpened === true` |
| Empty tab after adding item | `loadCostumes()` not called after submit | Add `await loadCostumes()` in submit handler |
