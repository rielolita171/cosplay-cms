#!/usr/bin/env node
/**
 * The brand assets the APP serves, as opposed to the ones the Pages site uses.
 *
 * WHY THIS EXISTS
 * public/assets/ is a set of hand-copied files. Nothing generates them, nothing
 * checks them, and a missing or renamed one fails SILENTLY: a <link> pointing at
 * a 404 renders as the browser's default globe icon rather than as an error, so
 * the branding quietly disappears and the page still works perfectly.
 *
 * That is exactly the failure this suite guards. The favicon has three
 * independent consumers — the page's <link> tags, iOS via apple-touch-icon, and
 * the Electron window/taskbar icon — and each needs a real file at a path nobody
 * derived from anything.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'public', 'assets');
const client = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function section(title) { console.log('\n' + title); }

function main() {
  section('1. The app has its own copy of the brand assets');
  // express.static(PUBLIC_DIR) mounts ONLY public/, so the root assets/ folder is
  // unreachable from the running app. A link to it renders on the Pages site and
  // 404s in the app, which is why these copies exist.
  check('public/assets/ exists', fs.existsSync(ASSETS));
  check('the header mark is present', fs.existsSync(path.join(ASSETS, 'mark.svg')));
  check('the favicon source is present', fs.existsSync(path.join(ASSETS, 'favicon.svg')));

  section('2. The favicon SVG is well formed and square');
  const svg = fs.readFileSync(path.join(ASSETS, 'favicon.svg'), 'utf8');

  // A single root <svg> with nothing after it. A botched edit that appends the
  // new body after the old one produces exactly this and still reads fine.
  check('there is exactly one </svg>', (svg.match(/<\/svg>/g) || []).length === 1);
  check('the document opens with <svg', svg.trimStart().startsWith('<svg'));

  const vb = svg.match(/viewBox="([\d.\-\s]+)"/);
  check('it declares a viewBox', !!vb);
  if (vb) {
    const nums = vb[1].trim().split(/\s+/).map(Number);
    check('the viewBox has four numbers', nums.length === 4, vb[1]);
    check('the viewBox is SQUARE — a non-square favicon is letterboxed',
      nums[2] === nums[3], nums[2] + ' x ' + nums[3]);
    // The artwork spans roughly x 13..70, y 12..54. A viewBox starting at 0 with
    // slack on both sides is what stops the ears being clipped at 16px.
    check('it leaves margin at the top (ears not clipped)', nums[1] <= 11, 'y at ' + nums[1]);
    check('and at the left (ear not clipped)', nums[0] <= 12, 'x at ' + nums[0]);
  }

  check('it uses the DARK accents, not the muted light set',
    /#38BDF8/.test(svg) && /#FBBF24/.test(svg) && !/#06B6D4/.test(svg),
    'the muted #06B6D4 stitch is invisible against dark browser chrome');

  section('3. Every icon the page declares actually exists');
  // Each href resolved and checked on disk — this is the assertion that turns a
  // silent 404 into a test failure.
  const links = [...client.matchAll(/<link[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/g)]
    .map(m => m[0]);
  check('the page declares icon links', links.length >= 2, 'found ' + links.length);

  links.forEach(tag => {
    const href = tag.match(/href="([^"]+)"/);
    if (!href) { check('a declared icon has an href', false, tag); return; }
    const rel = (tag.match(/rel="([^"]+)"/) || [, '?'])[1];
    check('rel="' + rel + '" → ' + path.basename(href[1]) + ' exists',
      fs.existsSync(path.join(ASSETS, path.basename(href[1]))));
    // Relative, not absolute: a /assets/... href stops working if the app is ever
    // served from a subdirectory, which is how the Electron build loads it.
    check('  …and is relative', !href[1].startsWith('/'), href[1]);
  });

  section('4. The PNG fallbacks match the sizes that reference them');
  // A PNG whose real dimensions differ from its name gets upscaled into a blur.
  [16, 32, 48, 64, 180, 192, 256, 512].forEach(size => {
    const file = path.join(ASSETS, 'favicon-' + size + '.png');
    if (!fs.existsSync(file)) { check('favicon-' + size + '.png exists', false); return; }
    const buf = fs.readFileSync(file);
    check('favicon-' + size + '.png is really ' + size + 'x' + size,
      buf.readUInt32BE(16) === size && buf.readUInt32BE(20) === size,
      buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20));
  });

  section('5. favicon.ico is a REAL ICO, not a renamed PNG');
  // A previous hand-exported set shipped `favicon.ico` that was a PNG with the
  // extension changed. Some consumers accept that; the Windows shell and older
  // Safari do not, and they fail SILENTLY by showing the default globe. The magic
  // bytes are the only reliable check — `file` and the extension both lie.
  const icoPath = path.join(ASSETS, 'favicon.ico');
  check('favicon.ico exists', fs.existsSync(icoPath));
  if (fs.existsSync(icoPath)) {
    const ico = fs.readFileSync(icoPath);
    const isPngMagic = ico[0] === 0x89 && ico[1] === 0x50 && ico[2] === 0x4e && ico[3] === 0x47;
    check('it is NOT a renamed PNG', !isPngMagic,
      'first bytes are the PNG signature');
    // ICONDIR: reserved(2)=0, type(2)=1, count(2)
    check('it starts with the ICO header',
      ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1,
      'reserved=' + ico.readUInt16LE(0) + ' type=' + ico.readUInt16LE(2));

    const frames = ico.readUInt16LE(4);
    check('it carries several sizes', frames >= 3, frames + ' frames');

    // Read the directory: 16 bytes per entry, width/height as single bytes where
    // 0 means 256.
    const found = [];
    for (let i = 0; i < frames; i++) {
      const o = 6 + i * 16;
      found.push(ico[o] === 0 ? 256 : ico[o]);
    }
    [16, 32, 48].forEach(s => {
      check('it includes a ' + s + 'x' + s + ' frame', found.includes(s),
        'frames: ' + found.join(', '));
    });

    // A 256px frame is stored UNCOMPRESSED and took the file from 34KB to 172KB
    // for a size no favicon consumer samples. Guard the weight, not just presence.
    check('it carries no 256px frame (uncompressed, and never sampled)',
      !found.includes(256), 'frames: ' + found.join(', '));
    check('favicon.ico stays small enough to ship',
      ico.length < 80 * 1024, (ico.length / 1024).toFixed(0) + 'KB');
  }

  section('6. The published copies are identical to the source');
  // assets/ is the canonical source and public/assets/ is what the app serves.
  // They are separate files, so they can drift. A stale published icon is
  // invisible: the page still loads, it just shows yesterday's artwork.
  const SRC = path.join(ROOT, 'assets');
  const iconFiles = fs.readdirSync(SRC).filter(f => f.startsWith('favicon'));
  check('the source folder holds an icon set', iconFiles.length >= 3,
    iconFiles.join(', '));

  iconFiles.forEach(name => {
    const a = fs.readFileSync(path.join(SRC, name));
    const bPath = path.join(ASSETS, name);
    if (!fs.existsSync(bPath)) { check(name + ' is published', false); return; }
    check(name + ' is published byte-identically',
      Buffer.compare(a, fs.readFileSync(bPath)) === 0,
      'published copy differs — re-run node scripts/build_icons.js');
  });

  check('the icon set is rebuildable by a script, not by hand',
    fs.existsSync(path.join(ROOT, 'scripts/build_icons.js')));

  section('7. The Electron window icon points at a packaged file');
  // electron-builder packages public/**/*, so the icon must live under public/
  // to exist inside the asar. The repo's root assets/ folder would work in
  // `npm run electron:dev` and break in a built app.
  const mainJs = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  check('createWindow() sets an icon', /icon:\s*path\.join\(__dirname/.test(mainJs));
  check('it resolves through public/assets',
    /icon:\s*path\.join\(__dirname, '\.\.', 'public', 'assets', 'favicon-\d+\.png'\)/.test(mainJs));
  const used = mainJs.match(/icon:\s*path\.join\([^)]*favicon-(\d+)\.png/);
  check('the file it names exists',
    !!used && fs.existsSync(path.join(ASSETS, 'favicon-' + used[1] + '.png')),
    used ? 'favicon-' + used[1] + '.png' : 'no icon path found');

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  check('electron-builder packages public/**/* so the icon ships',
    ((pkg.build && pkg.build.files) || []).includes('public/**/*'));
}

main();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);