require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const { parse } = require('url');

// Test configuration
const PORT = process.env.PORT || 4001;
const API_BASE = process.env.API_BASE || `http://localhost:${PORT}`;
let TEST_COSTUME_ID = null;
let TEST_PROP_ID = null;
let TEST_LENS_ID = null;

// Test results tracking
let passCount = 0;
let failCount = 0;
const results = [];

// ============================================================================
// Helper: Make HTTP requests
// ============================================================================
function makeRequest(method, path, data = null) {
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

    // NOTE: no Authorization header. This deployment has no login and no
    // session tokens (see testNoAuthentication for why), so sending one would
    // only ever be a header the server ignores.

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve({ status: res.statusCode, body: parsed });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

// ============================================================================
// Helper: Log test results
// ============================================================================
function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  const message = `${status}: ${name}`;
  const fullMessage = details ? `${message} - ${details}` : message;
  
  console.log(fullMessage);
  results.push({ name, passed, details });

  if (passed) passCount++;
  else failCount++;
}

// ============================================================================
// PHASE 1: NO-AUTHENTICATION DEPLOYMENT
// ============================================================================
// This app is deliberately unauthenticated: it is a private single-user CMS
// and the operator secures it at the network/reverse-proxy boundary. These
// tests assert that CONTRACT, not a previous one.
//
// Asserting 404 on the old login routes is deliberate, not leftover cruft. It
// is the only thing that catches a partially-completed removal — if someone
// re-adds a route or a middleware that is no longer documented, /api/version's
// `authentication.scheme` still says "none" while the routes work, and this
// test is what makes that disagreement loud.
async function testNoAuthentication() {
  console.log('\n=== PHASE 1: NO-AUTHENTICATION DEPLOYMENT ===\n');

  const versionRes = await makeRequest('GET', '/api/version');
  const auth = (versionRes.body && versionRes.body.authentication) || {};

  logTest(
    'Version endpoint declares authentication is not required',
    versionRes.status === 200 && auth.required === false && auth.scheme === 'none',
    `required: ${auth.required}, scheme: ${auth.scheme}`
  );

  // Every route the old auth module served must now be gone. `/auth/profile`
  // is the one that matters most: it was the endpoint a viewer role was locked
  // out of, so its disappearance is the clearest proof the role system went.
  for (const route of ['/auth/register', '/auth/login', '/auth/profile', '/auth/refresh']) {
    const res = await makeRequest('GET', route);
    logTest(
      `Removed auth route stays gone: ${route}`,
      res.status === 404,
      `Status: ${res.status}`
    );
  }

  // A read and a write, both with no credentials of any kind.
  const unauthRead = await makeRequest('GET', '/costumes');
  logTest(
    'Allow unauthenticated read',
    unauthRead.status === 200,
    `Status: ${unauthRead.status}`
  );

  const unauthWrite = await makeRequest('POST', '/brands', {
    name: 'Unauthenticated Write Probe',
    slug: `unauth-probe-${Date.now()}`
  });
  logTest(
    'Allow unauthenticated write',
    unauthWrite.status === 201,
    `Status: ${unauthWrite.status}`
  );

  // Clean up the probe so a repeated run does not accumulate brands.
  if (unauthWrite.status === 201 && unauthWrite.body && unauthWrite.body.id) {
    await makeRequest('DELETE', `/brands/${unauthWrite.body.id}`);
  }
}

// ============================================================================
// PHASE 2: COSTUME ENDPOINT TESTS
// ============================================================================
async function testCostumes() {
  console.log('\n=== PHASE 2: COSTUME ENDPOINTS ===\n');

  // Create costume
  const createRes = await makeRequest('POST', '/costumes', {
    character: 'Test Character',
    fandom: 'Test Fandom',
    brand: 'Test Brand',
    size: 'M',
    notes: 'Test costume'
  });

  logTest(
    'Create new costume',
    createRes.status === 201 && createRes.body.id,
    `Status: ${createRes.status}`
  );

  if (createRes.body && createRes.body.id) {
    TEST_COSTUME_ID = createRes.body.id;
  }

  // List costumes
  const listRes = await makeRequest('GET', '/costumes');
  logTest(
    'List all costumes',
    listRes.status === 200 && Array.isArray(listRes.body.costumes),
    `Count: ${listRes.body.count}`
  );

  // Get single costume
  if (TEST_COSTUME_ID) {
    const getRes = await makeRequest('GET', `/costumes/${TEST_COSTUME_ID}`);
    logTest(
      'Get single costume',
      getRes.status === 200 && getRes.body.character,
      `Character: ${getRes.body.character}`
    );
  }

  // Filter costumes
  const filterRes = await makeRequest('GET', '/costumes?fandom=Test%20Fandom');
  logTest(
    'Filter costumes by fandom',
    filterRes.status === 200,
    `Status: ${filterRes.status}`
  );

  // Update costume
  if (TEST_COSTUME_ID) {
    const updateRes = await makeRequest('PUT', `/costumes/${TEST_COSTUME_ID}`, {
      status: 'ON_RENT',
      isFullset: true
    });

    logTest(
      'Update costume status',
      updateRes.status === 200,
      `Status: ${updateRes.status}`
    );
  }
}

// ============================================================================
// PHASE 3: PROPS ENDPOINT TESTS
// ============================================================================
async function testProps() {
  console.log('\n=== PHASE 3: PROPS ENDPOINTS ===\n');

  if (!TEST_COSTUME_ID) {
    console.log('Skipping props tests - no costume created');
    return;
  }

  // Create prop
  const createRes = await makeRequest('POST', '/props', {
    costumeId: TEST_COSTUME_ID,
    name: 'Test Prop',
    category: 'Weapon',
    location: 'Shelf A',
    condition: 'Good'
  });

  logTest(
    'Create new prop',
    createRes.status === 201 && createRes.body.id,
    `Status: ${createRes.status}`
  );

  if (createRes.body && createRes.body.id) {
    TEST_PROP_ID = createRes.body.id;
  }

  // List props
  const listRes = await makeRequest('GET', '/props');
  logTest(
    'List all props',
    listRes.status === 200 && Array.isArray(listRes.body.props),
    `Count: ${listRes.body.count}`
  );

  // Filter props by category
  const filterRes = await makeRequest('GET', '/props?category=Weapon');
  logTest(
    'Filter props by category',
    filterRes.status === 200,
    `Status: ${filterRes.status}`
  );

  // Get single prop
  if (TEST_PROP_ID) {
    const getRes = await makeRequest('GET', `/props/${TEST_PROP_ID}`);
    logTest(
      'Get single prop',
      getRes.status === 200 && getRes.body.name,
      `Prop: ${getRes.body.name}`
    );
  }
}

// ============================================================================
// PHASE 4: CONTACT LENSES ENDPOINT TESTS
// ============================================================================
async function testLenses() {
  console.log('\n=== PHASE 4: CONTACT LENSES ENDPOINTS ===\n');

  // Create lens
  const createRes = await makeRequest('POST', '/lenses', {
    character: 'Test Char',
    color: 'Blue',
    brand: 'TestLens',
    prescription: '-1.50',
    expiryDate: '2027-12-31'
  });

  logTest(
    'Create new contact lens record',
    createRes.status === 201 && createRes.body.id,
    `Status: ${createRes.status}`
  );

  if (createRes.body && createRes.body.id) {
    TEST_LENS_ID = createRes.body.id;
  }

  // List lenses
  const listRes = await makeRequest('GET', '/lenses');
  logTest(
    'List all contact lenses',
    listRes.status === 200 && Array.isArray(listRes.body.lenses),
    `Count: ${listRes.body.count}`
  );

  // Filter lenses by status
  const filterRes = await makeRequest('GET', '/lenses?status=ACTIVE');
  logTest(
    'Filter lenses by status',
    filterRes.status === 200,
    `Status: ${filterRes.status}`
  );

  // Get single lens
  if (TEST_LENS_ID) {
    const getRes = await makeRequest('GET', `/lenses/${TEST_LENS_ID}`);
    logTest(
      'Get single contact lens',
      getRes.status === 200 && getRes.body.color,
      `Color: ${getRes.body.color}`
    );
  }
}

// ============================================================================
// PHASE 5: ERROR HANDLING TESTS
// ============================================================================
async function testErrorHandling() {
  console.log('\n=== PHASE 5: ERROR HANDLING ===\n');

  // Missing required fields
  const missingFieldRes = await makeRequest('POST', '/costumes', {
    character: 'Test'
    // Missing fandom
  });

  logTest(
    'Reject request with missing required fields',
    missingFieldRes.status === 400,
    `Status: ${missingFieldRes.status}`
  );

  // Invalid costume ID
  const invalidIdRes = await makeRequest('GET', '/costumes/invalid-id');
  logTest(
    'Handle invalid costume ID',
    invalidIdRes.status === 500 || invalidIdRes.status === 404,
    `Status: ${invalidIdRes.status}`
  );

}

// ============================================================================
// PHASE 6: PERFORMANCE TESTS
// ============================================================================
async function testPerformance() {
  console.log('\n=== PHASE 6: PERFORMANCE ===\n');

  // Test server health endpoint
  const healthStart = Date.now();
  const healthRes = await makeRequest('GET', '/health');
  const healthTime = Date.now() - healthStart;

  logTest(
    'Health endpoint responds',
    healthRes.status === 200,
    `Status: ${healthRes.status}, Response time: ${healthTime}ms`
  );

  // Test API version endpoint
  const versionRes = await makeRequest('GET', '/api/version');
  logTest(
    'API version endpoint responds',
    versionRes.status === 200,
    `Status: ${versionRes.status}`
  );

  // Test list endpoint with multiple items
  const listStart = Date.now();
  const listRes = await makeRequest('GET', '/costumes');
  const listTime = Date.now() - listStart;

  logTest(
    'List endpoint performance acceptable',
    listTime < 1000,
    `Response time: ${listTime}ms`
  );
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================
async function runAllTests() {
  console.log('🧪 STARTING COMPREHENSIVE API TESTS\n');
  console.log('='.repeat(50));

  try {
    await testNoAuthentication();
    await testCostumes();
    await testProps();
    await testLenses();
    await testErrorHandling();
    await testPerformance();

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('\n📊 TEST SUMMARY');
    console.log(`✅ Passed: ${passCount}`);
    console.log(`❌ Failed: ${failCount}`);
    console.log(`📈 Success Rate: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%\n`);

    if (failCount === 0) {
      console.log('🎉 ALL TESTS PASSED! System ready for deployment.\n');
      process.exit(0);
    } else {
      console.log(`⚠️ ${failCount} test(s) failed. Please review and fix issues.\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n❌ Test execution failed:', error.message);
    process.exit(1);
  }
}

// Run tests
runAllTests();
