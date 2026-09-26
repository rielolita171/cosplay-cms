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

// ============================================================================
// GET /api/props - List all props with filtering
// ============================================================================
router.get('/props', async (req, res) => {
  try {
    const { costumeId, category, condition } = req.query;
    
    let where = '1=1';
    if (costumeId) where += ` AND costumeId = '${costumeId}'`;
    if (category) where += ` AND category = '${category}'`;
    if (condition) where += ` AND condition = '${condition}'`;

    const sql = `SELECT id, costumeId, name, category, condition, location FROM "Prop" WHERE ${where} ORDER BY name ASC;`;
    const result = await queryDb(sql);
    const props = parseSqlResult(result, ['id', 'costumeId', 'name', 'category', 'condition', 'location']);

    res.json({
      count: props.length,
      props: props,
      categories: ['Weapon', 'Armor', 'Headpiece', 'Wig', 'Accessory', 'Shoes']
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// GET /api/props/:id - Get single prop
// ============================================================================
router.get('/props/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `SELECT * FROM "Prop" WHERE id = '${id}' LIMIT 1;`;
    const result = await queryDb(sql);

    if (!result) return res.status(404).json({ error: 'Prop not found' });

    const prop = parseSqlResult(result, ['id', 'costumeId', 'name', 'category', 'location', 'condition', 'notes', 'imageUrls', 'createdAt', 'updatedAt'])[0];
    res.json(prop);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/props - Create new prop
// ============================================================================
router.post('/props', async (req, res) => {
  try {
    const { costumeId, name, category, location, condition, notes } = req.body;

    if (!costumeId || !name || !category) {
      return res.status(400).json({ error: 'costumeId, name, and category are required' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const escapedName = name.replace(/'/g, "''");
    const escapedNotes = notes ? notes.replace(/'/g, "''") : null;
    const escapedLocation = location ? location.replace(/'/g, "''") : null;

    const sql = `INSERT INTO "Prop" (id, costumeId, name, category, location, condition, notes, createdAt, updatedAt)
                 VALUES ('${id}', '${costumeId}', '${escapedName}', '${category}', ${escapedLocation ? `'${escapedLocation}'` : 'NULL'}, ${condition ? `'${condition}'` : 'NULL'}, ${escapedNotes ? `'${escapedNotes}'` : 'NULL'}, '${now}', '${now}');`;
    
    await queryDb(sql);

    res.status(201).json({
      id,
      costumeId,
      name,
      category,
      location: location || null,
      condition: condition || null,
      createdAt: now
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PUT /api/props/:id - Update prop
// ============================================================================
router.put('/props/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { location, condition, notes } = req.body;

    let updates = [];
    if (location) updates.push(`location = '${location.replace(/'/g, "''")}'`);
    if (condition) updates.push(`condition = '${condition}'`);
    if (notes) updates.push(`notes = '${notes.replace(/'/g, "''")}'`);

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`updatedAt = '${new Date().toISOString()}'`);

    const sql = `UPDATE "Prop" SET ${updates.join(', ')} WHERE id = '${id}';`;
    await queryDb(sql);

    res.json({ id, message: 'Prop updated successfully', updatedFields: req.body });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// DELETE /api/props/:id - Delete prop
// ============================================================================
router.delete('/props/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `DELETE FROM "Prop" WHERE id = '${id}';`;
    await queryDb(sql);

    res.json({ id, message: 'Prop deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
