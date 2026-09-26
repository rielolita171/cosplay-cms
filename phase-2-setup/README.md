# Phase 2: Core REST API & Image Engine — Complete Guide

## Overview

Phase 2 builds the REST API server that handles all CMS operations. It includes Express.js setup, RESTful endpoints for managing costumes, props, and contact lenses, automatic image optimization with Sharp, and authentication middleware.

---

## Learning Path: 6 Sequential Steps

### 1. **Step 1: Express Server Setup**
   - **Duration:** ~10 minutes
   - **What You'll Do:**
     - Install Express.js and required dependencies
     - Create main server file
     - Configure environment-based server startup
     - Set up basic middleware (CORS, body parser, logging)
   - **Files Created:** `server.js`, `package.json` updated
   - **Next:** [→ Step 2](02-api-endpoints.md)
   - [**Read Full Guide →**](01-express-setup.md)

---

### 2. **Step 2: REST API Endpoints (Costumes)**
   - **Duration:** ~20 minutes
   - **What You'll Do:**
     - Create GET /api/costumes endpoint
     - Create POST /api/costumes endpoint
     - Create GET /api/costumes/:id endpoint
     - Create PUT /api/costumes/:id endpoint
     - Create DELETE /api/costumes/:id endpoint
     - Implement query filtering (status, fandom, brand)
   - **Files Created:** `routes/costumes.js`
   - **Next:** [→ Step 3](03-props-lenses.md)
   - [**Read Full Guide →**](02-api-endpoints.md)

---

### 3. **Step 3: Props & Contact Lenses Endpoints**
   - **Duration:** ~15 minutes
   - **What You'll Do:**
     - Create CRUD endpoints for Props
     - Create CRUD endpoints for Contact Lenses
     - Implement expiry calculations for lenses
     - Add filtering by costume, category, or location
     - Format lens status with day calculations
   - **Files Created:** `routes/props.js`, `routes/lenses.js`
   - **Next:** [→ Step 4](04-image-optimization.md)
   - [**Read Full Guide →**](03-props-lenses.md)

---

### 4. **Step 4: Image Optimization with Sharp**
   - **Duration:** ~15 minutes
   - **What You'll Do:**
     - Install Sharp image processor
     - Create image upload endpoint
     - Implement auto-resize (1200px max)
     - Convert images to WebP format
     - Store optimized images in /data/uploads
     - Return optimized image URLs
   - **Files Created:** `routes/uploads.js`, `middleware/imageProcessor.js`
   - **Next:** [→ Step 5](05-authentication.md)
   - [**Read Full Guide →**](04-image-optimization.md)

---

### 5. **Step 5: Authentication & Authorization Middleware**
   - **Duration:** ~15 minutes
   - **What You'll Do:**
     - Create API key validation middleware
     - Implement request logging middleware
     - Add error handling middleware
     - Create authentication routes
     - Set up session management (basic)
   - **Files Created:** `middleware/auth.js`, `middleware/errorHandler.js`
   - **Next:** [→ Step 6](06-testing.md)
   - [**Read Full Guide →**](05-authentication.md)

---

### 6. **Step 6: Testing & Server Verification**
   - **Duration:** ~15 minutes
   - **What You'll Do:**
     - Test all REST endpoints with curl
     - Verify image optimization pipeline
     - Check database persistence
     - Load test with sample requests
     - Review logs and error handling
   - **Files Used:** All created files tested
   - **Next:** Phase 3 — Auth Engine & Telegram 2FA
   - [**Read Full Guide →**](06-testing.md)

---

## Quick Command Reference

### Run All Steps (Copy & Paste)

```bash
# Step 1: Install dependencies
cd ~/cosplay-cms
npm install express multer sharp dotenv cors morgan body-parser

# Step 2-5: Create server files (follow guides)
# ... create server.js and route files ...

# Step 6: Start server
npm start

# Test endpoints in another terminal
curl http://localhost:3000/api/costumes
```

---

## Phase 2 Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│         Express.js REST API Server                  │
│         (Port 3000)                                 │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  Middleware Stack                            │  │
│  │  ├─ CORS                                     │  │
│  │  ├─ Body Parser (JSON)                       │  │
│  │  ├─ Logging (Morgan)                         │  │
│  │  ├─ Authentication (API Key)                 │  │
│  │  └─ Error Handler                            │  │
│  └──────────────────────────────────────────────┘  │
│                      ↓                              │
│  ┌──────────────────────────────────────────────┐  │
│  │  Route Handlers                              │  │
│  │  ├─ GET /api/costumes                        │  │
│  │  ├─ POST /api/costumes (+ image upload)      │  │
│  │  ├─ PUT /api/costumes/:id                    │  │
│  │  ├─ DELETE /api/costumes/:id                 │  │
│  │  ├─ GET /api/props                           │  │
│  │  ├─ POST /api/props                          │  │
│  │  ├─ GET /api/lenses                          │  │
│  │  ├─ PATCH /api/lenses/:id/open               │  │
│  │  └─ POST /api/upload (standalone image)      │  │
│  └──────────────────────────────────────────────┘  │
│                      ↓                              │
│  ┌──────────────────────────────────────────────┐  │
│  │  Image Processor (Optional)                  │  │
│  │  ├─ Resize (1200x1200 max)                   │  │
│  │  ├─ Convert to WebP                          │  │
│  │  ├─ Compress (80% quality)                   │  │
│  │  └─ Store in /data/uploads/                  │  │
│  └──────────────────────────────────────────────┘  │
│                      ↓                              │
│  ┌──────────────────────────────────────────────┐  │
│  │  Database Layer (Prisma + SQLite)            │  │
│  │  ├─ Query Costume records                    │  │
│  │  ├─ Update inventory status                  │  │
│  │  ├─ Store image URLs                         │  │
│  │  └─ Log all operations                       │  │
│  └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────────────────┐
│         SQLite Database                             │
│  (~/cosplay-cms/data/db/cms.db)                     │
│                                                     │
│  Tables: User, Costume, Prop, ContactLens          │
└─────────────────────────────────────────────────────┘
```

---

## API Endpoints Reference

### Costumes
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/costumes` | List all costumes (with filters) |
| `GET` | `/api/costumes?fandom=Genshin` | Filter by fandom |
| `GET` | `/api/costumes?status=ON_RENT` | Filter by status |
| `GET` | `/api/costumes/:id` | Get single costume |
| `POST` | `/api/costumes` | Create new costume |
| `PUT` | `/api/costumes/:id` | Update costume |
| `DELETE` | `/api/costumes/:id` | Delete costume |

### Props & Accessories
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/props` | List all props |
| `GET` | `/api/props?costumeId=xyz` | Props for costume |
| `POST` | `/api/props` | Create prop |
| `PUT` | `/api/props/:id` | Update prop |
| `DELETE` | `/api/props/:id` | Delete prop |

### Contact Lenses
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/lenses` | List all lenses |
| `GET` | `/api/lenses?status=EXPIRING_SOON` | Filter expiring |
| `POST` | `/api/lenses` | Register lens |
| `PATCH` | `/api/lenses/:id/open` | Mark as opened |
| `DELETE` | `/api/lenses/:id` | Dispose lens |

### Image Upload
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/upload` | Upload & optimize image |
| `GET` | `/uploads/:filename` | Access optimized image |

---

## Estimated Time for Phase 2

| Step | Duration | Total |
|------|----------|-------|
| 1. Express Setup | 10 min | 10 min |
| 2. Costume Endpoints | 20 min | 30 min |
| 3. Props & Lenses | 15 min | 45 min |
| 4. Image Optimization | 15 min | 60 min |
| 5. Authentication | 15 min | 75 min |
| 6. Testing & Verification | 15 min | **90 min (~1.5 hours)** |

---

## Phase 2 Success Criteria

✅ Phase 2 is complete when:

1. Express server starts without errors on port 3000
2. All CRUD endpoints respond correctly via HTTP
3. Image uploads are compressed to WebP and available at /uploads/
4. Database queries return expected results
5. Query filtering works (status, fandom, brand)
6. Authentication middleware blocks unauthorized requests
7. Error handling returns proper HTTP status codes
8. All 20+ endpoints tested and verified

---

## Technology Stack for Phase 2

| Component | Package | Version |
|-----------|---------|---------|
| Web Framework | express | ^4.18.0 |
| Image Processing | sharp | ^0.32.0 |
| File Upload | multer | ^1.4.5 |
| Logging | morgan | ^1.10.0 |
| CORS | cors | ^2.8.5 |
| Body Parser | body-parser | ^1.20.0 |
| Dotenv | dotenv | ^16.0.0 |
| Prisma Client | @prisma/client | ^5.0.0 |

---

## System Requirements

- **RAM:** 512MB minimum (Express is lightweight)
- **Disk:** 1GB free (for images and database)
- **CPU:** Single core sufficient
- **Node.js:** v18+
- **npm:** v9+

---

## Troubleshooting Quick Links

- **Port 3000 already in use:** See [Step 1 Troubleshooting](01-express-setup.md#troubleshooting)
- **Image upload fails:** See [Step 4 Troubleshooting](04-image-optimization.md#troubleshooting)
- **Database queries hang:** See [Step 2 Troubleshooting](02-api-endpoints.md#troubleshooting)
- **Authentication rejected:** See [Step 5 Troubleshooting](05-authentication.md#troubleshooting)

---

## Next: Phase 3 Preview

Once Phase 2 is verified complete, you'll move to:

### **Phase 3: Auth Engine, Telegram 2FA & Break-Glass Recovery**

What you'll build:
- ✨ OAuth2 authentication system
- 📱 Telegram bot integration for 2FA
- 🔐 Session management
- 🆘 Emergency recovery key generation
- 🔑 JWT token handling

**Est. Time:** 2-3 hours

---

## Getting Started

[→ **Start with Step 1: Express Server Setup**](01-express-setup.md)

Good luck! 🚀
