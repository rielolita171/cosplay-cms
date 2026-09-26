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

// Full column list of the "Prop" table (see init_db.sql / live schema).
// This file SELECTs `p.*, c.character AS costumeName`, so the parse order
// must match exactly — a mismatch silently mislabels fields in the UI.
const PROP_COLUMNS = [
  'id', 'costumeId', 'name', 'category', 'location', 'condition',
  'notes', 'imageUrls', 'createdAt', 'updatedAt', 'costumeName'
];

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
router.get('/', async (req, res) => {
  try {
    const { costumeId, category, condition } = req.query;

    // Columns are aliased with the `p.` prefix because the query joins "Costume".
    let where = '1=1';
    if (costumeId) where += ` AND p.costumeId = '${costumeId}'`;
    if (category) where += ` AND p.category = '${category}'`;
    if (condition) where += ` AND p.condition = '${condition}'`;

    // Left join so each prop also carries the display name of its costume.
    // `p.*` restores notes/imageUrls, which the narrow column list omitted.
    const sql = `SELECT p.*, c.character AS costumeName
                 FROM "Prop" p
                 LEFT JOIN "Costume" c ON c.id = p.costumeId
                 WHERE ${where}
                 ORDER BY p.name ASC;`;
    const result = await queryDb(sql);
    const props = parseSqlResult(result, PROP_COLUMNS);

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
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const sql = `SELECT p.*, c.character AS costumeName
                 FROM "Prop" p
                 LEFT JOIN "Costume" c ON c.id = p.costumeId
                 WHERE p.id = '${id}' LIMIT 1;`;
    const result = await queryDb(sql);

    if (!result) return res.status(404).json({ error: 'Prop not found' });

    const prop = parseSqlResult(result, PROP_COLUMNS)[0];
    res.json(prop);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/props - Create new prop
// ============================================================================
// "Prop".costumeId is `TEXT` with `FOREIGN KEY (costumeId) REFERENCES
// "Costume"(id) ON DELETE SET NULL` (init_db.sql) and the Prisma model declares
// `costumeId String?` / `costume Costume?`. A standalone prop — one that
// belongs to no costume — is therefore a legitimate row in this data model, so
// costumeId is optional here and stored as NULL when it is absent. The
// dashboard's prop form currently marks the select as required; that is a UI
// constraint, not an API rule, and it is not enforced server-side.
router.post('/', async (req, res) => {
  try {
    const { costumeId, name, category, location, condition, notes } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: 'name and category are required' });
    }

    // Normalise the optional link: '' / null / undefined all mean "standalone".
    const linkedCostumeId = typeof costumeId === 'string' && costumeId.trim() !== ''
      ? costumeId.trim()
      : null;
    if (costumeId !== undefined && costumeId !== null && typeof costumeId !== 'string') {
      return res.status(400).json({ error: 'costumeId must be a string' });
    }
    if (linkedCostumeId && linkedCostumeId.length > 64) {
      return res.status(400).json({ error: 'costumeId is too long' });
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const escapedName = name.replace(/'/g, "''");
    const escapedNotes = notes ? notes.replace(/'/g, "''") : null;
    const escapedLocation = location ? location.replace(/'/g, "''") : null;

    const sql = `INSERT INTO "Prop" (id, costumeId, name, category, location, condition, notes, createdAt, updatedAt)
                 VALUES ('${id}', ${linkedCostumeId ? `'${linkedCostumeId.replace(/'/g, "''")}'` : 'NULL'}, '${escapedName}', '${category}', ${escapedLocation ? `'${escapedLocation}'` : 'NULL'}, ${condition ? `'${condition}'` : 'NULL'}, ${escapedNotes ? `'${escapedNotes}'` : 'NULL'}, '${now}', '${now}');`;
    
    await queryDb(sql);

    res.status(201).json({
      id,
      costumeId: linkedCostumeId,
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
router.put('/:id', async (req, res) => {
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
router.delete('/:id', async (req, res) => {
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
