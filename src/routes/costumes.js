const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

// Helper function to execute SQL queries
async function queryDb(sql) {
  return new Promise((resolve, reject) => {
    const sqlite = spawn('sqlite3', ['data/db/cms.db']);
    let output = '';
    
    sqlite.stdout.on('data', (data) => { output += data; });
    sqlite.stderr.on('data', (data) => { reject(new Error(data.toString())); });
    
    sqlite.stdin.write(sql);
    sqlite.stdin.end();
    
    sqlite.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`SQLite exited with code ${code}`));
      }
    });
  });
}

// Parse SQLite output into objects
function parseSqlResult(output, columns) {
  if (!output) return [];
  const rows = output.split('\n');
  return rows.map(row => {
    const values = row.split('|');
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = values[i];
    });
    return obj;
  });
}

// ============================================================================
// GET /api/costumes - List all costumes with optional filtering
// ============================================================================
router.get('/costumes', async (req, res) => {
  try {
    const { fandom, status, brand } = req.query;
    
    let where = '1=1';
    if (fandom) where += ` AND fandom LIKE '%${fandom}%'`;
    if (status) where += ` AND status = '${status}'`;
    if (brand) where += ` AND brand LIKE '%${brand}%'`;

    const sql = `SELECT id, character, fandom, brand, size, isFullset, status, buyPrice FROM "Costume" WHERE ${where} ORDER BY character ASC;`;
    
    const result = await queryDb(sql);
    const costumes = parseSqlResult(result, ['id', 'character', 'fandom', 'brand', 'size', 'isFullset', 'status', 'buyPrice']);
    
    res.json({
      count: costumes.length,
      costumes: costumes,
      filters: { fandom, status, brand }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// GET /api/costumes/:id - Get single costume with props
// ============================================================================
router.get('/costumes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const sql = `SELECT * FROM "Costume" WHERE id = '${id}' LIMIT 1;`;
    const result = await queryDb(sql);
    
    if (!result) {
      return res.status(404).json({ error: 'Costume not found' });
    }

    const costume = parseSqlResult(result, ['id', 'character', 'fandom', 'brand', 'size', 'isFullset', 'doneCostest', 'doneEvent', 'donePhotoSession', 'status', 'buyPrice', 'notes', 'referenceUrl', 'imageUrls', 'createdAt', 'updatedAt'])[0];

    // Calculate completion percentage
    const completion = ((costume.isFullset ? 1 : 0) + (costume.doneCostest ? 1 : 0) + (costume.doneEvent ? 1 : 0) + (costume.donePhotoSession ? 1 : 0)) / 4 * 100;
    costume.completionPercent = Math.round(completion);

    res.json(costume);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/costumes - Create new costume
// ============================================================================
router.post('/costumes', async (req, res) => {
  try {
    const { character, fandom, brand, size, notes, referenceUrl } = req.body;

    if (!character || !fandom) {
      return res.status(400).json({ error: 'character and fandom are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const escapedCharacter = character.replace(/'/g, "''");
    const escapedFandom = fandom.replace(/'/g, "''");
    const escapedBrand = brand ? brand.replace(/'/g, "''") : null;
    const escapedNotes = notes ? notes.replace(/'/g, "''") : null;

    const sql = `INSERT INTO "Costume" (id, character, fandom, brand, size, notes, referenceUrl, status, isFullset, createdAt, updatedAt) 
                 VALUES ('${id}', '${escapedCharacter}', '${escapedFandom}', ${escapedBrand ? `'${escapedBrand}'` : 'NULL'}, ${size ? `'${size}'` : 'NULL'}, ${escapedNotes ? `'${escapedNotes}'` : 'NULL'}, ${referenceUrl ? `'${referenceUrl}'` : 'NULL'}, 'IN_POSSESSION', 0, '${now}', '${now}');`;
    
    await queryDb(sql);

    res.status(201).json({
      id,
      character,
      fandom,
      brand: brand || null,
      size: size || null,
      status: 'IN_POSSESSION',
      isFullset: false,
      createdAt: now
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PUT /api/costumes/:id - Update costume
// ============================================================================
router.put('/costumes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, isFullset, doneCostest, doneEvent, donePhotoSession, notes } = req.body;

    let updates = [];
    if (status) updates.push(`status = '${status}'`);
    if (isFullset !== undefined) updates.push(`isFullset = ${isFullset ? 1 : 0}`);
    if (doneCostest !== undefined) updates.push(`doneCostest = ${doneCostest ? 1 : 0}`);
    if (doneEvent !== undefined) updates.push(`doneEvent = ${doneEvent ? 1 : 0}`);
    if (donePhotoSession !== undefined) updates.push(`donePhotoSession = ${donePhotoSession ? 1 : 0}`);
    if (notes) updates.push(`notes = '${notes.replace(/'/g, "''")}'`);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updatedAt = '${new Date().toISOString()}'`);

    const sql = `UPDATE "Costume" SET ${updates.join(', ')} WHERE id = '${id}';`;
    await queryDb(sql);

    res.json({ 
      id, 
      message: 'Costume updated successfully',
      updatedFields: req.body
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DELETE /api/costumes/:id - Delete costume
// ============================================================================
router.delete('/costumes/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const sql = `DELETE FROM "Costume" WHERE id = '${id}';`;
    await queryDb(sql);

    res.json({ 
      id, 
      message: 'Costume deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
