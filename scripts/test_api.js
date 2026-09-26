require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const http = require('http');
const { parse } = require('url');

// Test configuration
const PORT = process.env.PORT || 4001;
const API_BASE = process.env.API_BASE || `http://localhost:${PORT}`;
let TOKEN = null;
let TEST_USER_ID = null;
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

    if (TOKEN) {
      options.headers.Authorization = `Bearer ${TOKEN}`;
    }

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
// PHASE 1: AUTHENTICATION TESTS
// ============================================================================
async function testAuthentication() {
  console.log('\n=== PHASE 1: AUTHENTICATION ===\n');

  // Register user
  const registerRes = await makeRequest('POST', '/auth/register', {
    username: `testuser${Date.now()}`,
    email: `test${Date.now()}@example.com`,
    password: 'TestPassword123!'
  });

  logTest(
    'Register new user',
    registerRes.status === 201 && registerRes.body.token,
    `Status: ${registerRes.status}`
  );

  if (registerRes.body && registerRes.body.token) {
    TOKEN = registerRes.body.token;
    TEST_USER_ID = registerRes.body.id;
  }

  // Login
  const loginRes = await makeRequest('POST', '/auth/login', {
    username: registerRes.body.username,
    password: 'TestPassword123!'
  });

  logTest(
    'Login with credentials',
    loginRes.status === 200 && loginRes.body.token,
    `Status: ${loginRes.status}`
  );

  // Get profile
  const profileRes = await makeRequest('GET', '/auth/profile');
  logTest(
    'Get authenticated user profile',
    profileRes.status === 200 && profileRes.body.username,
    `User: ${profileRes.body.username}`
  );

  // Refresh token
  const refreshRes = await makeRequest('POST', '/auth/refresh');
  logTest(
    'Refresh JWT token',
    refreshRes.status === 200 && refreshRes.body.token,
    `Status: ${refreshRes.status}`
  );

  if (refreshRes.body && refreshRes.body.token) {
    TOKEN = refreshRes.body.token;
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

  // Unauthenticated access (remove token)
  const savedToken = TOKEN;
  TOKEN = null;

  const unauthRes = await makeRequest('GET', '/auth/profile');
  logTest(
    'Reject unauthenticated access to protected endpoint',
    unauthRes.status === 401,
    `Status: ${unauthRes.status}`
  );

  TOKEN = savedToken;

  // Invalid token
  TOKEN = 'invalid.token.here';
  const invalidTokenRes = await makeRequest('GET', '/auth/profile');
  logTest(
    'Reject invalid JWT token',
    invalidTokenRes.status === 403,
    `Status: ${invalidTokenRes.status}`
  );

  TOKEN = savedToken;
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
    await testAuthentication();
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
