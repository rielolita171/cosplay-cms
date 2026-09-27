/**
 * SQL-injection defence for the hand-rolled `spawn('sqlite3')` transport.
 *
 * WHY A SEPARATE MODULE
 * The project has no bind-parameter API: every route file spawns the `sqlite3`
 * binary and pipes a SQL string to stdin — that CLI is the only driver, there is
 * no in-process SQLite binding (see the header of src/services/db.js). "Use
 * prepared statements" is therefore not available, and safety has to come
 * from the text that reaches the statement. The route files each carry their own
 * copy of the spawn/parse helpers, so without a shared home it is trivially easy
 * for one file to gain a fourth, slightly different, escaping rule. This module
 * is that home: pure validation + escaping, no I/O, no driver, no architecture
 * change.
 *
 * THE RULES ENFORCED HERE
 * 1. IDENTIFIER / ORDER-BY / COLUMN positions are never escaped — they are
 *    allowlisted. Doubling quotes is meaningless in an identifier position, so an
 *    escaping-based "fix" there would be a false sense of safety.
 * 2. STRING-LITERAL positions go through esc(), which is *sufficient* there
 *    (a SQLite single-quoted literal needs only `'` -> `''`).
 * 3. NUMERIC positions never receive a raw string: the value is parsed with
 *    Number() and rejected unless finite, so `5; DROP TABLE` can never reach
 *    the statement at all.
 * 4. Every value that reaches SQL is additionally type-checked and
 *    length-capped, so the statement text is bounded regardless of escaping.
 *
 * A note on defence in depth: esc() alone would already be correct for the
 * string-literal positions below. The type/length/enum checks are there so that
 * a *future* edit which forgets esc() — or which moves a value into a different
 * SQL context — is caught by a validator rather than becoming an injection.
 */

/**
 * Escape a value for interpolation into a SQL *string literal*.
 *
 * Within a single-quoted SQLite literal the only significant character is the
 * quote itself, so doubling it is correct and complete. NOT sufficient for an
 * identifier position, and not a substitute for a type check — see above.
 */
function esc(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Build an Error that the routes' existing catch blocks turn into a 400. */
function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Validate a value drawn from a closed set (an enum / a sort key / a direction).
 *
 * This is the strongest defence available and the one to prefer wherever the
 * domain is genuinely finite: anything outside the set is rejected outright
 * rather than sanitised into something that happens to be inert.
 *
 * @param {*} value   the caller-supplied value (undefined / null / '' => absent)
 * @param {string[]} allowed
 * @param {string} name field name, used in the error message
 * @returns {string|null} the value, or null when the field is absent
 * @throws {Error} with `status = 400` when present but not in the set
 */
function enumParam(value, allowed, name) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || allowed.indexOf(value) === -1) {
    throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

/**
 * Validate a free-text value that will be interpolated into a SQL string
 * literal, then escape it.
 *
 * Note this does NOT restrict the character set: a quote is a legitimate
 * character in a fandom name or a note, and rejecting it would be a functional
 * regression. Correctness comes from esc(); the type and length checks are what
 * keep the statement text bounded and stop `?f=1&f=2` (which Express hands over
 * as an array) from being silently stringified into something the caller never
 * asked for.
 *
 * @param {*} value
 * @param {{name: string, maxLength: number, noSeparator?: boolean}} opts
 *   `noSeparator` additionally rejects '|' and line breaks, which are the
 *   sqlite3 CLI's row/field separators on this pipe transport (a stored value
 *   containing one silently corrupts every read of that column).
 * @returns {string|null} the trimmed value, or null when absent/blank
 * @throws {Error} with `status = 400`
 */
function textParam(value, { name, maxLength, noSeparator = false }) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw badRequest(`${name} must be a single string value`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw badRequest(`${name} accepts at most ${maxLength} characters`);
  }
  if (noSeparator && /[|\r\n]/.test(trimmed)) {
    throw badRequest(`${name} cannot contain the character | or a line break`);
  }
  return trimmed;
}

/**
 * Validate a value that will be interpolated into a SQL *numeric* position.
 *
 * Rejection is total and happens before any statement is built: the value must
 * be a string or a number that parses to a finite number, and (for `integer`)
 * must have no fractional part. `'5; DROP TABLE "Costume"; --'` fails on the
 * last step and is refused, so the payload never reaches the statement — which
 * is the point: in a numeric position an escaping-based defence is meaningless
 * because there is no literal to escape out of.
 *
 * @param {*} value
 * @param {{name: string, min?: number, max?: number, integer?: boolean,
 *          fallback?: number}} opts
 * @returns {number}
 * @throws {Error} with `status = 400`
 */
function numberParam(value, { name, min, max, integer = false, fallback }) {
  if (value === undefined || value === null || value === '') {
    if (fallback === undefined) {
      throw badRequest(`${name} is required and must be a number`);
    }
    return fallback;
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw badRequest(`${name} must be a number`);
  }
  // Number() is strict about trailing garbage: Number('5; DROP TABLE') is NaN,
  // whereas parseInt() would silently yield 5 and hide the injection attempt.
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    throw badRequest(`${name} must be a number`);
  }
  if (integer && !Number.isInteger(parsed)) {
    throw badRequest(`${name} must be a whole number`);
  }
  if (min !== undefined && parsed < min) {
    throw badRequest(`${name} must be at least ${min}`);
  }
  if (max !== undefined && parsed > max) {
    throw badRequest(`${name} must be at most ${max}`);
  }
  return parsed;
}

/**
 * Normalise a route `:id` parameter destined for a `WHERE id = ...` clause.
 *
 * A lookup key is not an enum, so this is deliberately NOT a charset allowlist:
 * rejecting an unknown id with 400 would change the contract of every
 * `GET /:id` (which must keep answering 404 for a costume that does not exist)
 * and of every PUT/DELETE (which answer 200 whether or not a row matched).
 * The value is instead length-capped, and an over-long id is reported as "no
 * such row" so the observable behaviour is identical to a well-formed miss.
 *
 * @param {*} value
 * @param {number} [maxLength=200]
 * @returns {string|null} the id, or null when it cannot be a real row id
 */
function idParam(value, maxLength = 200) {
  if (typeof value !== 'string' || value === '' || value.length > maxLength) {
    return null;
  }
  return value;
}

/**
 * The ONLY accepted shape for a stored colour hex: '#' plus exactly six hex digits.
 *
 * WHY A DEDICATED VALIDATOR AND NOT textParam()
 * A hex value is the one free-text field in this schema whose value is destined
 * for a STYLE CONTEXT on the client: the dashboard paints it into
 * `style="background:<hex>"` on the lens card. Escaping (esc()) is correct and
 * sufficient for a SQL string literal, but it is the WRONG tool for a CSS
 * property — `esc()` would happily pass through `#fff; background-image:url(...)`
 * because none of those characters is a quote. So the value is not escaped and
 * sanitised here, it is ALLOWLISTED: the anchored pattern admits exactly the 16
 * million values of the form #RRGGBB and nothing else. A value that fails is
 * refused with 400 rather than being repaired, because "repaired" is how a
 * crafted string reaches a style property in the first place.
 *
 * The pattern contains no quote, no '<', no ';' and no whitespace, so a value
 * that passes it cannot terminate a declaration or open a new attribute — which
 * is exactly the property the client-side `safeHexColor()` re-checks before
 * interpolating.
 *
 * @param {*} value
 * @param {{name?: string}} [opts]
 * @returns {string|null} the value, or null when absent/blank
 * @throws {Error} with `status = 400` when present but not a #RRGGBB literal
 */
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function hexColorParam(value, { name = 'colorHex' } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw badRequest(`${name} must be a single string value`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (!HEX_COLOR_PATTERN.test(trimmed)) {
    throw badRequest(`${name} must be a hex colour like #1A2B3C`);
  }
  return trimmed;
}

/**
 * Collapse runs of internal whitespace to a single space and trim the ends.
 *
 * WHY THIS IS HERE RATHER THAN IN ONE ROUTE
 * "Brand"/"Fandom" names are a *soft reference*: "Costume".brand holds the NAME
 * text, and the only thing that makes "blue  archive" (double space) and "blue
 * archive" the same entry is that both produce the same `nameLower`. If one
 * write path collapsed whitespace and another did not, the two spellings would
 * silently become two managed-list rows and two `<select>` options that both
 * point at the same costumes. Normalisation therefore has to be ONE function
 * used by every writer: brands.js, fandoms.js and costumes.js (which writes the
 * costume side of the same reference), plus the boot backfill in db.js.
 *
 * `\s` covers space, tab, CR, LF and the Unicode spaces; the line-break
 * characters additionally have to be rejected afterwards because they are the
 * sqlite3 CLI's row separator on this transport (see textParam's noSeparator).
 *
 * @param {*} value
 * @returns {string} the normalised value; '' for null/undefined/blank
 */
function collapseWhitespace(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Whether `body` carries `key` at all, ignoring an explicit JSON null.
 *
 * This is the presence test textParam() cannot make on its own. textParam()
 * collapses three different inputs — absent, null and '' — into the single
 * value `null`, which a route then reads as "leave this column alone". That
 * conflates two distinct caller intents:
 *
 *   1. the caller never mentioned the field  -> partial update, leave alone
 *   2. the caller sent '' because the user cleared the input -> clear it
 *
 * Intent 1 must survive: a partial update should not blank fields the caller
 * never mentioned. But intent 2 has to be expressible, or a cleared input is
 * silently discarded — which is exactly the bug this fixes. So presence is
 * decided on the KEY, and only here.
 *
 * `null` counts as absent so an explicit null keeps the historical
 * "leave it alone" meaning rather than silently clearing a column.
 *
 * @param {object} body the parsed request body
 * @param {string} key  the field name to test for
 * @returns {boolean} true when the caller supplied a real value for `key`
 */
function textUpdate(body, key) {
  return body[key] !== undefined && body[key] !== null;
}

module.exports = {
  esc,
  badRequest,
  enumParam,
  textParam,
  textUpdate,
  numberParam,
  idParam,
  hexColorParam,
  HEX_COLOR_PATTERN,
  collapseWhitespace
};
