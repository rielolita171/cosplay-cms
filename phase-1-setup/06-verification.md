# Phase 1: Step 6 — Verification & Testing

## Objective
Verify that all Phase 1 setup steps have been completed successfully and the system is ready for Phase 2 development.

---

## Pre-Verification Checklist

Before running tests, ensure you have completed all previous steps:

- [ ] Step 1: System prerequisites installed (Docker, Node.js, npm, git)
- [ ] Step 2: Directory structure created and permissions set
- [ ] Step 3: `.env` file configured with all required variables
- [ ] Step 4: Prisma schema created and database initialized
- [ ] Step 5: Excel import script created and data imported

---

## Verification Step 1: System & Dependency Health Check

Check that all required tools are available:

```bash
echo "=== System Health Check ===" && \
echo "Node.js version:" && node --version && \
echo "npm version:" && npm --version && \
echo "Docker version:" && docker --version && \
echo "Git version:" && git --version && \
echo "✓ All dependencies installed"
```

Expected output:
```
=== System Health Check ===
Node.js version:
v18.x.x
npm version:
9.x.x
Docker version:
Docker version 24.x.x
Git version:
git version 2.x.x
✓ All dependencies installed
```

---

## Verification Step 2: Directory Structure Validation

Verify all required directories exist and have correct permissions:

```bash
cd ~/cosplay-cms

echo "=== Directory Structure ===" && \
tree -L 2 || find . -type d -maxdepth 2 | sort && \
echo "" && \
echo "=== Directory Permissions ===" && \
ls -ld data/ imports/ prisma/ scripts/ && \
echo "" && \
echo "=== File Checks ===" && \
ls -lh .env prisma/schema.prisma scripts/import_excel.js 2>/dev/null || echo "Some files missing"
```

Expected structure:
```
cosplay-cms/
├── data/
│   ├── db/
│   │   └── cms.db
│   └── uploads/
├── imports/
│   └── Costume Inventory List (1).xlsx
├── prisma/
│   └── schema.prisma
├── scripts/
│   └── import_excel.js
├── node_modules/
├── .env
├── package.json
└── package-lock.json
```

---

## Verification Step 3: Environment Configuration Test

Verify the `.env` file is correctly loaded:

```bash
cd ~/cosplay-cms
node -e "
require('dotenv').config();
console.log('DATABASE_URL:', process.env.DATABASE_URL);
console.log('PORT:', process.env.PORT);
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('✓ .env loaded successfully');
"
```

Expected output:
```
DATABASE_URL: file:/data/db/cms.db
PORT: 3000
NODE_ENV: development
✓ .env loaded successfully
```

---

## Verification Step 4: Database Integrity Check

Verify the SQLite database is functional:

```bash
cd ~/cosplay-cms

# Check database file exists and has content
echo "=== Database File ===" && \
ls -lh data/db/cms.db && \
echo "" && \

# List database tables
echo "=== Tables in Database ===" && \
sqlite3 data/db/cms.db ".tables" && \
echo "" && \

# Count records
echo "=== Record Counts ===" && \
sqlite3 data/db/cms.db "SELECT COUNT(*) as 'Costumes' FROM \"Costume\";" && \
sqlite3 data/db/cms.db "SELECT COUNT(*) as 'Props' FROM \"Prop\";" && \
sqlite3 data/db/cms.db "SELECT COUNT(*) as 'Lenses' FROM \"ContactLens\";" && \
sqlite3 data/db/cms.db "SELECT COUNT(*) as 'Users' FROM \"User\";"
```

Expected output:
```
=== Database File ===
-rw-r--r-- 1 user user 12K Sep 27 10:30 data/db/cms.db

=== Tables in Database ===
ContactLens  Costume  Prop  User

=== Record Counts ===
Costumes
45
Props
0
Lenses
0
Users
0
```

---

## Verification Step 5: Prisma Client Test

Test that the Prisma client can connect and query:

```bash
cd ~/cosplay-cms

cat > test_prisma.js << 'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function test() {
  console.log('\n🧪 Testing Prisma Connection...\n');
  
  try {
    // Test 1: Count costumes
    const costumeCount = await prisma.costume.count();
    console.log(`✓ Costume table accessible: ${costumeCount} records`);
    
    // Test 2: Fetch sample costume
    const sampleCostume = await prisma.costume.findFirst({
      select: { id: true, character: true, fandom: true, status: true }
    });
    if (sampleCostume) {
      console.log(`✓ Sample costume retrieved: "${sampleCostume.character}" (${sampleCostume.fandom})`);
    }
    
    // Test 3: Create test record
    const testLens = await prisma.contactLens.create({
      data: {
        character: 'Test Character',
        color: 'TestColor',
        expiryDate: new Date('2026-12-31')
      }
    });
    console.log(`✓ Test contact lens created with ID: ${testLens.id}`);
    
    // Test 4: Clean up test record
    await prisma.contactLens.delete({ where: { id: testLens.id } });
    console.log(`✓ Test record cleaned up successfully`);
    
    console.log('\n✅ All Prisma tests passed!\n');
    
  } catch (error) {
    console.error('❌ Prisma test failed:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

test();
EOF

node test_prisma.js
```

Expected output:
```
🧪 Testing Prisma Connection...

✓ Costume table accessible: 45 records
✓ Sample costume retrieved: "Raiden Shogun" (Genshin Impact)
✓ Test contact lens created with ID: abc123def456...
✓ Test record cleaned up successfully

✅ All Prisma tests passed!
```

---

## Verification Step 6: Data Sample Review

View actual imported data:

```bash
cd ~/cosplay-cms

cat > review_data.js << 'EOF'
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function review() {
  console.log('\n📊 Imported Costume Samples:\n');
  
  const costumes = await prisma.costume.findMany({
    take: 5,
    select: {
      id: true,
      character: true,
      fandom: true,
      brand: true,
      buyPrice: true,
      status: true
    }
  });
  
  costumes.forEach((c, i) => {
    console.log(`${i + 1}. "${c.character}" - ${c.fandom}`);
    console.log(`   Brand: ${c.brand || 'N/A'} | Price: $${c.buyPrice || 'N/A'} | Status: ${c.status}`);
  });
  
  await prisma.$disconnect();
}

review();
EOF

node review_data.js
```

---

## Verification Step 7: Permission & Security Check

Ensure sensitive files have proper permissions:

```bash
cd ~/cosplay-cms

echo "=== File Permissions ===" && \
ls -l .env && \
echo "Expected: -rw------- (600)" && \
echo "" && \
echo "=== Prisma Schema Check ===" && \
ls -lh prisma/schema.prisma && \
echo "" && \
echo "=== Database File Check ===" && \
ls -lh data/db/cms.db
```

Should show:
- `.env`: `-rw-------` (600 - read/write for owner only)
- `prisma/schema.prisma`: Readable
- `data/db/cms.db`: Readable/writable

---

## Verification Step 8: Package.json Setup

Verify `package.json` has all necessary dependencies:

```bash
cd ~/cosplay-cms
cat package.json
```

Should include:
```json
{
  "dependencies": {
    "prisma": "^5.x.x",
    "@prisma/client": "^5.x.x",
    "xlsx": "^0.18.x"
  }
}
```

---

## Final Verification Summary

Run this comprehensive check script:

```bash
cat > phase1_verify.sh << 'EOF'
#!/bin/bash

echo "╔════════════════════════════════════════════════════════════╗"
echo "║          PHASE 1 VERIFICATION SUMMARY                      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

cd ~/cosplay-cms

checks_passed=0
checks_total=8

# Check 1: System dependencies
echo -n "✓ System dependencies... "
if command -v node &>/dev/null && command -v docker &>/dev/null; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 2: Directory structure
echo -n "✓ Directory structure... "
if [ -d "data/db" ] && [ -d "data/uploads" ] && [ -d "imports" ] && [ -d "prisma" ] && [ -d "scripts" ]; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 3: .env file
echo -n "✓ .env configuration... "
if [ -f ".env" ] && grep -q "DATABASE_URL" .env; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 4: Database file
echo -n "✓ SQLite database file... "
if [ -f "data/db/cms.db" ]; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 5: Prisma schema
echo -n "✓ Prisma schema... "
if [ -f "prisma/schema.prisma" ] && grep -q "model Costume" prisma/schema.prisma; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 6: Import script
echo -n "✓ Import script exists... "
if [ -f "scripts/import_excel.js" ]; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 7: node_modules
echo -n "✓ Dependencies installed... "
if [ -d "node_modules/@prisma/client" ] && [ -d "node_modules/xlsx" ]; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

# Check 8: Database connectivity
echo -n "✓ Database connectivity... "
if sqlite3 data/db/cms.db ".tables" | grep -q "Costume"; then
  echo "PASS"
  ((checks_passed++))
else
  echo "FAIL"
fi
((checks_total++))

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║ RESULT: $checks_passed/$checks_total checks passed          "
echo "╚════════════════════════════════════════════════════════════╝"

if [ $checks_passed -eq $checks_total ]; then
  echo "✅ Phase 1 Setup Complete! Ready for Phase 2."
  exit 0
else
  echo "⚠️  Some checks failed. Review the logs above."
  exit 1
fi
EOF

chmod +x phase1_verify.sh
./phase1_verify.sh
```

---

## Troubleshooting Summary

| Issue | Solution |
|-------|----------|
| Database file not found | Run `npx prisma db push` |
| Can't connect with Prisma | Check `DATABASE_URL` in `.env` |
| Import script fails | Verify Excel file location and column headers |
| Permission denied errors | Run `chmod -R 775 ~/cosplay-cms/data` |
| Dependency errors | Run `npm install` to reinstall all packages |

---

## Phase 1 Completion Checklist

- [ ] All prerequisites installed and verified
- [ ] Directory structure created with proper permissions
- [ ] `.env` file configured with all variables
- [ ] Prisma schema created and database initialized
- [ ] Excel data imported successfully
- [ ] All 8 verification tests passed
- [ ] Database contains expected number of costume records
- [ ] Prisma client can connect and query

---

## Next Steps: Ready for Phase 2

Once all verification checks pass, you are ready to proceed to:

**Phase 2: Core REST API & Image Engine**

This phase will implement:
- Express.js server setup
- RESTful endpoints for costumes, props, and lenses
- Image upload & optimization pipeline with Sharp
- Authentication middleware
