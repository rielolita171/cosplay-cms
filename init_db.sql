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
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
  -- THE MILESTONE LADDER, FIVE STEPS IN ORDER. See the migration in
  -- src/services/db.js for why `costumeOnly` is declared LAST: it is added by
  -- ALTER TABLE, and SQLite always appends an added column at the end of the
  -- physical order. Declaring it last here too means a fresh database and a
  -- migrated one have the SAME physical order, which is the only reason the
  -- positional `SELECT *` in src/routes/costumes.js stays correct on both.
  --
  -- The four older booleans are the ladder minus its first rung:
  --   costumeOnly       the garment alone, nothing to complete the look
  --   isFullset         garment + bare minimum styled wig
  --   doneCostest       tried once or twice, you know how to look it
  --   doneEvent         taken to an event, fits and wears comfortably
  --   donePhotoSession  properly styled and shot by a photographer
  --
  -- These stay INDEPENDENT booleans rather than one ordinal. An ordinal cannot
  -- represent the costume whose wig is ready but which has never been costested
  -- (Fullset yes, Costest no), which is a perfectly ordinary state.
  costumeOnly INTEGER DEFAULT 0
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

-- MAKER CORNER
-- The people who build the things in this collection: the commissions, the prop
-- makers, the accessory sellers. A maker is a CONTACT with a speciality, not a
-- costume and not a prop — the same person may have made three different props
-- for three different costumes, so linking one Maker row to a costume would
-- have to be many-to-many and there is nothing in the brief that needs it.
--
-- WHY A TABLE AND NOT A COLUMN ON "Prop"
-- A maker is entered once and reused. As a column it would be retyped on every
-- prop by hand, one spelling drift per row ("Rina", "Rina.", "rina"), and a
-- correction would have to be made N times.
--
-- `makerType` is a CLOSED SET, enforced by the API (enumParam in
-- src/routes/makers.js) and mirrored in the form's <select>. It is the answer to
-- "what do they make?", which is what the Corner is sorted and filtered by.
--
--   PROP       — the whole prop (sword, shield, staff)
--   WEAPON     — specifically a weapon
--   ACCESSORY  — jewellery, belts, pouches, hairpieces
--
-- `sosmed` is the maker's SOCIAL MEDIA LINK — one URL to their profile, not a
-- handle and not a per-network column. It is http(s)-only and validated at the
-- API boundary (the same rule as "Brand".storeUrl: no javascript:, no data:,
-- no protocol-relative '//evil.tld'), because the dashboard renders it as an
-- <a href>; a client-side filter alone is not a control. Any platform works —
-- Instagram, TikTok, Bluesky, X, a Linktree — so nothing is allowlisted by host.
--
-- `whatsapp` is TEXT, not a number: WhatsApp ids carry a country code, a
-- national number and often '+' and spaces, and a numeric column would force
-- the user to strip all of that. It is stored as typed; the digits are
-- validated only when the client builds the wa.me link, which is the single
-- place the number is ever interpreted.
--
-- NO COSTUME LINK, and no photos: a maker entry is a directory entry. The props
-- they built remain props, with their own photos, and point back here through
-- their notes if the operator wants the trail.
CREATE TABLE IF NOT EXISTS "Maker" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  makerType TEXT NOT NULL,
  sosmed TEXT,
  whatsapp TEXT,
  notes TEXT,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
  updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
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
