# Phase 5 Execution Checklist: Frontend UI Construction

Track the implementation and verification of Phase 5 — the browser-based SPA dashboard.

---

## Pre-Execution Verification
- [x] `express.static('public')` configured in `src/server.js`
- [x] Phase 2 REST API endpoints working (costumes, props, lenses, upload)
- [x] Phase 3 auth endpoints working (login, 2fa/verify, profile, logout)
- [x] `public/index.html` baseline shell exists (955 lines with CSS + render logic)

---

## Step 1: Authentication Gate

- [ ] Add `#screen-login` HTML section with username/password form
- [ ] Add `#screen-otp` HTML section with OTP code input field
- [ ] Implement `showLogin()` / `showOtp()` / `showDashboard()` screen switchers
- [ ] Implement `handleLogin()` → `POST /api/auth/login`
  - [ ] Success (no 2FA) → store token → show dashboard
  - [ ] Success (2FA) → store `tempToken` → show OTP screen
  - [ ] Failure → display inline error message
- [ ] Implement `handleOtpVerify()` → `POST /api/auth/2fa/verify`
  - [ ] Success → store JWT → show dashboard
  - [ ] Failure → inline error on OTP screen
- [ ] Store JWT in `sessionStorage` on success
- [ ] Implement `logout()` → clear token → show login screen
- [ ] On page load: check `sessionStorage` for existing token → skip login if present

---

## Step 2: Authenticated API Helper

- [ ] Implement `api(path, options)` helper that automatically injects `Authorization: Bearer <token>` header
- [ ] Handle `401` response globally → auto-logout
- [ ] Replace all bare `fetch('/api/...')` calls with `api('/api/...')`

---

## Step 3: Dashboard Metrics Bar

- [ ] Render 4 KPI metric cards dynamically from state data:
  - [ ] Total Outfits (`costumes.length`)
  - [ ] On Rent (`costumes.filter(ON_RENT).length`)
  - [ ] Active Lenses (`lenses.filter(ACTIVE).length`)
  - [ ] Expiring Soon with ⚠️ badge (`daysRemaining <= 14`)
- [ ] Update metrics on every data reload (`updateMetrics()`)

---

## Step 4: Costume Tab

- [ ] Costume card shows: image/placeholder, character, fandom, status badge, completion bar
- [ ] Completion bar calculates `(isFullset + doneCostest + doneEvent + donePhotoSession) / 4 * 100`
- [ ] Taobao link button visible only if `referenceUrl` is set
- [ ] Status badge correct color per status value
- [ ] Filter works (text + status dropdown)
- [ ] "Add Costume" modal submits `POST /api/costumes` and refreshes list
- [ ] "Delete" action calls `DELETE /api/costumes/:id` with confirmation

---

## Step 5: Props Tab

- [ ] Prop card shows: name, category icon, location tag, condition, linked costume name
- [ ] Filter bar works across name/category/location
- [ ] "Add Prop" modal submits `POST /api/props` and refreshes list

---

## Step 6: Contact Lens Tab

- [ ] Lens card shows: character, color, brand, prescription, expiry date, days-remaining countdown
- [ ] Color-coded status badge:
  - [ ] 🟢 Unopened (green)
  - [ ] 🔵 Active (blue)
  - [ ] 🟡 Expiring Soon ≤ 14 days (yellow)
  - [ ] 🔴 Expired (red)
- [ ] "Mark as Opened" button triggers `PATCH /api/lenses/:id/open` and refreshes
- [ ] "Add Lens" modal submits `POST /api/lenses` and refreshes list

---

## Step 7: Security & 2FA Tab

- [ ] Show current user profile (username, email, Telegram chat ID)
- [ ] Show 2FA enabled/disabled status
- [ ] Toggle button calls `PATCH /api/auth/2fa/toggle` (or equivalent)
- [ ] Break-glass recovery key display / info section

---

## Step 8: Image Upload

- [ ] Camera/upload icon on costume card triggers file input
- [ ] File input submits `POST /api/upload` (multipart/form-data)
- [ ] On success, update costume's `imageUrls` via `PUT /api/costumes/:id`
- [ ] Display uploaded image as card thumbnail

---

## Step 9: UX Polish

- [ ] Toast notification system for success/error feedback
- [ ] Loading skeleton or spinner during initial data load
- [ ] Empty state message when a tab has no items
- [ ] Form validation (required fields, date format)
- [ ] Confirm dialog before delete actions

---

## Step 10: Testing & Verification

- [ ] Create `scripts/test_phase5.js` automated test suite
  - [ ] Login returns JWT token
  - [ ] Authenticated GET /api/costumes returns 200
  - [ ] Authenticated GET /api/props returns 200
  - [ ] Authenticated GET /api/lenses returns 200
  - [ ] GET /api/auth/profile returns user object
  - [ ] Unauthenticated request returns 401
- [ ] Add `"test:phase5": "node scripts/test_phase5.js"` to `package.json`
- [ ] Manual browser test: open `http://localhost:4001`, complete full user flow

---

## Post-Execution Verification
- [ ] Login → OTP → Dashboard flow works end-to-end
- [ ] All three tabs load and display data
- [ ] Add forms save data and reload the view
- [ ] Logout clears session and returns to login screen
- [ ] 100% of Phase 5 automated tests pass
