# Phase 2: Step 3 — Props & Contact Lenses Endpoints

## Objective
Create API endpoints for managing costume props and contact lenses with categorization and status tracking.

---

## Endpoints Overview

### Props Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/props` | List all props (filterable by costume/category) |
| `POST` | `/api/props` | Create new prop |
| `GET` | `/api/props/:id` | Get single prop |
| `PUT` | `/api/props/:id` | Update prop |
| `DELETE` | `/api/props/:id` | Delete prop |

### Contact Lenses Endpoints
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/lenses` | List all contact lenses (filterable) |
| `POST` | `/api/lenses` | Create new lens record |
| `GET` | `/api/lenses/:id` | Get single lens |
| `PUT` | `/api/lenses/:id` | Update lens status/expiry |
| `DELETE` | `/api/lenses/:id` | Delete lens record |

---

## Step 3.1: Create Props Routes

Create `src/routes/props.js`:

```javascript
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
```

---

## Step 3.2: Create Contact Lenses Routes

Create `src/routes/lenses.js`:

```javascript
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
```

---

## Step 3.3: Register Routes in server.js

Update `src/server.js` to include both routes:

```javascript
// Add after costume routes
const propsRoutes = require('./routes/props');
const lensesRoutes = require('./routes/lenses');
app.use('/api', propsRoutes);
app.use('/api', lensesRoutes);
```

---

## Step 3.4: Test Props & Lenses Endpoints

### Create a prop
```bash
curl -X POST http://localhost:3000/api/props \
  -H "Content-Type: application/json" \
  -d '{
    "costumeId": "[COSTUME_ID]",
    "name": "Sword",
    "category": "Weapon",
    "location": "Shelf A",
    "condition": "Good",
    "notes": "Foam prop, needs paint touch-up"
  }'
```

### List all props
```bash
curl http://localhost:3000/api/props
```

### Filter props by category
```bash
curl "http://localhost:3000/api/props?category=Weapon"
```

### Create contact lens record
```bash
curl -X POST http://localhost:3000/api/lenses \
  -H "Content-Type: application/json" \
  -d '{
    "character": "Fischl",
    "color": "Amber",
    "brand": "GEO",
    "prescription": "-1.50",
    "purchaseDate": "2026-01-15",
    "expiryDate": "2027-01-15",
    "notes": "Comfortable fit"
  }'
```

### List lenses by status
```bash
curl "http://localhost:3000/api/lenses?status=ACTIVE"
```

### Update lens status
```bash
curl -X PUT http://localhost:3000/api/lenses/[ID] \
  -H "Content-Type: application/json" \
  -d '{
    "status": "DISPOSED",
    "notes": "Torn during removal"
  }'
```

---

## Success Criteria

✅ Props endpoints fully functional (CRUD + filtering)  
✅ Lenses endpoints fully functional (CRUD + filtering)  
✅ Status auto-calculation for expiring lenses  
✅ Proper error handling (400 for bad requests, 404 for not found)  
✅ All query filters working correctly  

---

## Next Step

Proceed to **Step 4: Image Optimization with Sharp**.
