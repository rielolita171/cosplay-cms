#!/usr/bin/env node
/**
 * The brand/fandom <select>s in the Add and Edit Costume forms.
 *
 * TWO DEFECTS THIS GUARDS, both of which rendered as a blank or wrong control
 * with no error anywhere.
 *
 * 1. THE EMPTY PLACEHOLDER.
 *    populateFandomSelects() passed `''` as the blank label, so the select's
 *    first option was an EMPTY, SELECTABLE row. It said nothing and submitted
 *    ''. On a required field that is the worst case: it looks like a control the
 *    user is meant to use, and it is the only "blank" state the select has.
 *    This is the same defect as the old "Loading…" option, one layer down — a
 *    selectable entry carrying no information.
 *
 * 2. NAVIGATION AMONG DATA VALUES.
 *    `__manage__` was appended as an <option>, putting a navigation action
 *    inside a list of fandoms, at the BOTTOM — so reaching Reference Lists meant
 *    scrolling past all 24. It is now a real button beside the field.
 *
 * The assertions are on the SOURCE rather than on a rendered DOM: this page has
 * no test harness and no jsdom, and both defects are visible in the arguments
 * passed and the markup emitted.
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

// The four selects.
const FIELDS = [
  'add-costume-fandom',
  'edit-costume-fandom',
  'add-costume-brand',
  'edit-costume-brand'
];

// Pull the argument list of one fillReferenceSelect() call so the positions are
// blankLabel, manageLabel, selected — the id and the items array are dropped.
//
// The naive version of this stripped `'id', ` with a regex that assumed a space
// after the comma, which silently FAILED for the fandom calls: those pass
// `state.fandoms` and the comment above them means the match started at the
// wrong call, leaving args[0] as "state.fandoms". A test whose parser is off by
// one reports confident nonsense, so the arguments are located by scanning
// parentheses instead of by pattern-matching a prefix.
function callArgs(call) {
  const open = call.indexOf('(');
  const body = call.slice(open + 1, call.lastIndexOf(')'));

  const args = [];
  let depth = 0;
  let current = '';
  let quote = null;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    // A bracket opens a nested call or an array literal; its commas are not
    // argument separators.
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());

  // Drop the first two arguments (selectId, items) and the trailing comma's
  // empty remainder.
  return args.slice(2).filter((a, i, arr) => !(i === arr.length - 1 && a === ''));
}

// Find one call by its select id. The two fandom calls wrap onto a second line
// (because of the comment above them), so the match must tolerate a newline and
// enough text to cover the arguments — matched up to the closing paren.
function findCall(id) {
  const calls = [...client.matchAll(
    /fillReferenceSelect\(\s*'[a-z-]+'[\s\S]{0,400}?\);/g)];
  const hit = calls.find(m => m[0].includes("'" + id + "'"));
  return hit ? callArgs(hit[0]) : null;
}

function main() {
  section('1. No select is given an empty placeholder label');
  FIELDS.forEach(id => {
    const args = findCall(id);
    if (!args) { check(id + ' is populated', false); return; }
    const blankLabel = args[0] || '';
    check(id + ' gets a non-empty placeholder label',
      blankLabel.length > 2 && blankLabel.startsWith("'"), 'blankLabel is ' + blankLabel);
    check(id + ' and the label SAYS something',
      /Select|fandom|brand|No brand|None/i.test(blankLabel), 'blankLabel is ' + blankLabel);
  });

  section('2. The costume selects no longer offer the Manage option');
  FIELDS.forEach(id => {
    const args = findCall(id);
    if (!args) return;
    check(id + ' passes an empty manageLabel',
      args[1] === "''", 'manageLabel is ' + args[1]);
  });

  // These four fields are now SEARCHABLE COMBOBOXES, not <select>s, so there is
  // no <option> to create at all. What must not reappear is a MANAGE SENTINEL
  // smuggled in as a list row — the same class of defect as the blank and the
  // "Loading…" option this file already records.
  check('fillReferenceSelect builds no <option> elements — the fields are comboboxes',
    !/createElement\('option'\)/.test(client.match(/function fillReferenceSelect[\s\S]*?\n {4}\}/)[0]),
    'fillReferenceSelect still creates <option>s');
  check('the sentinel is not injected into a combobox list',
    !/MANAGE_LISTS_VALUE[\s\S]{0,400}(renderComboList|combo-option)/.test(client));
  check('list rows carry role="option" for the listbox',
    /item\.setAttribute\('role', 'option'\)/.test(client));

  section('3. The Manage buttons exist on all four fields');
  const buttons = [...client.matchAll(/<button[^>]*data-manage-lists="(\w+)"[^>]*>([^<]*)</g)];
  check('four manage buttons are declared', buttons.length === 4, 'found ' + buttons.length);

  const seen = buttons.map(m => m[1]);
  check('one for Brand and one for Fandom in each form',
    seen.filter(s => s === 'Brand').length === 2 &&
    seen.filter(s => s === 'Fandom').length === 2, seen.join(', '));

  buttons.forEach(m => {
    check('"' + m[2].trim() + '" is type="button" — a submit here would save the costume',
      /type="button"/.test(m[0]), m[0].slice(0, 90));
  });

  section('4. The button is wired to the right select, inside a .field-head');
  FIELDS.forEach(id => {
    const block = client.match(
      new RegExp('<div class="field-head">\\s*<label for="' + id + '">[\\s\\S]*?</div>'));
    check(id + ' has a .field-head holding its label and a manage button',
      !!block && /data-manage-lists/.test(block[0]));
  });

  // The label must still point at a REAL select, or clicking it focuses nothing.
  FIELDS.forEach(id => {
    check(id + ' still has both a label[for] and a matching select',
      new RegExp('<label for="' + id + '">').test(client) &&
      new RegExp('id="' + id + '"').test(client));
  });

  section('5. The click handler closes the dialog before switching tab');
  // A <dialog> opened with showModal() makes the rest of the document inert, so
  // switching the tab underneath it would look like nothing happened.
  // The window must start at the LISTENER, not at the `[data-manage-lists]`
  // selector inside it — `document.addEventListener` sits a few lines ABOVE that,
  // so a narrower capture silently failed this assertion while the code was
  // perfectly correct. Widened, and anchored on the selector only to find the
  // listener, then grown backwards to include its opening.
  const sel = client.indexOf("[data-manage-lists]");
  check('the handler matches on [data-manage-lists]', sel > -1);
  const listenerStart = client.lastIndexOf('document.addEventListener', sel);
  // Sizing the window by counting braces to the listener's own close, rather than
  // by a fixed character count or by searching for the first '});' — the handler
  // contains a nested arrow function, so the first `});` is nowhere near its end
  // and any capture stopping there would miss most of the body.
  let handler = null;
  if (sel > -1 && listenerStart > -1) {
    let depth = 0;
    let end = -1;
    for (let i = listenerStart; i < client.length; i++) {
      if (client[i] === '{') depth++;
      else if (client[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end > -1) handler = client.slice(listenerStart, end);
  }
  check('the delegated handler exists', !!handler);
  if (handler) {
    // `handler` is the captured SOURCE STRING, not a regex match array — the
    // first version of this block still wrote handler[0], which on a string is
    // its first CHARACTER, so all three assertions silently tested "d" and failed
    // against code that was correct.
    check('it finds the enclosing dialog and closes it',
      /closest\('dialog'\)/.test(handler) && /dialog\.close\(\)/.test(handler));
    check('close() runs BEFORE switchTab()',
      handler.indexOf('dialog.close()') > -1 &&
      handler.indexOf('dialog.close()') < handler.indexOf("switchTab('lists')"),
      'close at ' + handler.indexOf('dialog.close()') +
      ', switchTab at ' + handler.indexOf("switchTab('lists')"));
    check('it is delegated on document, so re-rendered markup keeps working',
      /document\.addEventListener\('click'/.test(handler));
  }

  section('6. The submit handlers still strip the sentinel');
  // Defensive, and kept deliberately: a restored form or a stale value could
  // still hold `__manage__`, and it must never reach the server as a real name.
  check('the add path drops the brand sentinel',
    /if \(data\.brand === MANAGE_LISTS_VALUE\) data\.brand = '';/.test(client));
  check('the edit path drops the brand sentinel',
    /if \(brand !== MANAGE_LISTS_VALUE && brand !== ''\) payload\.brand = brand;/.test(client));
  check('and the fandom sentinel',
    /if \(fandom !== MANAGE_LISTS_VALUE\) payload\.fandom = fandom;/.test(client));

  section('7. The styling exists and is keyboard reachable');
  check('.field-head lays the label and the link on one line',
    /\.field-head \{[\s\S]*?display:\s*flex/.test(client));
  check('.manage-link is styled', /\.manage-link \{/.test(client));
  check('it reads as a link, not a button that looks like one',
    /\.manage-link \{[\s\S]*?background:\s*none[\s\S]*?border:\s*0/.test(client));
  // Moving it out of the dropdown is only an improvement if it can still be
  // reached by keyboard — it could not before.
  check('it keeps a visible focus ring',
    /\.manage-link:focus-visible \{[\s\S]*?outline:/.test(client));
}

main();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);