# Phase 5 Step 3: Add Forms, Image Upload & Security Tab

This guide covers form submission logic, image upload integration, and the Security & 2FA settings tab.

---

## Add Costume Form

### HTML (inside `<dialog id="modal-add-costume">`)

The form needs these fields:
- character (required)
- fandom (required)
- brand, size (optional)
- status (select: IN_POSSESSION / ON_RENT / TO_BE_SOLD / WISHLIST)
- isFullset, doneCostest, doneEvent, donePhotoSession (checkboxes)
- notes (textarea)
- referenceUrl (Taobao link)

### Submit Handler

```javascript
async function submitAddCostume(event) {
  event.preventDefault();
  const form = event.target;
  
  const payload = {
    character: form.character.value.trim(),
    fandom:    form.fandom.value.trim(),
    brand:     form.brand.value.trim() || null,
    size:      form.size.value.trim() || null,
    status:    form.status.value,
    isFullset:        form.isFullset?.checked ? 1 : 0,
    doneCostest:      form.doneCostest?.checked ? 1 : 0,
    doneEvent:        form.doneEvent?.checked ? 1 : 0,
    donePhotoSession: form.donePhotoSession?.checked ? 1 : 0,
    notes:       form.notes?.value.trim() || null,
    referenceUrl: form.referenceUrl?.value.trim() || null
  };

  try {
    await api('/api/costumes', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    closeModal('modal-add-costume');
    form.reset();
    showToast('Costume added!', 'success');
    await loadCostumes();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
```

---

## Add Prop Form

### Submit Handler

```javascript
async function submitAddProp(event) {
  event.preventDefault();
  const form = event.target;

  const payload = {
    name:      form.name.value.trim(),
    category:  form.category.value || null,
    location:  form.location.value.trim() || null,
    condition: form.condition.value || null,
    costumeId: form.costumeId?.value || null,
    notes:     form.notes?.value.trim() || null
  };

  try {
    await api('/api/props', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    closeModal('modal-add-prop');
    form.reset();
    showToast('Prop added!', 'success');
    await loadProps();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
```

### Populate Costume Dropdown in Prop Modal

```javascript
function populateCostumeSelects() {
  const selects = document.querySelectorAll('.costume-select');
  const options = state.costumes.map(c =>
    `<option value="${c.id}">${escapeHtml(c.character)} — ${escapeHtml(c.fandom)}</option>`
  ).join('');

  selects.forEach(sel => {
    sel.innerHTML = `<option value="">None (Standalone)</option>` + options;
  });
}
```

Call `populateCostumeSelects()` after `loadCostumes()`.

---

## Add Lens Form

### Submit Handler

```javascript
async function submitAddLens(event) {
  event.preventDefault();
  const form = event.target;

  const payload = {
    character:    form.character?.value.trim() || null,
    color:        form.color.value.trim(),
    brand:        form.brand?.value.trim() || null,
    prescription: form.prescription?.value.trim() || null,
    purchaseDate: form.purchaseDate?.value || null,
    expiryDate:   form.expiryDate.value,  // Required
    notes:        form.notes?.value.trim() || null
  };

  try {
    await api('/api/lenses', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    closeModal('modal-add-lens');
    form.reset();
    showToast('Lens added!', 'success');
    await loadLenses();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  }
}
```

---

## Image Upload

### Trigger

Each costume card has an upload trigger:

```html
<button class="btn btn-ghost btn-sm" onclick="triggerImageUpload('${item.id}')">📷 Upload Image</button>
<input type="file" id="img-upload-${item.id}" style="display:none"
       accept="image/*" onchange="handleImageUpload(event, '${item.id}')">
```

### Upload Handler

```javascript
function triggerImageUpload(costumeId) {
  document.getElementById(`img-upload-${costumeId}`).click();
}

async function handleImageUpload(event, costumeId) {
  const file = event.target.files[0];
  if (!file) return;

  showToast('Uploading image…', 'info');

  const formData = new FormData();
  formData.append('image', file);

  try {
    // Upload file (no Content-Type header — browser sets multipart boundary)
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${state.token}` },
      body: formData
    });

    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    const newUrl = data.url || data.path;

    // Append URL to costume's imageUrls
    const costume = state.costumes.find(c => c.id === costumeId);
    if (costume) {
      const existing = (() => {
        try { return JSON.parse(costume.imageUrls || '[]'); }
        catch { return []; }
      })();
      existing.push(newUrl);

      await api(`/api/costumes/${costumeId}`, {
        method: 'PUT',
        body: JSON.stringify({ imageUrls: JSON.stringify(existing) })
      });

      showToast('Image uploaded!', 'success');
      await loadCostumes();
    }
  } catch (err) {
    showToast('Upload error: ' + err.message, 'error');
  }
}
```

> **Note:** `POST /api/upload` returns `{ url: "/uploads/img_xxx.webp" }`. The URL is relative and will resolve correctly since the SPA and API share the same origin.

---

## Security & 2FA Tab

### HTML Content for `#tab-security`

```html
<section id="tab-security" style="display: none;">
  <div class="security-grid">

    <!-- Profile Card -->
    <div class="security-card">
      <h2>👤 Account</h2>
      <div class="security-row">
        <span>Username</span>
        <strong id="sec-username">—</strong>
      </div>
      <div class="security-row">
        <span>Email</span>
        <strong id="sec-email">—</strong>
      </div>
      <div class="security-row">
        <span>Telegram Chat ID</span>
        <strong id="sec-telegram">Not configured</strong>
      </div>
    </div>

    <!-- 2FA Card -->
    <div class="security-card">
      <h2>🔐 Two-Factor Authentication</h2>
      <div class="security-row">
        <span>Telegram 2FA</span>
        <span id="sec-2fa-status" class="badge badge-success">Enabled</span>
      </div>
      <p class="security-note">
        When enabled, logging in will send a 6-digit OTP to your Telegram account.
        You must have a Telegram Chat ID configured.
      </p>
      <button class="btn btn-secondary" onclick="toggle2FA()" id="btn-toggle-2fa">
        Disable 2FA
      </button>
    </div>

    <!-- Break-Glass Card -->
    <div class="security-card">
      <h2>🚨 Emergency Recovery</h2>
      <p class="security-note">
        If you lose access to your Telegram account, use your Break-Glass recovery key
        to bypass 2FA. This key was shown when you first set up the server.
      </p>
      <p class="security-note">
        Format: <code>CMS-XXXX-XXXX</code><br>
        Store this in a password manager (e.g. Bitwarden).
      </p>
      <a href="/api/auth/break-glass" class="btn btn-ghost">
        📖 Use Recovery Endpoint
      </a>
    </div>

  </div>
</section>
```

### Load Security Profile

```javascript
async function loadSecurityProfile() {
  try {
    const data = await api('/api/auth/profile');
    if (!data) return;
    
    state.user = data.user || data;

    document.getElementById('sec-username').textContent = state.user.username || '—';
    document.getElementById('sec-email').textContent = state.user.email || '—';
    document.getElementById('sec-telegram').textContent = state.user.telegramChatId || 'Not configured';

    const is2FAOn = state.user.telegram2FAEnabled;
    const statusEl = document.getElementById('sec-2fa-status');
    const toggleBtn = document.getElementById('btn-toggle-2fa');

    if (statusEl) {
      statusEl.textContent = is2FAOn ? 'Enabled' : 'Disabled';
      statusEl.className = `badge ${is2FAOn ? 'badge-success' : 'badge-secondary'}`;
    }
    if (toggleBtn) {
      toggleBtn.textContent = is2FAOn ? 'Disable 2FA' : 'Enable 2FA';
    }
  } catch (err) {
    console.error('Failed to load profile:', err);
  }
}
```

### 2FA Toggle

```javascript
async function toggle2FA() {
  const is2FAOn = state.user?.telegram2FAEnabled;
  const action = is2FAOn ? 'disable' : 'enable';
  
  if (!confirm(`Are you sure you want to ${action} Telegram 2FA?`)) return;

  try {
    await api('/api/auth/2fa/toggle', { method: 'PATCH' });
    showToast(`2FA ${action}d successfully`, 'success');
    await loadSecurityProfile();
  } catch (err) {
    showToast('Failed to toggle 2FA: ' + err.message, 'error');
  }
}
```

> **Note:** The `PATCH /api/auth/2fa/toggle` endpoint toggles the current 2FA state server-side. If the endpoint name differs, update accordingly.

---

## Calling `loadSecurityProfile()` on Tab Switch

```javascript
function switchTab(tab) {
  state.currentTab = tab;
  // ... (existing tab show/hide logic) ...

  if (tab === 'security') {
    loadSecurityProfile();
  }
}
```

---

## Modal System (Shared Helpers)

```javascript
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.showModal();
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.close();
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
  if (e.target.tagName === 'DIALOG') {
    e.target.close();
  }
});
```

---

## CSS for Security Tab

```css
.security-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 20px;
  padding: 20px 0;
}

.security-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: var(--radius);
  padding: 24px;
  backdrop-filter: blur(8px);
}

.security-card h2 {
  font-size: 1.1rem;
  font-weight: 700;
  margin-bottom: 16px;
  color: var(--text);
}

.security-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--card-border);
  font-size: 0.9rem;
}

.security-row span:first-child {
  color: var(--text-muted);
}

.security-note {
  color: var(--text-muted);
  font-size: 0.85rem;
  line-height: 1.5;
  margin: 12px 0;
}
```
