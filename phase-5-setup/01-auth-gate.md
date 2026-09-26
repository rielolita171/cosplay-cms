# Phase 5 Step 1: Authentication Gate

This guide covers implementing the login screen, OTP prompt, and JWT session management that gates access to the dashboard.

---

## Overview

The SPA has **three screens** that are mutually exclusive:

```
#screen-login   ← shown on load / after logout
#screen-otp     ← shown when 2FA challenge is issued
#screen-dashboard ← shown after successful authentication
```

Only one is visible at a time, controlled by `state.currentScreen`.

---

## HTML Structure to Add

### Login Screen

```html
<section id="screen-login" class="auth-screen">
  <div class="auth-card">
    <div class="auth-logo">
      <h1>👘 CMS</h1>
      <p>Cosplay Management System</p>
    </div>
    <form id="login-form" onsubmit="handleLogin(event)">
      <div class="form-group">
        <label for="login-username">Username</label>
        <input type="text" id="login-username" required autocomplete="username" placeholder="your username">
      </div>
      <div class="form-group">
        <label for="login-password">Password</label>
        <input type="password" id="login-password" required autocomplete="current-password" placeholder="••••••••">
      </div>
      <div id="login-error" class="form-error" style="display:none;"></div>
      <button type="submit" class="btn btn-primary btn-full" id="login-btn">Sign In</button>
    </form>
  </div>
</section>
```

### OTP Prompt Screen

```html
<section id="screen-otp" class="auth-screen" style="display:none;">
  <div class="auth-card">
    <div class="auth-logo">
      <h1>📱 2FA Verify</h1>
      <p>A 6-digit code was sent to your Telegram</p>
    </div>
    <form id="otp-form" onsubmit="handleOtpVerify(event)">
      <div class="form-group">
        <label for="otp-code">Enter OTP Code</label>
        <input type="text" id="otp-code" required maxlength="6" inputmode="numeric"
               pattern="[0-9]{6}" placeholder="______" class="otp-input">
      </div>
      <div id="otp-error" class="form-error" style="display:none;"></div>
      <button type="submit" class="btn btn-primary btn-full">Verify</button>
      <button type="button" class="btn btn-ghost btn-full" onclick="handleResendOtp()">Resend Code</button>
    </form>
  </div>
</section>
```

---

## JavaScript to Implement

### Screen Switchers

```javascript
function showLogin() {
  state.currentScreen = 'login';
  document.getElementById('screen-login').style.display = 'flex';
  document.getElementById('screen-otp').style.display = 'none';
  document.getElementById('screen-dashboard').style.display = 'none';
}

function showOtp() {
  state.currentScreen = 'otp';
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-otp').style.display = 'flex';
  document.getElementById('screen-dashboard').style.display = 'none';
}

function showDashboard() {
  state.currentScreen = 'dashboard';
  document.getElementById('screen-login').style.display = 'none';
  document.getElementById('screen-otp').style.display = 'none';
  document.getElementById('screen-dashboard').style.display = 'block';
  init(); // load all data
}
```

### Login Handler

```javascript
async function handleLogin(event) {
  event.preventDefault();
  const btn = document.getElementById('login-btn');
  const errorEl = document.getElementById('login-error');
  
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  errorEl.style.display = 'none';

  try {
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Login failed');
    }

    if (data.requires2FA && data.tempToken) {
      state.tempToken = data.tempToken;
      showOtp();
    } else if (data.token) {
      storeToken(data.token);
      showDashboard();
    }
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}
```

### OTP Verify Handler

```javascript
async function handleOtpVerify(event) {
  event.preventDefault();
  const errorEl = document.getElementById('otp-error');
  errorEl.style.display = 'none';

  try {
    const code = document.getElementById('otp-code').value;
    
    const res = await fetch('/api/auth/2fa/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: state.tempToken, code })
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Invalid OTP');
    }

    storeToken(data.token);
    state.tempToken = null;
    showDashboard();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  }
}
```

### Token Storage & Session Management

```javascript
function storeToken(token) {
  state.token = token;
  sessionStorage.setItem('cms_token', token);
}

function logout() {
  state.token = null;
  state.user = null;
  state.tempToken = null;
  sessionStorage.removeItem('cms_token');
  showLogin();
}

// Called once when page loads
function checkExistingSession() {
  const saved = sessionStorage.getItem('cms_token');
  if (saved) {
    state.token = saved;
    showDashboard();
  } else {
    showLogin();
  }
}
```

### Authenticated API Helper

```javascript
async function api(path, options = {}) {
  const headers = {
    ...(options.isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(state.token ? { 'Authorization': `Bearer ${state.token}` } : {}),
    ...(options.headers || {})
  };
  
  const res = await fetch(path, {
    ...options,
    headers
  });

  if (res.status === 401) {
    logout(); // Token expired
    return null;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }

  return res.json();
}
```

---

## Initialization Entry Point

Replace the existing bare `init()` call with:

```javascript
// Called on page load (replaces any existing DOMContentLoaded handler)
document.addEventListener('DOMContentLoaded', checkExistingSession);
```

---

## CSS for Auth Screens

```css
.auth-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
}

.auth-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 40px;
  width: 100%;
  max-width: 420px;
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow);
}

.auth-logo {
  text-align: center;
  margin-bottom: 32px;
}

.auth-logo h1 {
  font-size: 2rem;
  font-weight: 800;
  background: linear-gradient(135deg, #c084fc, #f472b6);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.auth-logo p {
  color: var(--text-muted);
  font-size: 0.9rem;
  margin-top: 6px;
}

.otp-input {
  text-align: center;
  font-size: 2rem;
  letter-spacing: 0.5em;
  font-family: monospace;
}

.btn-full {
  width: 100%;
  margin-top: 8px;
}

.form-error {
  color: var(--danger);
  font-size: 0.875rem;
  padding: 8px 12px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 6px;
  margin-bottom: 12px;
}
```

---

## Testing the Auth Flow Manually

```bash
# 1. Register a user (if no users exist)
curl -X POST http://localhost:4001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@local","password":"secret123"}'

# 2. Login
curl -X POST http://localhost:4001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"secret123"}'
# → { "token": "eyJ..." } or { "tempToken": "...", "requires2FA": true }

# 3. Use token
curl http://localhost:4001/api/auth/profile \
  -H "Authorization: Bearer eyJ..."
```
