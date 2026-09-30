#!/usr/bin/env node
/**
 * Download the sqlite3 CLI into resources/sqlite3/ so electron-builder can ship
 * it via extraResources.
 *
 * WHY THIS SCRIPT HAS TO EXIST
 *
 * This project has no in-process SQLite binding. Every query in src/ is a
 * short-lived `spawn('sqlite3', [DB_FILE])` child process. The Dockerfile proves
 * the consequence explicitly by installing sqlite3 via apt-get and failing the
 * boot when `command -v sqlite3` comes back empty.
 *
 * electron-builder bundles exactly the files listed in its config. A system
 * binary is not among them, so a packaged app would contain no SQLite whatsoever:
 * the window would open, /health would return 200, and every data route would
 * fail. Copying /usr/bin/sqlite3 into resources/ during a build made on this
 * machine would "work" while producing an installer broken on every other
 * machine, so the correct binary is downloaded per target platform instead.
 *
 * It runs as a BUILD hook, NOT at app start, so the network is required at build
 * time only. A shipped app never fetches anything — which matters because the
 * trust model here has no authentication, and a component that downloads an
 * executable on first run would be a serious hole in it.
 *
 * Usage:
 *   node scripts/fetch_sqlite.js                      # target = this machine
 *   node scripts/fetch_sqlite.js --platform=win      # target = Windows
 *   node scripts/fetch_sqlite.js --platform=linux --force
 *
 * --platform MATTERS WHEN CROSS-COMPILING. Building a Windows installer from
 * Linux, the build host is still Linux, so defaulting to `process.platform`
 * would download the LINUX sqlite3 binary and bundle it into the .exe installer
 * — producing an app that installs fine and then fails on the first database
 * query with a bad-executable error. The target platform must therefore be an
 * explicit input, and the output is written to a per-platform directory so
 * several targets can coexist and electron-builder can pick the right one.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// Per-platform output root: resources/sqlite3/<platform>-<arch>/.
//
// PER-PLATSUBDIRECTORY, NOT ONE SHARED DIR, and that is required for
// cross-compiling. If everything landed in resources/sqlite3/, fetching the
// Windows binary on a Linux build host would overwrite the Linux one, and the
// two builds could not coexist in one checkout. electron-builder's `win` and
// `linux` blocks each point extraResources at their own subdirectory.
const OUT_ROOT = path.join(ROOT, 'resources', 'sqlite3');

/**
 * Pinned deliberately. An unpinned "latest" URL means an installer built today
 * and one built next month ship different SQLite versions, which is exactly the
 * kind of drift that becomes a support problem months later.
 */
const SQLITE_VERSION = '3.45.1';

/**
 * sqlite.org encodes the version in filenames as 3XXYY00 so that a plain `ls`
 * sorts them in version order — 3.45.1 is 3450100. Using the dotted version here
 * yields a 404, which is exactly the bug this constant exists to prevent.
 */
const BUILD_ID = '3450100';

/** Release year folder on sqlite.org. */
const YEAR = '2024';

const BASE = `https://www.sqlite.org/${YEAR}`;

/**
 * Official precompiled CLI tools, per target.
 *
 * These exist for all three desktop platforms, so the common path requires NO C
 * compiler at all — the build-from-source fallback below is only for platforms
 * with no published binary (e.g. macOS arm64 at this version).
 *
 * macOS arm64 is absent for 3450100; `mac` falls back to the x64 build, which
 * runs under Rosetta 2. That is a real trade-off, not an oversight, and the
 * message printed when it happens says so.
 */
const PRECOMPILED = {
  linux: `${BASE}/sqlite-tools-linux-x64-${BUILD_ID}.zip`,
  win: `${BASE}/sqlite-tools-win-x64-${BUILD_ID}.zip`,
  mac: `${BASE}/sqlite-tools-osx-x64-${BUILD_ID}.zip`
};

/** Source used only when no precompiled binary exists for the target. */
const AMALGAMATION = `${BASE}/sqlite-amalgamation-${BUILD_ID}.zip`;

function targetFor(platform, arch) {
  if (platform === 'win32') return 'win';
  if (platform === 'darwin') return 'mac';
  return 'linux';
}

function get(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // sqlite.org 302s to a CDN for the large downloads. Follow, but bounded —
      // an unbounded redirect loop on a build machine is a hang, not a warning.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft === 0) return reject(new Error('Too many redirects'));
        res.resume();
        return resolve(get(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function findBinary(dir, wantExe) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) {
      const hit = findBinary(full, wantExe);
      if (hit) return hit;
    } else if (wantExe ? /^sqlite3\.exe$/i.test(entry) : /^sqlite3$/i.test(entry)) {
      return full;
    }
  }
  return null;
}

/** Read --name=value from argv, with a fallback. */
function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

/**
 * Map a user-supplied target name to this script's internal keys.
 * Accepts win/win32/windows, mac/macOS/darwin, linux.
 */
function normalizeTarget(value) {
  const v = String(value).toLowerCase();
  if (v.startsWith('win')) return 'win';
  if (v.startsWith('mac') || v === 'darwin') return 'mac';
  if (v.startsWith('linux')) return 'linux';
  throw new Error(
    `Unknown --platform "${value}". Use one of: win, mac, linux.`
  );
}

async function main() {
  const force = process.argv.includes('--force');

  // DEFAULT TO THE HOST, but let --platform override it — that override is the
  // whole reason cross-compiling works.
  const hostTarget = targetFor(process.platform, process.arch);
  const target = normalizeTarget(arg('platform', hostTarget));
  const arch = arg('arch', 'x64');

  const isWindows = target === 'win';
  const OUT_DIR = path.join(OUT_ROOT, `${target}-${arch}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const dest = path.join(OUT_DIR, isWindows ? 'sqlite3.exe' : 'sqlite3');

  // Guard against the silent-corruption case this script exists to prevent:
  // a PE binary ("MZ" magic) is required for Windows, an ELF one ("\x7fELF")
  // for everything else. If a wrong-platform binary is ever packaged, fail HERE
  // rather than on a user's machine at the first query.
  const magic = fs.existsSync(dest) ? fs.readFileSync(dest).subarray(0, 2) : null;
  const looksWindows = magic && magic.toString('latin1') === 'MZ';
  const looksElf = magic && magic[0] === 0x7f && magic[1] === 0x45;

  if (fs.existsSync(dest) && !force) {
    const wrong = isWindows ? (looksElf ? ' (ELF — wrong platform!)' : '')
      : (looksWindows ? ' (PE/Windows — wrong platform!)' : '');
    if (wrong) throw new Error(`${dest} exists but is the wrong platform${wrong}. Re-run with --force.`);
    console.log(`[fetch_sqlite] already present: ${dest} (use --force to re-download)`);
    return;
  }

  console.log(`[fetch_sqlite] target: ${target}/${arch}`);
  console.log(`[fetch_sqlite] host:  ${process.platform}/${process.arch}`);
  console.log(`[fetch_sqlite] sqlite: ${SQLITE_VERSION} (build ${BUILD_ID})`);

  const precompiled = PRECOMPILED[target];

  if (precompiled) {
    if (target === 'mac' && arch === 'arm64') {
      // Stated plainly rather than silently shipping an x64 binary that needs
      // Rosetta: on an Apple Silicon Mac without Rosetta installed, the app
      // would fail at the first query with a confusing "bad CPU type" error.
      console.log(
        '[fetch_sqlite] NOTE: no arm64 build published for this version —\n' +
        '                using the x64 build, which requires Rosetta 2.'
      );
    }

    console.log('[fetch_sqlite] downloading official precompiled CLI...');
    const zipPath = path.join(os.tmpdir(), 'sqlite-tools.zip');
    fs.writeFileSync(zipPath, await get(precompiled));

    const extractDir = path.join(os.tmpdir(), 'sqlite-tools');
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.mkdirSync(extractDir, { recursive: true });

    // unzip ships on Debian/Ubuntu; tar.exe understands zip on Windows 10+.
    // Trying both keeps this working on a build host without adding a dependency.
    try {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', extractDir], { stdio: 'inherit' });
    } catch (_) {
      execFileSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'inherit' });
    }

    // The zip nests everything under a versioned directory, so search rather
    // than assume a depth — that layout changes between releases.
    const found = findBinary(extractDir, isWindows);
    if (!found) throw new Error('sqlite3 binary not found inside the downloaded archive');

    fs.copyFileSync(found, dest);
  } else {
    // No precompiled binary for this platform. Build from the amalgamation — the
    // same C source the official tools above are themselves compiled from.
    console.log(
      '[fetch_sqlite] no precompiled binary for this platform — building from\n' +
      '                the SQLite amalgamation (requires cc/gcc/clang).'
    );

    const srcZip = path.join(os.tmpdir(), 'sqlite-amalgamation.zip');
    fs.writeFileSync(srcZip, await get(AMALGAMATION));

    const buildDir = path.join(os.tmpdir(), 'sqlite-amalgamation');
    fs.rmSync(buildDir, { recursive: true, force: true });
    fs.mkdirSync(buildDir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', srcZip, '-d', buildDir], { stdio: 'inherit' });

    const root = fs.readdirSync(buildDir)
      .map((d) => path.join(buildDir, d))
      .find((d) => fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, 'sqlite3.c')));

    if (!root) throw new Error('sqlite3.c not found in the amalgamation archive');

    // shell.c is the CLI driver — it is what turns `sqlite3 file.sql` into a
    // runnable program, and it ships in the amalgamation for exactly this use.
    const cSource = path.join(root, 'shell.c');
    if (!fs.existsSync(cSource)) {
      throw new Error('shell.c missing from the amalgamation — cannot build the CLI');
    }

    const out = path.join(buildDir, 'sqlite3-built');
    execFileSync('cc', [
      '-O2', '-o', out,
      cSource, path.join(root, 'sqlite3.c'),
      '-I', root, '-lpthread', '-ldl', '-lm'
    ], { stdio: 'inherit' });

    fs.copyFileSync(out, dest);
  }

  fs.chmodSync(dest, 0o755);

  // Prove the artifact is usable BEFORE a build packages it. Catching a
  // truncated download or a wrong-platform binary here is far cheaper than
  // discovering it as a broken installer on someone else's desktop.
  //
  // Two different checks, because the honest one differs by target:
  //   - Cross-compiling (target !== host): the binary CANNOT be executed here —
  //     a Windows PE will not run on Linux. Verify the magic bytes instead,
  //     which is exactly the property that would otherwise fail silently.
  //   - Native target: execute it. A real `--version` catches a missing shared
  //     library and a wrong-CPU build, which magic bytes cannot detect.
  const head = fs.readFileSync(dest).subarray(0, 2);
  const isPE = head.toString('latin1') === 'MZ';
  const isELF = head[0] === 0x7f && head[1] === 0x45;

  if (isWindows && !isPE) {
    throw new Error(`${dest} is not a Windows PE executable (bad magic: ${head.toString('hex')}).`);
  }
  if (!isWindows && !isELF) {
    throw new Error(`${dest} is not an ELF executable (bad magic: ${head.toString('hex')}).`);
  }

  const isCrossCompile = target !== normalizeTarget(targetFor(process.platform, process.arch));

  if (isCrossCompile) {
    console.log(`[fetch_sqlite] wrote ${dest}`);
    console.log(
      `[fetch_sqlite] verified: ${isWindows ? 'PE/Windows' : 'ELF'} header OK ` +
      `(cannot execute a ${target} binary on ${process.platform})`
    );
  } else {
    const version = execFileSync(dest, ['--version'], { encoding: 'utf8' }).trim();
    console.log(`[fetch_sqlite] wrote ${dest}`);
    console.log(`[fetch_sqlite] verified: ${version}`);
  }
}

main().catch((error) => {
  console.error(`\n[fetch_sqlite] FAILED: ${error.message}\n`);
  console.error('  A packaged app cannot ship without the sqlite3 binary, because');
  console.error('  the app spawns it for every query and has no in-process driver.\n');
  process.exit(1);
});
