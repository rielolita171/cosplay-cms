# Phase 1: Server Setup & Data Migration — Complete Guide

## Overview

Phase 1 prepares your home server with all necessary infrastructure, configuration, and data to run the Cosplay Management System (CMS). This includes installing system dependencies, creating the database schema, configuring environment variables, and importing your existing costume inventory from Excel.

---

## Learning Path: 6 Sequential Steps

### 1. **Step 1: System Prerequisites & Dependencies**
   - **Duration:** ~10 minutes
   - **What You'll Do:**
     - Install Docker, Docker Compose, Node.js 18+, npm, and Git
     - Verify all tools are installed correctly
     - Enable Docker for non-sudo access
   - **Files Created:** None
   - **Next:** [→ Step 2](02-directory-setup.md)
   - [**Read Full Guide →**](01-prerequisites.md)

---

### 2. **Step 2: Directory Structure Setup**
   - **Duration:** ~5 minutes
   - **What You'll Do:**
     - Create persistent data directories (`~/cosplay-cms/data/db`, `/uploads`, `/imports`)
     - Set proper file permissions (775)
     - Copy your Excel inventory file to the imports folder
   - **Files Created:** Directory structure
   - **Next:** [→ Step 3](03-environment-config.md)
   - [**Read Full Guide →**](02-directory-setup.md)

---

### 3. **Step 3: Environment Configuration (.env)**
   - **Duration:** ~10 minutes
   - **What You'll Do:**
     - Create a `.env` file with all configuration variables
     - Generate secure API keys and secrets using OpenSSL
     - Set up Telegram integration credentials
     - Protect `.env` with proper file permissions
   - **Files Created:** `.env`
   - **Next:** [→ Step 4](04-database-schema.md)
   - [**Read Full Guide →**](03-environment-config.md)

---

### 4. **Step 4: Database Schema (Prisma)**
   - **Duration:** ~15 minutes
   - **What You'll Do:**
     - Install Prisma ORM and client
     - Create complete SQLite schema with 4 main models (User, Costume, Prop, ContactLens)
     - Initialize the database file
     - Optionally view schema in Prisma Studio
   - **Files Created:** 
     - `prisma/schema.prisma`
     - `data/db/cms.db` (SQLite database)
   - **Next:** [→ Step 5](05-import-script.md)
   - [**Read Full Guide →**](04-database-schema.md)

---

### 5. **Step 5: Excel Import Script & Migration**
   - **Duration:** ~10 minutes
   - **What You'll Do:**
     - Create a Node.js script to parse your Excel file
     - Intelligently map Excel columns to database fields
     - Import all costume records from your spreadsheet
     - Verify import success with data samples
   - **Files Created:** `scripts/import_excel.js`
   - **Next:** [→ Step 6](06-verification.md)
   - [**Read Full Guide →**](05-import-script.md)

---

### 6. **Step 6: Verification & Testing**
   - **Duration:** ~15 minutes
   - **What You'll Do:**
     - Run 8 comprehensive verification checks
     - Validate system health and dependencies
     - Test database connectivity with Prisma
     - Review imported data samples
     - Ensure security permissions are correct
   - **Files Used:** All created files tested
   - **Next:** Phase 2 — Core REST API & Image Engine
   - [**Read Full Guide →**](06-verification.md)

---

## Quick Command Reference

### Run All Steps (Copy & Paste)

```bash
# Step 1: Install dependencies
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose-plugin nodejs npm git
sudo usermod -aG docker $USER
newgrp docker

# Step 2: Create directories
cd ~
mkdir -p cosplay-cms/{data/{db,uploads},imports,prisma,scripts}
chmod -R 775 ~/cosplay-cms/data

# Step 3: Create .env
cd ~/cosplay-cms
cat > .env << 'EOF'
DATABASE_URL="file:/data/db/cms.db"
NODE_ENV="development"
PORT=3000
API_KEY="$(openssl rand -hex 32)"
TELEGRAM_BOT_TOKEN="your_telegram_bot_token_here"
SESSION_SECRET="$(openssl rand -hex 32)"
JWT_SECRET="$(openssl rand -hex 32)"
UPLOAD_DIR="/data/uploads"
IMPORT_DIR="/app/imports"
EOF
chmod 600 .env

# Step 4: Initialize project & database
npm init -y
npm install -D prisma @prisma/client
npx prisma init
# ... then add schema.prisma content ...
npx prisma db push

# Step 5: Create import script & run
# ... copy import_excel.js from guide ...
npm install xlsx
node scripts/import_excel.js

# Step 6: Verify all systems
node -e "..."  # Run verification tests
```

---

## Summary Table: What Gets Created

| Item | Type | Location | Purpose |
|------|------|----------|---------|
| **Directory Structure** | Folders | `~/cosplay-cms/` | Persistent data storage |
| **Environment Config** | File | `.env` | Configuration variables |
| **Database Schema** | File | `prisma/schema.prisma` | Data model definition |
| **SQLite Database** | File | `data/db/cms.db` | Actual data storage |
| **Import Script** | Script | `scripts/import_excel.js` | Excel → SQLite migration |
| **Node Modules** | Dependencies | `node_modules/` | Prisma, xlsx, etc. |

---

## Phase 1 Data Models

### User
```
├── Authentication (username, email, OAuth)
├── Telegram 2FA (telegramChatId, 2FA toggle)
└── Security (recovery codes, session tokens)
```

### Costume (Main Model)
```
├── Identity (fandom, character, brand, size)
├── Status (IN_POSSESSION, ON_RENT, TO_BE_SOLD, WISHLIST)
├── Pricing (buyPrice, sellPrice, sellPriceMutual)
├── Completion Tracking (isFullset, doneCostest, doneEvent, donePhotoSession)
├── Media (imageUrls)
└── Relations (linked Props)
```

### Prop (Accessory Model)
```
├── Identity (name, category, location, condition)
├── Media (imageUrls)
└── Relations (linked to Costume)
```

### ContactLens (Inventory Model)
```
├── Identity (character, color, brand, prescription)
├── Timeline (purchaseDate, openedDate, expiryDate)
├── Status (UNOPENED, ACTIVE, EXPIRING_SOON, EXPIRED, DISPOSED)
└── Media (imageUrl)
```

---

## System Architecture After Phase 1

```
                    Your Home Server
                         │
                    ┌────────────────┐
                    │  Docker Host   │
                    └────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
    ┌───▼────┐   ┌──────▼─────┐   ┌──────▼──────┐
    │  Data  │   │  Prisma    │   │   Node.js   │
    │ Store  │   │   ORM      │   │  (upcoming) │
    └────────┘   └────────────┘   └─────────────┘
        │                │
    ┌───▼────────────────▼────┐
    │   SQLite Database       │
    │  (cms.db)              │
    │  - Costumes            │
    │  - Props               │
    │  - Contact Lenses      │
    │  - Users               │
    └────────────────────────┘
```

---

## Estimated Time for Phase 1

| Step | Duration | Total |
|------|----------|-------|
| 1. Prerequisites | 10 min | 10 min |
| 2. Directory Setup | 5 min | 15 min |
| 3. Environment Config | 10 min | 25 min |
| 4. Database Schema | 15 min | 40 min |
| 5. Excel Import | 10 min | 50 min |
| 6. Verification | 15 min | **65 min (~1 hour)** |

---

## Phase 1 Success Criteria

✅ Phase 1 is complete when:

1. All system dependencies are installed and verified
2. Directory structure exists with proper permissions
3. `.env` file is created and secured
4. SQLite database is initialized and online
5. Prisma schema is applied to the database
6. Excel data is successfully imported (at least 1 costume visible in database)
7. All 8 verification tests pass
8. You can view imported data using Prisma Studio or CLI queries

---

## Troubleshooting Quick Links

- **Installation issues:** See [Step 1 Troubleshooting](01-prerequisites.md#troubleshooting)
- **Directory/permission errors:** See [Step 2 Troubleshooting](02-directory-setup.md#troubleshooting)
- **Environment config issues:** See [Step 3 Troubleshooting](03-environment-config.md#troubleshooting)
- **Database problems:** See [Step 4 Troubleshooting](04-database-schema.md#troubleshooting)
- **Import failures:** See [Step 5 Troubleshooting](05-import-script.md#troubleshooting)
- **Verification failures:** See [Step 6 Verification Summary](06-verification.md#troubleshooting-summary)

---

## Next: Phase 2 Preview

Once Phase 1 is verified complete, you'll move to:

### **Phase 2: Core REST API & Image Engine**

What you'll build:
- ✨ Express.js REST API server
- 🖼️ Image upload & automatic compression (WebP, 1200px max)
- 📋 Endpoints for costumes, props, and contact lenses
- 🔍 Advanced filtering and search capabilities
- 🔐 Authentication middleware

**Est. Time:** 2-3 hours

---

## Document Map

```
📁 phase-1-setup/
├── 📄 README.md (this file)
├── 📄 01-prerequisites.md
├── 📄 02-directory-setup.md
├── 📄 03-environment-config.md
├── 📄 04-database-schema.md
├── 📄 05-import-script.md
└── 📄 06-verification.md
```

---

## Questions or Issues?

- **Stuck on a step?** Review the detailed guide for that step
- **Command failing?** Check the Troubleshooting section at the bottom of each guide
- **Need details?** Each guide includes examples, expected outputs, and reference tables

---

## Getting Started

[→ **Start with Step 1: System Prerequisites**](01-prerequisites.md)

Good luck! 🎉
