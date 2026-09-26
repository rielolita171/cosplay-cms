# Cosplay Management System (CMS) — Detailed Phase-by-Phase Implementation & Server Setup Guide

---

## 📋 Quick Jump / Table of Contents
1. [Phase 1: Server Setup & Data Migration](#phase-1-server-setup--data-migration)
2. [Phase 2: Core REST API & Image Engine](#phase-2-core-rest-api--image-engine)
3. [Phase 3: Auth Engine, Telegram 2FA & Break-Glass Recovery](#phase-3-auth-engine-telegram-2fa--break-glass-recovery)
4. [Phase 4: n8n Workflow Integration & Lens Expiry Alerts](#phase-4-n8n-workflow-integration--lens-expiry-alerts)
5. [Phase 5: Frontend UI Construction](#phase-5-frontend-ui-construction)
6. [Phase 6: Testing, Docker Build & Server Production Deployment](#phase-6-testing-docker-build--server-production-deployment)

---

## Phase 1: Server Setup & Data Migration

### 1.1 Server Prerequisites & To-Do Checklist

Perform these steps directly on your home server (e.g., Ubuntu/Debian Server, CasaOS, Portainer, or Unraid terminal):

#### Server To-Do Checklist
- [ ] **Step 1: Install System Dependencies**
  Ensure Docker and Docker Compose are installed on your server:
  ```bash
  sudo apt update && sudo apt install -y docker.io docker-compose-plugin git nodejs npm
  ```

- [ ] **Step 2: Create Host Data Directory Structure**
  Set up persistent storage paths on your host server to hold SQLite database files and user image uploads:
  ```bash
  mkdir -p ~/cosplay-cms/data/db
  mkdir -p ~/cosplay-cms/data/uploads
  mkdir -p ~/cosplay-cms/imports
  cd ~/cosplay-cms
  ```

- [ ] **Step 3: Upload Excel Source File**
  Copy your spreadsheet file `Costume Inventory List (1).xlsx` into `~/cosplay-cms/imports/`.

- [ ] **Step 4: Configure Permissions**
  Ensure correct ownership so Docker/Node process can read/write:
  ```bash
  chmod -R 775 ~/cosplay-cms/data
  ```

---

### 1.2 Database Initialization & Schema

Initialize Prisma with SQLite. The single-file database will be persisted at `/data/db/cms.db`.

#### `prisma/schema.prisma`
```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model User {
  id                 String    @id @default(uuid())
  username           String    @unique
  email              String    @unique
  oauthProvider      String?
  oauthId            String?
  telegramChatId     String?   @unique
  telegram2FAEnabled Boolean   @default(true)
  twoFactorSecret    String?
  twoFactorExpiry    DateTime?
  recoveryCodeHash   String?
  createdAt          DateTime  @default(now())
}

model Costume {
  id               String        @id @default(uuid())
  fandom           String
  character        String
  brand            String?
  size             String?
  isFullset        Boolean       @default(false)
  doneCostest      Boolean       @default(false)
  doneEvent        Boolean       @default(false)
  donePhotoSession Boolean       @default(false)
  status           CostumeStatus @default(IN_POSSESSION)
  buyPrice         Float?
  sellPrice        Float?
  sellPriceMutual  Float?
  notes            String?
  referenceUrl     String?
  imageUrls        String        @default("[]") // JSON string
  props            Prop[]
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
}

enum CostumeStatus {
  IN_POSSESSION
  ON_RENT
  TO_BE_SOLD
  WISHLIST
}

model Prop {
  id        String   @id @default(uuid())
  costumeId String?
  costume   Costume? @relation(fields: [costumeId], references: [id], onDelete: SetNull)
  name      String
  category  String?  // Weapon, Armor, Headpiece, Wig, Accessory
  location  String?  // Storage Box / Closet Shelf
  condition String?  // Mint, Minor Wear, Needs Repair
  notes     String?
  imageUrls String?  @default("[]")
  createdAt DateTime @default(now())
}

model ContactLens {
  id           String     @id @default(uuid())
  character    String?
  color        String
  brand        String?
  prescription String?
  purchaseDate DateTime?
  openedDate   DateTime?
  expiryDate   DateTime   // Calculated active expiry or sealed expiration date
  isOpened     Boolean    @default(false)
  status       LensStatus @default(UNOPENED)
  notes        String?
  imageUrl     String?
  createdAt    DateTime   @default(now())
}

enum LensStatus {
  UNOPENED
  ACTIVE
  EXPIRED
  DISPOSED
}
```

---

### 1.3 Excel Migration & Seed Script

Run this script during setup to import existing costume rows from Excel into SQLite.

#### `scripts/import_excel.js`
```javascript
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');

async function importExcel() {
  const filePath = path.join(__dirname, '../imports/Costume Inventory List (1).xlsx');
  console.log(` Reading source spreadsheet: ${filePath}`);

  const workbook = XLSX.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

  console.log(` Found ${sheetData.length} records to import.`);

  let importedCount = 0;
  for (const row of sheetData) {
    const fandom = row['Fandom'] || row['Series'] || 'Uncategorized';
    const character = row['Character'] || row['Name'] || 'Unknown';
    const brand = row['Brand'] || row['Maker'] || null;
    const size = row['Size'] || null;
    const buyPrice = parseFloat(row['Buy Price'] || row['Cost'] || 0) || null;
    const notes = row['Notes'] || row['Remarks'] || null;
    const referenceUrl = row['Link'] || row['Taobao Link'] || null;

    await prisma.costume.create({
      data: {
        fandom,
        character,
        brand,
        size,
        buyPrice,
        notes,
        referenceUrl,
        status: 'IN_POSSESSION',
        isFullset: true
      }
    });
    importedCount++;
  }

  console.log(` Successfully imported ${importedCount} costumes into SQLite database!`);
}

importExcel()
  .catch(err => console.error(' Migration failed:', err))
  .finally(async () => await prisma.$disconnect());
```

---

## Phase 2: Core REST API & Image Engine

### 2.1 API Endpoint Matrix

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/costumes` | List costumes with query filters (`status`, `fandom`, `brand`) |
| `POST` | `/api/costumes` | Create costume entry |
| `GET` | `/api/costumes/:id` | Get single costume with linked props |
| `PUT` | `/api/costumes/:id` | Update costume milestones, status, or prices |
| `DELETE` | `/api/costumes/:id` | Delete costume record |
| `POST` | `/api/costumes/:id/upload` | Upload & compress image (Sharp -> WebP) |
| `GET` | `/api/props` | List all props with filter by costume or storage location |
| `POST` | `/api/props` | Add standalone or costume-linked prop |
| `GET` | `/api/lenses` | Fetch lens inventory with auto-computed days remaining |
| `POST` | `/api/lenses` | Register lens vial/box |
| `PATCH` | `/api/lenses/:id/open` | Set opened timestamp & calculate active expiry date |

### 2.2 Image Optimization Pipeline (`sharp`)

When an image is uploaded, it is auto-resized to maximum `1200px` width/height and compressed to `.webp` format to save disk space on home servers.

```javascript
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

async function processImageUpload(fileBuffer, originalName) {
  const filename = `img_${Date.now()}_${path.parse(originalName).name}.webp`;
  const outputPath = path.join('/data/uploads', filename);

  await sharp(fileBuffer)
    .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
    .toFormat('webp', { quality: 80 })
    .toFile(outputPath);

  return `/uploads/${filename}`;
}
```

---

## Phase 3: Auth Engine, Telegram 2FA & Break-Glass Recovery

### 3.1 Authentication Workflow Overview

```
 [ User Login Request ]
           │
           ▼
 ┌───────────────────┐
 │ Standard OAuth2   │ ──(Success)──► Check Telegram 2FA Enabled?
 └───────────────────┘                      │
                                            ├── [Yes] ──► Issue 6-Digit Telegram OTP
                                            │             User inputs OTP in Web UI
                                            │             Validate OTP -> Grant Session Cookie
                                            │
                                            └── [No] ───► Grant Session Cookie directly
```

### 3.2 Server Break-Glass Recovery Mechanism

Upon first initialization on your home server, the application generates an emergency secret recovery key:

```javascript
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function generateBreakGlassRecoveryKey() {
  const secretKey = `CMS-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const keyHash = bcrypt.hashSync(secretKey, 10);
  
  console.log('=====================================================');
  console.log(' EMERGENCY BREAK-GLASS RECOVERY SECRET KEY GENERATED:');
  console.log(` >>> ${secretKey} <<<`);
  console.log(' Save this key in a secure location (e.g. Bitwarden).');
  console.log('=====================================================');

  return { secretKey, keyHash };
}
```

---

## Phase 4: n8n Workflow Integration & Lens Expiry Alerts

### 4.1 Notification Query Endpoint

The backend provides a customizable endpoint allowing n8n to query expiring lenses by supplying any threshold in days (`days` parameter):

```http
GET /api/notifications/contact-lenses/expiring?days=14
Header: X-CMS-API-KEY: your_server_api_key
```

#### JSON Response Schema:
```json
{
  "thresholdDays": 14,
  "count": 2,
  "items": [
    {
      "id": "lens-uuid-1",
      "character": "Raiden Shogun",
      "color": "Purple",
      "brand": "Sweety Spata",
      "prescription": "-1.50",
      "expiryDate": "2026-10-15T00:00:00.000Z",
      "daysRemaining": 18,
      "status": "ACTIVE"
    }
  ]
}
```

### 4.2 n8n Workflow Setup Steps

1. **Add Schedule Trigger Node in n8n:** Set execution schedule (e.g., Every day at 08:00 AM).
2. **Add HTTP Request Node:**
   - **Method:** `GET`
   - **URL:** `http://cosplay_cms:3000/api/notifications/contact-lenses/expiring?days=14`
   - **Header:** `X-CMS-API-KEY` = `your_server_api_key`
3. **Add IF Node:** Check if `items.length > 0`.
4. **Add Telegram Node:** Send styled message formatting to your Telegram account:

```text
⚠️ Contact Lens Expiry Warning (14-Day Window)

The following colored lenses are expiring within {{ $json.thresholdDays }} days:

{{#each $json.items}}
• {{character}} ({{color}})
  Brand: {{brand}} | Degree: {{prescription}}
  Expiry Date: {{expiryDate}} ({{daysRemaining}} days left)
  Status: {{status}}
{{/each}}

Please verify your inventory before event usage!
```

---

## Phase 5: Frontend UI Construction

### 5.1 Dashboard UI Metrics & Layout

The user interface is built as a single responsive dashboard featuring:

1. **Metrics Cards:**
   - Total Outfits
   - Costumes On Rent
   - Active Lenses
   - Lenses Expiring Soon (Badge counter)

2. **Costume Completion Metric Formula:**
   $$
   \text{Completion \%} = \left( \frac{\text{isFullset} + \text{doneCostest} + \text{doneEvent} + \text{donePhotoSession}}{4} \right) \times 100\%
   $$

3. **Filterable Views:**
   - **Costumes Tab:** Cards displaying preview image, fandom, character, completion bar, and quick Taobao redirect button.
   - **Props & Accessories Tab:** Filter items by category (Weapon, Wig, Armor) and show exact physical location tag (`Box A - Closet`).
   - **Contact Lens Inventory Tab:** Color-coded status badges:
     - 🟢 **Unopened:** Valid until factory expiration date.
     - 🔵 **Active:** Currently open and within safe lifespan.
     - 🟡 **Expiring Soon:** Within user-configured threshold days.
     - 🔴 **Expired:** Past safety limit.

---

## Phase 6: Testing, Docker Build & Server Production Deployment

### 6.1 Server Deployment Checklist & Commands

Run these steps on your server terminal to deploy the containerized application.

#### Step-by-Step Server Execution:

- [ ] **Step 1: Create `Dockerfile` in project directory**

```dockerfile
# Build Stage
FROM node:18-alpine AS builder
WORKDIR /app
COPY package*.json prisma ./
RUN npm ci
COPY . .
RUN npx prisma generate
RUN npm run build

# Production Stage
FROM node:18-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --only=production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push && node dist/server.js"]
```

- [ ] **Step 2: Create `docker-compose.yml`**

```yaml
version: '3.8'

services:
  cosplay_cms:
    build: .
    container_name: cosplay_cms
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - PORT=3000
      - DATABASE_URL="file:/data/db/cms.db"
      - API_KEY=replace_with_a_secure_api_key
      - TELEGRAM_BOT_TOKEN=your_telegram_bot_token
    volumes:
      - ~/cosplay-cms/data/db:/data/db
      - ~/cosplay-cms/data/uploads:/data/uploads
      - ~/cosplay-cms/imports:/app/imports
```

- [ ] **Step 3: Run Database Seed & Migration inside Container**
```bash
docker compose up -d --build
docker exec -it cosplay_cms node scripts/import_excel.js
```

- [ ] **Step 4: Verify Server Health & Logs**
```bash
docker logs cosplay_cms -f
```
Access the application dashboard at `http://<your-server-ip>:3000`.

- [ ] **Step 5: Automated Daily SQLite Backup Cron Job on Server**
Add a daily cron backup to ensure your data is always safe:
```bash
crontab -e
```
Add the following line (backups database daily at 02:00 AM):
```bash
0 2 * * * cp ~/cosplay-cms/data/db/cms.db ~/cosplay-cms/data/db/cms_backup_$(date +\%Y\%m\%d).db
```