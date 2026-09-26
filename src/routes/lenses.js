const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// Execute SQL queries helper
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

// Parse SQLite output
function parseSqlResult(output, columns) {
  if (!output) return [];
  return output.split('\n').map(row => {
    const values = row.split('|');
    const obj = {};
    columns.forEach((col, i) => { obj[col] = values[i]; });
    return obj;
  });
}

// Check if lens is expiring soon (within 30 days)
function checkExpiryStatus(expiryDate) {
  const now = new Date();
  const expiry = new Date(expiryDate);
  const daysUntilExpiry = Math.floor((expiry - now) / (1000 * 60 * 60 * 24));

  if (daysUntilExpiry < 0) return 'EXPIRED';
  if (daysUntilExpiry <= 30) return 'EXPIRING_SOON';
  return 'ACTIVE';
}

// ============================================================================
// GET /api/lenses - List all lenses with filtering
// ============================================================================
router.get('/lenses', async (req, res) => {
  try {
    const { status, color, brand } = req.query;
    
    let where = '1=1';
    if (status) where += ` AND status = '${status}'`;
    if (color) where += ` AND color LIKE '%${color}%'`;
    if (brand) where += ` AND brand LIKE '%${brand}%'`;

    const sql = `SELECT id, character, color, brand, status, expiryDate FROM "ContactLens" WHERE ${where} ORDER BY character ASC;`;
    const result = await queryDb(sql);
    const lenses = parseSqlResult(result, ['id', 'character', 'color', 'brand', 'status', 'expiryDate']);

    res.json({
      count: lenses.length,
      lenses: lenses,
      statuses: ['UNOPENED', 'ACTIVE', 'EXPIRING_SOON', 'EXPIRED', 'DISPOSED']
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// GET /api/lenses/:id - Get single lens
// ============================================================================
router.get('/lenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `SELECT * FROM "ContactLens" WHERE id = '${id}' LIMIT 1;`;
    const result = await queryDb(sql);

    if (!result) return res.status(404).json({ error: 'Lens not found' });

    const lens = parseSqlResult(result, ['id', 'character', 'color', 'brand', 'prescription', 'purchaseDate', 'openedDate', 'expiryDate', 'isOpened', 'status', 'notes', 'imageUrl', 'createdAt', 'updatedAt'])[0];
    res.json(lens);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/lenses - Create new lens
// ============================================================================
router.post('/lenses', async (req, res) => {
  try {
    const { character, color, brand, prescription, purchaseDate, expiryDate, notes } = req.body;

    if (!character || !color) {
      return res.status(400).json({ error: 'character and color are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const escapedCharacter = character.replace(/'/g, "''");
    const escapedColor = color.replace(/'/g, "''");
    const escapedBrand = brand ? brand.replace(/'/g, "''") : null;
    const escapedNotes = notes ? notes.replace(/'/g, "''") : null;

    const status = checkExpiryStatus(expiryDate || new Date().toISOString());

    const sql = `INSERT INTO "ContactLens" (id, character, color, brand, prescription, purchaseDate, expiryDate, isOpened, status, notes, createdAt, updatedAt)
                 VALUES ('${id}', '${escapedCharacter}', '${escapedColor}', ${escapedBrand ? `'${escapedBrand}'` : 'NULL'}, ${prescription ? `'${prescription}'` : 'NULL'}, ${purchaseDate ? `'${purchaseDate}'` : 'NULL'}, ${expiryDate ? `'${expiryDate}'` : 'NULL'}, 0, '${status}', ${escapedNotes ? `'${escapedNotes}'` : 'NULL'}, '${now}', '${now}');`;
    
    await queryDb(sql);

    res.status(201).json({
      id,
      character,
      color,
      brand: brand || null,
      status,
      createdAt: now
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PUT /api/lenses/:id - Update lens
// ============================================================================
router.put('/lenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, isOpened, openedDate, expiryDate, notes } = req.body;

    let updates = [];
    if (status) updates.push(`status = '${status}'`);
    if (isOpened !== undefined) updates.push(`isOpened = ${isOpened ? 1 : 0}`);
    if (openedDate) updates.push(`openedDate = '${openedDate}'`);
    if (expiryDate) updates.push(`expiryDate = '${expiryDate}'`);
    if (notes) updates.push(`notes = '${notes.replace(/'/g, "''")}'`);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updatedAt = '${new Date().toISOString()}'`);

    const sql = `UPDATE "ContactLens" SET ${updates.join(', ')} WHERE id = '${id}';`;
    await queryDb(sql);

    res.json({ id, message: 'Lens updated successfully', updatedFields: req.body });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DELETE /api/lenses/:id - Delete lens
// ============================================================================
router.delete('/lenses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `DELETE FROM "ContactLens" WHERE id = '${id}';`;
    await queryDb(sql);

    res.json({ id, message: 'Lens deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
