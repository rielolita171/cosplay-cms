#!/usr/bin/env node

const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// Create database directory if needed
const dbDir = path.join(__dirname, '../data/db');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'cms.db');

// Initialize database with SQL commands
function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const sqlCommands = `
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
    `;

    const sqlite = spawn('sqlite3', [dbPath]);
    
    sqlite.stdin.write(sqlCommands);
    sqlite.stdin.end();

    sqlite.on('close', (code) => {
      if (code === 0) {
        console.log('✓ Database tables initialized');
        resolve();
      } else {
        reject(new Error(`sqlite3 exited with code ${code}`));
      }
    });

    sqlite.on('error', reject);
  });
}

async function importExcel() {
  try {
    const filePath = path.join(__dirname, '../imports/Costume Inventory List (1).xlsx');
    
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Error: Could not find Excel file at: ${filePath}`);
      console.log('📋 Please ensure your Excel file is placed at:');
      console.log('   ~/cosplay-cms/imports/Costume Inventory List (1).xlsx');
      process.exit(1);
    }

    console.log('\n📂 Reading source spreadsheet...');
    console.log(`   File: ${filePath}\n`);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    
    if (!sheetName) {
      console.error('❌ Error: No sheets found in Excel file.');
      process.exit(1);
    }

    console.log(`📄 Using sheet: "${sheetName}"\n`);
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (sheetData.length === 0) {
      console.error('❌ Error: Sheet contains no data rows.');
      process.exit(1);
    }

    console.log(`📊 Found ${sheetData.length} records to import.\n`);

    let importedCount = 0;
    let skippedCount = 0;
    let sqlInserts = [];

    for (let i = 0; i < sheetData.length; i++) {
      const row = sheetData[i];
      
      // Map Excel columns to variables (accounting for actual column structure)
      const character = (row['83'] || row['Character'] || row['Name'] || '').trim();
      
      if (!character || character === '' || character.toLowerCase() === 'unknown' || character === 'Character') {
        skippedCount++;
        continue;
      }

      const fandom = (row['Costume count'] || row['Fandom'] || row['Series'] || 'Uncategorized').trim();
      const brand = (row['__EMPTY'] || row['Brand'] || 'Unknown').trim() || null;
      const size = (row['__EMPTY_1'] || row['Size'] || null);
      const isFullset = (row['__EMPTY_2'] || '').toString().toLowerCase() === 'true' ? 1 : 0;
      const doneCostest = (row['__EMPTY_3'] || '').toString().toLowerCase() === 'true' ? 1 : 0;
      const doneEvent = (row['__EMPTY_4'] || '').toString().toLowerCase() === 'true' ? 1 : 0;
      const donePhotoSession = (row['__EMPTY_5'] || '').toString().toLowerCase() === 'true' ? 1 : 0;
      
      const notes = (row['__EMPTY_6'] || row['Notes'] || '').trim() || null;
      const now = new Date().toISOString();
      const id = randomUUID();

      // Escape single quotes for SQL
      const escapedCharacter = character.replace(/'/g, "''");
      const escapedFandom = fandom.replace(/'/g, "''");
      const escapedBrand = brand ? brand.replace(/'/g, "''") : null;
      const escapedNotes = notes ? notes.replace(/'/g, "''") : null;

      const sql = `INSERT INTO "Costume" (id, fandom, character, brand, size, isFullset, doneCostest, doneEvent, donePhotoSession, status, notes, createdAt, updatedAt) VALUES ('${id}', '${escapedFandom}', '${escapedCharacter}', ${escapedBrand ? `'${escapedBrand}'` : 'NULL'}, ${size ? `'${size}'` : 'NULL'}, ${isFullset}, ${doneCostest}, ${doneEvent}, ${donePhotoSession}, 'IN_POSSESSION', ${escapedNotes ? `'${escapedNotes}'` : 'NULL'}, '${now}', '${now}');`;
      
      sqlInserts.push(sql);
      importedCount++;

      if (importedCount % 10 === 0) {
        console.log(`  ✓ Processed ${importedCount + skippedCount}/${sheetData.length} rows...`);
      }
    }

    // Execute all inserts
    if (sqlInserts.length > 0) {
      await new Promise((resolve, reject) => {
        const sqlite = spawn('sqlite3', [dbPath]);
        const allSQL = sqlInserts.join('\n');
        
        sqlite.stdin.write(allSQL);
        sqlite.stdin.end();

        sqlite.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`sqlite3 insert exited with code ${code}`));
          }
        });

        sqlite.on('error', reject);
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ IMPORT COMPLETE');
    console.log('='.repeat(60));
    console.log(`✓ Successfully imported: ${importedCount} costumes`);
    console.log(`⊘ Skipped: ${skippedCount} rows`);
    console.log('='.repeat(60));
    console.log('\n💾 Your data is now in SQLite at:');
    console.log('   ~/cosplay-cms/data/db/cms.db\n');

  } catch (error) {
    console.error('❌ Fatal error during import:', error.message);
    process.exit(1);
  }
}

importExcel();
