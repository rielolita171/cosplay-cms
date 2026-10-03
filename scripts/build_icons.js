#!/usr/bin/env node
/**
 * Rebuild the favicon set from the ONE source drawing.
 *
 * WHY A SCRIPT
 * assets/favicon.svg is the only hand-edited icon file. Everything else — the
 * PNG ladder and the multi-size .ico — is DERIVED from it, and every consumer
 * (Chrome, Safari, the Windows shell, iOS, Electron) needs a different size or
 * container. Deriving them by hand is how the set drifts: someone exports a
 * 32x32, someone else exports a 64x64, and the two stop matching.
 *
 * A previous set of hand-exported files is exactly how this came up — it shipped
 * a `favicon.ico` that was really a PNG with the extension renamed, which some
 * consumers accept and others silently refuse.
 *
 * WHAT IT DOES
 *   1. Renders the PNG ladder with `sharp` (the repo's only image dependency).
 *   2. Builds a REAL multi-frame .ico with ImageMagick, which is the only thing
 *      on the box that writes the ICO container format. If `convert` is missing
 *      the .ico step is SKIPPED with a warning rather than failing the build —
 *      every other icon still regenerates, and the previous .ico is left alone.
 *   3. Copies the whole set to public/assets/, which is what the running app
 *      serves (express.static mounts only public/).
 *
 * The ICO deliberately stops at 64x64. A 256px frame is stored UNCOMPRESSED in
 * the ICO container, which took the file from 34KB to 172KB for a frame no
 * favicon consumer ever samples — a tab is 16–32px, the Windows shell reads 32.
 * Anything needing more uses the PNG.
 *
 * USAGE
 *   node scripts/build_icons.js
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'public', 'assets');
const SVG = path.join(SRC, 'favicon.svg');

// The PNG ladder, and which consumer each size exists for.
const PNG_SIZES = [16, 32, 48, 64, 180, 192, 256, 512];

// The frames packed into the .ico. See the note above on why 256 is absent.
const ICO_SIZES = [16, 24, 32, 48, 64];

function log(msg) { console.log(msg); }

async function main() {
  if (!fs.existsSync(SVG)) {
    console.error('✗ assets/favicon.svg is missing — nothing to build from.');
    process.exit(1);
  }

  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.error('✗ sharp is not installed. Run `npm install` first.');
    process.exit(1);
  }

  const svg = fs.readFileSync(SVG);

  log('Rendering the PNG ladder from assets/favicon.svg …');
  for (const size of PNG_SIZES) {
    // `density` is set well above 72 because the SVG is drawn on a 68x68
    // viewBox: at the default density a 512px request would rasterise the
    // vector at its natural size and then upscale, which is visibly soft.
    await sharp(svg, { density: 1200 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(path.join(SRC, 'favicon-' + size + '.png'));
    log('  favicon-' + size + '.png');
  }

  // -------------------------------------------------------------------------
  // The .ico
  // -------------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cosplay-ico-'));
  try {
    const frames = ICO_SIZES.map(size => {
      const png = path.join(tmp, size + '.png');
      execFileSync('convert', [
        '-background', 'none',
        SVG,
        '-resize', size + 'x' + size,
        png
      ], { stdio: 'ignore' });
      return png;
    });

    const ico = path.join(SRC, 'favicon.ico');
    execFileSync('convert', [...frames, ico], { stdio: 'ignore' });
    log('  favicon.ico (' + ICO_SIZES.join('/') + ')');

    // A .ico whose first bytes are the PNG magic is a renamed PNG, not an icon.
    // That file was shipped once already, so it is checked rather than assumed.
    const head = fs.readFileSync(ico).subarray(0, 4);
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    if (isPng) {
      console.error('✗ favicon.ico is a renamed PNG, not an ICO container.');
      process.exit(1);
    }
  } catch (error) {
    console.warn('⚠️  Could not build favicon.ico (' + error.message + ').');
    console.warn('   ImageMagick\'s `convert` is required for the .ico only —');
    console.warn('   every PNG above was still regenerated. Install it and re-run.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Publish to public/assets/
  // -------------------------------------------------------------------------
  log('Publishing to public/assets/ …');
  fs.mkdirSync(OUT, { recursive: true });
  const files = ['favicon.svg', 'favicon.ico']
    .concat(PNG_SIZES.map(s => 'favicon-' + s + '.png'));
  for (const name of files) {
    fs.copyFileSync(path.join(SRC, name), path.join(OUT, name));
  }
  log('  ' + files.length + ' files copied');

  log('\n✓ Icon set rebuilt.');
}

main().catch(error => {
  console.error('✗ ' + error.message);
  process.exit(1);
});