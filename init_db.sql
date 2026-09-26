CREATE TABLE IF NOT EXISTS "User" (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
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
