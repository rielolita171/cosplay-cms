# Phase 1 Architecture & Workflow Diagram

## Phase 1: Complete System Architecture

```
    ┌─────────────────────────────────────────────────────────┐
    │              YOUR HOME SERVER (Ubuntu/Debian)           │
    │                                                          │
    │  ┌──────────────────────────────────────────────────┐  │
    │  │           Docker Environment                     │  │
    │  │  (Prepared for Phase 2 containerization)         │  │
    │  └──────────────────────────────────────────────────┘  │
    │                      │                                  │
    │  ┌──────────────────▼─────────────────────────────┐    │
    │  │       ~/cosplay-cms/ Directory                 │    │
    │  │                                                │    │
    │  │  ┌─────────────────────────────────────────┐  │    │
    │  │  │  Configuration & Secrets                │  │    │
    │  │  │  ├─ .env (encrypted secrets)            │  │    │
    │  │  │  ├─ prisma/schema.prisma (ORM config)   │  │    │
    │  │  │  └─ package.json (dependencies)         │  │    │
    │  │  └─────────────────────────────────────────┘  │    │
    │  │                                                │    │
    │  │  ┌─────────────────────────────────────────┐  │    │
    │  │  │  Data Storage                           │  │    │
    │  │  │  ├─ data/db/cms.db (SQLite database)   │  │    │
    │  │  │  ├─ data/uploads/ (optimized images)   │  │    │
    │  │  │  └─ imports/ (Excel source file)       │  │    │
    │  │  └─────────────────────────────────────────┘  │    │
    │  │                                                │    │
    │  │  ┌─────────────────────────────────────────┐  │    │
    │  │  │  Tools & Scripts                        │  │    │
    │  │  │  ├─ scripts/import_excel.js (migrator) │  │    │
    │  │  │  ├─ node_modules/ (Prisma, xlsx)       │  │    │
    │  │  │  └─ prisma/client (ORM runtime)        │  │    │
    │  │  └─────────────────────────────────────────┘  │    │
    │  └──────────────────────────────────────────────┘    │
    │                                                          │
    └─────────────────────────────────────────────────────────┘
```

---

## Phase 1 Data Flow: Excel → SQLite

```
    .xlsx File (Your Inventory)
         │
         ▼
    ┌──────────────────────────┐
    │ import_excel.js Script   │
    │                          │
    │ 1. Reads Excel file      │
    │ 2. Maps columns          │
    │ 3. Validates data        │
    │ 4. Transforms records    │
    └─────────┬────────────────┘
              │
              ▼
    ┌──────────────────────────┐
    │   Prisma Client ORM      │
    │                          │
    │ - Validates schema       │
    │ - Type checks            │
    │ - Creates abstractions   │
    └─────────┬────────────────┘
              │
              ▼
    ┌──────────────────────────┐
    │   SQLite Database        │
    │   (cms.db)               │
    │                          │
    │ Tables Created:          │
    │ ├─ Costume               │
    │ ├─ Prop                  │
    │ ├─ ContactLens           │
    │ └─ User                  │
    │                          │
    │ Data Populated:          │
    │ └─ Costumes (from Excel) │
    └──────────────────────────┘
```

---

## Phase 1 Step Sequence

```
┌─────────────────────────────────────────┐
│ STEP 1: Install System Dependencies     │ ~10 min
│                                         │
│ ✓ Docker & Docker Compose              │
│ ✓ Node.js 18+ & npm                    │
│ ✓ Git                                  │
│ ✓ User permissions for Docker          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ STEP 2: Create Directory Structure      │ ~5 min
│                                         │
│ ✓ ~/cosplay-cms/                        │
│ ✓ data/db/ (database storage)           │
│ ✓ data/uploads/ (image storage)         │
│ ✓ imports/ (Excel source)               │
│ ✓ prisma/ (schema location)             │
│ ✓ scripts/ (migration scripts)          │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ STEP 3: Environment Configuration       │ ~10 min
│                                         │
│ ✓ Create .env file                     │
│ ✓ Generate secure secrets (API key)    │
│ ✓ Add Telegram credentials              │
│ ✓ Secure file permissions (600)         │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ STEP 4: Initialize Database (Prisma)   │ ~15 min
│                                         │
│ ✓ Install Prisma & @prisma/client      │
│ ✓ Create schema.prisma                 │
│ ✓ Generate Prisma client               │
│ ✓ Push schema to SQLite (db push)       │
│ ✓ Verify 4 tables created              │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ STEP 5: Run Excel Data Migration        │ ~10 min
│                                         │
│ ✓ Create import_excel.js script         │
│ ✓ Install xlsx library                 │
│ ✓ Execute import script                │
│ ✓ Verify X costumes imported           │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ STEP 6: Comprehensive Verification      │ ~15 min
│                                         │
│ ✓ System dependencies check             │
│ ✓ Directory structure validation        │
│ ✓ Database connectivity test            │
│ ✓ Prisma client functionality test      │
│ ✓ Data sample verification              │
│ ✓ Security permissions audit            │
│ ✓ All 8 tests PASS                      │
└─────────────┬──────────────────────────┘
              │
              ▼
    ✅ PHASE 1 COMPLETE!
       (Estimated: ~65 minutes)
```

---

## Database Schema Relationships

```
┌──────────────┐
│    User      │
├──────────────┤
│ id (PK)      │
│ username     │
│ email        │
│ telegramId   │
│ twoFAEnabled │
│ recoveryCode │
└──────┬───────┘
       │
       │ (1:N) May own multiple costumes in future
       │
       ▼
┌──────────────────────────┐          ┌──────────────┐
│      Costume             │          │     Prop     │
├──────────────────────────┤          ├──────────────┤
│ id (PK)                  │◄─────────│ costumeId    │
│ fandom                   │  (1:N)   │ id (PK)      │
│ character                │          │ name         │
│ brand                    │          │ category     │
│ size                     │          │ location     │
│ status                   │          │ condition    │
│ buyPrice                 │          │ notes        │
│ sellPrice                │          │ imageUrls    │
│ isFullset                │          └──────────────┘
│ doneCostest              │
│ doneEvent                │
│ donePhotoSession         │
│ imageUrls                │
│ notes                    │
│ referenceUrl             │
└──────────────────────────┘

(Independent)
┌──────────────────┐
│   ContactLens    │
├──────────────────┤
│ id (PK)          │
│ character        │
│ color            │
│ brand            │
│ prescription     │
│ purchaseDate     │
│ openedDate       │
│ expiryDate       │
│ isOpened         │
│ status           │
│ notes            │
│ imageUrl         │
└──────────────────┘
```

---

## File Permissions & Security Model

```
Security Layer 1: Operating System
└─ Ubuntu/Debian file permissions
   ├─ ~/cosplay-cms/data/      (drwxrwxr-x 775) - R/W for owner & group
   ├─ ~/cosplay-cms/imports/   (drwxrwxr-x 775) - R/W for owner & group
   ├─ .env                      (-rw------- 600) - R/W ONLY for owner (SECRETS!)
   └─ prisma/schema.prisma      (-rw-r--r-- 644) - R/W for owner, R for others

Security Layer 2: Environment Variables
└─ .env file (not in version control)
   ├─ DATABASE_URL (SQLite path)
   ├─ API_KEY (server auth token)
   ├─ TELEGRAM_BOT_TOKEN (Telegram integration)
   ├─ SESSION_SECRET (session signing key)
   └─ JWT_SECRET (JSON Web Token signing)

Security Layer 3: Database
└─ SQLite File
   ├─ Single-file database (no separate server)
   ├─ Persistent at: ~/cosplay-cms/data/db/cms.db
   ├─ Can be encrypted in Phase 6
   └─ Daily backups via cron (Phase 6)

Security Layer 4: ORM (Prisma)
└─ Type-safe parameterized queries
   ├─ Prevents SQL injection
   ├─ Runtime type validation
   └─ Schema enforcement
```

---

## Phase 1 vs Phase 2 Preview

### Phase 1 (This Section) - ✅ SETUP
```
Focus: Infrastructure & Data Foundation

Creates:
✓ System environment
✓ Database schema
✓ SQLite instance
✓ Data import pipeline
✓ Configuration framework

No Running Server:
⊘ No API server yet
⊘ No frontend
⊘ No containerization
```

### Phase 2 (Next) - 🚀 API ENGINE
```
Focus: REST API & Image Processing

Adds:
✨ Express.js server
✨ REST endpoints (/api/costumes, etc.)
✨ Image optimization (Sharp/WebP)
✨ Authentication middleware
✨ Request/response handlers

Ready for Phase 3:
→ Authentication system
→ Telegram 2FA integration
```

---

## Environment Readiness Check

After Phase 1, your environment looks like:

```
✅ System Dependencies:
   ├─ Docker: READY (for Phase 6 containerization)
   ├─ Node.js v18+: READY (for Express server in Phase 2)
   ├─ npm packages: READY (Prisma, xlsx installed)
   └─ Git: READY (for version control)

✅ Configuration:
   ├─ .env file: READY (secrets configured)
   ├─ Prisma: READY (schema defined, client generated)
   └─ File permissions: READY (secure)

✅ Data:
   ├─ SQLite database: READY (initialized)
   ├─ Schema tables: READY (4 models defined)
   ├─ Costume data: READY (imported from Excel)
   └─ Persistent storage: READY (~/cosplay-cms/data/)

⊘ API Server: NOT STARTED (Phase 2)
⊘ Frontend: NOT STARTED (Phase 5)
⊘ Containerization: NOT STARTED (Phase 6)
⊘ Authentication: NOT STARTED (Phase 3)
⊘ Image Processing: NOT STARTED (Phase 2)
```

---

## Summary Statistics

| Category | Count | Status |
|----------|-------|--------|
| **System Dependencies Installed** | 5 | ✅ |
| **Directories Created** | 6 | ✅ |
| **Configuration Files** | 2 (.env, schema.prisma) | ✅ |
| **Database Tables** | 4 | ✅ |
| **NPM Packages** | 3+ (prisma, xlsx, etc.) | ✅ |
| **Data Records (Costumes)** | N (from your Excel) | ✅ |
| **Estimated Time** | 65 minutes | - |
| **Next Phase** | Phase 2: REST API | → |

---

## Visual Timeline

```
Day 1: Phase 1 Setup
═══════════════════════════════════════════════════════════

Time 0:00 ─┐
           │  STEP 1: Install deps
           │  ├─ apt install
           │  ├─ docker install
           │  └─ npm install
Time 0:10 ─┤
           │  STEP 2: Directories
           │  └─ mkdir all paths
Time 0:15 ─┤
           │  STEP 3: .env config
           │  ├─ openssl secrets
           │  └─ telegram setup
Time 0:25 ─┤
           │  STEP 4: Prisma schema
           │  ├─ npm install prisma
           │  ├─ create schema
           │  └─ npx prisma db push
Time 0:40 ─┤
           │  STEP 5: Excel import
           │  ├─ create script
           │  └─ node import_excel.js
Time 0:50 ─┤
           │  STEP 6: Verification
           │  ├─ 8 tests running
           │  └─ all pass ✅
Time 1:05 ─┘
           
           ✅ PHASE 1 COMPLETE
```

---

## Next Steps After Phase 1 ✅

1. **Celebrate!** 🎉 You have a working database system.

2. **Backup your work:**
   ```bash
   tar -czf ~/cosplay-cms-phase1-backup.tar.gz ~/cosplay-cms/
   ```

3. **Review Phase 2 requirements:**
   - Express.js knowledge helpful
   - Image processing library (Sharp)
   - REST API patterns

4. **Set aside 2-3 hours for Phase 2:**
   - When ready: Read Phase 2 guide
   - Build REST API endpoints
   - Implement image optimization pipeline

5. **Keep your .env file secure:**
   - Don't commit to git
   - Don't share credentials
   - Use .gitignore: `echo ".env" >> .gitignore`

---

*Phase 1 Architecture Guide*  
*Last Updated: September 27, 2026*  
*Version: 1.0*
