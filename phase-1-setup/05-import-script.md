# Phase 1: Step 5 — Excel Import Script & Data Migration

## Objective
Create and run a Node.js script to migrate existing costume data from your Excel spreadsheet into the SQLite database.

---

## Step 5.1: Install Required Dependencies

Install the Excel parsing library `xlsx`:

```bash
cd ~/cosplay-cms
npm install xlsx
```

---

## Step 5.2: Create Import Script

Create the script file:

```bash
nano scripts/import_excel.js
```

Paste the complete import script below:

### `scripts/import_excel.js`

```javascript
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');
const fs = require('fs');

async function importExcel() {
  try {
    // Define source Excel file path
    const filePath = path.join(__dirname, '../imports/Costume Inventory List (1).xlsx');
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      console.error(`❌ Error: Could not find Excel file at: ${filePath}`);
      console.log('📋 Please ensure your Excel file is placed at:');
      console.log('   ~/cosplay-cms/imports/Costume Inventory List (1).xlsx');
      process.exit(1);
    }

    console.log('\n📂 Reading source spreadsheet...');
    console.log(`   File: ${filePath}\n`);

    // Read Excel workbook
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    
    if (!sheetName) {
      console.error('❌ Error: No sheets found in Excel file.');
      process.exit(1);
    }

    console.log(`📄 Using sheet: "${sheetName}"\n`);

    // Parse sheet data
    const sheetData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (sheetData.length === 0) {
      console.error('❌ Error: Sheet contains no data rows.');
      process.exit(1);
    }

    console.log(`📊 Found ${sheetData.length} records to import.\n`);

    // Track import statistics
    let importedCount = 0;
    let skippedCount = 0;
    const errors = [];

    // Import each row
    for (let i = 0; i < sheetData.length; i++) {
      const row = sheetData[i];

      try {
        // Map Excel columns to Costume fields
        // Adjust column names to match your actual Excel headers
        const fandom = (row['Fandom'] || row['Series'] || row['Anime'] || 'Uncategorized').trim();
        const character = (row['Character'] || row['Name'] || row['Character Name'] || 'Unknown').trim();
        const brand = (row['Brand'] || row['Maker'] || row['Source'] || null);
        const size = (row['Size'] || null);
        const buyPrice = parseFloat(row['Buy Price'] || row['Cost'] || row['Price'] || 0) || null;
        const sellPrice = parseFloat(row['Sell Price'] || 0) || null;
        const notes = (row['Notes'] || row['Remarks'] || row['Description'] || null);
        const referenceUrl = (row['Link'] || row['Taobao Link'] || row['URL'] || null);

        // Skip rows with no meaningful data
        if (!character || character === '' || character.toLowerCase() === 'unknown') {
          skippedCount++;
          continue;
        }

        // Create costume record
        const costume = await prisma.costume.create({
          data: {
            fandom,
            character,
            brand: brand && brand.trim() ? brand.trim() : null,
            size: size && size.trim() ? size.trim() : null,
            buyPrice,
            sellPrice,
            notes: notes && notes.trim() ? notes.trim() : null,
            referenceUrl: referenceUrl && referenceUrl.trim() ? referenceUrl.trim() : null,
            status: 'IN_POSSESSION',
            isFullset: true  // Default assumption; can be updated via API later
          }
        });

        importedCount++;
        
        // Progress indicator every 10 rows
        if ((i + 1) % 10 === 0) {
          console.log(`  ✓ Processed ${i + 1}/${sheetData.length} rows...`);
        }

      } catch (rowError) {
        skippedCount++;
        errors.push({
          row: i + 1,
          data: row,
          error: rowError.message
        });
      }
    }

    // Print summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ IMPORT COMPLETE');
    console.log('='.repeat(60));
    console.log(`✓ Successfully imported: ${importedCount} costumes`);
    console.log(`⊘ Skipped: ${skippedCount} rows`);
    
    if (errors.length > 0) {
      console.log(`⚠️  Errors encountered: ${errors.length}`);
      console.log('\nFirst 3 errors:');
      errors.slice(0, 3).forEach(err => {
        console.log(`  Row ${err.row}: ${err.error}`);
      });
    }

    console.log('='.repeat(60));
    console.log('\n💾 Your data is now in SQLite at:');
    console.log('   ~/cosplay-cms/data/db/cms.db\n');

  } catch (error) {
    console.error('❌ Fatal error during import:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the import
importExcel();
```

---

## Step 5.3: Run the Import Script

Execute the import from your project root:

```bash
cd ~/cosplay-cms
node scripts/import_excel.js
```

### Expected Output:

```
📂 Reading source spreadsheet...
   File: /home/user/cosplay-cms/imports/Costume Inventory List (1).xlsx

📄 Using sheet: "All"

📊 Found 45 records to import.

  ✓ Processed 10/45 rows...
  ✓ Processed 20/45 rows...
  ✓ Processed 30/45 rows...
  ✓ Processed 40/45 rows...

============================================================
✅ IMPORT COMPLETE
============================================================
✓ Successfully imported: 45 costumes
⊘ Skipped: 0 rows
============================================================

💾 Your data is now in SQLite at:
   ~/cosplay-cms/data/db/cms.db
```

---

## Step 5.4: Verify Import Success

### Option A: Using Prisma Studio
```bash
npx prisma studio
```
Opens web UI at `http://localhost:5555` to inspect imported costumes.

### Option B: Using Prisma CLI Query
```bash
npx prisma db execute --stdin < <(echo "SELECT COUNT(*) as total_costumes FROM \"Costume\";")
```

Or use the Prisma client in a Node script:

```bash
cat > verify_import.js << 'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function verify() {
  const costumes = await prisma.costume.findMany({
    select: { id: true, character: true, fandom: true, status: true }
  });
  
  console.log(`\n✓ Total costumes in database: ${costumes.length}\n`);
  console.log('Sample records:');
  costumes.slice(0, 5).forEach(c => {
    console.log(`  • ${c.character} (${c.fandom}) - ${c.status}`);
  });
  
  await prisma.$disconnect();
}

verify();
EOF
node verify_import.js
```

---

## Step 5.5: Excel Column Mapping Reference

The script intelligently maps your Excel columns. If your Excel file uses different column names, edit the mapping in the script:

| Script Variable | Excel Columns (detected by) |
|-----------------|---------------------------|
| `fandom` | "Fandom", "Series", "Anime" |
| `character` | "Character", "Name", "Character Name" |
| `brand` | "Brand", "Maker", "Source" |
| `size` | "Size" |
| `buyPrice` | "Buy Price", "Cost", "Price" |
| `sellPrice` | "Sell Price" |
| `notes` | "Notes", "Remarks", "Description" |
| `referenceUrl` | "Link", "Taobao Link", "URL" |

If your Excel has different headers, update the script's column name mappings.

---

## Troubleshooting

**Problem:** `Cannot find module 'xlsx'`
- **Solution:** Install the package: `npm install xlsx`

**Problem:** `Error: Could not find Excel file`
- **Solution:** Ensure your file is at: `~/cosplay-cms/imports/Costume Inventory List (1).xlsx`

**Problem:** `0 rows imported, all skipped`
- **Solution:** Check your Excel file has a "Character" or similar header and actual data rows.

**Problem:** Import hangs or takes very long
- **Solution:** Press `Ctrl+C` to cancel. Check if your Excel file has merged cells or unusual formatting that might slow parsing.

---

## Next Step
Once import is verified successfully, proceed to **Step 6: Verification & Testing**.
