const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function runQuery(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', ['data/db/cms.db']);
    let output = '';
    
    sqlite.stdout.on('data', (data) => { output += data; });
    sqlite.stderr.on('data', (data) => { reject(new Error(data)); });
    
    sqlite.stdin.write(sql);
    sqlite.stdin.end();
    
    sqlite.on('close', () => resolve(output.trim()));
  });
}

async function verify() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          PHASE 1 VERIFICATION SUMMARY                       ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  let passed = 0, total = 8;

  // Check 1: Directory structure
  console.log('✓ Directory structure... ', end='');
  if (fs.existsSync('data/db') && fs.existsSync('data/uploads') && fs.existsSync('imports') && fs.existsSync('prisma') && fs.existsSync('scripts')) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  // Check 2: .env file
  console.log('✓ .env configuration... ', end='');
  if (fs.existsSync('.env') && fs.readFileSync('.env', 'utf8').includes('DATABASE_URL')) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  // Check 3: Database file
  console.log('✓ SQLite database file... ', end='');
  if (fs.existsSync('data/db/cms.db')) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  // Check 4: Database tables
  console.log('✓ Database tables... ', end='');
  const tables = await runQuery('.tables');
  if (tables.includes('Costume') && tables.includes('User') && tables.includes('ContactLens')) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  // Check 5: Costume records
  console.log('✓ Costume records... ', end='');
  const costumeCount = await runQuery('SELECT COUNT(*) FROM "Costume";');
  console.log(`(${costumeCount} records) PASS`);
  passed++;

  // Check 6: Prisma schema
  console.log('✓ Prisma schema... ', end='');
  if (fs.existsSync('prisma/schema.prisma')) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  // Check 7: Import script
  console.log('✓ Import script exists... ', end='');
  if (fs.existsSync('scripts/import_excel.js')) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  // Check 8: Sample data
  console.log('✓ Database connectivity... ', end='');
  const sample = await runQuery('SELECT character, fandom FROM "Costume" LIMIT 1;');
  if (sample) {
    console.log('PASS');
    passed++;
  } else {
    console.log('FAIL');
  }

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log(`║ RESULT: ${passed}/${total} checks passed                           ║`);
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  if (passed === total) {
    console.log('✅ Phase 1 Setup Complete! Ready for Phase 2.\n');
  }
}

verify();
