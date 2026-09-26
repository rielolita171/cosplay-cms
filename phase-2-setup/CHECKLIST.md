# Phase 2 Execution Checklist

## Pre-Execution Verification

- [x] Node.js v18+ installed: `node --version`
- [x] npm installed: `npm --version`
- [x] Project directory exists: `~/cosplay-cms/`
- [x] Phase 1 complete (database initialized with costumes)
- [x] Terminal ready for commands

---

## Step 1: Express Server Setup (10 minutes)

### 1.1: Install Dependencies
- [x] `cd ~/cosplay-cms`
- [x] `npm install express cors morgan body-parser helmet`
- [x] Verify all packages installed: `npm list`

### 1.2: Create Server Structure
- [x] Create `src/` directory
- [x] Create `src/routes/` subdirectory
- [x] Create `src/middleware/` subdirectory

### 1.3: Create Server File
- [x] Create `src/server.js` with full middleware stack
- [x] Update `package.json` scripts: `"start": "node src/server.js"`

### 1.4: Test Server Startup
- [x] Run: `npm start`
- [x] Verify: `curl http://localhost:4001/health` returns 200
- [x] Verify: `curl http://localhost:4001/api/version` returns version info
- [x] Stop server: Ctrl+C

---

## Step 2: REST API Endpoints - Costumes (20 minutes)

### 2.1: Create Routes
- [x] Create `src/routes/costumes.js` with all CRUD endpoints
- [x] Update `src/server.js` to register costume routes

### 2.2: Create Test Endpoints
- [x] Start server: `npm start`
- [x] Test GET `/api/costumes` — should list all 83 costumes
- [x] Test POST `/api/costumes` — create test costume
- [x] Test GET `/api/costumes/:id` — retrieve test costume
- [x] Test PUT `/api/costumes/:id` — update costume status
- [x] Test DELETE `/api/costumes/:id` — delete test costume
- [x] Test filters: `?fandom=X`, `?status=Y`, `?brand=Z`

### 2.3: Verify Success
- [x] All endpoint tests passing without errors
- [x] Filters working correctly
- [x] Error handling for invalid IDs (404 responses)

---

## Step 3: Props & Contact Lenses Endpoints (15 minutes)

### 3.1: Create Props Routes
- [x] Create `src/routes/props.js` with full CRUD
- [x] Update `src/server.js` to register props routes

### 3.2: Create Lenses Routes
- [x] Create `src/routes/lenses.js` with full CRUD
- [x] Update `src/server.js` to register lenses routes
- [x] Verify status auto-calculation (UNOPENED, ACTIVE, EXPIRING_SOON, EXPIRED)

### 3.3: Test All Endpoints
- [x] Props: Create, list, filter, get, update, delete
- [x] Lenses: Create, list, filter, get, update, delete
- [x] Verify relationships: Props linked to costumes

---

## Step 4: Image Optimization with Sharp (15 minutes)

### 4.1: Install Image Processing
- [x] `npm install sharp multer` (declared in package.json)
- [x] Verify: `npm list sharp multer`

### 4.2: Create Image Middleware
- [x] Create `src/middleware/imageUpload.js` (multer config)
- [x] Create `src/middleware/imageProcessor.js` (sharp processing)
- [x] Verify `data/uploads/` directory exists

### 4.3: Create Image Routes
- [x] Create `src/routes/images.js` with upload endpoints
- [x] Update `src/server.js` to register image routes

### 4.4: Test Image Upload
- [ ] Test single image upload: `POST /api/images/upload`
- [ ] Test batch upload: `POST /api/images/upload-multiple`
- [ ] Test stats: `GET /api/images/stats`
- [ ] Verify WebP conversion: `ls -lh data/uploads/`
- [ ] Verify original files deleted after processing

---

## Step 5: Authentication & Authorization (15 minutes)

### 5.1: Create Auth Middleware
- [x] Create `src/middleware/auth.js` (JWT generation & verification)
- [x] Verify JWT_SECRET in `.env`

### 5.2: Create Auth Routes
- [x] Create `src/routes/auth.js` with:
  - [x] POST `/api/auth/register` — create new user
  - [x] POST `/api/auth/login` — authenticate
  - [x] GET `/api/auth/profile` — protected endpoint
  - [x] POST `/api/auth/refresh` — token refresh
  - [x] POST `/api/auth/logout` — logout
- [x] Update `src/server.js` to register auth routes

### 5.3: Test Authentication
- [x] Register new test user
- [x] Login with credentials
- [x] Get profile with valid token
- [x] Verify 401 response without token
- [x] Verify 403 response with invalid token
- [x] Refresh token and get new one

---

## Step 6: Comprehensive Testing (15 minutes)

### 6.1: Create Test Script
- [x] Create `scripts/test_api.js` (comprehensive test suite)

### 6.2: Run Test Suite
- [ ] Ensure server running: `npm start` (Terminal 1)
- [ ] Run tests: `node scripts/test_api.js` (Terminal 2)
- [ ] Verify all 24 tests passing
- [ ] Check success rate: 100%

### 6.3: Final Verification
- [ ] Database integrity: 83 costumes still present
- [ ] No console errors during testing
- [ ] All endpoints accessible
- [ ] Performance acceptable (<1000ms per request)


---

## Post-Execution Verification

### Database Check
```bash
sqlite3 data/db/cms.db "SELECT COUNT(*) FROM Costume;"
```
Expected output: `83`

### Server Health
```bash
curl http://localhost:3000/health
```
Expected: Status 200, JSON response

### Test Results
```bash
node scripts/test_api.js 2>&1 | tail -20
```
Expected: 100% success rate

---

## Troubleshooting Reference

| Issue | Solution |
|-------|----------|
| npm ERR: Cannot find module | Run: `npm install` |
| Port 3000 already in use | Kill process: `lsof -i :3000` or use different port |
| Database connection error | Check DATABASE_URL in .env, verify db/cms.db exists |
| Token issues | Regenerate JWT_SECRET in .env, restart server |
| Image upload fails | Check data/uploads permissions, verify Sharp installed |
| Test script fails | Ensure server running on port 3000, check network |

---

## Time Estimate

- **Total Phase 2 Time**: 90 minutes (10+20+15+15+15+15)
- **Recommended Breaks**: After Step 3, after Step 5

## Sign-Off

**Phase 2 Completion Date**: ________________  
**Tester Signature**: ________________  
**Status**: ☐ Ready for Phase 3 | ☐ Issues Found (document below)

**Notes/Issues**:
```
_________________________________________________________________

_________________________________________________________________

_________________________________________________________________
```

---

## Next Phase

Once Phase 2 is complete and all tests passing:
- **Phase 3**: Frontend UI (React/Vue/Angular)
- **Phase 4**: Deployment to production
- **Phase 5**: Monitoring and maintenance
- **Phase 6**: Advanced features (reporting, analytics)
