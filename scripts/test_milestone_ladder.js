#!/usr/bin/env node
/**
 * The milestone ladder: its meaning, and the two copies of it.
 *
 * WHY THIS EXISTS
 * The ladder is defined TWICE — as MILESTONE_LADDER in src/routes/costumes.js
 * (which computes the completion percentage the API returns) and again in
 * public/index.html (which draws the chips, the checklist and the progress bar).
 * They cannot be shared at runtime: this app ships no bundler and no module
 * loader, and the page is a single 600KB file.
 *
 * Two copies of one definition is two places to forget. Adding a sixth rung and
 * updating only the client would leave the server dividing by 5 while the UI
 * shows 6 chips — a percentage that is quietly wrong on every card, with no
 * error anywhere. So the copies are asserted equal here instead.
 *
 * The second half of this suite guards the rule the five flags are actually
 * kept under: they are INDEPENDENT, and the completion percentage is nothing
 * more than the plain count of them, one flag worth 20%. The ladder this
 * replaced let a ticked flag imply the ones below it, which quietly rewrote
 * every existing percentage; if that machinery creeps back, either the number or
 * the copy will contradict the others, and both are asserted here.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const server = require(path.join(ROOT, 'src/routes/costumes.js')).normalizers;

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

// THE EXPECTED LADDER, written out here a third time — deliberately. A test that
// imported its expectation from the code under test would pass by construction
// and catch nothing; this is an independent statement of what the five rungs
// are, in order.
const EXPECTED = [
  ['costumeOnly', 'Costume Ready'],
  ['isFullset', 'Fullset'],
  ['doneCostest', 'Costest Done'],
  ['doneEvent', 'Event Done'],
  ['donePhotoSession', 'Photoshoot Done']
];

function main() {
  section('1. The ladder has five rungs, in the documented order');

  check('the server exports MILESTONE_LADDER', Array.isArray(server.MILESTONE_LADDER));
  check('milestoneCompletionPercent is exported too',
    typeof server.milestoneCompletionPercent === 'function');
  check('the client defines MILESTONE_LADDER', /const MILESTONE_LADDER = \[/.test(client));
  check('the server ladder has ' + EXPECTED.length + ' rungs',
    server.MILESTONE_LADDER.length === EXPECTED.length,
    'got ' + server.MILESTONE_LADDER.length);

  server.MILESTONE_LADDER.forEach((rung, i) => {
    const want = EXPECTED[i];
    check('rung ' + (i + 1) + ' is ' + want[0] + ' / "' + want[1] + '"',
      rung.key === want[0] && rung.label === want[1],
      'got ' + rung.key + ' / "' + rung.label + '"');
  });

  section('2. Both copies agree — the failure this suite exists for');
  // The client's keys, extracted from its own definition in source order.
  const clientBlock = client.match(/const MILESTONE_LADDER = \[([\s\S]*?)\n {4}\];/);
  check('the client ladder literal is readable', !!clientBlock);
  const clientKeys = clientBlock
    ? (clientBlock[1].match(/key: '([a-zA-Z]+)'/g) || []).map(s => s.match(/'([^']+)'/)[1])
    : [];

  check('the client declares the same number of rungs',
    clientKeys.length === server.MILESTONE_LADDER.length,
    'client ' + clientKeys.length + ' vs server ' + server.MILESTONE_LADDER.length);

  EXPECTED.forEach((want, i) => {
    check('rung ' + (i + 1) + ' is ' + want[0] + ' on BOTH sides',
      clientKeys[i] === want[0],
      'client has ' + clientKeys[i] + ' where the server has ' + want[0]);
  });

  section('3. Every rung has a glossary — the part that explains it');
  const noGloss = server.MILESTONE_LADDER.filter(r =>
    typeof r.glossary !== 'string' || r.glossary.length <= 20);
  check('every server rung carries a substantive glossary',
    noGloss.length === 0, noGloss.map(r => r.key).join(', '));
  check('the client glossary sentences are all present',
    server.MILESTONE_LADDER.every(r => client.includes(r.glossary)),
    'a glossary sentence is missing from public/index.html');

  // The sentences are also duplicated into the FORM markup, so there are three
  // copies of the prose. Compared by value rather than by count, so rewording one
  // copy fails loudly instead of quietly leaving two different definitions of
  // "Fullset" in the app.
  const clientGlossaries = clientBlock
    ? (clientBlock[1].match(/glossary: '([^']+)'/g) || []).map(s => s.slice(11, -1))
    : [];
  check('the client declares one glossary per rung',
    clientGlossaries.length === EXPECTED.length,
    'client has ' + clientGlossaries.length);
  // EXACT EQUALITY IS ENFORCED FOR ALL FIVE, WITH NO EXEMPTION. An earlier
  // version compared only the four ladder rungs and let the "Costume Ready"
  // sentence drift, on the grounds that it was drawn outside the sequence. The
  // five flags are peers now, so all five are one list and one set of words.
  EXPECTED.forEach((want, i) => {
    check('the glossary for "' + want[1] + '" is IDENTICAL on both sides',
      clientGlossaries[i] === server.MILESTONE_LADDER[i].glossary,
      'client: ' + clientGlossaries[i]);
  });

  // The glossary is duplicated into the FORM as literal markup (the dialog must
  // exist before any script runs), so it is a third copy of the same sentences.
  section('4. The form checklist matches the ladder');
  const form = client.match(/id="edit-milestone-ladder">([\s\S]*?)\n {8}<\/div>/);
  check('the edit form has a milestone checklist', !!form);

  EXPECTED.forEach(want => {
    check('the form has a checkbox named ' + want[0],
      !!form && form[1].includes('name="' + want[0] + '"'));
    check('the form labels it "' + want[1] + '"',
      !!form && form[1].includes('>' + want[1] + '<'));
  });

  check('the form checkbox order matches the ladder order',
    !!form && EXPECTED.map(w => form[1].indexOf('name="' + w[0] + '"')).every((pos, i, a) =>
      i === 0 || pos > a[i - 1]),
    'the checkboxes are not in ladder order');

  section('5. The five flags are independent — the percentage is the plain count');
  // NO FLAG IMPLIES ANY OTHER. The product decision is that these are five
  // separate things that were done, not five steps of a sequence, so the number
  // is simply how many boxes are ticked: each one 20%. Every case below is a
  // case where the OLD implied-ladder maths answered something else, so this
  // section is the regression guard in both directions.
  const ALL_FIVE = {
    costumeOnly: 1, isFullset: 1, doneCostest: 1, doneEvent: 1, donePhotoSession: 1
  };
  const CASES = [
    ['a brand-new costume with nothing ticked', {}, 0],
    ['only Costume Ready ticked', { costumeOnly: 1 }, 20],
    ['Fullset and Event Done ticked', { isFullset: 1, doneEvent: 1 }, 40],
    // The two cases the implied ladder existed for. Both used to read 100% and
    // now read what is actually ticked.
    ['the four original flags, from a row predating costumeOnly',
      { isFullset: 1, doneCostest: 1, doneEvent: 1, donePhotoSession: 1 }, 80],
    ['a single Photoshoot Done, which used to imply all the others',
      { donePhotoSession: 1 }, 20],
    ['all five ticked', ALL_FIVE, 100]
  ];
  CASES.forEach(([what, flags, want]) => {
    check(what + ' reads ' + want + '% on the server',
      server.milestoneCompletionPercent(flags) === want,
      'got ' + server.milestoneCompletionPercent(flags) + '%');
  });

  // EVERY SINGLE FLAG ON ITS OWN IS 20% — the property the ladder never had.
  // A rung that used to drag the four below it up with it would fail here.
  EXPECTED.forEach(([key]) => {
    check('only ' + key + ' ticked is 20%',
      server.milestoneCompletionPercent({ [key]: 1 }) === 20,
      'got ' + server.milestoneCompletionPercent({ [key]: 1 }) + '%');
  });

  // THE IMPLICATION MACHINERY CANNOT COME BACK QUIETLY. It was a set of
  // `impliedBy` arrays plus a `||` in the percentage plus a dialog handler that
  // auto-ticked a box the user had deliberately cleared; all three were removed
  // together, and this asserts the data and the maths, which is where a partial
  // revert would show up first.
  check('the server ladder carries no impliedBy arrays',
    !server.MILESTONE_LADDER.some(r => 'impliedBy' in r));
  const serverSource = fs.readFileSync(path.join(ROOT, 'src/routes/costumes.js'), 'utf8');
  check('milestoneCompletionPercent does not read impliedBy',
    /function milestoneCompletionPercent\(costume\) \{[\s\S]*?\n  \}/.test(serverSource)
      && !/function milestoneCompletionPercent\(costume\) \{[\s\S]*?\n  \}[\s\S]*?impliedBy/
        .test(serverSource.match(/function milestoneCompletionPercent[\s\S]*?\n  \}/)[0])
      && !serverSource.includes('impliedBy'));

  // THE CLIENT COPY IS EXECUTED, NOT MERELY READ. The card bar, the chips and
  // the preview all derive their number from milestoneReached() in the page, so
  // a client that disagreed with the server would not fail anywhere — the API
  // would answer 40% while every card read 80%, silently, forever. The client's
  // own ladder literal and its own milestoneReached() are therefore lifted out
  // of the page and run here over the same cases.
  const clientFn = client.match(/function milestoneReached\(costume, rung\) \{[\s\S]*?\n {4}\}/);
  check('the client defines milestoneReached()', !!clientFn);
  if (clientFn && clientBlock) {
    // eslint-disable-next-line no-new-func
    const clientLadder = new Function('return [' + clientBlock[1] + '];')();
    const toBool = v => v === true || v === 1 || v === '1';
    const clientPercent = new Function('MILESTONE_LADDER', 'toBool', clientFn[0] + '\n'
      + 'return function (c) {\n'
      + '  const reached = MILESTONE_LADDER.filter(rung => milestoneReached(c, rung)).length;\n'
      + '  return Math.round((reached / MILESTONE_LADDER.length) * 100);\n'
      + '};')(clientLadder, toBool);
    CASES.forEach(([what, flags, want]) => {
      check(what + ' reads ' + want + '% on the client too',
        clientPercent(flags) === want,
        'got ' + clientPercent(flags) + '%');
    });
  }

  check('the card bar still counts through milestoneReached()',
    /MILESTONE_LADDER\.filter\(rung => milestoneReached\(item, rung\)\)\.length/.test(client));
  check('the client counts each flag on its own, with no positional fallback',
    /function milestoneReached\(costume, rung\) \{\s*\n?\s*return toBool\(costume\[rung\.key\]\);\s*\n?\s*\}/
      .test(client),
    'milestoneReached() has grown a rule that reads another flag');

  section('6. The column exists end to end');
  // A rung added to the ladder but not to the schema would render, save, and
  // silently vanish on reload — the PUT whitelist and the migration are the two
  // places that has to be true.
  const db = fs.readFileSync(path.join(ROOT, 'src/services/db.js'), 'utf8');
  check('the migration adds costumeOnly to "Costume"',
    /ALTER TABLE "Costume" ADD COLUMN costumeOnly/.test(db));

  const sql = fs.readFileSync(path.join(ROOT, 'init_db.sql'), 'utf8');
  check('init_db.sql declares costumeOnly', /costumeOnly INTEGER DEFAULT 0/.test(sql));
  check('COSTUME_COLUMNS includes costumeOnly', server.COSTUME_COLUMNS.includes('costumeOnly'));
  check('costumeOnly is LAST in COSTUME_COLUMNS — the ALTER TABLE order',
    server.COSTUME_COLUMNS[server.COSTUME_COLUMNS.length - 1] === 'costumeOnly',
    'last is ' + server.COSTUME_COLUMNS[server.COSTUME_COLUMNS.length - 1]);

  const routes = fs.readFileSync(path.join(ROOT, 'src/routes/costumes.js'), 'utf8');
  check('the PUT accepts costumeOnly',
    /if \(costumeOnly !== undefined\) updates\.push/.test(routes));
  check('the completion endpoint uses the ladder helper',
    /costume\.completionPercent = milestoneCompletionPercent\(costume\)/.test(routes));
  check('the edit dialog reads costumeOnly back into the form',
    /querySelector\('\[name="costumeOnly"\]'\)\.checked = toBool/.test(client));
  check('the edit form submits costumeOnly',
    /costumeOnly: form\.querySelector\('\[name="costumeOnly"\]'\)\.checked/.test(client));
  check('the submit path still sends ALL FIVE keys',
    ['costumeOnly', 'isFullset', 'doneCostest', 'doneEvent', 'donePhotoSession']
      .every(key => new RegExp('\\n\\s+' + key + ': form\\.querySelector').test(client)),
    'a milestone key is no longer sent on every save');

}

main();

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);