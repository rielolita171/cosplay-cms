# Phase 1: Step 4 — Database Schema (Prisma Setup)

## Objective
Initialize Prisma ORM and create the SQLite database schema for all CMS entities (Users, Costumes, Props, Contact Lenses).

---

## Step 4.1: Install Prisma

Navigate to your project root and install Prisma CLI and client:

```bash
cd ~/cosplay-cms
npm install -D prisma @prisma/client
```

---

## Step 4.2: Initialize Prisma Project

Create the Prisma configuration:

```bash
npx prisma init
```

This will generate:
- `.env` file (already exists, so it will backup the existing one)
- `prisma/schema.prisma` file

---

## Step 4.3: Create Full Database Schema

Open or create `prisma/schema.prisma`:

```bash
nano prisma/schema.prisma
```

Replace the contents with the complete schema below:

### `prisma/schema.prisma`

```prisma
// This is your Prisma schema file,
// learn more about it in the docs: https://pris.ly/d/prisma-schema

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}

// ============================================================================
// USER MODEL - Handles authentication, OAuth, Telegram 2FA
// ============================================================================
model User {
  id                 String    @id @default(uuid())
  username           String    @unique
  email              String    @unique
  oauthProvider      String?   // google, github, etc.
  oauthId            String?   @unique
  telegramChatId     String?   @unique
  telegram2FAEnabled Boolean   @default(true)
  twoFactorSecret    String?   // TOTP secret (optional backup)
  twoFactorExpiry    DateTime?
  recoveryCodeHash   String?   // Hashed break-glass recovery key
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
}

// ============================================================================
// COSTUME MODEL - Main inventory tracking with completion milestones
// ============================================================================
model Costume {
  id                 String        @id @default(uuid())
  fandom             String        // Anime series, game, etc.
  character          String        // Character name
  brand              String?       // Maker/brand name
  size               String?       // XS, S, M, L, XL, etc.
  isFullset          Boolean       @default(false)
  doneCostest        Boolean       @default(false)     // Competed at costest event
  doneEvent          Boolean       @default(false)     // Worn at formal event
  donePhotoSession   Boolean       @default(false)     // Professional photo session
  status             CostumeStatus @default(IN_POSSESSION)
  buyPrice           Float?
  sellPrice          Float?
  sellPriceMutual    Float?        // Mutual swap offer price
  notes              String?
  referenceUrl       String?
  imageUrls          String        @default("[]")     // JSON array of image URLs
  props              Prop[]
  createdAt          DateTime      @default(now())
  updatedAt          DateTime      @updatedAt
}

enum CostumeStatus {
  IN_POSSESSION
  ON_RENT
  TO_BE_SOLD
  WISHLIST
}

// ============================================================================
// PROP MODEL - Props, accessories, wigs linked to costumes
// ============================================================================
model Prop {
  id        String    @id @default(uuid())
  costumeId String?
  costume   Costume?  @relation(fields: [costumeId], references: [id], onDelete: SetNull)
  name      String    // e.g., "Raiden Shogun's Polearm"
  category  String?   // Weapon, Armor, Headpiece, Wig, Accessory, Shoes
  location  String?   // Storage location: "Box A - Hall Closet", "Shelf 2 - Bedroom"
  condition String?   // Mint, Minor Wear, Needs Repair, Damaged
  notes     String?
  imageUrls String?   @default("[]")    // JSON array
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
}

// ============================================================================
// CONTACT LENS MODEL - Colored/prescription lens inventory with expiry tracking
// ============================================================================
model ContactLens {
  id           String     @id @default(uuid())
  character    String?    // Character these lenses are for
  color        String     // Purple, Red, Blue, etc.
  brand        String?    // Sweety Spata, Pinkholic, etc.
  prescription String?    // Degree: -1.50, 0.00, +2.00
  purchaseDate DateTime?
  openedDate   DateTime?  // Date lens vial was first opened
  expiryDate   DateTime   // Factory expiration or calculated active expiry
  isOpened     Boolean    @default(false)
  status       LensStatus @default(UNOPENED)
  notes        String?
  imageUrl     String?
  createdAt    DateTime   @default(now())
  updatedAt    DateTime   @updatedAt
}

enum LensStatus {
  UNOPENED      // Sealed, valid until factory expiration
  ACTIVE        // Currently open, within safe lifespan (12 months from open date)
  EXPIRING_SOON // Within 14-day warning threshold
  EXPIRED       // Past safe usage date
  DISPOSED      // Properly discarded
}
```

---

## Step 4.4: Generate Prisma Client

After creating the schema, generate the Prisma client:

```bash
npx prisma generate
```

Expected output:
```
✔ Generated Prisma Client (v5.x.x) to ./node_modules/@prisma/client
```

---

## Step 4.5: Create Initial SQLite Database

Push your schema to create the SQLite database:

```bash
npx prisma db push
```

You should see output like:
```
✔ Database synchronized, created missing table(s) and column(s)
💾 Prisma schema pushed to SQLite
```

Verify the database was created:
```bash
ls -lh ~/cosplay-cms/data/db/cms.db
```

Should show a file size > 0 bytes.

---

## Step 4.6: Verify Database with Prisma Studio

Optionally, open Prisma Studio to inspect your empty database:

```bash
npx prisma studio
```

This opens a web UI at `http://localhost:5555` where you can view all tables and their schema.

---

## Schema Entity Reference

### User
- **Purpose:** Authentication and 2FA management
- **Key Fields:** `username`, `email`, `telegramChatId`, `telegram2FAEnabled`, `recoveryCodeHash`

### Costume
- **Purpose:** Main inventory tracking
- **Key Fields:** `fandom`, `character`, `status`, completion flags (`isFullset`, `doneCostest`, etc.)
- **Relationships:** Has many `Prop` records

### Prop
- **Purpose:** Accessories, wigs, armor linked to costumes
- **Key Fields:** `category`, `location`, `condition`
- **Relationships:** Belongs to `Costume` (optional)

### ContactLens
- **Purpose:** Colored contact lens inventory with expiry tracking
- **Key Fields:** `expiryDate`, `isOpened`, `status`, `character`
- **Auto-computed:** `daysRemaining` = `expiryDate - today()`

---

## Troubleshooting

**Problem:** `Error: ENOENT: no such file or directory, open '.env'`
- **Solution:** Ensure `.env` exists: `touch .env` and add `DATABASE_URL="file:/data/db/cms.db"`

**Problem:** `Cannot find module '@prisma/client'`
- **Solution:** Run `npm install @prisma/client` to install the package.

**Problem:** Database file not created
- **Solution:** Check that `/data/db/` directory exists with proper permissions.

---

## Next Step
Once the schema is verified and the database is created, proceed to **Step 5: Excel Import Script**.
