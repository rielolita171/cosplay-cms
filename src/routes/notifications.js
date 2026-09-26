const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { requireApiKey } = require('../middleware/apiKeyAuth');

// Execute SQL query helper
async function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', ['data/db/cms.db']);
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
// Returns colored lenses expiring within the specified threshold in days (default: 14)
// Protected via Header: X-CMS-API-KEY
// ============================================================================
router.get('/notifications/contact-lenses/expiring', requireApiKey, async (req, res) => {
  try {
    const thresholdDays = parseInt(req.query.days || '14', 10);
    
    if (isNaN(thresholdDays) || thresholdDays < 0) {
      return res.status(400).json({ error: 'Parameter "days" must be a positive number' });
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
      count: expiringItems.length,
      items: expiringItems
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
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
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
