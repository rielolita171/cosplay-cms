# Phase 2 Architecture & Data Flows

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     CLIENT APPLICATIONS                      │
│  (Web Browser, Mobile App, Admin Dashboard)                 │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          │ HTTP/REST
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     EXPRESS.JS SERVER                        │
│              (localhost:3000)                               │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ MIDDLEWARE STACK                                     │  │
│  │ • Body Parser (JSON, 10MB limit)                     │  │
│  │ • CORS (Cross-Origin)                                │  │
│  │ • Morgan (HTTP Logging)                              │  │
│  │ • Helmet (Security Headers)                          │  │
│  │ • Authentication (JWT Verification)                  │  │
│  │ • Image Processor (Sharp Optimization)               │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ROUTE HANDLERS                                       │  │
│  │ • Auth Routes (/auth/*)                              │  │
│  │ • Costume Routes (/api/costumes/*)                   │  │
│  │ • Props Routes (/api/props/*)                        │  │
│  │ • Lenses Routes (/api/lenses/*)                      │  │
│  │ • Image Routes (/api/images/*)                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ BUSINESS LOGIC                                       │  │
│  │ • CRUD Operations                                    │  │
│  │ • Query Filtering & Sorting                          │  │
│  │ • Authentication & Authorization                     │  │
│  │ • Image Processing                                   │  │
│  │ • Status Management                                  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          │ SQL Queries
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      SQLITE DATABASE                         │
│           ~/cosplay-cms/data/db/cms.db                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Tables                                               │  │
│  │ • User (authentication)                              │  │
│  │ • Costume (inventory)                                │  │
│  │ • Prop (accessories)                                 │  │
│  │ • ContactLens (lenses)                               │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    FILE STORAGE                              │
│           ~/cosplay-cms/data/uploads/                       │
│  (WebP optimized images: max 1200x1200px)                   │
└─────────────────────────────────────────────────────────────┘
```

---

## Request/Response Flow

### Example: Create and Retrieve Costume

```
CLIENT                          SERVER                    DATABASE
  │                              │                           │
  ├──POST /api/costumes         │                           │
  │  (name, fandom, brand)       │                           │
  ├─────────────────────────────>│                           │
  │                              │                           │
  │                              ├─ Validate Input          │
  │                              ├─ Generate UUID           │
  │                              ├─ Hash Password (if auth) │
  │                              │                           │
  │                              ├──INSERT INTO Costume    │
  │                              ├───────────────────────────>
  │                              │                           │
  │                              │← Record created           │
  │                              │                           │
  │<─200 Created ──────────────  │
  │  {id, name, fandom, ...}     │
  │                              │
  │                              │
  ├──GET /api/costumes/:id       │
  │  (JWT Token)                 │
  ├─────────────────────────────>│
  │                              │
  │                              ├─ Verify JWT             │
  │                              ├─ Check Authorization    │
  │                              │                           │
  │                              ├──SELECT * FROM Costume  │
  │                              │  WHERE id = 'abc123'     │
  │                              ├───────────────────────────>
  │                              │                           │
  │                              │← Return costume row      │
  │                              │                           │
  │<─200 OK ──────────────────── │
  │  {id, name, fandom, ...}     │
  │                              │
```

---

## Authentication Flow

```
┌─ NEW USER REGISTRATION ─────────────────────────────────────┐
│                                                              │
│  POST /auth/register                                        │
│  {username, email, password}                                │
│         │                                                   │
│         ├─ Validate: username unique                        │
│         ├─ Validate: email format                           │
│         ├─ Validate: password >= 8 chars                    │
│         ├─ Hash password (SHA-256)                          │
│         ├─ Generate User ID (UUID)                          │
│         ├─ INSERT INTO User                                 │
│         ├─ Generate JWT Token                               │
│         │   ├─ Payload: {id, role, iat}                    │
│         │   ├─ Secret: process.env.JWT_SECRET              │
│         │   ├─ Expiry: 7 days                              │
│         └─ Return 201 + Token                              │
│                                                              │
└─ LOGIN ────────────────────────────────────────────────────┘
│                                                              │
│  POST /auth/login                                           │
│  {username, password}                                       │
│         │                                                   │
│         ├─ Hash provided password                           │
│         ├─ SELECT User WHERE username AND passwordHash     │
│         ├─ If match: Generate new JWT Token                │
│         └─ Return 200 + Token                              │
│                                                              │
└─ PROTECTED ENDPOINT ACCESS ────────────────────────────────┘
│                                                              │
│  GET /api/endpoint                                          │
│  Headers: Authorization: Bearer <JWT_TOKEN>                │
│         │                                                   │
│         ├─ Extract token from header                        │
│         ├─ Verify JWT signature (using JWT_SECRET)         │
│         ├─ Check expiration time                            │
│         ├─ If valid: Extract user ID & role                │
│         ├─ If invalid: Return 403 Forbidden                │
│         ├─ If expired: Return 401 Unauthorized             │
│         └─ Attach req.user = {id, role, iat}              │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Image Processing Pipeline

```
UPLOAD                        PROCESSING                   STORAGE
    │                              │                           │
    ├─ Receive image file          │                           │
    │                              │                           │
    ├─ Validate MIME type ───────→ │                           │
    │  (jpeg, png, webp, gif)      │                           │
    │                              │                           │
    ├─ Store to temp location      │                           │
    │                              │                           │
    │                       ┌──────▼──────────┐               │
    │                       │ Sharp Processing │               │
    │                       │                  │               │
    │                       ├─ Detect size   │               │
    │                       │ ├─ Resize to   │               │
    │                       │ │  1200×1200px │               │
    │                       │ │  (fit inside) │               │
    │                       │ │                │               │
    │                       │ ├─ Convert to  │               │
    │                       │ │  WebP format  │               │
    │                       │ │  (quality: 85)│               │
    │                       │ │                │               │
    │                       │ └─ Output       │               │
    │                       └──────┬──────────┘               │
    │                              │                           │
    │                       ┌──────▼─────────────────┐        │
    │                       │ Delete original file   │        │
    │                       └──────┬────────────────┘        │
    │                              │                           │
    │                              │ Save metadata to DB       │
    │                              │                           │
    │                              └──→ Store WebP file ──────▶│
    │                                  /uploads/[uuid].webp    │
    │                                                           │
    └─ Return 201 + URL ─────────────────────────────────────┘
       {processedUrl: "/uploads/[uuid].webp"}
```

---

## Data Model Relationships

```
┌─────────────┐          ┌─────────────┐
│    USER     │          │   COSTUME   │
├─────────────┤          ├─────────────┤
│ id (PK)     │          │ id (PK)     │
│ username    │          │ character   │
│ email       │          │ fandom      │
│ role        │          │ brand       │
│ tokens      │          │ status      │
│ createdAt   │          │ imageUrls   │
└─────────────┘          └──────┬──────┘
                                │
                                │ 1:N
                                │
                    ┌───────────▼──────────┐
                    │       PROP           │
                    ├──────────────────────┤
                    │ id (PK)              │
                    │ costumeId (FK)       │
                    │ name                 │
                    │ category             │
                    │ location             │
                    │ condition            │
                    │ imageUrls            │
                    └──────────────────────┘

┌────────────────┐
│ CONTACTLENS    │
├────────────────┤
│ id (PK)        │
│ character      │
│ color          │
│ brand          │
│ status         │
│ expiryDate     │
│ imageUrl       │
│ createdAt      │
└────────────────┘
```

---

## API Endpoint Categories

### 1. Health & Monitoring (No Auth Required)
```
GET  /health              → Server status
GET  /api/version         → Available endpoints
```

### 2. Authentication (No Auth for register/login)
```
POST /api/auth/register   → Create user
POST /api/auth/login      → Authenticate
GET  /api/auth/profile    → Get user (requires auth)
POST /api/auth/refresh    → Renew token (requires auth)
POST /api/auth/logout     → Logout (requires auth)
```

### 3. Costumes (Requires Auth)
```
GET    /api/costumes              → List (filterable)
POST   /api/costumes              → Create
GET    /api/costumes/:id          → Retrieve
PUT    /api/costumes/:id          → Update
DELETE /api/costumes/:id          → Delete
```

### 4. Props (Requires Auth)
```
GET    /api/props                 → List (filterable)
POST   /api/props                 → Create
GET    /api/props/:id             → Retrieve
PUT    /api/props/:id             → Update
DELETE /api/props/:id             → Delete
```

### 5. Contact Lenses (Requires Auth)
```
GET    /api/lenses                → List (filterable)
POST   /api/lenses                → Create
GET    /api/lenses/:id            → Retrieve
PUT    /api/lenses/:id            → Update (status)
DELETE /api/lenses/:id            → Delete
```

### 6. Images (Requires Auth)
```
POST /api/images/upload           → Single upload
POST /api/images/upload-multiple  → Batch upload
GET  /api/images/stats            → Storage info
```

---

## Query Parameters Reference

### Costume Filters
```
GET /api/costumes?fandom=Genshin&status=IN_POSSESSION&brand=Uwowo
```

### Props Filters
```
GET /api/props?costumeId={uuid}&category=Weapon&condition=Good
```

### Lenses Filters
```
GET /api/lenses?status=ACTIVE&color=Blue&brand=GEO
```

---

## Error Handling Strategy

```
Request Status Codes:
├─ 2xx Success
│  ├─ 200 OK           → GET succeeded
│  ├─ 201 Created      → POST succeeded, resource created
│  └─ 204 No Content   → DELETE succeeded
│
├─ 4xx Client Error
│  ├─ 400 Bad Request  → Invalid input, missing fields
│  ├─ 401 Unauthorized → No token or expired
│  ├─ 403 Forbidden    → Invalid token or insufficient role
│  └─ 404 Not Found    → Resource doesn't exist
│
└─ 5xx Server Error
   ├─ 500 Internal Server Error → Database/processing failure
   └─ 503 Service Unavailable   → Server down/maintenance
```

---

## Performance Considerations

### Request Handling
- **Max JSON body**: 10 MB
- **Max file upload**: 10 MB per file
- **Batch image limit**: 10 files at a time
- **Query response time**: <1000ms (acceptable)

### Database
- **Indexing**: Primary keys on id, foreign keys on costumeId
- **Query optimization**: SELECT only needed columns
- **Transaction safety**: No explicit transactions (SQLite auto-commits)

### Image Processing
- **WebP compression**: ~25-35% smaller than JPEG/PNG
- **Resize threshold**: Max 1200×1200px
- **Quality setting**: 85 (good balance quality/size)
- **Storage**: Local filesystem (`/data/uploads/`)

---

## Security Measures

### Authentication
- JWT tokens with 7-day expiration
- Password hashing (SHA-256, consider bcrypt for production)
- Token refresh mechanism

### Authorization
- Role-based access control (admin, curator, user, guest)
- Role hierarchy enforcement
- Protected endpoints require valid token

### Data Protection
- Input validation (required fields, format checks)
- CORS enabled for specified origins
- Security headers via Helmet middleware
- File type validation (images only)
- File size limits

### Logging
- Morgan middleware logs all requests
- Format: `:method :url :status :response-time ms`
- Useful for debugging and monitoring

---

## Monitoring & Health Checks

```javascript
// Health endpoint structure
{
  "status": "healthy",
  "timestamp": "2026-09-27T10:30:00Z",
  "uptime": 3600,
  "environment": "production",
  "database": "connected",
  "version": "2.0.0"
}
```

---

## File Structure

```
cosplay-cms/
├── src/
│   ├── server.js              ← Main Express app
│   ├── routes/
│   │   ├── auth.js            ← JWT auth
│   │   ├── costumes.js        ← Costume CRUD
│   │   ├── props.js           ← Props CRUD
│   │   ├── lenses.js          ← Lenses CRUD
│   │   └── images.js          ← Image upload/processing
│   └── middleware/
│       ├── auth.js            ← Token verification
│       ├── imageUpload.js     ← Multer config
│       └── imageProcessor.js  ← Sharp optimization
├── scripts/
│   ├── test_api.js            ← Comprehensive tests
│   └── import_excel.js        ← (Phase 1)
├── data/
│   ├── db/
│   │   └── cms.db             ← SQLite database
│   └── uploads/               ← WebP images
├── prisma/
│   └── schema.prisma          ← Database schema
├── .env                       ← Configuration
├── .gitignore
├── package.json
└── README.md
```

---

## Deployment Checklist

- [ ] Environment variables configured (.env)
- [ ] Database migrations applied
- [ ] Dependencies installed (npm install)
- [ ] Tests passing (npm run test)
- [ ] Error logging configured
- [ ] CORS origin configured for production domain
- [ ] JWT_SECRET changed from default
- [ ] Password hashing upgraded (bcrypt)
- [ ] File upload limits tuned
- [ ] Rate limiting added (optional)
- [ ] Reserved upload directory with proper permissions
- [ ] Backup strategy for database and uploads
- [ ] Monitoring/alerting configured
- [ ] SSL/TLS enabled (HTTPS)
- [ ] Reverse proxy configured (nginx)

