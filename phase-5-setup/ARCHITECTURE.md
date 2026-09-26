# Phase 5 Architecture: Frontend SPA Design

## System Context

```
┌─────────────────────────────────────────────────────────────┐
│                     User's Browser                          │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              public/index.html (SPA)                 │    │
│  │                                                      │    │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │    │
│  │  │  Login   │  │Dashboard │  │  OTP Prompt      │   │    │
│  │  │  Screen  │  │  Shell   │  │  (2FA screen)    │   │    │
│  │  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │    │
│  │       │             │                  │             │    │
│  │  ┌────▼─────────────▼──────────────────▼─────────┐  │    │
│  │  │           State Manager (JS Object)            │  │    │
│  │  │   { token, costumes, props, lenses, user }     │  │    │
│  │  └────────────────────┬──────────────────────────┘  │    │
│  │                       │ fetch()                      │    │
│  └───────────────────────┼──────────────────────────────┘   │
│                          │                                   │
└──────────────────────────┼───────────────────────────────────┘
                           │ HTTP (same-origin, port 4001)
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Express API Server                         │
│                                                             │
│  POST /api/auth/login         POST /api/auth/2fa/verify     │
│  GET  /api/costumes           POST /api/costumes            │
│  GET  /api/props              POST /api/props               │
│  GET  /api/lenses             POST /api/lenses              │
│  PATCH /api/lenses/:id/open   POST /api/upload              │
│  GET  /api/auth/profile       PATCH /api/auth/2fa/toggle    │
└─────────────────────────────────────────────────────────────┘
```

---

## Application State Model

All UI data lives in a single global `state` object — no framework, no stores:

```javascript
const state = {
  // Auth
  token: null,              // JWT from login; null = not authenticated
  user: null,               // Profile object { id, username, email, telegram2FAEnabled }
  currentScreen: 'login',   // 'login' | 'otp' | 'dashboard'
  tempToken: null,          // Short-lived token during 2FA challenge

  // Data
  costumes: [],
  props: [],
  lenses: [],

  // UI
  currentTab: 'costumes',   // 'costumes' | 'props' | 'lenses' | 'security'
  filterQuery: '',
  filterStatus: 'all',
  loading: false,
  error: null
};
```

---

## Screen Flow

```
App Load
   │
   ▼
sessionStorage.getItem('cms_token') ?
   │
   ├── YES → validate token expiry → Dashboard
   │
   └── NO → Login Screen
              │
              ▼
         POST /api/auth/login
              │
              ├── { token } (no 2FA) ─────────────────────► Dashboard
              │
              └── { tempToken, requires2FA: true }
                        │
                        ▼
                   OTP Prompt Screen
                        │
                   POST /api/auth/2fa/verify
                        │
                        ├── { token } ────────────────────► Dashboard
                        │
                        └── { error } → show error, allow retry
```

---

## Component Map

### Screens (mutually exclusive `<section>` elements)

| Screen ID | Visibility Condition |
|-----------|---------------------|
| `#screen-login` | `state.currentScreen === 'login'` |
| `#screen-otp` | `state.currentScreen === 'otp'` |
| `#screen-dashboard` | `state.currentScreen === 'dashboard'` |

### Dashboard Tab Sections

| Section ID | Tab |
|-----------|-----|
| `#tab-costumes` | Costumes (default) |
| `#tab-props` | Props & Accessories |
| `#tab-lenses` | Contact Lenses |
| `#tab-security` | Security & 2FA |

### Modals (`<dialog>` elements)

| Modal ID | Trigger | Submits To |
|----------|---------|------------|
| `#modal-add-costume` | "+ New Costume" button | `POST /api/costumes` |
| `#modal-add-prop` | "+ Add Prop" button | `POST /api/props` |
| `#modal-add-lens` | "+ Add Lens" button | `POST /api/lenses` |
| `#modal-open-lens` | "Mark as Opened" button on card | `PATCH /api/lenses/:id/open` |
| `#modal-upload-image` | Camera icon on costume card | `POST /api/upload` |

---

## API Call Pattern

All authenticated calls use a shared helper that injects the JWT:

```javascript
async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(state.token ? { 'Authorization': `Bearer ${state.token}` } : {}),
    ...(options.headers || {})
  };
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    // Token expired or invalid → force logout
    logout();
    return null;
  }
  return res.json();
}
```

---

## Data Flow: Costume Tab

```
init()
  └── loadCostumes()
        └── GET /api/costumes (with Bearer token)
              └── state.costumes = data
                    └── updateMetrics()
                          └── renderCostumes()
                                └── DOM: #costume-grid innerHTML
                                      └── each card:
                                            ├── image thumbnail (or placeholder)
                                            ├── character + fandom
                                            ├── status badge
                                            ├── completion bar (%)
                                            ├── Taobao link button
                                            └── "Edit" / "Delete" action buttons
```

---

## Data Flow: Lens Tab

```
loadLenses()
  └── GET /api/lenses (with Bearer token)
        └── state.lenses = data
              └── renderLenses()
                    └── for each lens:
                          ├── compute daysRemaining = (expiryDate - now) / 86400000
                          ├── assign status class:
                          │     daysRemaining < 0  → EXPIRED (red)
                          │     daysRemaining ≤ 14 → EXPIRING_SOON (yellow)
                          │     isOpened           → ACTIVE (blue)
                          │     else               → UNOPENED (green)
                          └── render card with countdown badge
```

---

## Auth Header Persistence

```javascript
// On successful login:
sessionStorage.setItem('cms_token', token);
state.token = token;

// On page load:
const saved = sessionStorage.getItem('cms_token');
if (saved) {
  state.token = saved;
  showDashboard();
} else {
  showLogin();
}

// On logout:
sessionStorage.removeItem('cms_token');
state.token = null;
showLogin();
```

> `sessionStorage` is used (not `localStorage`) so the session clears when the browser tab is closed — appropriate for a home server private system.

---

## Security Considerations

| Risk | Mitigation |
|------|------------|
| JWT stored client-side | `sessionStorage` (tab-scoped, not persistent) |
| 401 from expired token | Auto-logout redirect to login screen |
| XSS via rendered data | All user content set via `textContent`, not `innerHTML` for raw values |
| CSRF | Not applicable — SPA uses Bearer token, not cookies |

---

## CSS Architecture

All styles are embedded in a `<style>` block inside `index.html`. Structure:

```
:root { /* CSS custom properties / design tokens */ }

* { /* Reset */ }
body { /* Background gradient */ }

/* Layout */
.container
header
.metrics-grid .metric-card
.tabs-nav .tab-btn
.tab-content section

/* Cards */
.costume-card
.prop-card
.lens-card

/* Modals */
dialog .modal-content .modal-header .modal-body .modal-actions

/* Forms */
.form-group label input select textarea

/* Badges */
.badge .badge-success .badge-warning .badge-danger .badge-info

/* Buttons */
.btn .btn-primary .btn-secondary .btn-danger .btn-ghost

/* Utilities */
.skeleton .toast .loading-overlay
```
