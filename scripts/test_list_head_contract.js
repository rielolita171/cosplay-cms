#!/usr/bin/env node
/**
 * The list-header class contract.
 *
 * WHY THIS EXISTS
 * The costume list header once rendered as an unreadable vertical stack of
 * labels. The cause was not a layout bug at all: it was a NAME MISMATCH.
 *
 *   renderListHead() builds its class from the row class it is handed:
 *       '<div class="' + rowClass + '-head list-head" …>'
 *   and the costume call site passes 'costume-row', so the element carries
 *   `costume-row-head`.
 *
 *   The CSS, however, styled `.costume-list-head` — a class nothing ever
 *   emitted. So the header matched NO rule: no `display: grid`, no
 *   `grid-template-columns`, no sticky band, no small-caps treatment. It fell
 *   back to block layout and its cells stacked vertically in a column.
 *
 *   Props and lenses were unaffected only by luck: their row classes happen to
 *   be named `prop-row`/`lens-row`, which is exactly what their CSS expects.
 *
 * WHY IT NEEDS AN ASSERTION RATHER THAN A REVIEW
 * Nothing about the file looks wrong. The CSS block is well-formed and
 * well-commented, the JS is well-formed, and the two are simply describing
 * different words. A reviewer reading either side in isolation confirms the
 * other is fine. It fails only at runtime, in one tab, visually — and only on
 * the widest viewport, because the narrow-viewport rule that hides the header
 * uses the same dead class and so "works" for the wrong reason.
 *
 * So this asserts the CONTRACT rather than the appearance: for every list, the
 * class the renderer emits must be the class the stylesheet targets. That
 * catches the mismatch whichever side is renamed later.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

// COMMENTS STRIPPED. Every assertion below asks "does this CSS selector exist?"
// and this file documents its own class names extensively in prose — a match on
// a comment proves nothing and, worse, reports a FALSE PASS when the real
// selector was renamed away. Both `/* … */` and `<!-- … -->` forms are removed
// before any selector is looked for.
const code = client
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log('  ✓ ' + name);
  } else {
    failed++;
    console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
  }
}

function section(title) {
  console.log('\n' + title);
}

function main() {
  section('1. renderListHead derives its class from the row class');
  // The behaviour this whole suite depends on. If this ever changes to take a
  // literal class name, the derivation below is what stops applying.
  check('renderListHead is defined', /function renderListHead\s*\(/.test(client));

  const defn = client.match(/function renderListHead\s*\([\s\S]*?\n {4}\}/);
  check('it builds the class as rowClass + "-head"',
    !!(defn && /rowClass\s*\+\s*'-head/.test(defn[0])),
    defn ? defn[0] : 'renderListHead body not found');

  // ---------------------------------------------------------------------
  section('2. Every list header: emitted class matches a styled class');
  // ---------------------------------------------------------------------
  // Each call site passes a row class; the element it produces is
  // `<rowClass>-head`. That name must appear as a CSS selector.
  const calls = client.match(/renderListHead\('([a-z-]+)'/g) || [];
  check('all three lists render a header', calls.length === 3,
    'found ' + calls.length + ': ' + calls.join(', '));

  const rowClasses = calls.map(c => c.match(/'([a-z-]+)'/)[1]);
  rowClasses.forEach(rowClass => {
    const headClass = rowClass + '-head';
    const selector = new RegExp('\\.' + headClass + '\\b');
    check('the header for ' + rowClass + ' is styled as .' + headClass,
      selector.test(code));
  });

  // ---------------------------------------------------------------------
  section('3. The header shares the row\'s grid tracks');
  // ---------------------------------------------------------------------
  // This is the property the layout actually depends on: a header and the rows
  // beneath it are pinned to the same grid-template-columns BY CONSTRUCTION,
  // so a heading cannot drift out of register with its own data.
  const pairs = [
    ['costume-row-head', /\.costume-row,\s*\.costume-row-head\s*\{[^}]*grid-template-columns/],
    ['prop-row-head', /\.prop-row,\s*\.prop-row-head\s*\{[^}]*grid-template-columns/],
    ['lens-row-head', /\.lens-row,\s*\.lens-row-head\s*\{[^}]*grid-template-columns/]
  ];
  pairs.forEach(function (pair) {
    check('.' + pair[0] + ' is declared alongside its row with the same tracks',
      pair[1].test(code));
  });
  // ---------------------------------------------------------------------
  section('4. No orphaned header class in the stylesheet');
  // ---------------------------------------------------------------------
  // The exact failure that produced the bug: a `.costume-list-head` selector
  // with nothing emitting that class. Rather than naming the one class we know
  // about, this asserts the general rule in BOTH directions — no `*-head`
  // selector may exist unless the renderer emits it, and no emitted header may
  // lack a selector. Either half alone would have missed the original bug.
  // Every `*-head` SELECTOR in the stylesheet, not just the row headers. The bug
  // being guarded against is a selector nobody emits, and narrowing this to
  // `*-row-head` would hide the exact failure — the dead class was named
  // `costume-list-head`, which does not end in `-row-head`.
  const styledHeads = new Set();
  const selRe = /\.([a-z][a-z0-9-]*-head)\b/g;
  let m;
  while ((m = selRe.exec(code)) !== null) styledHeads.add(m[1]);

  // NOT every `*-head` class belongs to the list headers. These are written
  // straight into the markup and styled by hand; they have nothing to do with
  // renderListHead, so demanding the renderer emit them would be wrong. They are
  // recognised by APPEARING in the markup, not by being listed here, so a new
  // one needs no edit to this file:
  //   .upload-progress-head — the upload progress bar's heading row.
  const staticHeadClasses = new Set();
  const classAttr = /class="([^"]*)"/g;
  let a;
  while ((a = classAttr.exec(code)) !== null) {
    a[1].split(/\s+/).forEach(tok => { if (tok && /-head$/.test(tok)) staticHeadClasses.add(tok); });
  }

  const emittedHeads = new Set(rowClasses.map(r => r + '-head'));

  const orphans = [...styledHeads].filter(c =>
    !emittedHeads.has(c) && !staticHeadClasses.has(c));
  check('every *-head selector in the CSS is a class the renderer emits',
    orphans.length === 0,
    orphans.length ? 'orphaned: ' + orphans.join(', ') : '');

  const unstyled = [...emittedHeads].filter(c => !styledHeads.has(c));
  check('every emitted header class has a matching CSS selector',
    unstyled.length === 0,
    unstyled.length ? 'unstyled: ' + unstyled.join(', ') : '');

  // ---------------------------------------------------------------------
  section('5. The narrow-viewport rule hides a class that exists');
  // ---------------------------------------------------------------------
  // Worth its own assertion: the media query hides the header below 700px. It
  // used the same dead `.costume-list-head` name, so it was correct-looking
  // code that would never have fired — and it masked the bug, because the
  // broken header was hidden on exactly the narrow widths a reviewer is most
  // likely to be testing in a small window.
  // There is more than one `@media (max-width: 700px)` block in the page, so a
  // non-global match would test only the FIRST one and silently pass or fail
  // for reasons unrelated to the header. Every such block is scanned.
  const blocks = code.match(/@media \(max-width: 700px\) \{[\s\S]*?\n {4}\}/g) || [];
  check('the 700px media queries exist', blocks.length > 0);

  const hideRules = [];
  blocks.forEach(b => {
    const re = /\.([a-z][a-z0-9-]*-row-head)\s*\{\s*display:\s*none/g;
    let h;
    while ((h = re.exec(b)) !== null) hideRules.push(h[1]);
  });

  check('a 700px rule hides the costume header', hideRules.includes('costume-row-head'),
    hideRules.length ? 'hide rules: ' + hideRules.join(', ') : 'no header hide rule found');

  hideRules.forEach(c => {
    check('the header hidden at 700px (. ' + c + ') is a class that exists',
      emittedHeads.has(c));
  });
}

main();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);