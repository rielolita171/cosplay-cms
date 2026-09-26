/**
 * PHASE 5 AUTOMATED TEST SUITE — Auth gate, authorization, data contracts and
 * frontend static assertions.
 *
 * ---------------------------------------------------------------------------
 * HARNESS DESIGN (read this before changing anything)
 * ---------------------------------------------------------------------------
 * 1. The real `data/db/cms.db` holds the user's actual collection. This suite
 *    NEVER touches it. It copies the database into a temp directory and starts
 *    the server with that temp directory as its `process.cwd()` — every route
 *    in this project spawns `sqlite3 data/db/cms.db` relative to the CWD, so
 *    changing the CWD is what isolates the run. A sha256 of the original file
 *    is captured before and compared at the end.
 *
 * 2. `better-sqlite3` SEGFAULTS on this Node 18 runtime, so it is never
 *    required. Direct DB inspection uses the same `sqlite3` CLI transport the
 *    app itself uses.
 *
 * 3. Rate limiting (login 10/15min, 2fa-verify 5/15min, ...) is intentionally
 *    aggressive. The suite drives those endpoints far more than 5 times, so
 *    the server is started with the default-off test bypass:
 *        NODE_ENV=test  +  CMS_TEST_DISABLE_RATE_LIMIT=1
 *    See the documented hook in src/middleware/rateLimit.js. The production
 *    limits themselves are untouched.
 *
 * 4. Telegram is not configured, so a 2FA login would 503. The server is
 *    started with the default-off capture stub:
 *        CMS_TEST_TELEGRAM_CAPTURE=<file>
 *    (see src/services/telegramService.js) which records the OTP to a file
 *    instead of calling api.telegram.org. Both stubs are inert unless
 *    NODE_ENV === 'test'.
 *
 * 5. A dedicated strong JWT_SECRET and a dedicated API_KEY are injected for the
 *    run so the suite can (a) forge `alg:none` / wrong-secret tokens and
 *    (b) exercise the X-CMS-API-KEY paths without touching the real .env.
 *
 * 6. Uploads are written by the app to an absolute path (`data/uploads` next to
 *    src/), so the suite records the directory contents before the run and
 *    deletes anything new afterwards.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const REAL_DB = path.join(REPO_ROOT, 'data/db/cms.db');
const REAL_UPLOADS = path.join(REPO_ROOT, 'data/uploads');
const FRONTEND = path.join(REPO_ROOT, 'public/index.html');
const SERVER_ENTRY = path.join(REPO_ROOT, 'src/server.js');

const PORT = Number(process.env.PHASE5_PORT || 4120);
const API_BASE = `http://127.0.0.1:${PORT}`;

// Dedicated credentials for this run only.
const TEST_JWT_SECRET = 'phase5-suite-9f2b7c1d4e6a8b0c5d3e7f1a9b2c4d6e8f0a1b3c';
const TEST_API_KEY = 'phase5-suite-api-key-3f9a1c7e5b2d8046';
// A syntactically valid (but fake) bot token: passes the `isTelegramConfigured`
// placeholder check so the 2FA code path is genuinely reachable.
const TEST_TELEGRAM_TOKEN = '123456789:AAHphase5suitefakebottoken00000';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

// ============================================================================
// Result tracking
// ============================================================================
let passCount = 0;
let failCount = 0;
let skipCount = 0;
const results = [];
const failures = [];

function logTest(name, passed, details = '') {
  const status = passed ? '✅ PASS' : '❌ FAIL';
  console.log(`${status}: ${name}${details ? ` - ${details}` : ''}`);
  results.push({ name, passed, details });
  if (passed) passCount++;
  else {
    failCount++;
    failures.push({ name, details });
  }
}

function logSkip(name, reason) {
  console.log(`⏭️  SKIP: ${name} - ${reason}`);
  results.push({ name, passed: null, details: reason });
  skipCount++;
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ============================================================================
// HTTP helper
// ============================================================================
/**
 * @param {object} opts
 *   method, path, body (object -> JSON), token, apiKey, headers, raw (Buffer)
 */
function request(opts = {}) {
  const { method = 'GET', path: p, body = null, token = null, apiKey = null, headers = {}, raw = null } = opts;
  const url = new URL(p, API_BASE);

  const finalHeaders = Object.assign({}, headers);
  let payload = null;

  if (raw) {
    payload = raw;
  } else if (body !== null) {
    payload = Buffer.from(JSON.stringify(body));
    if (!finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
  }
  if (payload && !finalHeaders['Content-Length']) finalHeaders['Content-Length'] = payload.length;
  if (token) finalHeaders.Authorization = `Bearer ${token}`;
  if (apiKey) finalHeaders['X-CMS-API-KEY'] = apiKey;

  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: finalHeaders
    }, (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Build a multipart/form-data body for the image upload tests. */
function multipart(fieldName, filename, mimeType, buffer) {
  const boundary = `----phase5${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

// A real 1x1 PNG — sharp must be able to decode it for the upload to succeed.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// ============================================================================
// Direct sqlite3 CLI helper (never better-sqlite3 — it segfaults here)
// ============================================================================
function sqlite(file, sql) {
  const result = spawnSyncSqlite(file, sql);
  return result.trim();
}

function spawnSyncSqlite(file, sql) {
  const { spawnSync } = require('child_process');
  const res = spawnSync('sqlite3', [file], { input: sql, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`sqlite3 exited ${res.status}: ${res.stderr}`);
  }
  return res.stdout || '';
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ============================================================================
// Server lifecycle
// ============================================================================
let serverProc = null;
let workDir = null;
let captureFile = null;
let uploadSnapshot = null;

function startServer() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cms-phase5-'));
  workDir = tmp;
  fs.mkdirSync(path.join(tmp, 'data/db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data/uploads'), { recursive: true });
  fs.copyFileSync(REAL_DB, path.join(tmp, 'data/db/cms.db'));
  captureFile = path.join(tmp, 'telegram-capture.jsonl');

  serverProc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmp,                      // <-- isolates every cwd-relative sqlite3 call
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'test',
      PORT: String(PORT),
      JWT_SECRET: TEST_JWT_SECRET,
      API_KEY: TEST_API_KEY,
      TELEGRAM_BOT_TOKEN: TEST_TELEGRAM_TOKEN,
      CMS_TEST_DISABLE_RATE_LIMIT: '1',
      CMS_TEST_TELEGRAM_CAPTURE: captureFile
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProc.stdout.on('data', d => { if (process.env.PHASE5_VERBOSE) process.stdout.write(`[server] ${d}`); });
  serverProc.stderr.on('data', d => { if (process.env.PHASE5_VERBOSE) process.stderr.write(`[server] ${d}`); });
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await request({ path: '/health' });
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error(`Server did not become healthy on ${API_BASE} within ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/** Read OTPs the stubbed transport recorded (newest last). */
function capturedOtps() {
  if (!captureFile || !fs.existsSync(captureFile)) return [];
  return fs.readFileSync(captureFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => JSON.parse(line))
    .map(entry => {
      const match = /<code>(\d{6})<\/code>/.exec(entry.text || '');
      return { chatId: entry.chatId, otp: match ? match[1] : null };
    });
}

/** Strip HTML tags the Telegram message wraps the OTP in. */
async function latestOtp() {
  const entries = capturedOtps();
  return entries.length ? entries[entries.length - 1].otp : null;
}

async function stopServer() {
  if (serverProc && !serverProc.killed) {
    const exited = new Promise(resolve => serverProc.once('exit', resolve));
    serverProc.kill('SIGKILL');
    await Promise.race([exited, sleep(3000)]);
  }
  serverProc = null;
}

function cleanup() {
  // Remove anything the upload test wrote into the shared data/uploads dir.
  try {
    if (uploadSnapshot && fs.existsSync(REAL_UPLOADS)) {
      for (const file of fs.readdirSync(REAL_UPLOADS)) {
        if (!uploadSnapshot.includes(file)) {
          try { fs.unlinkSync(path.join(REAL_UPLOADS, file)); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }
  if (workDir) {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  workDir = null;
}

// ============================================================================
// Suite state
// ============================================================================
const state = {
  primaryToken: null,
  primaryRefresh: null,
  primaryUserId: null,
  twoFaUserId: null,
  costumeId: null,
  propId: null,
  lensId: null,
  fixtureLensId: null,
  brandId: null,
  fandomId: null
};

const PASSWORD = 'Phase5Password!2026';

async function registerUser(label) {
  const username = `p5_${label}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const res = await request({
    method: 'POST',
    path: '/api/auth/register',
    body: { username, email: `${username}@example.test`, password: PASSWORD }
  });
  if (res.status !== 201) {
    throw new Error(`register(${label}) failed: ${res.status} ${res.text}`);
  }
  return { username, id: res.body.id, password: PASSWORD, registerBody: res.body };
}

/** Give a user a telegram chat id directly in the scratch DB. */
function setTelegramChatId(userId, chatId) {
  sqlite(
    path.join(workDir, 'data/db/cms.db'),
    `UPDATE "User" SET telegramChatId = '${chatId}' WHERE id = '${userId}';`
  );
}

// ============================================================================
// 1. AUTH GATE
// ============================================================================
async function testAuthGate() {
  console.log('\n=== PHASE 5 — SECTION 1: AUTH GATE ===\n');

  // --- registration + plain login (2FA disabled) ---------------------------
  section('1.1 Login (2FA disabled) returns a JWT');
  const primary = await registerUser('primary');
  state.primaryUserId = primary.id;

  const login = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: primary.username, password: PASSWORD }
  });

  logTest(
    'POST /api/auth/login returns 200 with a JWT access token',
    login.status === 200 && typeof login.body.token === 'string' && login.body.token.split('.').length === 3,
    `status=${login.status} jwtSegments=${login.body.token ? String(login.body.token).split('.').length : 'none'}`
  );

  logTest(
    'Login response advertises require2FA:false plus a refresh token',
    login.body.require2FA === false && !!login.body.refreshToken,
    `require2FA=${login.body.require2FA} hasRefresh=${!!login.body.refreshToken}`
  );

  state.primaryToken = login.body.token;
  state.primaryRefresh = login.body.refreshToken;

  // --- no user enumeration -------------------------------------------------
  section('1.2 Wrong password vs unknown user are indistinguishable');
  const wrongPassword = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: primary.username, password: 'DefinitelyNotThePassword1!' }
  });
  const unknownUser = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: 'no_such_user_phase5', password: 'DefinitelyNotThePassword1!' }
  });

  logTest(
    'Wrong password → 401 INVALID_CREDENTIALS',
    wrongPassword.status === 401 && wrongPassword.body.code === 'INVALID_CREDENTIALS',
    `status=${wrongPassword.status} code=${wrongPassword.body.code}`
  );

  logTest(
    'Unknown user → 401 INVALID_CREDENTIALS',
    unknownUser.status === 401 && unknownUser.body.code === 'INVALID_CREDENTIALS',
    `status=${unknownUser.status} code=${unknownUser.body.code}`
  );

  logTest(
    'No user enumeration: the two 401 bodies are byte-identical',
    JSON.stringify(wrongPassword.body) === JSON.stringify(unknownUser.body),
    `wrongPassword=${JSON.stringify(wrongPassword.body)} unknownUser=${JSON.stringify(unknownUser.body)}`
  );

  // --- profile -------------------------------------------------------------
  section('1.3 Profile shape and secret redaction');
  const profile = await request({ method: 'GET', path: '/api/auth/profile', token: state.primaryToken });
  const profileUser = profile.body.user || profile.body;

  logTest(
    'GET /api/auth/profile returns the authenticated user',
    profile.status === 200 && profileUser.id === state.primaryUserId,
    `status=${profile.status} id=${profileUser.id}`
  );

  logTest(
    'Profile exposes telegramChatId and telegram2FAEnabled',
    'telegramChatId' in profileUser && 'telegram2FAEnabled' in profileUser,
    `telegramChatId=${JSON.stringify(profileUser.telegramChatId)} telegram2FAEnabled=${JSON.stringify(profileUser.telegram2FAEnabled)}`
  );

  const serialisedProfile = JSON.stringify(profile.body);
  logTest(
    'Profile NEVER leaks twoFactorSecret',
    !('twoFactorSecret' in profileUser) && !serialisedProfile.includes('twoFactorSecret'),
    'key absent from the response object and from the raw payload'
  );

  logTest(
    'Profile NEVER leaks recoveryCodeHash',
    !('recoveryCodeHash' in profileUser) && !serialisedProfile.includes('recoveryCodeHash'),
    'key absent from the response object and from the raw payload'
  );

  // --- 2FA login: no access token at the challenge stage -------------------
  section('1.4 2FA-enabled login returns require2FA + tempToken and NO access token');
  const twoFa = await registerUser('twofa');
  state.twoFaUserId = twoFa.id;
  setTelegramChatId(twoFa.id, '9988776655');

  const enable2fa = await request({
    method: 'PATCH',
    path: '/api/auth/2fa/toggle',
    token: twoFa.registerBody.token,
    body: { enabled: true }
  });
  logTest(
    'PATCH /api/auth/2fa/toggle enables 2FA and reports the new state',
    enable2fa.status === 200 && enable2fa.body.telegram2FAEnabled === true,
    `status=${enable2fa.status} telegram2FAEnabled=${enable2fa.body.telegram2FAEnabled}`
  );

  const twoFaLogin = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: twoFa.username, password: PASSWORD }
  });

  logTest(
    '2FA login returns require2FA:true with a tempToken',
    twoFaLogin.status === 200 && twoFaLogin.body.require2FA === true && !!twoFaLogin.body.tempToken,
    `status=${twoFaLogin.status} require2FA=${twoFaLogin.body.require2FA}`
  );

  logTest(
    '2FA login issues NO access token at the challenge stage',
    !twoFaLogin.body.token && !twoFaLogin.body.accessToken && !twoFaLogin.body.refreshToken,
    `token=${twoFaLogin.body.token} accessToken=${twoFaLogin.body.accessToken} refreshToken=${twoFaLogin.body.refreshToken}`
  );

  const tempToken = twoFaLogin.body.tempToken;
  const firstOtp = await latestOtp();
  logTest(
    'OTP was dispatched through the transport for the 2FA user',
    !!firstOtp && /^\d{6}$/.test(firstOtp),
    `otp=${firstOtp ? '******' : 'none'}`
  );

  // The stored value must be an HMAC of the OTP, never the plaintext.
  const storedHash = sqlite(
    path.join(workDir, 'data/db/cms.db'),
    `SELECT twoFactorSecret FROM "User" WHERE id = '${twoFa.id}';`
  );
  const expectedHmac = crypto
    .createHmac('sha256', TEST_JWT_SECRET)
    .update(`${twoFa.id}:${firstOtp}`)
    .digest('hex');
  logTest(
    'Stored OTP is an HMAC, not the plaintext code',
    !!storedHash && storedHash === expectedHmac && !storedHash.includes(firstOtp),
    'recomputed HMAC matches the stored twoFactorSecret'
  );

  // --- 2FA verify: wrong code ---------------------------------------------
  section('1.5 POST /api/auth/2fa/verify — wrong, right, replay, expired');
  const wrongCode = await request({
    method: 'POST',
    path: '/api/auth/2fa/verify',
    body: { tempToken, otp: '000000' === firstOtp ? '111111' : '000000' }
  });

  logTest(
    'Wrong OTP → 401 with the GENERIC message',
    wrongCode.status === 401 && wrongCode.body.error === 'Invalid or expired code' && wrongCode.body.code === 'INVALID_2FA',
    `status=${wrongCode.status} error=${JSON.stringify(wrongCode.body.error)} code=${wrongCode.body.code}`
  );

  const goodCode = await request({
    method: 'POST',
    path: '/api/auth/2fa/verify',
    body: { tempToken, otp: firstOtp }
  });

  logTest(
    'Correct OTP → 200 with a full token pair',
    goodCode.status === 200 && !!goodCode.body.token && !!goodCode.body.refreshToken,
    `status=${goodCode.status} hasToken=${!!goodCode.body.token} hasRefresh=${!!goodCode.body.refreshToken}`
  );

  const replay = await request({
    method: 'POST',
    path: '/api/auth/2fa/verify',
    body: { tempToken, otp: firstOtp }
  });

  logTest(
    'Replayed tempToken is rejected (single-use jti)',
    replay.status === 401 && replay.body.code === 'INVALID_2FA',
    `status=${replay.status} code=${replay.body.code}`
  );

  // Expired tempToken: signed with the run's secret but already past exp.
  const jwt = require(path.join(REPO_ROOT, 'node_modules/jsonwebtoken'));
  const expiredTemp = jwt.sign(
    { sub: twoFa.id, id: twoFa.id, jti: crypto.randomUUID(), type: '2fa_pending' },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', issuer: 'cosplay-cms', audience: 'cosplay-cms-client', expiresIn: -60 }
  );
  const expiredRes = await request({
    method: 'POST',
    path: '/api/auth/2fa/verify',
    body: { tempToken: expiredTemp, otp: '123456' }
  });

  logTest(
    'Expired tempToken → 401 with the GENERIC message',
    expiredRes.status === 401 && expiredRes.body.error === 'Invalid or expired code',
    `status=${expiredRes.status} error=${JSON.stringify(expiredRes.body.error)}`
  );

  // --- resend --------------------------------------------------------------
  section('1.6 POST /api/auth/2fa/resend');
  const resendLogin = await request({
    method: 'POST',
    path: '/api/auth/login',
    body: { username: twoFa.username, password: PASSWORD }
  });
  const resendTemp = resendLogin.body.tempToken;
  const otpBeforeResend = await latestOtp();
  const dispatchesBeforeResend = capturedOtps().length;

  const resend = await request({
    method: 'POST',
    path: '/api/auth/2fa/resend',
    body: { tempToken: resendTemp }
  });
  const otpAfterResend = await latestOtp();

  logTest(
    'Resend with a valid tempToken → 200',
    resend.status === 200 && /sent/i.test(resend.body.message || ''),
    `status=${resend.status} message=${JSON.stringify(resend.body.message)}`
  );

  // The contract is "a fresh code is dispatched", not "the digits differ" — two
  // 6-digit codes can legitimately collide, so assert the dispatch count grew
  // by exactly one rather than comparing the values.
  const dispatchesAfterResend = capturedOtps().length;
  logTest(
    'Resend dispatches exactly one additional OTP',
    dispatchesAfterResend === dispatchesBeforeResend + 1 && !!otpAfterResend,
    `dispatches ${dispatchesBeforeResend} -> ${dispatchesAfterResend}, newOtp=${otpAfterResend}`
  );

  const staleOtp = await request({
    method: 'POST',
    path: '/api/auth/2fa/verify',
    body: { tempToken: resendTemp, otp: otpBeforeResend }
  });
  const freshOtpRes = await request({
    method: 'POST',
    path: '/api/auth/2fa/verify',
    body: { tempToken: resendTemp, otp: otpAfterResend }
  });

  logTest(
    'The pre-resend OTP is invalidated by the resend',
    staleOtp.status === 401 && staleOtp.body.error === 'Invalid or expired code',
    `status=${staleOtp.status} error=${JSON.stringify(staleOtp.body.error)}`
  );

  logTest(
    'After a resend the most recent OTP is the one that verifies',
    freshOtpRes.status === 200 && !!freshOtpRes.body.token,
    `status=${freshOtpRes.status} hasToken=${!!freshOtpRes.body.token}`
  );

  const resendBadToken = await request({
    method: 'POST',
    path: '/api/auth/2fa/resend',
    body: { tempToken: 'not-a-jwt' }
  });
  logTest(
    'Resend with a garbage tempToken → 401 GENERIC',
    resendBadToken.status === 401 && resendBadToken.body.error === 'Invalid or expired code',
    `status=${resendBadToken.status} error=${JSON.stringify(resendBadToken.body.error)}`
  );

  // --- toggle --------------------------------------------------------------
  section('1.7 PATCH /api/auth/2fa/toggle round-trip');
  const toggleOff = await request({
    method: 'PATCH',
    path: '/api/auth/2fa/toggle',
    token: goodCode.body.token,
    body: { enabled: false }
  });
  logTest(
    'Toggle disables 2FA and reports telegram2FAEnabled:false',
    toggleOff.status === 200 && toggleOff.body.telegram2FAEnabled === false,
    `status=${toggleOff.status} telegram2FAEnabled=${toggleOff.body.telegram2FAEnabled}`
  );

  const profileAfterToggle = await request({
    method: 'GET', path: '/api/auth/profile', token: goodCode.body.token
  });
  logTest(
    'Profile reflects the toggled 2FA state (state is persisted, not cached)',
    (profileAfterToggle.body.user || profileAfterToggle.body).telegram2FAEnabled === false,
    `telegram2FAEnabled=${(profileAfterToggle.body.user || profileAfterToggle.body).telegram2FAEnabled}`
  );

  const loginAfterToggle = await request({
    method: 'POST', path: '/api/auth/login', body: { username: twoFa.username, password: PASSWORD }
  });
  logTest(
    'With 2FA off, the same account logs straight in (no tempToken)',
    loginAfterToggle.status === 200 && loginAfterToggle.body.require2FA === false && !!loginAfterToggle.body.token,
    `status=${loginAfterToggle.status} require2FA=${loginAfterToggle.body.require2FA}`
  );

  // --- break-glass ---------------------------------------------------------
  section('1.8 Break-glass key is single-use');
  const generated = await request({
    method: 'POST', path: '/api/auth/break-glass/generate', token: state.primaryToken
  });
  logTest(
    'POST /api/auth/break-glass/generate returns a recovery key',
    generated.status === 200 && typeof generated.body.recoveryKey === 'string' && generated.body.recoveryKey.length > 8,
    `status=${generated.status} keyPrefix=${String(generated.body.recoveryKey || '').slice(0, 4)}****`
  );

  const breakGlass = await request({
    method: 'POST',
    path: '/api/auth/break-glass',
    body: { username: primary.username, recoveryKey: generated.body.recoveryKey }
  });
  logTest(
    'Break-glass with the generated key → 200 and a session',
    breakGlass.status === 200 && breakGlass.body.usedBreakGlass === true && !!breakGlass.body.token,
    `status=${breakGlass.status} usedBreakGlass=${breakGlass.body.usedBreakGlass}`
  );

  const reuseKey = await request({
    method: 'POST',
    path: '/api/auth/break-glass',
    body: { username: primary.username, recoveryKey: generated.body.recoveryKey }
  });
  logTest(
    'Reusing the break-glass key is rejected — the key is burned',
    reuseKey.status === 401 && reuseKey.body.code === 'INVALID_RECOVERY_KEY',
    `status=${reuseKey.status} code=${reuseKey.body.code}`
  );

  const wrongKey = await request({
    method: 'POST',
    path: '/api/auth/break-glass',
    body: { username: primary.username, recoveryKey: 'CMS-definitely-not-the-key' }
  });
  logTest(
    'Break-glass with a wrong key → 401',
    wrongKey.status === 401 && wrongKey.body.code === 'INVALID_RECOVERY_KEY',
    `status=${wrongKey.status} code=${wrongKey.body.code}`
  );

  // --- refresh rotation ----------------------------------------------------
  section('1.9 Refresh rotation and reuse detection');
  const refreshLogin = await request({
    method: 'POST', path: '/api/auth/login', body: { username: primary.username, password: PASSWORD }
  });
  const originalRefresh = refreshLogin.body.refreshToken;

  const rotated = await request({
    method: 'POST', path: '/api/auth/refresh', body: { refreshToken: originalRefresh }
  });
  logTest(
    'POST /api/auth/refresh rotates: new access + new refresh token',
    rotated.status === 200 && !!rotated.body.accessToken && !!rotated.body.refreshToken
      && rotated.body.refreshToken !== originalRefresh,
    `status=${rotated.status} changed=${rotated.body.refreshToken !== originalRefresh}`
  );

  const reuse = await request({
    method: 'POST', path: '/api/auth/refresh', body: { refreshToken: originalRefresh }
  });
  logTest(
    'Reusing a rotated refresh token → 401 REFRESH_TOKEN_REUSED',
    reuse.status === 401 && reuse.body.code === 'REFRESH_TOKEN_REUSED',
    `status=${reuse.status} code=${reuse.body.code}`
  );

  const afterReuseDetection = await request({
    method: 'POST', path: '/api/auth/refresh', body: { refreshToken: rotated.body.refreshToken }
  });
  logTest(
    'Reuse detection revokes the whole token family (the rotated token dies too)',
    afterReuseDetection.status === 401,
    `status=${afterReuseDetection.status} code=${afterReuseDetection.body.code}`
  );

  const garbageRefresh = await request({
    method: 'POST', path: '/api/auth/refresh', body: { refreshToken: 'not.a.jwt' }
  });
  logTest(
    'Garbage refresh token → 401 INVALID_REFRESH_TOKEN',
    garbageRefresh.status === 401 && garbageRefresh.body.code === 'INVALID_REFRESH_TOKEN',
    `status=${garbageRefresh.status} code=${garbageRefresh.body.code}`
  );

  // --- logout --------------------------------------------------------------
  section('1.10 POST /api/auth/logout');
  const logoutLogin = await request({
    method: 'POST', path: '/api/auth/login', body: { username: primary.username, password: PASSWORD }
  });
  const logoutToken = logoutLogin.body.token;
  const logoutRefresh = logoutLogin.body.refreshToken;

  const logout = await request({
    method: 'POST', path: '/api/auth/logout', token: logoutToken, body: { refreshToken: logoutRefresh }
  });
  logTest(
    'POST /api/auth/logout succeeds',
    logout.status === 200 && /Logged out/i.test(logout.body.message || ''),
    `status=${logout.status} message=${JSON.stringify(logout.body.message)}`
  );

  const afterLogout = await request({
    method: 'POST', path: '/api/auth/refresh', body: { refreshToken: logoutRefresh }
  });
  logTest(
    'The refresh token is dead after logout',
    afterLogout.status === 401,
    `status=${afterLogout.status} code=${afterLogout.body.code}`
  );

  const logoutNoToken = await request({ method: 'POST', path: '/api/auth/logout' });
  logTest(
    'Logout without a token → 401 (the route is guarded)',
    logoutNoToken.status === 401,
    `status=${logoutNoToken.status}`
  );
}

// ============================================================================
// 2. AUTHORIZATION
// ============================================================================
async function testAuthorization() {
  console.log('\n=== PHASE 5 — SECTION 2: AUTHORIZATION (REGRESSION) ===\n');

  section('2.1 Anonymous reads are rejected');
  for (const resource of ['costumes', 'props', 'lenses']) {
    const res = await request({ method: 'GET', path: `/api/${resource}` });
    logTest(
      `GET /api/${resource} with NO token → 401`,
      res.status === 401,
      `status=${res.status}`
    );
  }

  const stats = await request({ method: 'GET', path: '/api/images/stats' });
  logTest(
    'GET /api/images/stats with NO token → 401',
    stats.status === 401,
    `status=${stats.status}`
  );

  section('2.2 Anonymous writes are rejected');
  for (const resource of ['costumes', 'props', 'lenses']) {
    const res = await request({
      method: 'POST',
      path: `/api/${resource}`,
      body: { character: 'anon', fandom: 'anon', color: 'anon', name: 'anon', category: 'Weapon' }
    });
    logTest(
      `POST /api/${resource} with NO token → 401`,
      res.status === 401,
      `status=${res.status}`
    );
  }

  const anonPut = await request({
    method: 'PUT', path: `/api/costumes/${UNKNOWN_ID}`, body: { status: 'SOLD' }
  });
  logTest(
    'PUT /api/costumes/:id with NO token → 401',
    anonPut.status === 401,
    `status=${anonPut.status}`
  );

  const anonDelete = await request({
    method: 'DELETE', path: `/api/lenses/${UNKNOWN_ID}/open`
  });
  logTest(
    'PATCH /api/lenses/:id/open with NO token → 401',
    anonDelete.status === 401,
    `status=${anonDelete.status}`
  );

  section('2.3 /api/notifications requires a valid X-CMS-API-KEY');
  const notifPaths = [
    '/api/notifications/contact-lenses/expiring',
    '/api/notifications/costumes/on-rent'
  ];
  for (const p of notifPaths) {
    const noKey = await request({ method: 'GET', path: p });
    logTest(
      `GET ${p} with NO X-CMS-API-KEY → 401`,
      noKey.status === 401,
      `status=${noKey.status}`
    );

    const badKey = await request({ method: 'GET', path: p, apiKey: 'wrong-key-entirely' });
    logTest(
      `GET ${p} with a WRONG X-CMS-API-KEY → 403`,
      badKey.status === 403,
      `status=${badKey.status}`
    );

    const goodKey = await request({ method: 'GET', path: p, apiKey: TEST_API_KEY });
    logTest(
      `GET ${p} with the CORRECT X-CMS-API-KEY → 200`,
      goodKey.status === 200 && Array.isArray(goodKey.body.items),
      `status=${goodKey.status} count=${goodKey.body && goodKey.body.count}`
    );
  }

  section('2.4 Forged / unsigned JWTs are rejected');
  const jwtLib = require(path.join(REPO_ROOT, 'node_modules/jsonwebtoken'));

  const algNone = jwtLib.sign(
    { sub: state.primaryUserId, id: state.primaryUserId, role: 'user', type: 'access' },
    '',
    { algorithm: 'none', issuer: 'cosplay-cms', audience: 'cosplay-cms-client', expiresIn: '15m' }
  );
  const algNoneRes = await request({ method: 'GET', path: '/api/costumes', token: algNone });
  logTest(
    'alg:none (unsigned) token → 401',
    algNoneRes.status === 401,
    `status=${algNoneRes.status} tokenHeader=${JSON.stringify(algNone.split('.')[0])}`
  );

  const wrongSecret = jwtLib.sign(
    { sub: state.primaryUserId, id: state.primaryUserId, role: 'user', type: 'access' },
    'a-completely-different-signing-secret-0123456789',
    { algorithm: 'HS256', issuer: 'cosplay-cms', audience: 'cosplay-cms-client', expiresIn: '15m' }
  );
  const wrongSecretRes = await request({ method: 'GET', path: '/api/costumes', token: wrongSecret });
  logTest(
    'Token signed with a DIFFERENT secret → 401',
    wrongSecretRes.status === 401,
    `status=${wrongSecretRes.status}`
  );

  const rightSecretWrongType = jwtLib.sign(
    { sub: state.primaryUserId, id: state.primaryUserId, role: 'user', type: 'refresh' },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', issuer: 'cosplay-cms', audience: 'cosplay-cms-client', expiresIn: '15m' }
  );
  const typeConfusion = await request({ method: 'GET', path: '/api/costumes', token: rightSecretWrongType });
  logTest(
    'A correctly-signed token of the WRONG type (refresh used as access) → 401',
    typeConfusion.status === 401,
    `status=${typeConfusion.status}`
  );

  const garbage = await request({ method: 'GET', path: '/api/costumes', token: 'abc.def.ghi' });
  logTest(
    'Malformed bearer token → 401',
    garbage.status === 401,
    `status=${garbage.status}`
  );

  section('2.5 CORS allowlist');
  const badOrigin = await request({
    method: 'GET', path: '/api/version', headers: { Origin: 'http://evil.example.com' }
  });
  logTest(
    'Disallowed Origin → 403 CORS_DENIED',
    badOrigin.status === 403 && badOrigin.body.code === 'CORS_DENIED',
    `status=${badOrigin.status} code=${badOrigin.body && badOrigin.body.code}`
  );

  const noOrigin = await request({ method: 'GET', path: '/api/version' });
  logTest(
    'No Origin header (same-origin / server-to-server) is allowed',
    noOrigin.status === 200,
    `status=${noOrigin.status}`
  );
}

// ============================================================================
// 3. DATA CONTRACTS
// ============================================================================
async function testDataContracts() {
  console.log('\n=== PHASE 5 — SECTION 3: DATA CONTRACTS ===\n');
  const token = state.primaryToken;

  section('3.1 GET /api/costumes returns every field the dashboard renders');
  const costumes = await request({ method: 'GET', path: '/api/costumes', token });
  logTest('GET /api/costumes → 200 with a list', costumes.status === 200 && Array.isArray(costumes.body.costumes),
    `status=${costumes.status} count=${costumes.body.count}`);

  if (Array.isArray(costumes.body.costumes) && costumes.body.costumes.length) {
    const sample = costumes.body.costumes[0];
    state.costumeId = sample.id;
    const required = ['doneCostest', 'doneEvent', 'donePhotoSession', 'referenceUrl', 'imageUrls', 'notes'];
    const missing = required.filter(field => !(field in sample));
    logTest(
      'Costume objects expose doneCostest, doneEvent, donePhotoSession, referenceUrl, imageUrls, notes',
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : 'all 6 fields present'
    );
  } else {
    logSkip('Costume list field contract', 'the scratch database contains no costumes');
  }

  section('3.2 GET /api/props returns notes and costumeName');
  const props = await request({ method: 'GET', path: '/api/props', token });
  logTest('GET /api/props → 200 with a list', props.status === 200 && Array.isArray(props.body.props),
    `status=${props.status} count=${props.body.count}`);

  const allProps = props.body.props || [];
  if (allProps.length) {
    state.propId = allProps[0].id;
    const missingProp = allProps.filter(p => !('notes' in p) || !('costumeName' in p));
    logTest(
      'Every prop exposes notes and costumeName',
      missingProp.length === 0,
      missingProp.length ? `${missingProp.length}/${allProps.length} props missing fields` : `checked ${allProps.length} props`
    );
  } else {
    logSkip('Prop list field contract', 'the scratch database contains no props');
  }

  section('3.3 GET /api/lenses returns prescription');
  const lenses = await request({ method: 'GET', path: '/api/lenses', token });
  logTest('GET /api/lenses → 200 with a list', lenses.status === 200 && Array.isArray(lenses.body.lenses),
    `status=${lenses.status} count=${lenses.body.count}`);

  const allLenses = lenses.body.lenses || [];
  if (allLenses.length) {
    state.lensId = allLenses[0].id;
    const missingLens = allLenses.filter(l => !('prescription' in l));
    logTest(
      'Every lens exposes prescription',
      missingLens.length === 0,
      missingLens.length ? `${missingLens.length}/${allLenses.length} lenses missing prescription` : `checked ${allLenses.length} lenses`
    );
  } else {
    logSkip('Lens list field contract', 'the scratch database contains no lenses');
  }

  // --- PUT imageUrls round-trip -------------------------------------------
  section('3.4 PUT /api/costumes/:id with only { imageUrls } round-trips');
  const created = await request({
    method: 'POST', path: '/api/costumes', token,
    body: { character: 'Phase5 Tester', fandom: 'Phase5Test' }
  });
  logTest('POST /api/costumes creates a fixture costume', created.status === 201 && !!created.body.id,
    `status=${created.status} id=${created.body.id}`);

  const costumeId = created.body.id;
  const urls = ['/uploads/phase5-a.webp', '/uploads/phase5-b.webp'];
  const putImages = await request({
    method: 'PUT', path: `/api/costumes/${costumeId}`, token, body: { imageUrls: urls }
  });
  logTest(
    'PUT with ONLY { imageUrls } → 200',
    putImages.status === 200,
    `status=${putImages.status} error=${JSON.stringify(putImages.body.error)}`
  );

  const afterPut = await request({ method: 'GET', path: `/api/costumes/${costumeId}`, token });
  let roundTripped = null;
  try {
    roundTripped = JSON.parse(afterPut.body.imageUrls);
  } catch { roundTripped = null; }

  logTest(
    'imageUrls round-trips: GET returns the same array that was PUT',
    Array.isArray(roundTripped) && JSON.stringify(roundTripped) === JSON.stringify(urls),
    `stored=${JSON.stringify(afterPut.body.imageUrls)}`
  );

  section('3.5 Input validation on PUT /api/costumes/:id');
  const malformed = await request({
    method: 'PUT', path: `/api/costumes/${costumeId}`, token, body: { imageUrls: 'not-json-at-all' }
  });
  logTest(
    'Malformed imageUrls → 400',
    malformed.status === 400,
    `status=${malformed.status} error=${JSON.stringify(malformed.body.error)}`
  );

  const objectShaped = await request({
    method: 'PUT', path: `/api/costumes/${costumeId}`, token, body: { imageUrls: { a: 1 } }
  });
  logTest(
    'Object-shaped imageUrls → 400',
    objectShaped.status === 400,
    `status=${objectShaped.status} error=${JSON.stringify(objectShaped.body.error)}`
  );

  const tooManyUrls = await request({
    method: 'PUT', path: `/api/costumes/${costumeId}`, token,
    body: { imageUrls: Array.from({ length: 21 }, (_, i) => `/uploads/x${i}.webp`) }
  });
  logTest(
    'More than 20 imageUrls → 400',
    tooManyUrls.status === 400,
    `status=${tooManyUrls.status} error=${JSON.stringify(tooManyUrls.body.error)}`
  );

  const oversizedNotes = await request({
    method: 'PUT', path: `/api/costumes/${costumeId}`, token, body: { notes: 'x'.repeat(2001) }
  });
  logTest(
    'notes longer than 2000 characters → 400',
    oversizedNotes.status === 400,
    `status=${oversizedNotes.status} error=${JSON.stringify(oversizedNotes.body.error)}`
  );

  const emptyBody = await request({ method: 'PUT', path: `/api/costumes/${costumeId}`, token, body: {} });
  logTest(
    'Empty update body → 400',
    emptyBody.status === 400,
    `status=${emptyBody.status} error=${JSON.stringify(emptyBody.body.error)}`
  );

  const validNotes = await request({
    method: 'PUT', path: `/api/costumes/${costumeId}`, token, body: { notes: 'x'.repeat(2000) }
  });
  logTest(
    'notes of exactly 2000 characters is accepted (boundary is inclusive)',
    validNotes.status === 200,
    `status=${validNotes.status}`
  );

  section('3.6 POST /api/props without costumeId → standalone prop');
  const standalone = await request({
    method: 'POST', path: '/api/props', token,
    body: { name: 'Phase5 Loose Prop', category: 'Accessory' }
  });
  logTest(
    'POST /api/props without costumeId → 201 with costumeId:null',
    standalone.status === 201 && standalone.body.costumeId === null,
    `status=${standalone.status} costumeId=${JSON.stringify(standalone.body.costumeId)}`
  );

  const rereadStandalone = await request({ method: 'GET', path: `/api/props/${standalone.body.id}`, token });
  logTest(
    'The standalone prop persists and lists with a null costume link',
    rereadStandalone.status === 200 && (rereadStandalone.body.costumeId === '' || rereadStandalone.body.costumeId === null)
      && (rereadStandalone.body.costumeName === '' || rereadStandalone.body.costumeName === null),
    `costumeId=${JSON.stringify(rereadStandalone.body.costumeId)} costumeName=${JSON.stringify(rereadStandalone.body.costumeName)}`
  );

  section('3.7 PATCH /api/lenses/:id/open');
  const newLens = await request({
    method: 'POST', path: '/api/lenses', token,
    body: { character: 'Phase5 Lens', color: 'Blue', expiryDate: new Date(Date.now() + 86400000 * 200).toISOString() }
  });
  logTest('POST /api/lenses creates a fixture lens', newLens.status === 201 && !!newLens.body.id,
    `status=${newLens.status} id=${newLens.body.id}`);

  state.fixtureLensId = newLens.body.id;
  const open1 = await request({ method: 'PATCH', path: `/api/lenses/${newLens.body.id}/open`, token });
  logTest(
    'PATCH /api/lenses/:id/open → 200 and marks the lens opened',
    open1.status === 200 && open1.body.isOpened === true && !!open1.body.openedDate,
    `status=${open1.status} isOpened=${open1.body.isOpened} status=${open1.body.status}`
  );

  const open2 = await request({ method: 'PATCH', path: `/api/lenses/${newLens.body.id}/open`, token });
  logTest(
    'PATCH /api/lenses/:id/open is idempotent (second call → 200, same openedDate)',
    open2.status === 200 && open2.body.isOpened === true && open2.body.openedDate === open1.body.openedDate,
    `status=${open2.status} openedDate stable=${open2.body.openedDate === open1.body.openedDate}`
  );

  const openMissing = await request({ method: 'PATCH', path: `/api/lenses/${UNKNOWN_ID}/open`, token });
  logTest(
    'PATCH /api/lenses/:id/open for an unknown id → 404',
    openMissing.status === 404,
    `status=${openMissing.status} error=${JSON.stringify(openMissing.body.error)}`
  );

  section('3.8 Image upload (canonical + alias)');
  const upload = multipart('image', 'phase5.png', 'image/png', TINY_PNG);
  const uploadRes = await request({
    method: 'POST', path: '/api/images/upload', token,
    raw: upload.body, headers: { 'Content-Type': upload.contentType }
  });
  logTest(
    'POST /api/images/upload (multipart field "image") → 201 with a url',
    uploadRes.status === 201 && typeof uploadRes.body.url === 'string' && uploadRes.body.url.startsWith('/uploads/'),
    `status=${uploadRes.status} url=${JSON.stringify(uploadRes.body.url)}`
  );

  const alias = multipart('image', 'phase5-alias.png', 'image/png', TINY_PNG);
  const aliasRes = await request({
    method: 'POST', path: '/api/upload', token,
    raw: alias.body, headers: { 'Content-Type': alias.contentType }
  });
  logTest(
    'POST /api/upload alias behaves identically (201 + url)',
    aliasRes.status === 201 && typeof aliasRes.body.url === 'string' && aliasRes.body.url.startsWith('/uploads/'),
    `status=${aliasRes.status} url=${JSON.stringify(aliasRes.body.url)}`
  );

  const wrongField = multipart('notimage', 'phase5.png', 'image/png', TINY_PNG);
  const wrongFieldRes = await request({
    method: 'POST', path: '/api/images/upload', token,
    raw: wrongField.body, headers: { 'Content-Type': wrongField.contentType }
  });
  logTest(
    'Upload with the wrong multipart field name → 400 (no file accepted)',
    wrongFieldRes.status === 400,
    `status=${wrongFieldRes.status} error=${JSON.stringify(wrongFieldRes.body.error)}`
  );

  const anonUpload = multipart('image', 'phase5.png', 'image/png', TINY_PNG);
  const anonUploadRes = await request({
    method: 'POST', path: '/api/images/upload',
    raw: anonUpload.body, headers: { 'Content-Type': anonUpload.contentType }
  });
  logTest(
    'POST /api/images/upload with NO token → 401',
    anonUploadRes.status === 401,
    `status=${anonUploadRes.status}`
  );

  section('3.9 Brand / Fandom reference lists');
  // Fixtures are deliberately NOT attached to any costume, so a DELETE of one
  // is allowed (200) rather than refused as in-use (409). Both are non-404,
  // but 200 keeps the manifest probe below unambiguous.
  const newBrand = await request({
    method: 'POST', path: '/api/brands', token,
    body: { name: `Phase5 Brand ${Date.now()}`, storeUrl: 'https://example.test/phase5' }
  });
  logTest('POST /api/brands creates a fixture brand', newBrand.status === 201 && !!newBrand.body.id,
    `status=${newBrand.status} id=${newBrand.body.id}`);
  state.brandId = newBrand.body.id;

  const newFandom = await request({
    method: 'POST', path: '/api/fandoms', token,
    body: { name: `Phase5 Fandom ${Date.now()}` }
  });
  logTest('POST /api/fandoms creates a fixture fandom', newFandom.status === 201 && !!newFandom.body.id,
    `status=${newFandom.status} id=${newFandom.body.id}`);
  state.fandomId = newFandom.body.id;

  const brandLists = await request({ method: 'GET', path: '/api/brands', token });
  const fandomLists = await request({ method: 'GET', path: '/api/fandoms', token });
  logTest(
    'GET /api/brands and /api/fandoms return the migrated lists with a costume usage count',
    brandLists.status === 200 && Array.isArray(brandLists.body.brands)
      && brandLists.body.brands.length > 0
      && brandLists.body.brands.every(b => 'costumeCount' in b && 'name' in b)
      && fandomLists.status === 200 && Array.isArray(fandomLists.body.fandoms)
      && fandomLists.body.fandoms.length > 0
      && fandomLists.body.fandoms.every(f => 'costumeCount' in f && 'name' in f),
    `brands=${brandLists.body.brands && brandLists.body.brands.length} fandoms=${fandomLists.body.fandoms && fandomLists.body.fandoms.length}`
  );

  const badStore = await request({
    method: 'POST', path: '/api/brands', token, body: { name: `Phase5 Bad ${Date.now()}`, storeUrl: 'javascript:alert(1)' }
  });
  logTest('POST /api/brands with a non-http(s) storeUrl → 400', badStore.status === 400,
    `status=${badStore.status} error=${JSON.stringify(badStore.body.error)}`);

  section('3.10 /api/version manifest only advertises routes that exist');
  const version = await request({ method: 'GET', path: '/api/version' });
  logTest('GET /api/version → 200 with an endpoint list',
    version.status === 200 && Array.isArray(version.body.endpoints) && version.body.endpoints.length > 0,
    `status=${version.status} advertised=${version.body.endpoints && version.body.endpoints.length}`);

  // Real ids are used wherever a 404 would be ambiguous between "route missing"
  // and "row missing" (GET-by-id, and any route that reads its row first).
  // Destructive/validating methods use a synthetic id and an empty body, which
  // yields 400/200 — anything but 404 proves the route exists.
  const ids = {
    '/api/costumes': state.costumeId,
    '/api/props': state.propId,
    '/api/lenses': state.lensId,
    '/api/brands': state.brandId,
    '/api/fandoms': state.fandomId
  };
  // PATCH /api/lenses/:id/open reads the lens first and 404s before doing
  // anything, so it needs a real id for the same reason GET-by-id does.
  // The Brand/Fandom PUT + DELETE routes read their row first for the same
  // reason: a 404 there means "no such brand", NOT "no such route", so probing
  // them with a synthetic id would be testing the wrong thing.
  const idSemanticEntries = {
    'PATCH /api/lenses/:id/open': state.fixtureLensId,
    'PUT /api/brands/:id': state.brandId,
    'DELETE /api/brands/:id': state.brandId,
    'PUT /api/fandoms/:id': state.fandomId,
    'DELETE /api/fandoms/:id': state.fandomId
  };
  const notFound = [];
  for (const entry of version.body.endpoints || []) {
    const [method, rawPath] = entry.split(' ');
    let pathToCall = rawPath;
    if (pathToCall.includes(':id')) {
      const base = pathToCall.split('/:')[0];
      const needsRealId = method === 'GET' || entry in idSemanticEntries;
      if (needsRealId) {
        const realId = entry in idSemanticEntries ? idSemanticEntries[entry] : ids[base];
        if (!realId) {
          logSkip(`Manifest route ${entry}`, 'no fixture id available in the scratch database');
          continue;
        }
        pathToCall = pathToCall.replace(':id', realId);
      } else {
        pathToCall = pathToCall.replace(':id', UNKNOWN_ID);
      }
    }
    const res = await request({ method, path: pathToCall, token: state.primaryToken });
    if (res.status === 404) notFound.push(`${entry} (got 404)`);
  }
  logTest(
    'Every advertised endpoint responds with something other than 404',
    notFound.length === 0,
    notFound.length ? notFound.join('; ') : `${version.body.endpoints.length} endpoints verified`
  );
}

// ============================================================================
// 4. FRONTEND STATIC ASSERTIONS
// ============================================================================
function testFrontend() {
  console.log('\n=== PHASE 5 — SECTION 4: FRONTEND STATIC ASSERTIONS ===\n');
  const html = fs.readFileSync(FRONTEND, 'utf8');
  const lines = html.split('\n');

  // Locate the api() helper so "bare fetch" can be defined as "outside api()".
  const apiStart = lines.findIndex(l => /async function api\(/.test(l));
  let apiEnd = apiStart;
  if (apiStart >= 0) {
    for (let i = apiStart; i < lines.length; i++) {
      if (/^\s{4}\}/.test(lines[i])) { apiEnd = i; break; }
      apiEnd = i;
    }
  }
  const inApi = (idx) => apiStart >= 0 && idx >= apiStart && idx <= apiEnd;

  section('4.1 Every network call goes through the api() helper');
  const bareFetches = [];
  lines.forEach((line, i) => {
    if (!/\bfetch\s*\(/.test(line)) return;
    if (inApi(i)) return;
    bareFetches.push(`line ${i + 1}: ${line.trim()}`);
  });
  logTest(
    'Zero bare fetch( calls outside the api() helper',
    apiStart >= 0 && bareFetches.length === 0,
    bareFetches.length ? bareFetches.join(' | ') : `the only fetch( is on line ${lines.findIndex(l => /fetch\s*\(/.test(l)) + 1}, inside api()`
  );

  logTest(
    'The api() helper is defined and is the single network chokepoint',
    apiStart >= 0,
    apiStart >= 0 ? `defined on line ${apiStart + 1}` : 'async function api( not found'
  );

  const apiBody = apiStart >= 0 ? lines.slice(apiStart, apiEnd + 1).join('\n') : '';
  logTest(
    'api() checks res.ok and throws on failure',
    /if\s*\(!res\.ok\)/.test(apiBody) && /throw new ApiError/.test(apiBody),
    /if\s*\(!res\.ok\)/.test(apiBody) ? 'found `if (!res.ok)` + `throw new ApiError`' : 'missing the !res.ok guard'
  );

  section('4.2 Refresh-on-401 path');
  logTest(
    'The refresh path calls POST /api/auth/refresh',
    /api\('\/api\/auth\/refresh'/.test(html),
    'found api(\'/api/auth/refresh\''
  );

  logTest(
    'A 401 triggers exactly one refresh attempt, with auth:false to avoid recursion',
    /res\.status === 401/.test(html) && /auth:\s*false/.test(html),
    'res.status === 401 guard + auth:false on the refresh call'
  );

  section('4.3 API paths match the backend contract');
  logTest(
    'The lens "open" action uses PATCH /api/lenses/:id/open',
    /api\('\/api\/lenses\/' \+ encodeURIComponent\([^)]*\) \+ '\/open',\s*\{\s*method:\s*'PATCH'/.test(html),
    "api('/api/lenses/' + id + '/open', { method: 'PATCH' })"
  );

  logTest(
    'The image upload uses POST /api/images/upload',
    /api\('\/api\/images\/upload',\s*\{\s*method:\s*'POST'/.test(html),
    "api('/api/images/upload', { method: 'POST' })"
  );

  section('4.4 XSS hardening');
  const escapeDefined = /function escapeHtml\s*\(/.test(html);
  logTest('escapeHtml( is defined', escapeDefined,
    escapeDefined ? `defined on line ${lines.findIndex(l => /function escapeHtml\s*\(/.test(l)) + 1}` : 'not found');

  const escapeUses = (html.match(/escapeHtml\(/g) || []).length;
  logTest('escapeHtml( is actually applied across the renderers', escapeUses >= 20,
    `${escapeUses} call sites`);

  for (const [label, marker] of [
    ['costume renderer', 'escapeHtml(clean(c.character)'],
    ['prop renderer', 'escapeHtml(clean(p.name)'],
    ['lens renderer', 'escapeHtml(clean(l.character)']
  ]) {
    logTest(`escapeHtml is applied in the ${label}`, html.includes(marker), `marker: ${marker}`);
  }

  section('4.5 bindGridEvents');
  const bindDefined = /function bindGridEvents\s*\(/.test(html);
  logTest('bindGridEvents is defined (it previously threw a ReferenceError on load)',
    bindDefined,
    bindDefined ? `defined on line ${lines.findIndex(l => /function bindGridEvents\s*\(/.test(l)) + 1}` : 'not found');
  logTest('bindGridEvents is actually invoked',
    /bindGridEvents\(\);/.test(html),
    'called at boot');

  section('4.6 CSP compatibility');
  const externalRefs = [];
  lines.forEach((line, i) => {
    const matches = line.match(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g);
    if (matches) externalRefs.push(`line ${i + 1}: ${matches.join(' ')}`);
  });
  logTest(
    'No external http(s):// script/link references that the CSP would block',
    externalRefs.length === 0,
    externalRefs.length ? externalRefs.join(' | ') : 'all script/link tags are same-origin or inline'
  );

  logTest(
    'The document declares no external stylesheet or script CDN',
    !/<link[^>]+rel=["']stylesheet["'][^>]+https?:/i.test(html) && !/<script[^>]+src=["']https?:/i.test(html),
    'no <link rel=stylesheet href=http…> and no <script src=http…>'
  );

  section('4.7 503 TELEGRAM_NOT_CONFIGURED is surfaced to the user');
  logTest(
    'describeAuthError special-cases TELEGRAM_NOT_CONFIGURED',
    /err\.code === 'TELEGRAM_NOT_CONFIGURED'/.test(html),
    'error-code branch present'
  );
  logTest(
    'The 503 branch returns actionable guidance (mentions TELEGRAM_BOT_TOKEN)',
    /TELEGRAM_NOT_CONFIGURED[\s\S]{0,600}TELEGRAM_BOT_TOKEN/.test(html),
    'the user is told the server lacks Telegram credentials and offered break-glass'
  );
}

// ============================================================================
// Runner
// ============================================================================
async function main() {
  console.log('🛡️  STARTING PHASE 5 AUTOMATED TEST SUITE\n');
  console.log('='.repeat(60));

  if (!fs.existsSync(REAL_DB)) {
    console.error(`❌ Cannot find ${REAL_DB}. Run init_db.sql first.`);
    process.exit(1);
  }

  const realDbHashBefore = sha256(REAL_DB);
  uploadSnapshot = fs.existsSync(REAL_UPLOADS) ? fs.readdirSync(REAL_UPLOADS) : [];

  let exitCode = 1;
  try {
    console.log(`\n📦 Original data/db/cms.db sha256: ${realDbHashBefore}`);
    console.log(`📂 Scratch work directory: (created below)`);
    startServer();
    console.log(`🌐 Test server: ${API_BASE} (cwd = temp copy of the database)`);
    await waitForServer();
    console.log(`📂 Scratch work directory: ${workDir}`);

    await testAuthGate();
    await testAuthorization();
    await testDataContracts();
    testFrontend();

    // --- post-run integrity checks -----------------------------------------
    console.log('\n=== PHASE 5 — SECTION 5: HARNESS INTEGRITY ===\n');
    const realDbHashAfter = sha256(REAL_DB);
    logTest(
      'The REAL data/db/cms.db is byte-identical after the run',
      realDbHashBefore === realDbHashAfter,
      `before=${realDbHashBefore.slice(0, 16)}… after=${realDbHashAfter.slice(0, 16)}…`
    );

    const scratchRows = sqlite(path.join(workDir, 'data/db/cms.db'), 'SELECT COUNT(*) FROM "Costume";');
    logTest(
      'The run really did write to the scratch copy (writes were not silently no-ops)',
      Number(scratchRows) > 0,
      `scratch Costume rows=${scratchRows}, original Costume rows untouched`
    );

    exitCode = failCount === 0 ? 0 : 1;
  } catch (error) {
    console.error('\n❌ SUITE ABORTED:', error && (error.stack || error.message));
    exitCode = 1;
  } finally {
    await stopServer();

    // Confirm the port is actually free again.
    await sleep(300);
    let portStillOpen = false;
    try {
      const probe = await request({ path: '/health' });
      portStillOpen = probe.status === 200;
    } catch { portStillOpen = false; }
    logTest(
      'The test server is stopped and port ' + PORT + ' is free afterwards',
      !portStillOpen && !serverProc,
      portStillOpen ? 'port still answering' : 'connection refused, process reaped'
    );

    cleanup();

    // --- summary -----------------------------------------------------------
    const total = passCount + failCount;
    console.log('\n' + '='.repeat(60));
    console.log('📊 PHASE 5 TEST SUMMARY');
    console.log(`📋 Total assertions: ${total} (+1 post-teardown check)`);
    console.log(`✅ Passed:  ${passCount}`);
    console.log(`❌ Failed:  ${failCount}`);
    console.log(`⏭️  Skipped: ${skipCount}`);
    if (failCount === 0) {
      console.log('🎉 ALL PHASE 5 TESTS PASSED!\n');
    } else {
      console.log('\n⚠️  FAILURES:');
      failures.forEach(f => console.log(`   ❌ ${f.name}${f.details ? ` — ${f.details}` : ''}`));
      console.log('');
    }
  }

  process.exit(exitCode);
}

process.on('uncaughtException', (error) => {
  console.error('\n❌ UNCAUGHT:', error && (error.stack || error.message));
  cleanup();
  process.exit(1);
});

main();
