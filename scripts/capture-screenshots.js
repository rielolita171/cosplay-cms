#!/usr/bin/env node
/**
 * scripts/capture-screenshots.js
 *
 * Regenerates the four GitHub Pages screenshots in docs/assets/screenshots/
 * from the REAL running app, using the REAL data in data/db/cms.db.
 *
 * WHAT THIS SCRIPT IS FOR
 * `.github/workflows/pages.yml` checks that the four files exist before it
 * publishes the site, and docs/index.html tells readers to run
 *   node scripts/capture-screenshots.js
 * whenever they change the UI. Until now neither instruction was runnable --
 * the file did not exist -- so the published screenshots froze at whatever
 * the UI looked like when they were first taken, while the alt text on the
 * site kept describing features that had since changed underneath it.
 *
 * WHY NO Puppeteer / Playwright
 * Adding a browser-automation dependency for a script that runs a handful of
 * times (once whenever the UI changes) is not worth it: it drags a browser
 * download into `npm install` for every person who clones this repo to work on
 * the app itself. Chrome is already a dev dependency of this workflow (see
 * the cached Chrome-for-Testing build), so this script talks to Chrome
 * directly over the DevTools Protocol using Node built-ins only.
 *
 * Two approaches were possible:
 *   1. `chrome --headless --screenshot=... --virtual-time-budget=5000`
 *   2. a ~100 line CDP client (this script)
 * (1) is shorter but it cannot answer "has the grid actually drawn yet?". This
 * app lazy-loads a tab panel the first time you switch to it, fills it by
 * shelling out to a per-query `sqlite3` subprocess, and only then swaps
 * skeleton placeholders for real cards whose <img> thumbnails still have to
 * download 272 files out of data/uploads. `virtual-time-budget` fires on a
 * timer, so it happily captures a panel of grey skeleton blocks and writes
 * that to disk as a "screenshot". The client below instead polls the real
 * rendered state -- cards present, no skeleton, every visible <img> decoded --
 * and refuses to write anything it is not sure about. A blank PNG in
 * docs/assets/ is worse than no PNG at all: the site's four
 * width="2880" height="1800" <img> elements would still reserve the right box
 * and the reader would get a grey rectangle.
 *
 * WHY deviceScaleFactor MUST BE 2
 * docs/index.html declares `width="2880" height="1800"` on all four <img>
 * elements and the stylesheet sizes the frame from those attributes -- that is
 * what lets the browser reserve the box before a ~1.6 MB PNG decodes, which
 * matters because dashboard.png is the page's LCP element. Those numbers are
 * the 1440x900 CSS viewport at 2x, so the capture must be 2x too. Capturing at
 * 1x and letting the site scale it would shrink the declared box to half the
 * layout the page was designed around. The script asserts the real PNG header
 * dimensions before it writes a single byte and aborts on a mismatch, so a
 * mis-sized capture can never reach git.
 *
 * READ-ONLY BY CONSTRUCTION
 * This script starts the server, navigates to it, and reads pixels. It issues
 * no POST/PUT/DELETE, never runs scripts/import_excel.js, and never touches
 * data/. The only network traffic it generates is GET.
 *
 * USAGE
 *   node scripts/capture-screenshots.js [options]
 *
 *   --port <n>          port to serve on (default 4001, or $PORT)
 *   --out <dir>         output directory (default docs/assets/screenshots)
 *   --chrome <path>     Chrome/Chromium binary (default $CHROME_PATH, then the
 *                       cached Chrome-for-Testing build, then Brave)
 *   --keep-server       leave the server running when the script exits
 *   --use-running       adopt a server that is ALREADY serving this app on
 *                       --port instead of starting one (it is then never
 *                       stopped, even without --keep-server)
 *   --only <a,b,c>      re-shoot only the named files (default: all four)
 *   --help              print this header
 *
 * EXIT CODES
 *   0  every requested file was written and verified
 *   1  anything else -- the message on stderr says what and why
 */

'use strict';

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// The four captures. The filenames and the dimensions are load-bearing: the
// site references exactly these four and `pages.yml` asserts each one exists.
// ---------------------------------------------------------------------------

const VIEWPORT_W = 1440;
const VIEWPORT_H = 900;
const SCALE = 2;

const SHOTS = [
  {
    file: 'dashboard.png',
    hash: '#costumes',
    scrollTo: 0,
    // docs/index.html calls this one "the dashboard: five metric cards ... above
    // the tab navigation", so it has to be the untouched boot view at scroll 0.
    requireMetrics: true,
    grids: ['costumes-grid'],
  },
  {
    file: 'costumes.png',
    hash: '#costumes',
    // Same tab as dashboard.png, scrolled just past the fold so the frame is
    // actually the card grid this caption describes ("thumbnails, fandom,
    // character, brand, size, status badges and prices") instead of a second
    // copy of the header. The Size filter is on the toolbar just above.
    scrollTo: 430,
    grids: ['costumes-grid'],
  },
  {
    file: 'props.png',
    hash: '#props',
    scrollTo: 0,
    grids: ['props-grid'],
  },
  {
    file: 'reference-lists.png',
    hash: '#lists',
    scrollTo: 0,
    grids: ['brands-grid', 'fandoms-grid'],
  },
];

// A file this small is a blank page, not a screenshot of 86 costumes. The
// smallest current capture (props.png) is ~800 KB; this floor is low enough to
// stay out of the way but far above what a solid-dark-theme 2x viewport with a
// handful of thin text rows would produce.
const MIN_BYTES = 120 * 1024;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.PORT) || 4001,
    out: path.join(ROOT, 'docs/assets/screenshots'),
    chrome: process.env.CHROME_PATH || null,
    keepServer: false,
    useRunning: false,
    only: null,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--out') opts.out = path.resolve(process.cwd(), argv[++i]);
    else if (a === '--chrome') opts.chrome = argv[++i];
    else if (a === '--keep-server') opts.keepServer = true;
    else if (a === '--use-running') opts.useRunning = true;
    else if (a === '--only') opts.only = String(argv[++i]).split(',').map(s => s.trim());
    else throw new Error(`unknown option: ${a}`);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`--port must be a valid port number, got ${opts.port}`);
  }
  if (opts.only) {
    const known = new Set(SHOTS.map(s => s.file));
    for (const f of opts.only) {
      if (!known.has(f)) throw new Error(`--only: unknown screenshot "${f}"`);
    }
  }
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function firstExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichSync(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir && firstExecutable(path.join(dir, bin))) return path.join(dir, bin);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chrome discovery. Prefer Chrome for Testing (the build this repo's other
// tooling already caches) and fall back to a system Brave/Chromium.
// ---------------------------------------------------------------------------

function findChrome(explicit) {
  const candidates = [];
  const tried = [];
  if (explicit) candidates.push(explicit);
  // Chrome-for-Testing as installed by any prior puppeteer install. Globbed by
  // directory name rather than hardcoded so a newer build still resolves.
  const puppeteerRoot = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (fs.existsSync(puppeteerRoot)) {
    for (const ver of fs.readdirSync(puppeteerRoot)) {
      candidates.push(
        path.join(puppeteerRoot, ver, 'chrome-linux64', 'chrome'),
        path.join(puppeteerRoot, ver, 'chrome-linux', 'chrome')
      );
    }
  }
  candidates.push(
    '/opt/brave.com/brave/brave-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  );
  for (const c of candidates) {
    if (!c) continue;
    tried.push(c);
    if (firstExecutable(c)) return c;
  }
  throw new Error(
    'no Chrome/Chromium binary found. Tried:\n  ' + tried.join('\n  ') +
    '\nPass --chrome <path> or set CHROME_PATH.'
  );
}

// ---------------------------------------------------------------------------
// Server lifecycle
//
// NOTE ON NOT USING pkill: the README warns that `pkill -f src/server.js` also
// matches every other dev server on the box, and this repo is routinely run two
// or three times over on different ports. We only ever signal the single child
// we spawned ourselves, tracked by handle.
// ---------------------------------------------------------------------------

function get(port, urlPath, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: urlPath, timeout: timeoutMs },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function isThisApp(port) {
  const res = await get(port, '/health');
  if (!res || res.status !== 200) return false;
  // /health is tiny; some unrelated service answering 200 with a page of HTML
  // is not us, and treating it as us would mean screenshotting that instead.
  return /ok|healthy/i.test(res.body) && res.body.length < 200;
}

async function waitForHealth(port, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await isThisApp(port)) return true;
    await sleep(250);
  }
  return false;
}

function portInUse(port) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
}

async function startServer(port) {
  if (await isThisApp(port)) {
    throw new Error(
      `port ${port} is ALREADY serving this app.\n` +
      '  Nothing was started and nothing will be stopped, because this script\n' +
      '  cannot tell its own server apart from yours. Either pass\n' +
      `    --use-running          adopt it and leave it running, or\n` +
      `    --port ${port + 1}            shoot somewhere else.`
    );
  }
  if (await portInUse(port)) {
    throw new Error(
      `port ${port} is in use by something that is not this app.\n` +
      '  Refusing to touch it -- pass --port <other> to shoot somewhere else.'
    );
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => (log += d));
  child.stderr.on('data', d => (log += d));

  if (!(await waitForHealth(port, 30000))) {
    try { child.kill('SIGTERM'); } catch {}
    throw new Error(
      `server did not answer GET /health on port ${port} within 30s.\n` +
      '  It prints to stdout; run `node src/server.js` yourself to see why.\n' +
      '  A common cause is a missing sqlite3 binary: this app has no in-process\n' +
      '  SQLite driver (src/services/db.js spawns the sqlite3 CLI once per\n' +
      '  query), so without it every data route 500s and the UI renders empty.\n' +
      '  Log tail:\n' + log.slice(-2000)
    );
  }
  return child;
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

// ---------------------------------------------------------------------------
// Chrome launch
// ---------------------------------------------------------------------------

function launchChrome(bin, userDataDir, url, scale) {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--user-data-dir=' + userDataDir,
    '--window-size=' + VIEWPORT_W + ',' + VIEWPORT_H,
    '--force-device-scale-factor=' + scale,
    // The published shots are framed by CSS, not by the OS: a visible scrollbar
    // down the right edge would appear in every image on the site.
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,BackForwardCache',
    '--mute-audio',
    url,
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const wsUrl = new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error('Chrome did not print a DevTools endpoint within 30s')),
      30000
    );
    const onData = (chunk) => {
      buf += chunk;
      const m = buf.match(/ws:\/\/[^\s]+/);
      if (m) { clearTimeout(timer); child.stdout.off('data', onData); resolve(m[0]); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, sig) => {
      clearTimeout(timer);
      reject(new Error('Chrome exited before it started listening (' + (code || sig) + ')\n' + buf.slice(-2000)));
    });
  });
  return { child, wsUrl };
}

// ---------------------------------------------------------------------------
// CDP client
//
// Node 22 ships a global WebSocket, so this is the built-in WebSocket and
// nothing else -- no `ws` dependency either.
// ---------------------------------------------------------------------------

class Cdp {
  constructor(wsUrl) {
    this.url = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve(this));
      ws.addEventListener('error', () => reject(new Error('CDP socket error on ' + this.url)));
      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          return;
        }
        const entry = msg.id && this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(msg.error.message));
        else entry.resolve(msg.result);
      });
    });
  }

  send(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  // Evaluate in the page and take the value by value, not by handle.
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('page threw: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Readiness
//
// This is the part `--virtual-time-budget` cannot do. Per shot we wait for:
//   * the panel is the visible one (switchTab toggles display on #tab-<name>),
//   * every grid the shot is about has real children, and none of them is a
//     skeleton placeholder or an .empty-state,
//   * every <img> actually laid out in those grids has decoded. `complete`
//     alone is not enough -- it is also true for a broken image, so
//     naturalWidth > 0 is the test that matters for a 272-file upload dir,
//   * the dashboard's five metric tiles are filled (not still "--"),
//   * no error toast is on screen.
// Then two animation frames pass so the compositor has painted the scroll.
// ---------------------------------------------------------------------------

function readinessExpression(shot) {
  const tab = shot.hash.slice(1);
  return [
    '(() => {',
    `  const tab = ${JSON.stringify(tab)};`,
    `  const ids = ${JSON.stringify(shot.grids)};`,
    "  const panel = document.getElementById('tab-' + tab);",
    "  if (!panel) return 'WAIT no-panel';",
    "  if (getComputedStyle(panel).display === 'none') return 'WAIT panel-hidden';",
    '  const bad = [];',
    '  for (const id of ids) {',
    '    const grid = document.getElementById(id);',
    "    if (!grid) { bad.push(id + ':missing'); continue; }",
    '    const rows = Array.from(grid.children);',
    '    if (!rows.length) { bad.push(id + \':no-rows\'); continue; }',
    "    if (grid.querySelector('.skeleton')) { bad.push(id + ':skeleton'); continue; }",
    "    if (grid.querySelector('.empty-state')) { bad.push(id + ':empty-state'); continue; }",
    '    const imgs = Array.from(grid.querySelectorAll(\'img\')).filter(i => i.getBoundingClientRect().width > 0);',
    '    const pending = imgs.filter(i => !i.complete || i.naturalWidth === 0);',
    "    if (pending.length) { bad.push(id + ':img-pending:' + pending.length + '/' + imgs.length); continue; }",
    '  }',
    shot.requireMetrics
      ? [
        "  const mids = ['metric-total-costumes','metric-collection-worth','metric-rent-costumes',",
        "                'metric-active-lenses','metric-expiring-lenses'];",
        '  const vals = mids.map(id => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; });',
        "  if (vals.some(v => !v || v === '' || v === '--')) bad.push('metrics-unfilled:' + vals.join('|'));"
        ].join('\n')
      : '',
    "  const toast = document.querySelector('.toast, [role=\"alert\"]');",
    "  if (toast && getComputedStyle(toast).display !== 'none' && toast.textContent.trim()) {",
    "    bad.push('toast:' + toast.textContent.trim().slice(0, 60));",
    '  }',
    "  return bad.length ? 'WAIT ' + bad.join('; ') : 'READY';",
    '})()'
  ].filter(Boolean).join('\n');
}

async function waitForReady(cdp, shot, timeoutMs) {
  const expr = readinessExpression(shot);
  const deadline = Date.now() + timeoutMs;
  let last = 'never evaluated';
  while (Date.now() < deadline) {
    last = await cdp.eval(expr);
    if (last === 'READY') return;
    await sleep(300);
  }
  throw new Error(
    shot.file + ': ' + shot.hash + ' never finished rendering within ' +
      Math.round(timeoutMs / 1000) + 's, so nothing was written.\n' +
      '  last state: ' + last + '\n' +
      '  That string is the unfinished state this screenshot would have\n' +
      '  captured. If it says no-rows or empty-state the API returned nothing:\n' +
      '  check the src/server.js logs and `which sqlite3`.'
  );
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

// Waits until the app has booted and `tab` is the selected one. Falls back to
// calling switchTab() directly: setting location.hash is what the app listens
// for, but a programmatic hash write during boot can land before the listener
// is attached, and a screenshot of the wrong panel is worse than a slow run.
async function ensureTabActive(cdp, tab, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = 'never evaluated';
  while (Date.now() < deadline) {
    last = await cdp.eval([
      `(() => {`,
      `  const btn = document.getElementById('tabbtn-${tab}');`,
      `  if (!btn) return 'WAIT app-not-booted';`,
      `  if (!btn.classList.contains('active')) {`,
      `    if (window.switchTab) window.switchTab('${tab}');`,
      `    else location.hash = '#${tab}';`,
      `    return 'WAIT switching';`,
      `  }`,
      `  return 'ACTIVE';`,
      `})()`
    ].join('\n'));
    if (last === 'ACTIVE') return;
    await sleep(200);
  }
  throw new Error(
    'the ' + tab + ' tab never became active within ' + Math.round(timeoutMs / 1000) +
    's (last state: ' + last + ').\n' +
    '  Nothing was written. If this repeats, open the server yourself in a real\n' +
    '  browser and read the console -- the SPA is failing to boot.'
  );
}

// Reads width/height out of the PNG IHDR chunk. Asserting the real encoded
// size rather than trusting the flags is what keeps docs/index.html's
// width="2880" height="1800" attributes true.
function pngSize(buf) {
  const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIG)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function capture(cdp, shot, outDir, baseUrl) {
  const tab = shot.hash.slice(1);

  // Going from #costumes to #props is a same-document navigation, and Chrome
  // will happily "navigate" without re-running the app's hashchange handler --
  // so the panel stays display:none and the capture would be of the previous
  // tab. Going through '/' first forces a real document load, which is also
  // what a reader following the screenshot's own instructions would get.
  await cdp.send('Page.navigate', { url: baseUrl + '/' });
  await ensureTabActive(cdp, tab, 20000);

  await waitForReady(cdp, shot, 60000);

  // Scroll into position, then let two frames paint: capturing between them
  // yields a half-painted frame.
  await cdp.eval([
    '(async () => {',
    `  window.scrollTo(0, ${shot.scrollTo});`,
    '  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));',
    '  return true;',
    '})()'
  ].join('\n'));

  const res = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  const buf = Buffer.from(res.data, 'base64');

  const size = pngSize(buf);
  const want = { width: VIEWPORT_W * SCALE, height: VIEWPORT_H * SCALE };
  if (!size) throw new Error(shot.file + ': Chrome returned bytes that are not a PNG');
  if (size.width !== want.width || size.height !== want.height) {
    throw new Error(
      shot.file + ': captured ' + size.width + 'x' + size.height + ', expected ' +
      want.width + 'x' + want.height + '. docs/index.html declares\n' +
      '  width="2880" height="1800" on all four <img> elements, so a capture\n' +
      '  of any other size would silently break the page layout. The existing\n' +
      '  file was NOT overwritten.'
    );
  }
  if (buf.length < MIN_BYTES) {
    throw new Error(
      shot.file + ': only ' + buf.length + ' bytes. That is a blank page, not\n' +
      '  a screenshot of a populated grid. The existing file was NOT overwritten.'
    );
  }

  const dest = path.join(outDir, shot.file);
  fs.writeFileSync(dest, buf);
  return { dest, size, bytes: buf.length };
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    const header = fs.readFileSync(__filename, 'utf8');
    process.stdout.write(header.split('*/')[0].replace(/^\/\*\*?/, '').replace(/\n+$/, '') + '\n');
    return;
  }

  // sqlite3 is checked first because its failure mode is so misleading: no
  // error dialog, just four tidy low-byte PNGs of an app full of empty states.
  if (!whichSync('sqlite3')) {
    throw new Error(
      '`sqlite3` is not on PATH.\n' +
      '  This app has no in-process SQLite driver: src/services/db.js spawns\n' +
      '  the sqlite3 CLI once per query. Without it every data route 500s and\n' +
      '  the UI renders empty states, so there is nothing worth capturing.'
    );
  }

  fs.mkdirSync(opts.out, { recursive: true });
  const shots = opts.only ? SHOTS.filter(s => opts.only.includes(s.file)) : SHOTS;

  const chrome = findChrome(opts.chrome);
  const baseUrl = 'http://127.0.0.1:' + opts.port;

  let server = null;
  let chromeProc = null;
  let cdp = null;
  let userDataDir = null;

  try {
    if (opts.useRunning) {
      if (!(await isThisApp(opts.port))) {
        throw new Error('--use-running was given but port ' + opts.port + ' is not serving this app');
      }
      process.stdout.write('using the server already listening on ' + opts.port + '\n');
    } else {
      server = await startServer(opts.port);
      process.stdout.write('started src/server.js on ' + opts.port + '\n');
    }

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-screenshots-'));
    const launched = launchChrome(chrome, userDataDir, baseUrl, SCALE);
    chromeProc = launched.child;
    const browserWs = await launched.wsUrl;

    // Connect to a PAGE target, not the browser target: the Page.* and
    // Runtime.* domains only exist on a page session. The per-page socket URL
    // is read from the DevTools HTTP endpoint (/json/list) rather than from
    // Target.getTargets, because the browser session's copy of targetInfos
    // omits webSocketDebuggerUrl and asking for it there yields undefined.
    // Chrome was launched with the app URL, so it already has one page.
    const cdpPort = Number(new URL(browserWs).port);
    let pageWs = null;
    const attachDeadline = Date.now() + 15000;
    while (Date.now() < attachDeadline && !pageWs) {
      const res = await get(cdpPort, '/json/list');
      let list = [];
      try { list = JSON.parse(res ? res.body : '[]'); } catch { /* not up yet */ }
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) pageWs = page.webSocketDebuggerUrl;
      else await sleep(200);
    }
    if (!pageWs) throw new Error('Chrome never exposed a page target to attach to');

    cdp = await new Cdp(pageWs).connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Belt and braces alongside --force-device-scale-factor: the Emulation
    // override is what CDP honours for captureScreenshot, the launch flag only
    // makes the on-screen window match so layout agrees with the capture.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT_W,
      height: VIEWPORT_H,
      deviceScaleFactor: SCALE,
      mobile: false,
      screenWidth: VIEWPORT_W,
      screenHeight: VIEWPORT_H,
    });

    process.stdout.write('capturing with ' + chrome + '\n');
    for (const shot of shots) {
      const r = await capture(cdp, shot, opts.out, baseUrl);
      process.stdout.write(
        'wrote ' + path.relative(ROOT, r.dest) + '  ' +
        r.size.width + 'x' + r.size.height + '  ' + (r.bytes / 1024).toFixed(0) + ' KB\n'
      );
    }
  } finally {
    if (cdp) cdp.close();
    if (chromeProc) { try { chromeProc.kill('SIGTERM'); } catch {} }
    if (server) {
      if (opts.keepServer) process.stdout.write('leaving the server on ' + opts.port + ' (--keep-server)\n');
      else await stopServer(server);
    }
    if (userDataDir) { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write('\ncapture-screenshots: ' + ((err && err.message) || String(err)) + '\n');
    process.exit(1);
  }
);
