# Phase 1 Quick Reference & Execution Checklist

Print this page and check off each item as you complete it.

---

## Phase 1: Server Setup & Data Migration — Quick Checklist

**Start Date:** __________ | **Completion Date:** __________ | **Status:** ACTIVE

---

### 📋 STEP 1: System Prerequisites & Dependencies (10 min)

- [ ] System OS is Ubuntu 20.04+ or Debian 11+
- [ ] Have SSH access and `sudo` capability
- [ ] Run: `sudo apt update && sudo apt upgrade -y`
- [ ] Run: `sudo apt install -y docker.io docker-compose-plugin nodejs npm git`
- [ ] Verify: `docker --version` (shows version)
- [ ] Verify: `node --version` (shows v18+)
- [ ] Verify: `npm --version` (shows version)
- [ ] Verify: `git --version` (shows version)
- [ ] Run: `sudo usermod -aG docker $USER && newgrp docker`
- [ ] Verify: `docker ps` (no permission denied)
- **Status:** ✅ PASSED / ❌ FAILED

---

### 📁 STEP 2: Directory Structure Setup (5 min)

- [ ] Run: `cd ~ && mkdir -p cosplay-cms/{data/{db,uploads},imports,prisma,scripts}`
- [ ] Run: `chmod -R 775 ~/cosplay-cms/data`
- [ ] Run: `chmod -R 775 ~/cosplay-cms/imports`
- [ ] Verify: `ls -la ~/cosplay-cms/` (shows subdirectories)
- [ ] Copy Excel file: `cp /path/to/file.xlsx ~/cosplay-cms/imports/`
- [ ] Verify: `ls -l ~/cosplay-cms/imports/` (shows Excel file)
- **Status:** ✅ PASSED / ❌ FAILED

---

### ⚙️ STEP 3: Environment Configuration (.env) (10 min)

- [ ] Run: `cd ~/cosplay-cms && touch .env`
- [ ] Generate secret 1: `openssl rand -hex 32` → save as `API_KEY` value
- [ ] Generate secret 2: `openssl rand -hex 32` → save as `SESSION_SECRET` value
- [ ] Generate secret 3: `openssl rand -hex 32` → save as `JWT_SECRET` value
- [ ] Obtain Telegram Bot Token from [@BotFather](https://t.me/botfather)
- [ ] Obtain Telegram Chat ID (send msg to bot and parse response)
- [ ] Edit `.env` with all values using: `nano .env`
- [ ] Run: `chmod 600 .env`
- [ ] Verify: `ls -l .env` (shows `-rw-------`)
- **Status:** ✅ PASSED / ❌ FAILED

---

### 🗄️ STEP 4: Database Schema (Prisma) (15 min)

- [ ] Run: `cd ~/cosplay-cms && npm install -D prisma @prisma/client`
- [ ] Run: `npx prisma init`
- [ ] Create/edit: `nano prisma/schema.prisma`
- [ ] Paste: Complete schema from Step 4 guide (includes User, Costume, Prop, ContactLens models)
- [ ] Save file: `Ctrl+O, Enter, Ctrl+X` (if using nano)
- [ ] Run: `npx prisma generate`
- [ ] Run: `npx prisma db push`
- [ ] Verify: `ls -lh data/db/cms.db` (shows file > 0 bytes)
- [ ] Optional: `npx prisma studio` and verify schema in web UI
- **Status:** ✅ PASSED / ❌ FAILED

---

### 📊 STEP 5: Excel Import Script & Migration (10 min)

- [ ] Run: `npm install xlsx`
- [ ] Create: `nano scripts/import_excel.js`
- [ ] Paste: Complete import script from Step 5 guide
- [ ] Save file: `Ctrl+O, Enter, Ctrl+X`
- [ ] Verify Excel file location: `ls ~/cosplay-cms/imports/Costume*`
- [ ] Run import: `node scripts/import_excel.js`
- [ ] Check output: Shows "✅ IMPORT COMPLETE" message
- [ ] Note: Number of imported costumes: ________
- [ ] Verify: `sqlite3 data/db/cms.db "SELECT COUNT(*) FROM \"Costume\";"` matches import count
- **Status:** ✅ PASSED / ❌ FAILED

---

### ✅ STEP 6: Verification & Testing (15 min)

#### 6A: System Health
- [ ] Run: `node --version && docker --version && git --version`
- [ ] All commands return version info (no errors)

#### 6B: Directory Validation
- [ ] Run: `tree ~/cosplay-cms -L 2` or `find ~/cosplay-cms -type d -maxdepth 2`
- [ ] Output shows all 5 subdirectories (data, imports, prisma, scripts, node_modules)

#### 6C: Database Integrity
- [ ] Run: `sqlite3 data/db/cms.db ".tables"`
- [ ] Output includes: `ContactLens  Costume  Prop  User`
- [ ] Run: `sqlite3 data/db/cms.db "SELECT COUNT(*) FROM \"Costume\";"`
- [ ] Output shows costumeCount > 0

#### 6D: Prisma Connection Test
- [ ] Create: `nano test_prisma.js` (paste code from Step 6 guide)
- [ ] Run: `node test_prisma.js`
- [ ] Output shows: "✅ All Prisma tests passed!"
- [ ] Cleanup: `rm test_prisma.js`

#### 6E: Data Review
- [ ] Create: `nano review_data.js` (paste code from Step 6 guide)
- [ ] Run: `node review_data.js`
- [ ] Output shows 5 sample costumes with character names
- [ ] Cleanup: `rm review_data.js`

#### 6F: Security Check
- [ ] Run: `ls -l .env`
- [ ] Verify: Shows `-rw-------` (600 permissions)
- [ ] Run: `ls -lh data/db/cms.db`
- [ ] Verify: Readable and writable

#### 6G: Final Summary Check
- [ ] Run: `./phase1_verify.sh` (if created)
- [ ] Output shows: "✅ Phase 1 Setup Complete!"
- [ ] Verification Score: _____ / 8 checks passed

- **Status:** ✅ ALL TESTS PASSED / ❌ SOME TESTS FAILED

---

## 📊 Phase 1 Summary

### Files Created
- ✅ `.env` — Configuration file
- ✅ `prisma/schema.prisma` — Database schema
- ✅ `data/db/cms.db` — SQLite database
- ✅ `scripts/import_excel.js` — Import script
- ✅ `package.json` — Node.js dependencies
- ✅ `package-lock.json` — Locked dependency versions

### Directory Structure Verified
```
✅ ~/cosplay-cms/
   ✅ data/db/
   ✅ data/uploads/
   ✅ imports/
   ✅ prisma/
   ✅ scripts/
   ✅ node_modules/
```

### Database Tables Created
- ✅ `User` (0 records, will be populated in Phase 3)
- ✅ `Costume` (populated from Excel)
- ✅ `Prop` (0 records initially)
- ✅ `ContactLens` (0 records initially)

### Records Imported
- **Total Costumes:** ________
- **Total Props:** 0 (will add via API in Phase 2)
- **Total Contact Lenses:** 0 (will add via API in Phase 2)

---

## ⏱️ Time Log

| Step | Estimated | Actual | Notes |
|------|-----------|--------|-------|
| 1. Prerequisites | 10 min | __ min | |
| 2. Directory Setup | 5 min | __ min | |
| 3. Environment Config | 10 min | __ min | |
| 4. Database Schema | 15 min | __ min | |
| 5. Import Script | 10 min | __ min | |
| 6. Verification | 15 min | __ min | |
| **TOTAL** | **65 min** | **___ min** | |

---

## 🆘 Quick Troubleshooting

| Problem | Quick Fix | Docs |
|---------|-----------|------|
| `command not found: docker` | Run `exec bash` to reload shell | Step 1 |
| `mkdir: permission denied` | Use `sudo mkdir` or check home dir permissions | Step 2 |
| `.env: permission denied` | Run `chmod 600 .env` | Step 3 |
| `Cannot find module '@prisma/client'` | Run `npm install @prisma/client` | Step 4 |
| Database file not created | Run `npx prisma db push` | Step 4 |
| `Cannot find file Costume Inventory` | Check correct filename in imports/ | Step 5 |
| Import returns 0 records | Verify Excel column headers match script | Step 5 |
| Verification test fails | Check database permissions: `chmod -R 775 data/` | Step 6 |

---

## ✨ Phase 1: COMPLETE!

Once all checkboxes above are checked ✅:

1. **Backup your `.env` file:**
   ```bash
   cp .env .env.backup
   chmod 600 .env.backup
   ```

2. **Note your database location:**
   - Database file: `~/cosplay-cms/data/db/cms.db`
   - Backups directory: `~/cosplay-cms/data/db/` (create backup cron in Phase 6)

3. **Prepare for Phase 2:**
   - Phase 2 will build the Express.js REST API
   - Estimated duration: 2-3 hours
   - Start when ready: See **Phase 2: Core REST API & Image Engine**

---

## 📞 Support Resources

- **Prisma Docs:** https://www.prisma.io/docs/
- **SQLite Docs:** https://www.sqlite.org/docs.html
- **Node.js Docs:** https://nodejs.org/en/docs/
- **Docker Docs:** https://docs.docker.com/

---

**Phase 1 Status:** ☐ NOT STARTED | ☐ IN PROGRESS | ☑️ COMPLETE

**Signed Off By:** __________________ | **Date:** __________

---

*Last Updated: September 27, 2026*
*Phase 1 Version: 1.0*
