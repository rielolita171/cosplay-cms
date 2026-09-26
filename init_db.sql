-- ---------------------------------------------------------------------------
-- Managed reference lists
--
-- "Costume".brand / "Costume".fandom used to be free text. They now reference a
-- row here BY NAME (the column still holds the display string, see the note on
-- the backfill in src/services/db.js:initSchema), which means:
--   * the existing 83 costumes keep rendering with zero rewrites, and
--   * a brand/fandom can never end up pointing at a row that no longer exists.
-- The linkage is therefore a soft reference enforced in src/routes/brands.js and
-- src/routes/fandoms.js (a delete of a referenced row is refused with 409), NOT a
-- SQLite FOREIGN KEY — SQLite would not enforce it here anyway, since
-- `PRAGMA foreign_keys` is off by default on the `sqlite3` CLI this project uses.
--
-- nameLower carries a case-folded copy of `name` so uniqueness is
-- case-insensitive; the UNIQUE index on it is what "INSERT OR IGNORE" in the
-- backfill keys off. id is a 32-char hex string (randomblob(16)) because the
-- `sqlite3` CLI has no UUID function.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Brand" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nameLower TEXT NOT NULL,
  -- Optional online-store link, validated server-side to be http(s) only.
  storeUrl TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_Brand_nameLower" ON "Brand"(nameLower);
CREATE INDEX IF NOT EXISTS "idx_Brand_name" ON "Brand"(name);

CREATE TABLE IF NOT EXISTS "Fandom" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nameLower TEXT NOT NULL,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_Fandom_nameLower" ON "Fandom"(nameLower);
CREATE INDEX IF NOT EXISTS "idx_Fandom_name" ON "Fandom"(name);

CREATE TABLE IF NOT EXISTS "User" (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  -- Added post-initial-schema: bcrypt password hash + role.
  -- src/services/db.js also adds these idempotently at boot for existing DBs.
  passwordHash TEXT,
  role TEXT DEFAULT 'user',
  oauthProvider TEXT,
  oauthId TEXT UNIQUE,
  telegramChatId TEXT UNIQUE,
  telegram2FAEnabled INTEGER DEFAULT 1,
  twoFactorSecret TEXT,
  twoFactorExpiry TEXT,
  recoveryCodeHash TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Costume" (
  id TEXT PRIMARY KEY,
  fandom TEXT NOT NULL,
  character TEXT NOT NULL,
  brand TEXT,
  size TEXT,
  isFullset INTEGER DEFAULT 0,
  doneCostest INTEGER DEFAULT 0,
  doneEvent INTEGER DEFAULT 0,
  donePhotoSession INTEGER DEFAULT 0,
  status TEXT DEFAULT 'IN_POSSESSION',
  buyPrice REAL,
  sellPrice REAL,
  sellPriceMutual REAL,
  notes TEXT,
  referenceUrl TEXT,
  imageUrls TEXT DEFAULT '[]',
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "Prop" (
  id TEXT PRIMARY KEY,
  costumeId TEXT,
  name TEXT NOT NULL,
  category TEXT,
  location TEXT,
  condition TEXT,
  notes TEXT,
  imageUrls TEXT DEFAULT '[]',
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (costumeId) REFERENCES "Costume"(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS "ContactLens" (
  id TEXT PRIMARY KEY,
  character TEXT,
  color TEXT NOT NULL,
  brand TEXT,
  prescription TEXT,
  purchaseDate TEXT,
  openedDate TEXT,
  expiryDate TEXT NOT NULL,
  isOpened INTEGER DEFAULT 0,
  status TEXT DEFAULT 'UNOPENED',
  notes TEXT,
  imageUrl TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Rotating, single-use refresh tokens (family-based reuse detection)
CREATE TABLE IF NOT EXISTS "RefreshToken" (
  jti TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  familyId TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  usedAt INTEGER,
  revokedAt INTEGER,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_RefreshToken_family" ON "RefreshToken"(familyId);
CREATE INDEX IF NOT EXISTS "idx_RefreshToken_user" ON "RefreshToken"(userId);
CREATE INDEX IF NOT EXISTS "idx_RefreshToken_expires" ON "RefreshToken"(expiresAt);

-- Consumed single-use token ids (2FA tempToken replay protection)
CREATE TABLE IF NOT EXISTS "ConsumedToken" (
  jti TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  consumedAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_ConsumedToken_expires" ON "ConsumedToken"(expiresAt);
