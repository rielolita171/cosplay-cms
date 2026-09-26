# Phase 5: Frontend UI Construction

## Purpose

Phase 5 delivers a complete browser-based dashboard for the Cosplay Management System. It is a **single-page application (SPA)** served directly by the Express backend via `express.static('public')` — no framework build step, no separate server required.

The UI provides a private owner interface for:
- Browsing and managing costume inventory
- Tracking props and accessories by location
- Monitoring contact lens expiry status
- Managing 2FA settings and break-glass recovery

---

## Architecture Overview

```
Browser
  │
  ├── public/index.html          ← Single HTML file; all CSS and JS embedded
  │
  └── Fetches data from REST API (same origin, port 4001)
        ├── /api/costumes
        ├── /api/props
        ├── /api/lenses
        └── /api/auth/* (login, OTP, profile)
```

The SPA is **entirely self-contained** — no npm build, no CDN dependencies, no React/Vue. Pure vanilla HTML + CSS + JS for maximum server simplicity.

> **Design rationale:** Home server environment. No internet-facing CDN. Must work offline from local network. Zero framework overhead.

---

## Phase 5 Feature Set

### 5.1 Authentication Gate
Before the dashboard is visible, the user must authenticate:
- `POST /api/auth/login` → on success → either dashboard (2FA off) or OTP prompt (2FA on)
- OTP input screen calls `POST /api/auth/2fa/verify` with `tempToken`
- On success, JWT stored in `sessionStorage`; all API calls use `Authorization: Bearer <token>` header
- Logout clears token and returns to login screen

### 5.2 Dashboard Metrics Bar (4 KPI cards)
| Metric | Source |
|--------|--------|
| Total Outfits | `costumes.length` |
| On Rent | `costumes.filter(c => c.status === 'ON_RENT').length` |
| Active Lenses | `lenses.filter(l => l.status === 'ACTIVE').length` |
| Expiring Soon (⚠️) | `lenses.filter(l => daysRemaining <= 14).length` |

### 5.3 Costume Completion Formula
Each costume card shows a progress bar based on:
$$
\text{Completion \%} = \left( \frac{\text{isFullset} + \text{doneCostest} + \text{doneEvent} + \text{donePhotoSession}}{4} \right) \times 100\%
$$

### 5.4 Tab Views

| Tab | Content |
|-----|---------|
| 👘 Costumes | Filterable costume cards with image, status badge, completion bar, Taobao link |
| ⚔️ Props & Accessories | Props grid with category icon, storage location tag, linked costume |
| 👁️ Contact Lenses | Expiry-sorted cards with color-coded status badges and countdown |
| 🔐 Security & 2FA | 2FA toggle, QR/setup info, active session info |

### 5.5 Add / Edit Modals
- **Add Costume** — character, fandom, brand, size, status, notes, Taobao link
- **Add Prop** — name, category, location, condition, linked costume
- **Add Lens** — character, color, brand, prescription, purchase date, expiry date
- **Mark Lens Open** — triggers `PATCH /api/lenses/:id/open`; auto-calculates 1-year active expiry

### 5.6 Image Upload
- File input on costume edit triggers `POST /api/upload` (single image)
- Response URL stored in costume `imageUrls` JSON array
- Displayed in costume card as preview thumbnail

### 5.7 Filter Bar
- Text search across character/fandom/color/brand
- Status dropdown (All / IN_POSSESSION / ON_RENT / TO_BE_SOLD / WISHLIST)
- Real-time filter with no page reload

---

## File Structure

```
cosplay-cms/
└── public/
    └── index.html          ← Full SPA (HTML + embedded CSS + embedded JS)
```

> All UI lives in a **single file** for simplicity. Additional asset files (images, icons) may be added to `public/` in future phases.

---

## Implementation Sequence

| Step | Task | Details |
|------|------|---------|
| 5.1 | Auth flow + login screen | Login form, OTP prompt, JWT storage |
| 5.2 | Dashboard shell + metrics | Header, metric cards, KPI data |
| 5.3 | Costume tab | Cards, filter, completion bar, status badges |
| 5.4 | Props tab | Grid with location tags, category icons |
| 5.5 | Lens tab | Expiry countdown, status badges, open action |
| 5.6 | Add/edit modals | Form submission → API POST → reload state |
| 5.7 | Security tab | 2FA toggle endpoint calls, profile display |
| 5.8 | Image upload | File input → `/api/upload` → display preview |

---

## Design System

### Color Palette (CSS Variables)
| Variable | Value | Used For |
|----------|-------|----------|
| `--bg` | `#0f1117` | Page background |
| `--card-bg` | `rgba(26,31,46,0.85)` | Card surfaces (glassmorphism) |
| `--primary` | `#8b5cf6` | Buttons, active states |
| `--accent` | `#ec4899` | Gradient logo, highlights |
| `--success` | `#10b981` | Unopened lens, complete |
| `--warning` | `#f59e0b` | Expiring soon badge |
| `--danger` | `#ef4444` | Expired, delete actions |
| `--info` | `#3b82f6` | Active lens, info badges |

### Status Badge Mapping
```
Costume Status:
  IN_POSSESSION → green badge "In Possession"
  ON_RENT       → blue badge "On Rent"
  TO_BE_SOLD    → yellow badge "For Sale"
  WISHLIST      → purple badge "Wishlist"

Lens Status:
  UNOPENED      → green badge "Sealed" 🟢
  ACTIVE        → blue badge "Active" 🔵
  EXPIRING_SOON → yellow badge "Expiring!" ⚠️ (≤14 days)
  EXPIRED       → red badge "Expired" 🔴
```

---

## What Already Exists

A previous session created `public/index.html` (955 lines) with:
- ✅ Full CSS design system (glassmorphism dark theme)
- ✅ HTML structure: header, metrics bar, tab navigation, tab content sections
- ✅ All 3 Add modals (costume, prop, lens)
- ✅ `loadCostumes()`, `loadProps()`, `loadLenses()` fetch calls
- ✅ `renderCostumes()`, `renderProps()`, `renderLenses()` display logic
- ✅ `calculateCompletion()`, `updateMetrics()`, `filterItems()`, `switchTab()`
- ✅ Open/close modal helpers, form submission stubs

**What is NOT yet implemented in the existing file:**
- ❌ Login screen / authentication gate (all fetch calls are unauthenticated)
- ❌ JWT token storage and `Authorization` header injection
- ❌ OTP prompt screen for 2FA flow
- ❌ Image upload functionality wired up
- ❌ Edit/delete actions on existing items
- ❌ Security & 2FA tab content (toggle, profile info)
- ❌ Toast/notification feedback on form submit
- ❌ Error state handling in render functions
- ❌ `test:phase5` npm script + automated test

---

## Out of Scope for Phase 5

- No dark/light mode toggle (dark only for home server)
- No pagination (inventory is small, all items loaded at once)
- No PWA/offline mode (local network only)
- No i18n / localization

---

## Dependencies

Phase 5 has **zero new npm packages**. It uses:
- `express.static('public')` — already configured in `src/server.js`
- All Phase 2–4 API endpoints — already implemented
- JWT from Phase 3 auth — already working

---

## Testing Strategy

| Test Type | Approach |
|-----------|----------|
| Automated | `scripts/test_phase5.js` — headless HTTP checks of auth flow + API responses used by UI |
| Manual | Open `http://localhost:4001` in browser; walk through login → each tab → add forms → logout |

The automated test will cover:
1. Login endpoint returns token
2. Token used to fetch costumes/props/lenses successfully (simulating authenticated UI)
3. 2FA profile endpoint reachable with token
4. Upload endpoint reachable (form-data POST, checks 200 or 400)
