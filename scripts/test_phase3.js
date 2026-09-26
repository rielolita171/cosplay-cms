require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 4001;
const API_BASE = process.env.API_BASE || `http://localhost:${PORT}`;

let passCount = 0;
let failCount = 0;

function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', ['data/db/cms.db']);
    let output = '';
    sqlite.stdout.on('data', d => output += d);
    sqlite.stderr.on('data', d => reject(new Error(d.toString())));
    sqlite.stdin.write(sql);
    sqlite.stdin.end();
    sqlite.on('close', code => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`Exit code ${code}`));
    });
  });
}

function makeRequest(method, path, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const options = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (token) {
      options.headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${name}${details ? ` - ${details}` : ''}`);
  if (passed) passCount++;
  else failCount++;
}

async function runPhase3Tests() {
  console.log('🔐 STARTING PHASE 3: AUTH ENGINE & TELEGRAM 2FA TEST SUITE\n');
  console.log('='.repeat(60));

  const testUser = `phase3_user_${Date.now()}`;
  const testEmail = `${testUser}@example.com`;
  const testPassword = 'Password2026!';
  let initialRecoveryKey = null;
  let userToken = null;
  let userId = null;

  try {
    // 1. Register user
    console.log('\n--- 1. Registration with Break-Glass Key Generation ---');
    const regRes = await makeRequest('POST', '/api/auth/register', {
      username: testUser,
      email: testEmail,
      password: testPassword,
      telegramChatId: '987654321',
      telegram2FAEnabled: true
    });

    logTest(
      'Register user with 2FA & Break-Glass recovery key',
      regRes.status === 201 && regRes.body.recoveryKey && regRes.body.recoveryKey.startsWith('CMS-'),
      `Key: ${regRes.body.recoveryKey}`
    );

    initialRecoveryKey = regRes.body.recoveryKey;
    userId = regRes.body.id;

    // 2. Login requiring 2FA
    console.log('\n--- 2. Login Flow with Telegram 2FA Interception ---');
    const loginRes = await makeRequest('POST', '/api/auth/login', {
      username: testUser,
      password: testPassword
    });

    logTest(
      'Login detects Telegram 2FA and requests OTP',
      loginRes.status === 200 && loginRes.body.require2FA === true && loginRes.body.tempToken,
      `TempToken received, Chat ID: ${loginRes.body.telegramChatId}`
    );

    const tempToken = loginRes.body.tempToken;

    // 3. Test Invalid OTP
    console.log('\n--- 3. OTP Validation: Invalid Code Handling ---');
    const invalidOtpRes = await makeRequest('POST', '/api/auth/2fa/verify', {
      tempToken,
      otp: '000000'
    });

    logTest(
      'Reject invalid OTP code',
      invalidOtpRes.status === 400,
      `Status: ${invalidOtpRes.status}`
    );

    // 4. Retrieve Active OTP from Database to simulate Telegram delivery
    console.log('\n--- 4. Valid OTP Verification ---');
    const otpFromDb = await queryDb(`SELECT twoFactorSecret FROM "User" WHERE id = '${userId}';`);

    const validOtpRes = await makeRequest('POST', '/api/auth/2fa/verify', {
      tempToken,
      otp: otpFromDb
    });

    logTest(
      'Verify valid 6-digit Telegram OTP and issue JWT session',
      validOtpRes.status === 200 && validOtpRes.body.token,
      `Session token granted for user: ${validOtpRes.body.username}`
    );

    userToken = validOtpRes.body.token;

    // 5. Test Authenticated Profile
    console.log('\n--- 5. Authenticated Profile & 2FA State ---');
    const profileRes = await makeRequest('GET', '/api/auth/profile', null, userToken);
    logTest(
      'Fetch profile with 2FA status',
      profileRes.status === 200 && profileRes.body.telegram2FAEnabled === true,
      `2FA Enabled: ${profileRes.body.telegram2FAEnabled}`
    );

    // 6. Emergency Break-Glass Recovery
    console.log('\n--- 6. Emergency Break-Glass Account Recovery ---');
    const breakGlassRes = await makeRequest('POST', '/api/auth/break-glass', {
      username: testUser,
      recoveryKey: initialRecoveryKey
    });

    logTest(
      'Execute Break-Glass Recovery (bypasses 2FA & rotates key)',
      breakGlassRes.status === 200 && breakGlassRes.body.token && breakGlassRes.body.newRecoveryKey,
      `New Recovery Key issued: ${breakGlassRes.body.newRecoveryKey}`
    );

    const rotatedKey = breakGlassRes.body.newRecoveryKey;

    // 7. Verify Old Key is Invalidated (Single-Use)
    console.log('\n--- 7. Single-Use Key Invalidation Check ---');
    const reuseOldKeyRes = await makeRequest('POST', '/api/auth/break-glass', {
      username: testUser,
      recoveryKey: initialRecoveryKey
    });

    logTest(
      'Reject previously used Break-Glass recovery key',
      reuseOldKeyRes.status === 401,
      `Status: ${reuseOldKeyRes.status}`
    );

    // 8. Verify Rotated Key Works
    console.log('\n--- 8. Verification of Rotated Key ---');
    const useRotatedKeyRes = await makeRequest('POST', '/api/auth/break-glass', {
      username: testUser,
      recoveryKey: rotatedKey
    });

    logTest(
      'Authenticate successfully with rotated Break-Glass key',
      useRotatedKeyRes.status === 200 && useRotatedKeyRes.body.token,
      'Recovery cycle validated'
    );

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 PHASE 3 TEST SUMMARY');
    console.log(`✅ Passed: ${passCount}`);
    console.log(`❌ Failed: ${failCount}`);
    console.log(`📈 Success Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%\n`);

    if (failCount === 0) {
      console.log('🎉 ALL PHASE 3 TESTS PASSED! Telegram 2FA & Break-Glass engine complete.\n');
      process.exit(0);
    } else {
      console.log(`⚠️ ${failCount} test(s) failed.\n`);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Phase 3 test execution error:', err.message);
    process.exit(1);
  }
}

runPhase3Tests();
