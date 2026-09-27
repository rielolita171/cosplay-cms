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

-- The single operator contact point.
--
-- This table used to be a full account table: username, email, passwordHash, role,
-- oauthId, the 2FA columns and the refresh/reset/token tables all hung off it.
-- The CMS is now a single-user private app on a trusted network with no login, so
-- all of that is gone. What deliberately SURVIVES is telegramChatId, because it is
-- the address a notification is delivered to — a configuration value that happens
-- to be worth persisting, not an identity.
--
-- There is no "account" here: no id to log in with, no credentials, no role tier.
-- `slot` is a fixed constant so this is a single-row table rather than a list —
-- the ONE row is the operator's own Telegram chat.
--
-- MIGRATION NOTE: init_db.sql is CREATE TABLE IF NOT EXISTS only. It never
-- migrates an existing database, so an existing volume keeps the old 14-column
-- "User" table and this narrower definition simply does not apply to it. A fresh
-- container gets this shape. See DOCKER.md.
CREATE TABLE IF NOT EXISTS "TelegramChat" (
  slot TEXT PRIMARY KEY,
  telegramChatId TEXT UNIQUE,
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
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
  -- Swatch colour for `color`, stored SEPARATELY from the name. `color` stays a
  -- free-text name because that is what the user reads and searches; this holds
  -- only the #RRGGBB value the client paints, and is NULL for rows that predate
  -- the colour picker (those fall back to a name-based lookup).
  --
  -- DECLARED LAST ON PURPOSE. Every SELECT in src/routes/lenses.js is a positional
  -- `SELECT *`, and an existing database gets this column via ALTER TABLE, which
  -- always appends. Declaring it last here means a fresh database and a migrated
  -- one have the same physical column order. See LENS_COLUMNS in that file.
  colorHex TEXT
);

-- Runtime server settings (currently the CORS allowlist).
--
-- A key/value table rather than columns on an existing table, because these
-- are settings of the SERVER, not of a costume or a contact point, and a new
-- setting should not need a migration.
--
-- value is TEXT holding JSON so the shape of a setting can change without a
-- schema change; the reader contract lives in src/services/settings.js.
--
-- updatedBy records who set it, which matters for the security-relevant ones.
-- updatedAt is ISO-8601 TEXT (a human reads it, and toISOString() is fixed-width
-- UTC so byte order is chronological order).
--
-- NO ROW IS SEEDED. The absence of the row is exactly what "no override, fall
-- back to CORS_ORIGIN in .env" means, so seeding it with the default would make
-- a deliberate choice indistinguishable from the default.
CREATE TABLE IF NOT EXISTS "ServerSetting" (
  key TEXT PRIMARY KEY,
  value TEXT,
  updatedAt TEXT,
  updatedBy TEXT
);
