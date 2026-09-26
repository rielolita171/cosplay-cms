# Phase 4: Step 2 — n8n Workflow Configuration & Import

## Objective
Import and configure the automated workflow in your self-hosted n8n instance to deliver daily inventory warnings to Telegram.

---

## 2.1 Importing the Workflow Template

1. Open your n8n web dashboard (typically at `http://<server-ip>:5678`).
2. Navigate to **Workflows** → Click the **Add Workflow** button.
3. Click the **three dots menu (⋮)** in the top right → Select **Import from File**.
4. Upload `workflows/n8n_contact_lens_expiry_alert.json` (located in your `cosplay-cms/` folder).

---

## 2.2 Configuring Nodes

### 1. HTTP Request Node
- Double-click the **Query Expiring Lenses** node.
- Ensure the URL points to your running Cosplay CMS instance:
  ```text
  http://localhost:4001/api/notifications/contact-lenses/expiring?days=14
  ```
  *(If n8n is running in Docker, use the Docker container name or host IP: `http://cosplay_cms:4001/...`)*
- Under **Header Parameters**, set the value of `X-CMS-API-KEY` to your key from `.env`.

### 2. Telegram Node
- Double-click the **Send Telegram Alert** node.
- Select your Telegram Bot Credential.
- Set the **Chat ID** to your personal Telegram Chat ID (configured in Phase 3).

---

## 2.3 Testing & Activating

1. Click **Test Step** or **Execute Workflow** in n8n.
2. If any contact lenses in your database are expiring within 14 days, you will receive an instant notification on Telegram.
3. Toggle the workflow status to **Active** (green switch in top right) so it runs automatically every morning at 08:00 AM.

---

## Next Step
Proceed to [Step 3: Testing & Verification](03-testing-verification.md).
