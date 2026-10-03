#!/usr/bin/env node
/**
 * The View control (#view-mode) must agree with the grid it controls.
 *
 * THE BUG THIS GUARDS
 * There is ONE #view-mode <select> shared by all four list tabs, but FOUR
 * independent per-tab preferences (GRID_VIEWS). switchTab() called
 * setViewSelectVisible() and never syncViewSelect(), so the select's VALUE was
 * written only at boot and on a toggle — never on a tab flip.
 *
 * The result: set Contact Lenses to List view, then click Props. The props grid
 * was drawn correctly as CARDS (renderProps reads currentView('props'), which
 * was right), while the select still read "List view". The control contradicted
 * the thing it controls, and picking "Card view" then appeared to do nothing,
 * because props was already card.
 *
 * THE INVARIANT
 * For every tab, `currentView(tab)` must equal the select's value whenever that
 * tab is showing. Visibility is the other half and is asserted separately.
 *
 * These assertions read the source rather than driving a DOM — the page has no
 * test harness — but the property under test is exactly which functions each
 * call site must invoke, which is what drifted.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail ? '\n      ' + detail : '')); }
}

function section(title) { console.log('\n' + title); }

function main() {
  section('1. Both call sites sync visibility AND value together');
  // The bug was two functions updated by two owners. The fix is one function
  // that does both, called from both places that used to call one of them.
  check('syncViewControl() exists and does both halves',
    /function syncViewControl\(\) \{[\s\S]*?setViewSelectVisible\(isListViewTab\(state\.currentTab\)\);[\s\S]*?syncViewSelect\(\);[\s\S]*?\}/.test(client));

  // switchTab() — the every-tab-flip path, which is where the bug bit.
  const switchTab = client.match(/function switchTab\(tab, opts\) \{[\s\S]{0,6000}?\n {4}\}/);
  check('switchTab() is defined', !!switchTab);
  if (switchTab) {
    check('switchTab() calls syncViewControl()',
      /syncViewControl\(\);/.test(switchTab[0]));
    // The regression in its exact original form: visibility-only.
    check('and no longer calls the visibility half on its own',
      !/setViewSelectVisible\(/.test(switchTab[0].replace(/syncViewControl\(\);/, '')),
      'a bare setViewSelectVisible() call reintroduces the stale value');
  }

  // showDashboard() — the boot path.
  const showDash = client.match(/function showDashboard\(\) \{[\s\S]*?\n {4}\}/);
  check('showDashboard() is defined', !!showDash);
  if (showDash) {
    check('showDashboard() calls syncViewControl()',
      /syncViewControl\(\);/.test(showDash[0]));
    check('and no longer calls the visibility half on its own',
      !/setViewSelectVisible\(/.test(showDash[0].replace(/syncViewControl\(\);/, '')));
  }

  section('2. Every tab flip routes through switchTab()');
  // A second path that set visibility without the value would reopen the bug.
  check('the seven tab buttons call switchTab()',
    (client.match(/class="tab-btn[^"]*"[^>]*onclick="switchTab\('/g) || []).length === 7,
    'found ' + (client.match(/onclick="switchTab\('/g) || []).length);
  check('the arrow-key navigation calls switchTab() too',
    /switchTab\(TAB_NAMES\[next\]\);/.test(client));
  check('the hash-change boot path calls switchTab()',
    /switchTab\(requested, \{ fromHash: true \}\);/.test(client));

  section('3. The renderers read the per-tab preference');
  // If a renderer read one global, the select and the grid would disagree for a
  // different reason and this fix would not help.
  [['renderCostumes', 'costumes'], ['renderProps', 'props'], ['renderLenses', 'lenses']]
    .forEach(pair => {
      const body = client.match(new RegExp('function ' + pair[0] + '\\([\\s\\S]*?\\n {4}\\}'));
      check(pair[0] + '() reads currentView(\'' + pair[1] + '\')',
        !!body && new RegExp("currentView\\('" + pair[1] + "'\\) === 'list'").test(body[0]),
        body ? body[0].slice(0, 90) : pair[0] + ' not found');
    });

  section('4. The preferences really are per tab');
  // A single shared key would make the fix pointless: both tabs would show the
  // same value and there would be nothing to disagree about.
  check('GRID_VIEWS holds a separate entry per tab',
    /const GRID_VIEWS = \{ costumes: 'card', props: 'card', lenses: 'card' \};/.test(client));
  check('wishlist deliberately shares the costumes key',
    /VIEW_STATE_KEYS = \{ costumes: 'costumes', wishlist: 'costumes', props: 'props', lenses: 'lenses' \};/.test(client));
  check('the costume key is separate from the props/lenses ones',
    /COSTUME_VIEW_KEY = 'cosplay-cms\.costumeView'/.test(client) &&
    /VIEW_STORAGE_PREFIX = 'cosplay-cms\.'/.test(client));

  section('5. Only the four list tabs show the control');
  check('isListViewTab() lists exactly costumes, wishlist, props, lenses',
    /function isListViewTab\(tab\) \{\s*return tab === 'costumes' \|\| tab === 'wishlist' \|\| tab === 'props' \|\| tab === 'lenses';\s*\}/.test(client));
  // A tab with no list shape must hide it: it would otherwise offer a choice
  // that changes nothing, and now also show a value for a grid that ignores it.
  const isTabBody = client.match(/function isListViewTab[\s\S]*?\n {4}\}/)[0];
  ['makers', 'lists', 'settings'].forEach(tab => {
    check(tab + ' is excluded from the view control',
      isTabBody.indexOf("'" + tab + "'") === -1);
  });

  section('6. The control survives a re-render');
  // filterItems() redraws the grid on a tab flip; if it rebuilt the control it
  // could reset the value to its first option and undo the sync above.
  // Takes an optional `fromUser` flag — matched with `[^)]*` rather than `\(\)`
  // because an exact-zero-arg signature fails the moment a parameter is added,
  // which reads as "function missing" rather than as "my regex was too strict".
  const filterItems = client.match(/function filterItems\([^)]*\) \{[\s\S]*?\n {4}\}/);
  check('filterItems() exists', !!filterItems);
  if (filterItems) {
    check('it does not reset #view-mode to a literal',
      !/#view-mode[^;]*=\s*'card'/.test(filterItems[0]),
      'filterItems() writes #view-mode directly');
  }
}

main();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);