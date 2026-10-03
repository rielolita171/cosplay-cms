#!/usr/bin/env node
/**
 * The searchable Brand / Fandom comboboxes.
 *
 * WHY A CUSTOM WIDGET
 * Two things were asked for that a native <select> cannot deliver:
 *   · roomier options — `select option { padding }` is ignored by Chrome on
 *     Windows, which hands the popup to the OS, so option spacing is not a
 *     promise CSS can keep cross-platform;
 *   · type-to-filter — a native select gives prefix type-ahead only.
 *
 * The cost of hand-rolling it is that everything a native select provides for
 * free has to be rebuilt: the listbox semantics, the keyboard contract, and the
 * rules that keep the field working with the rest of the form. Those are what
 * this asserts.
 *
 * THE INVARIANT THAT MATTERS MOST
 * The visible element IS the form field — it carries `name="fandom"` itself.
 * validateForm() resolves the field by that name, reads its .value, toggles
 * .is-invalid on it and focuses it, and FormData submits it. A hidden <select>
 * behind a text box would send all four of those to an element the user cannot
 * see, and validation would silently stop working.
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

const FIELDS = [
  'add-costume-fandom', 'add-costume-brand',
  'edit-costume-fandom', 'edit-costume-brand'
];

function comboBlock(id) {
  return client.match(new RegExp('data-combo="' + id + '">[\\s\\S]*?</div>'));
}

function main() {
  section('1. Each field is a combobox that is also the form field');
  // The WHOLE wrapper is captured, not a slice up to `role="listbox"`: the
  // first version cut the capture exactly at that word and so could never see
  // the id, role or disabled that come after it — reporting four failures
  // against markup that was correct.
  FIELDS.forEach(id => {
    const block = comboBlock(id);
    check(id + ' has a .combo wrapper', !!block);
    if (!block) return;
    const inner = block[0];
    check(id + ' input carries name= and id=',
      /<input[^>]*name="/.test(inner) && new RegExp('id="' + id + '"').test(inner));
    check(id + ' is role="combobox" with aria-expanded',
      /role="combobox"/.test(inner) && /aria-expanded="false"/.test(inner));
    check(id + ' points at its list with aria-controls',
      new RegExp('aria-controls="' + id + '-list"').test(inner));
    check(id + ' declares aria-autocomplete="list"', /aria-autocomplete="list"/.test(inner));
    // Without this a browser autofills from its own history and overwrites a
    // deliberate pick, with no event the app can see.
    check(id + ' has autocomplete="off"', /autocomplete="off"/.test(inner));
    check(id + ' has a listbox of id ' + id + '-list',
      new RegExp('id="' + id + '-list" role="listbox"').test(inner));
  });

  section('2. The two required fields are still marked required');
  // The attribute list spans five lines, so a 220-character window from the id
  // stops before `required`. Matching the whole <input …> tag instead is both
  // shorter to express and immune to the attributes being reordered.
  const inputTag = id => (comboBlock(id)[0].match(/<input[\s\S]*?>/) || [''])[0];
  check('add-costume-fandom is required',
    /required/.test(inputTag('add-costume-fandom')));
  check('edit-costume-fandom is required',
    /required/.test(inputTag('edit-costume-fandom')));
  // Brand is optional on both forms. An invented `required` would block saving a
  // costume that legitimately has no brand.
  check('neither brand field is required',
    !/required/.test(inputTag('add-costume-brand')) &&
    !/required/.test(inputTag('edit-costume-brand')));

  section('3. Filtering is substring, case-insensitive, and never silent');
  const comboFns = client.match(/function comboMatches[\s\S]*?\n {4}\}/);
  check('comboMatches() exists', !!comboFns);
  if (comboFns) {
    check('the needle is lowercased',
      /combo\.filter\.trim\(\)\.toLowerCase\(\)/.test(comboFns[0]));
    check('an empty filter shows everything',
      /if \(!needle\) return combo\.names;/.test(comboFns[0]));
    check('matching is SUBSTRING, not prefix — "impact" must find Genshin Impact',
      /toLowerCase\(\)\.indexOf\(needle\) !== -1/.test(comboFns[0]) &&
      !/startsWith\(needle\)/.test(comboFns[0]));
  }

  const render = client.match(/function renderComboList[\s\S]*?\n {4}\}/);
  check('a search with no hits says so, and says how to add one',
    !!render && /No match for/.test(render[0]) && /Reference Lists/.test(render[0]),
    'a silent empty list reads as a broken app, not as an absent fandom');
  // The sentence lives in COMBO_STATE, which fillReferenceSelect() writes and
  // renderComboList() reads — so it is asserted where it is DEFINED, not where
  // it is used. Checking the reader would have failed on correct code.
  check('an empty collection has its own message in the widget state',
    /empty:\s*'No entries yet — add some under Reference Lists'/.test(client));
  check('and the placeholder says the same when there are no entries',
    /: 'No entries yet — add some under Reference Lists'/.test(client));

  section('4. Nothing is interpolated into an HTML string');
  // The managed lists are DB-derived, so the list is built with
  // createElement + textContent and cleared with .innerHTML = ''.
  if (render) {
    check('rows use createElement + textContent',
      /document\.createElement\('li'\)/.test(render[0]) &&
      /item\.textContent = name;/.test(render[0]));
    check('the list is cleared with an empty string',
      /list\.innerHTML = '';/.test(render[0]));
    check('no innerHTML assignment carries data',
      !/innerHTML\s*=\s*(?!'')[^;]*name/.test(render[0]));
  }


  section('5. The keyboard contract is complete');
  const keys = client.match(/addEventListener\('keydown'[\s\S]{0,4000}?default:\s*\n\s*break;/);
  check('a keydown handler exists for the comboboxes', !!keys);
  if (keys) {
    const body = keys[0];
    ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab', 'Home', 'End'].forEach(k => {
      check('handles ' + k, body.indexOf("'" + k + "'") !== -1);
    });
    // Enter must NOT be swallowed unconditionally: with nothing highlighted it
    // has to reach the form, or a filled-in costume cannot be saved by keyboard.
    check('Enter is only intercepted when a row is highlighted',
      /if \(!combo\.open \|\| combo\.active < 0 \|\| !matches\[combo\.active\]\) return;/.test(body));
    // Tab must never be trapped — a keyboard trap is a WCAG failure.
    check('Tab is never prevented, so focus can leave the field',
      !/case 'Tab':[\s\S]{0,240}?preventDefault\(\)/.test(body));
    check('Escape only closes an open popup',
      /case 'Escape': \{[\s\S]{0,140}?if \(!combo\.open\) return;/.test(body));
    check('arrow navigation wraps at both ends',
      /%\s*matches\.length/.test(body));
  }

  section('6. ARIA state is kept truthful');
  check('aria-expanded tracks the popup',
    /setAttribute\('aria-expanded', combo\.open \? 'true' : 'false'\)/.test(client));
  check('aria-activedescendant points at the highlighted row',
    /setAttribute\('aria-activedescendant', active\.id\)/.test(client));
  // The attribute and the visible highlight must be set together, or a screen
  // reader announces a row the sighted user cannot see (or the reverse).
  check('highlight class and aria-activedescendant are set in the same function',
    /function syncComboActive[\s\S]*?classList\.toggle\('is-active'[\s\S]*?aria-activedescendant/.test(client));
  check('the active row is scrolled into view',
    /scrollIntoView\(\{ block: 'nearest' \}\)/.test(client));
  check('closing clears aria-activedescendant',
    /if \(!combo\.open\) input\.removeAttribute\('aria-activedescendant'\)/.test(client));

  section('7. Poking a row cannot be lost to a re-render');
  // The list is rebuilt on `input`, so a click can be cancelled if focus moves
  // between press and release. pointerdown + preventDefault is the fix.
  check('row selection is bound on pointerdown',
    /addEventListener\('pointerdown'[\s\S]{0,260}?combo-option/.test(client));
  check('and it prevents the default so the click is not cancelled',
    /addEventListener\('pointerdown'[\s\S]{0,900}?preventDefault\(\)/.test(client));
  check('picking a row fires change, so inline errors clear',
    /function comboPick[\s\S]{0,900}?dispatchEvent\(new Event\('change'/.test(client));

  section('8. The fields are disarmed while the lists load');
  // Shipping the field enabled with an empty popup would let a costume be saved
  // with a blank fandom — the "Loading…" defect the sibling suite records.
  // A field that ships ENABLED, with no popup behind it, lets a costume be saved
  // with a blank fandom — the "Loading…" defect the sibling suite records. This
  // assertion earned its keep immediately: the four inputs were first written
  // without `disabled` and it caught exactly that.
  check('the inputs ship disabled',
    FIELDS.every(id => /disabled/.test(inputTag(id))),
    FIELDS.filter(id => !/disabled/.test(inputTag(id))).join(', '));
  check('fillReferenceSelect enables the field only once the data has arrived',
    /input\.disabled = false;\s*\n\s*setSelectLoading\(selectId, false\);/.test(client));
  check('markSelectsLoading also CLOSES an open popup, not just disables',
    /if \(COMBO_STATE\[id\]\) setComboOpen\(id, false\);/.test(client));

  section('9. The roomier option spacing is real CSS');
  check('.combo-option sets generous padding',
    /\.combo-option \{[\s\S]*?padding:\s*1\dpx/.test(client));
  check('and a comfortable minimum row height',
    /\.combo-option \{[\s\S]*?min-height:\s*4\dpx/.test(client));
  check('the list is scrollable, since it is taller than the field',
    /\.combo-list \{[\s\S]*?overflow-y:\s*auto/.test(client));
  // A touch device never fires :hover, so the highlight has to be driven by the
  // same class the keyboard uses.
  check('the active row is styled by class, not only :hover',
    /\.combo-option\.is-active/.test(client));
}

main();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
