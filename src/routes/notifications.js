const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { requireApiKey } = require('../middleware/apiKeyAuth');
const { numberParam } = require('../services/sqlSafety');
const { DB_FILE } = require('../services/db');
const telegramConfig = require('../services/telegramConfig');

// Execute SQL query helper
async function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', [DB_FILE]);
    let output = '';
    
    sqlite.stdout.on('data', (data) => { output += data; });
    sqlite.stderr.on('data', (data) => { reject(new Error(data.toString())); });
    
    sqlite.stdin.write(sql);
    sqlite.stdin.end();
    
    sqlite.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`SQLite exited with code ${code}`));
    });
  });
}

function parseSqlResult(output, columns) {
  if (!output) return [];
  return output.split('\n').map(row => {
    const values = row.split('|');
    const obj = {};
    columns.forEach((col, i) => { obj[col] = values[i]; });
    return obj;
  });
}

// ============================================================================
// GET /api/notifications/contact-lenses/expiring
// Returns colored lenses expiring within the threshold in days
// Protected via Header: X-CMS-API-KEY
// ============================================================================
//
// WHO READS THIS NOW — the n8n integration was removed
//
// This endpoint used to be polled once a day by an external scheduler that then
// forwarded the answer to Telegram. It is no longer: the daily check now lives
// inside this process, in src/services/lensExpiryChecker.js, which queries the
// lenses directly and sends the message itself. This endpoint remains as a
// plain read-only view of the same question — useful for inspecting what the
// check sees, and for any scripted caller that wants the list as JSON — but
// nothing in the app depends on it any more.
//
// `?days=` still works and still WINS over the stored setting, so a caller can
// ask for a different window without changing the configuration. With no query
// string it reports whatever the operator set in Settings → Telegram.
//
// `days` is still validated strictly, for the same reason as before: a lenient
// parse would accept '14abc' as 14. And an out-of-range value is now CLAMPED to
// the configured maximum instead of being honoured, because a caller asking for
// a 100,000-day window is either broken or probing, and honouring it would
// return the entire inventory as "expiring".
router.get('/notifications/contact-lenses/expiring', requireApiKey, async (req, res) => {
  try {
    // The configured window. A database problem here resolves to the built-in
    // default rather than throwing — see getExpiryThresholdDays() — because
    // this endpoint returning nothing at all is a worse failure than this
    // endpoint using the wrong window.
    const configuredDays = await telegramConfig.getExpiryThresholdDays();

    // `days` is validated as a strict non-negative integer.
    //
    // The old `parseInt(..., 10)` accepted anything with a numeric prefix and
    // silently truncated it: '14; DROP TABLE' became 14 and '7abc' became 7, so
    // a malformed or hostile value was accepted and answered as though it were
    // legitimate. numberParam() requires the WHOLE value to be a finite integer.
    //
    // (This value is not interpolated into SQL — the threshold is applied in JS
    // below — so this was never an injection, but it is the same class of
    // "unvalidated numeric input" defect and is fixed on the same terms.)
    //
    // The fallback is now the CONFIGURED window rather than a literal 14, which
    // is the entire point of the change.
    let requestedDays;
    try {
      requestedDays = numberParam(req.query.days, {
        name: 'days', integer: true, min: 0, fallback: configuredDays
      });
    } catch (validationError) {
      return res.status(400).json({
        error: 'Parameter "days" must be a positive number',
        code: 'VALIDATION_ERROR'
      });
    }

    const thresholdDays = Math.min(requestedDays, telegramConfig.MAX_THRESHOLD_DAYS);
    if (thresholdDays !== requestedDays) {
      console.warn(`⚠️  Requested a ${requestedDays}-day window, clamped to ${thresholdDays}.`);
    }

    // Retrieve active or unopened lenses
    const sql = `SELECT id, character, color, brand, prescription, expiryDate, status, openedDate FROM "ContactLens" WHERE status != 'DISPOSED' ORDER BY expiryDate ASC;`;
    const result = await queryDb(sql);
    const lenses = parseSqlResult(result, ['id', 'character', 'color', 'brand', 'prescription', 'expiryDate', 'status', 'openedDate']);

    const now = new Date();
    const expiringItems = [];

    for (const lens of lenses) {
      if (!lens.expiryDate) continue;
      const expiry = new Date(lens.expiryDate);
      if (isNaN(expiry.getTime())) continue;

      const diffMs = expiry - now;
      const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

      if (daysRemaining <= thresholdDays) {
        expiringItems.push({
          id: lens.id,
          character: lens.character || 'Unassigned',
          color: lens.color,
          brand: lens.brand || 'Unknown',
          prescription: lens.prescription || '0.00',
          expiryDate: lens.expiryDate,
          daysRemaining: daysRemaining,
          status: daysRemaining < 0 ? 'EXPIRED' : (daysRemaining <= 14 ? 'EXPIRING_SOON' : lens.status)
        });
      }
    }

    res.json({
      thresholdDays,
      // The window in force when there is no ?days= override. It makes an
      // override visible rather than silently changing what "expiring" means,
      // so a caller that overrides the window can also report the real one.
      configuredThresholdDays: configuredDays,
      thresholdSource: requestedDays === configuredDays ? 'configured' : 'request',
      count: expiringItems.length,
      items: expiringItems
    });
  } catch (error) {
    // The sqlite3 CLI writes its parse errors to stderr, and this route was
    // returning error.message verbatim — which leaks table and column names of
    // the real schema to any caller holding the API key. Log the detail, return
    // a generic body, and use the project's standard {error, code} shape.
    console.error('❌ notifications/contact-lenses/expiring:', error.message);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

// ============================================================================
// GET /api/notifications/costumes/on-rent
// Returns all costumes currently on rent
// Protected via Header: X-CMS-API-KEY
// ============================================================================
router.get('/notifications/costumes/on-rent', requireApiKey, async (req, res) => {
  try {
    const sql = `SELECT id, character, fandom, brand, size, updatedAt FROM "Costume" WHERE status = 'ON_RENT' ORDER BY updatedAt ASC;`;
    const result = await queryDb(sql);
    const costumes = parseSqlResult(result, ['id', 'character', 'fandom', 'brand', 'size', 'updatedAt']);

    res.json({
      count: costumes.length,
      items: costumes
    });
  } catch (error) {
    console.error('❌ notifications/costumes/on-rent:', error.message);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
