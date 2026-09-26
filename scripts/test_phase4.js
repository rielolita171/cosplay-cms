require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');

const PORT = process.env.PORT || 4001;
const API_BASE = process.env.API_BASE || `http://localhost:${PORT}`;
const API_KEY = process.env.API_KEY || 'default_test_key';

let passCount = 0;
let failCount = 0;

function makeRequest(path, apiKey = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, API_BASE);
    const options = {
      method: 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (apiKey) {
      options.headers['X-CMS-API-KEY'] = apiKey;
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
    req.end();
  });
}

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${name}${details ? ` - ${details}` : ''}`);
  if (passed) passCount++;
  else failCount++;
}

async function runPhase4Tests() {
  console.log('📬 STARTING PHASE 4: NOTIFICATIONS & N8N WEBHOOK TEST SUITE\n');
  console.log('='.repeat(60));

  try {
    // 1. Unauthenticated Request
    console.log('\n--- 1. API Key Security Enforcement ---');
    const noKeyRes = await makeRequest('/api/notifications/contact-lenses/expiring');
    logTest(
      'Reject request without X-CMS-API-KEY header',
      noKeyRes.status === 401,
      `Status: ${noKeyRes.status}`
    );

    // 2. Invalid API Key
    const badKeyRes = await makeRequest('/api/notifications/contact-lenses/expiring', 'wrong-key-123');
    logTest(
      'Reject request with invalid X-CMS-API-KEY',
      badKeyRes.status === 403,
      `Status: ${badKeyRes.status}`
    );

    // 3. Valid API Key - Default 14-day threshold
    console.log('\n--- 2. Contact Lens Expiry Query ---');
    const validKeyRes = await makeRequest('/api/notifications/contact-lenses/expiring', API_KEY);
    logTest(
      'Fetch expiring lenses with valid API key (default 14 days)',
      validKeyRes.status === 200 && validKeyRes.body.thresholdDays === 14 && Array.isArray(validKeyRes.body.items),
      `Threshold: ${validKeyRes.body.thresholdDays}, Count: ${validKeyRes.body.count}`
    );

    // 4. Custom Days Threshold (?days=60)
    console.log('\n--- 3. Custom Threshold Parameter Validation ---');
    const customDaysRes = await makeRequest('/api/notifications/contact-lenses/expiring?days=60', API_KEY);
    logTest(
      'Query with custom threshold (?days=60)',
      customDaysRes.status === 200 && customDaysRes.body.thresholdDays === 60,
      `Threshold: ${customDaysRes.body.thresholdDays}, Count: ${customDaysRes.body.count}`
    );

    // 5. Costumes On-Rent Notification Endpoint
    console.log('\n--- 4. Costumes On-Rent Query ---');
    const rentRes = await makeRequest('/api/notifications/costumes/on-rent', API_KEY);
    logTest(
      'Query costumes currently on rent',
      rentRes.status === 200 && Array.isArray(rentRes.body.items),
      `Count: ${rentRes.body.count}`
    );

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 PHASE 4 TEST SUMMARY');
    console.log(`✅ Passed: ${passCount}`);
    console.log(`❌ Failed: ${failCount}`);
    console.log(`📈 Success Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%\n`);

    if (failCount === 0) {
      console.log('🎉 ALL PHASE 4 TESTS PASSED! Notification endpoints ready for n8n.\n');
      process.exit(0);
    } else {
      console.log(`⚠️ ${failCount} test(s) failed.\n`);
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ Phase 4 test execution error:', err.message);
    process.exit(1);
  }
}

runPhase4Tests();
