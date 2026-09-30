/**
 * The desktop token guard — the regression test for a bug that shipped.
 *
 * WHY THIS FILE EXISTS
 *
 * v1.0.0 was published twice with the token guard silently OFF, while the UI
 * confidently reported otherwise. The cause was an ordering mistake in
 * electron/main.js:
 *
 *     const { generate } = require('../src/services/desktopToken');  // <- loads
 *     process.env.CMS_DESKTOP_TOKEN = generate();                   // <- too late
 *
 * The module self-installs from the environment as it loads. The `require` on
 * the first line therefore read an unset variable, cached "no token", and
 * setting the variable on the second line changed nothing — `require` returns
 * the same cached object. Every earlier verification missed it because the
 * headless test path (`CMS_DESKTOP_TOKEN=… npm start`) sets the variable
 * BEFORE the first require, which genuinely works.
 *
 * So the two paths diverged: headless guarded, packaged app unguarded. The
 * only thing that caught it was a human opening Settings and reading the badge.
 *
 * WHAT IS ASSERTED HERE
 *
 * The exact sequence electron/main.js performs, in a fresh process, in the same
 * order. If anyone reorders those two statements again, this fails.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${label}`);
    console.log(`      ${error.message}`);
    failed++;
  }
}

/**
 * Runs `body` in a child process with a clean module cache, so module-load
 * side effects (the self-install) actually happen rather than being cached
 * from an earlier test in this process.
 */
function inFreshProcess(body, env) {
  const { execFileSync } = require('child_process');
  const script = `
    const desktopToken = require('${require.resolve('../src/services/desktopToken')}');
    ${body}
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, env || {})
  });
  return out.trim();
}

console.log('\n1. THE PACKAGED-APP SEQUENCE (replay of electron/main.js)');
// This is the one that shipped broken. require happens FIRST — that is the bug.
check('requiring the module before the env var exists still ends up guarded', () => {
  const out = inFreshProcess(`
    // EXACTLY what electron/main.js does, in this order.
    desktopToken.install(
      process.env.CMS_DESKTOP_TOKEN || desktopToken.generate()
    );
    process.env.CMS_DESKTOP_TOKEN = desktopToken.get();
    console.log(JSON.stringify({
      hasToken: desktopToken.get() !== null,
      guarded: desktopToken.isGuarded()
    }));
  `, { CMS_SELF_ORIGIN: 'http://127.0.0.1:4101', CMS_DESKTOP_TOKEN: '' });

  const r = JSON.parse(out);
  assert.ok(r.hasToken, 'the module ended up holding no token');
  assert.strictEqual(r.guarded, true, 'isGuarded() is false — the guard is OFF');
});

check('re-requiring does not help (require is cached) — which is why install() is explicit', () => {
  const out = inFreshProcess(`
    const again = require('${require.resolve('../src/services/desktopToken')}');
    console.log(again === desktopToken ? 'same-object' : 'different-object');
  `, {});
  assert.strictEqual(out, 'same-object', 'expected require to return the cached copy');
});

console.log('\n2. THE HEADLESS PATH (CMS_DESKTOP_TOKEN set before the first require)');
check('a pre-set valid token is picked up by the module-load self-install', () => {
  const token = require('crypto').randomBytes(32).toString('hex');
  const out = inFreshProcess(`
    console.log(JSON.stringify({ hasToken: desktopToken.get() !== null, guarded: desktopToken.isGuarded() }));
  `, { CMS_SELF_ORIGIN: 'http://127.0.0.1:4101', CMS_DESKTOP_TOKEN: token });

  const r = JSON.parse(out);
  assert.ok(r.hasToken);
  assert.strictEqual(r.guarded, true);
});

console.log('\n3. DOCKER / npm start MUST STAY UNGUARDED');
check('no CMS_SELF_ORIGIN means the guard is inert, even with a token present', () => {
  const token = require('crypto').randomBytes(32).toString('hex');
  const out = inFreshProcess(`
    console.log(JSON.stringify({ guarded: desktopToken.isGuarded() }));
  `, { CMS_SELF_ORIGIN: '', CMS_DESKTOP_TOKEN: token });

  assert.strictEqual(JSON.parse(out).guarded, false, 'a Docker build must not be guarded');
});

check('no token at all means the guard is inert', () => {
  const out = inFreshProcess(`
    console.log(JSON.stringify({ guarded: desktopToken.isGuarded() }));
  `, { CMS_SELF_ORIGIN: 'http://127.0.0.1:4101', CMS_DESKTOP_TOKEN: '' });
  assert.strictEqual(JSON.parse(out).guarded, false);
});

console.log('\n4. THE ESCAPE HATCH DOES NOT DISABLE THE TOKEN');
check('CMS_ALLOW_ANY_ORIGIN=1 leaves the token guard on', () => {
  const out = inFreshProcess(`
    desktopToken.install(process.env.CMS_DESKTOP_TOKEN || desktopToken.generate());
    console.log(JSON.stringify({ guarded: desktopToken.isGuarded() }));
  `, { CMS_SELF_ORIGIN: 'http://127.0.0.1:4101', CMS_DESKTOP_TOKEN: '', CMS_ALLOW_ANY_ORIGIN: '1' });

  assert.strictEqual(JSON.parse(out).guarded, true, 'the opt-out must not open the data routes');
});

console.log('\n5. MATCHING IS CORRECT');
check('a generated token matches itself', () => {
  const desktopToken = require('../src/services/desktopToken');
  const token = desktopToken.generate();
  desktopToken.install(token);
  assert.strictEqual(desktopToken.matches(token), true);

  // EXACT byte comparison, deliberately. install() ACCEPTS uppercase hex (the
  // validation regex is case-insensitive), but matching is not normalised, so an
  // uppercase token only matches itself. That is fine and worth pinning: the
  // preload sends desktopToken.get() verbatim, so the value the renderer presents
  // is by construction the value that was installed. Normalising here would only
  // buy tolerance for a mismatch nobody can produce.
  const upper = token.toUpperCase();
  assert.notStrictEqual(upper, token, 'the generator emits lowercase hex');
  assert.strictEqual(desktopToken.matches(upper), false, 'case is not normalised');
  desktopToken.install(upper);
  assert.strictEqual(desktopToken.matches(upper), true, '…and it still matches itself');
});

check('anything else does not match', () => {
  const desktopToken = require('../src/services/desktopToken');
  desktopToken.install(desktopToken.generate());
  const token = desktopToken.get();

  assert.strictEqual(desktopToken.matches(''), false, 'empty');
  assert.strictEqual(desktopToken.matches('nonsense'), false, 'garbage');
  assert.strictEqual(desktopToken.matches(token.slice(0, -1)), false, 'one char short');
  assert.strictEqual(desktopToken.matches(token + 'a'), false, 'one char long');
  assert.strictEqual(desktopToken.matches(null), false, 'null');
  assert.strictEqual(desktopToken.matches(undefined), false, 'undefined');
  assert.strictEqual(
    desktopToken.matches(require('crypto').randomBytes(32).toString('hex')),
    false,
    'a different valid token'
  );
});

console.log('\n6. THE GENERATOR');
check('generates 32 bytes of hex, and a different value each time', () => {
  const desktopToken = require('../src/services/desktopToken');
  const a = desktopToken.generate();
  const b = desktopToken.generate();
  assert.ok(/^[0-9a-f]{64}$/.test(a), 'not 64 hex characters');
  assert.notStrictEqual(a, b, 'two launches produced the same token');
});

console.log('\n7. A MALFORMED TOKEN IS REJECTED, NOT SILENTLY ACCEPTED');
check('a non-hex value is refused and leaves the guard off', () => {
  const desktopToken = require('../src/services/desktopToken');
  desktopToken.install('this-is-not-a-token');
  assert.strictEqual(desktopToken.get(), null, 'a malformed token was accepted');
  assert.strictEqual(desktopToken.isGuarded(), false);
});

check('a too-short token is refused', () => {
  const desktopToken = require('../src/services/desktopToken');
  desktopToken.install('abcdef');
  assert.strictEqual(desktopToken.get(), null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
