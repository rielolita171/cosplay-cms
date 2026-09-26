# Phase 2: Step 1 — Express.js Server Setup

## Objective
Set up Express.js web server with all necessary middleware (CORS, logging, body parsing, error handling).

---

## Prerequisites Checklist

- [ ] Phase 1 completed successfully
- [ ] Node.js v18+ installed
- [ ] npm installed
- [ ] SQLite database at ~/cosplay-cms/data/db/cms.db
- [ ] .env file configured

---

## Step 1.1: Install Express Dependencies

```bash
cd ~/cosplay-cms
npm install express multer sharp dotenv cors morgan body-parser helmet
```

Expected output:
```
added X packages in Ys
```

Verify installation:
```bash
npm list express morgan cors
```

---

## Step 1.2: Create Main Server File

Create `src/server.js`:

```bash
mkdir -p src src/routes src/middleware
touch src/server.js
```

### `src/server.js`

```javascript
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Logging middleware
app.use(morgan(':method :url :status :response-time ms'));

// CORS middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CMS-API-KEY']
}));

// Body parser middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Static files for uploaded images
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// API version endpoint
app.get('/api/version', (req, res) => {
  res.json({
    api_version: '1.0.0',
    phase: 2,
    endpoints: [
      'GET /api/costumes',
      'POST /api/costumes',
      'GET /api/costumes/:id',
      'PUT /api/costumes/:id',
      'DELETE /api/costumes/:id',
      'GET /api/props',
      'POST /api/props',
      'GET /api/lenses',
      'POST /api/lenses',
      'PATCH /api/lenses/:id/open',
      'POST /api/upload'
    ]
  });
});

// Routes will be imported here (Step 2-4)
// const costumeRoutes = require('./routes/costumes');
// app.use('/api', costumeRoutes);

// ============================================================================
// ERROR HANDLING MIDDLEWARE
// ============================================================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    path: req.path,
    method: req.method
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.message);
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ Express Server Started');
  console.log(`${'='.repeat(60)}`);
  console.log(`🌐 Server running on: http://localhost:${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`📚 API version: http://localhost:${PORT}/api/version`);
  console.log(`${'='.repeat(60)}\n`);

  // Log available endpoints
  console.log('📡 Available Endpoints:');
  console.log('   Health: GET /health');
  console.log('   Version: GET /api/version');
  console.log('\nℹ️  More endpoints will be added in Steps 2-4\n');
});

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Server interrupted, shutting down...');
  process.exit(0);
});

module.exports = app;
```

---

## Step 1.3: Update package.json with Start Script

Edit `package.json` and add start scripts:

```bash
npm pkg set scripts.start="node src/server.js"
npm pkg set scripts.dev="node --watch src/server.js"
```

Verify in package.json:
```json
{
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  }
}
```

---

## Step 1.4: Test Server Startup

Start the server:

```bash
npm start
```

Expected output:
```
============================================================
✅ Express Server Started
============================================================
🌐 Server running on: http://localhost:3000
📋 Health check: http://localhost:3000/health
📚 API version: http://localhost:3000/api/version
============================================================

📡 Available Endpoints:
   Health: GET /health
   Version: GET /api/version

ℹ️  More endpoints will be added in Steps 2-4
```

---

## Step 1.5: Verify Server (New Terminal)

In another terminal, test the health endpoint:

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "timestamp": "2026-09-27T01:05:00.000Z",
  "uptime": 2.543,
  "environment": "development"
}
```

Test the API version endpoint:

```bash
curl http://localhost:3000/api/version
```

Expected response:
```json
{
  "api_version": "1.0.0",
  "phase": 2,
  "endpoints": [...]
}
```

---

## Step 1.6: Verify Middleware Configuration

### Test CORS headers
```bash
curl -i http://localhost:3000/health
```

Should include:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS
```

### Test body parser
```bash
curl -X POST http://localhost:3000/api/version -H "Content-Type: application/json" -d '{"test": "data"}'
```

Should return 404 but accept JSON (not error about JSON parsing)

---

## Directory Structure After Step 1

```
~/cosplay-cms/
├── src/
│   ├── server.js          ✅ Main Express app
│   ├── routes/            (will be populated in Step 2)
│   └── middleware/        (will be populated in Step 5)
├── data/
│   ├── db/cms.db
│   └── uploads/
├── prisma/
│   └── schema.prisma
├── scripts/
│   └── import_excel.js
├── .env
├── package.json
└── package-lock.json
```

---

## Environment Variables Reference

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `PORT` | No | 3000 | Server port |
| `NODE_ENV` | No | development | Environment mode |
| `CORS_ORIGIN` | No | * | CORS origin |
| `DATABASE_URL` | Yes | file:/data/db/cms.db | SQLite connection |

---

## Troubleshooting

**Problem:** `Error: listen EADDRINUSE: address already in use :::3000`
- **Solution:** Port 3000 is in use. Either:
  - Stop other services: `lsof -i :3000 | grep LISTEN | awk '{print $2}' | xargs kill -9`
  - Use different port: `PORT=3001 npm start`

**Problem:** `Cannot find module 'express'`
- **Solution:** Reinstall dependencies: `npm install`

**Problem:** Server starts but endpoints return 404
- **Solution:** Verify middleware order is correct (CORS before routes)

**Problem:** CORS errors in browser
- **Solution:** Update CORS_ORIGIN in .env: `CORS_ORIGIN=http://localhost:3000`

---

## Next Step

Once the server starts successfully, proceed to **Step 2: REST API Endpoints (Costumes)**.

Press `Ctrl+C` to stop the server when ready.
