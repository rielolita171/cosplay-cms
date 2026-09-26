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
