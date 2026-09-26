# Phase 1: Step 3 — Environment Configuration (.env file)

## Objective
Create the `.env` configuration file that will store sensitive credentials and environment variables for the CMS application.

---

## Step 3.1: Create .env File

Navigate to your project root and create a `.env` file:

```bash
cd ~/cosplay-cms
touch .env
```

---

## Step 3.2: Populate .env with Configuration Variables

Open the file in your preferred editor (nano, vim, or VS Code):

```bash
nano .env
```

Paste the following configuration:

```env
# Database Configuration
DATABASE_URL="file:/data/db/cms.db"

# Server Configuration
NODE_ENV="development"
PORT=3000

# API Security
API_KEY="cms_dev_secret_key_change_in_production"

# Telegram Configuration
TELEGRAM_BOT_TOKEN="your_telegram_bot_token_here"
TELEGRAM_CHAT_ID="your_telegram_chat_id_here"

# Session & Auth
SESSION_SECRET="session_secret_change_this_to_random_string"
JWT_SECRET="jwt_secret_change_this_to_random_string"

# File Upload Paths
UPLOAD_DIR="/data/uploads"
IMPORT_DIR="/app/imports"
```

---

## Step 3.3: Secure Sensitive Values

Replace placeholder values with actual secrets:

| Variable | How to Obtain |
|----------|---------------|
| `TELEGRAM_BOT_TOKEN` | Create via [@BotFather](https://t.me/botfather) on Telegram |
| `TELEGRAM_CHAT_ID` | Send a message to your bot and retrieve ID via `/getMe` |
| `API_KEY` | Generate with: `openssl rand -hex 32` |
| `SESSION_SECRET` | Generate with: `openssl rand -hex 32` |
| `JWT_SECRET` | Generate with: `openssl rand -hex 32` |

### Generate Secure Secrets:
```bash
# Generate three secure random strings
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Copy the output and paste into corresponding `.env` variables.

---

## Step 3.4: Set File Permissions

Protect the `.env` file to prevent unauthorized access:

```bash
chmod 600 .env
```

Verify permissions:
```bash
ls -la ~/cosplay-cms/.env
```

Should show: `-rw------- 1 user user`

---

## Step 3.5: Verify Configuration

Test that Node.js can read the `.env` file:

```bash
cd ~/cosplay-cms
node -e "require('dotenv').config(); console.log('DATABASE_URL:', process.env.DATABASE_URL); console.log('PORT:', process.env.PORT);"
```

If you get an error about `dotenv`, that's OK—we'll install dependencies in the next phase.

---

## Environment Variable Reference

| Variable | Purpose | Example |
|----------|---------|---------|
| `DATABASE_URL` | SQLite connection string | `file:/data/db/cms.db` |
| `NODE_ENV` | Environment (development/production) | `production` |
| `PORT` | Server port | `3000` |
| `API_KEY` | Authentication header value | `cms_xyz123...` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot credentials | `123456:ABC-DEF...` |

---

## Troubleshooting

**Problem:** `.env` file shows permission denied
- **Solution:** Run `chmod 600 .env` to fix permissions.

**Problem:** Cannot read .env values
- **Solution:** Ensure the file exists in the correct directory: `ls -l ~/cosplay-cms/.env`

---

## Next Step
Once `.env` is configured and secured, proceed to **Step 4: Database Schema (Prisma)**.
