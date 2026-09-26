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

// Full column list of the "Costume" table (see init_db.sql / live schema).
// Every SELECT in this file is `SELECT *`, so the parse order MUST match this
// list exactly — an omission here silently blanks the field in the UI.
const COSTUME_COLUMNS = [
  'id', 'fandom', 'character', 'brand', 'size', 'isFullset',
  'doneCostest', 'doneEvent', 'donePhotoSession', 'status',
  'buyPrice', 'sellPrice', 'sellPriceMutual',
  'notes', 'referenceUrl', 'imageUrls', 'createdAt', 'updatedAt'
];

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
// Field validators
// ============================================================================
// "Costume".imageUrls is TEXT holding a JSON array of strings (init_db.sql:
// `imageUrls TEXT DEFAULT '[]'`). The dashboard sends it as a JSON *string*
// (`JSON.stringify(urls)`), so a raw array is also tolerated and re-serialised
// here. Anything that is not a JSON array of strings is rejected outright —
// writing a half-parsed or object-shaped value into that column is what makes
// the thumbnail render as raw text in the UI.
const MAX_IMAGE_URLS = 20;
const MAX_IMAGE_URL_LENGTH = 2048;
const MAX_NOTES_LENGTH = 2000;

/**
 * Validate an incoming `imageUrls` value.
 * @returns {string|null} the canonical JSON string to persist, or null when the
 *   field is absent (null === "leave the column alone").
 * @throws {Error} with `status = 400` when the value is malformed.
 */
function normalizeImageUrls(value) {
  if (value === undefined || value === null) return null;

  let urls;
  if (Array.isArray(value)) {
    urls = value;
  } else if (typeof value === 'string') {
    if (value.length > MAX_IMAGE_URLS * (MAX_IMAGE_URL_LENGTH + 8)) {
      throw Object.assign(new Error('imageUrls payload is too large'), { status: 400 });
    }
    try {
      urls = JSON.parse(value);
    } catch (parseError) {
      throw Object.assign(new Error('imageUrls must be a JSON array of strings'), { status: 400 });
    }
  } else {
    throw Object.assign(new Error('imageUrls must be a JSON array of strings'), { status: 400 });
  }

  if (!Array.isArray(urls)) {
    throw Object.assign(new Error('imageUrls must be a JSON array of strings'), { status: 400 });
  }
  if (urls.length > MAX_IMAGE_URLS) {
    throw Object.assign(new Error(`imageUrls accepts at most ${MAX_IMAGE_URLS} entries`), { status: 400 });
  }
  for (const url of urls) {
    if (typeof url !== 'string' || url.length === 0 || url.length > MAX_IMAGE_URL_LENGTH) {
      throw Object.assign(new Error('imageUrls entries must be non-empty strings of at most '
        + `${MAX_IMAGE_URL_LENGTH} characters`), { status: 400 });
    }
  }

  return JSON.stringify(urls);
}

/** Cap `notes` so an unbounded blob cannot be written into the TEXT column. */
function normalizeNotes(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw Object.assign(new Error('notes must be a string'), { status: 400 });
  }
  if (value.length > MAX_NOTES_LENGTH) {
    throw Object.assign(new Error(`notes accepts at most ${MAX_NOTES_LENGTH} characters`), { status: 400 });
  }
  return value;
}

// ============================================================================
// GET /api/costumes - List all costumes with optional filtering
// ============================================================================
router.get('/', async (req, res) => {
  try {
    const { fandom, status, brand } = req.query;
    
    let where = '1=1';
    if (fandom) where += ` AND fandom LIKE '%${fandom}%'`;
    if (status) where += ` AND status = '${status}'`;
    if (brand) where += ` AND brand LIKE '%${brand}%'`;

    // SELECT * so the list endpoint returns every column the dashboard cards
    // render (doneCostest, doneEvent, donePhotoSession, referenceUrl, imageUrls,
    // notes, prices, ...). A narrow column list here was the cause of blank cards.
    const sql = `SELECT * FROM "Costume" WHERE ${where} ORDER BY character ASC;`;

    const result = await queryDb(sql);
    const costumes = parseSqlResult(result, COSTUME_COLUMNS);
    
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
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const sql = `SELECT * FROM "Costume" WHERE id = '${id}' LIMIT 1;`;
    const result = await queryDb(sql);
    
    if (!result) {
      return res.status(404).json({ error: 'Costume not found' });
    }

    const costume = parseSqlResult(result, COSTUME_COLUMNS)[0];

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
router.post('/', async (req, res) => {
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
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, isFullset, doneCostest, doneEvent, donePhotoSession, notes, imageUrls } = req.body;

    let updates = [];
    if (status) updates.push(`status = '${status.replace(/'/g, "''")}'`);
    if (isFullset !== undefined) updates.push(`isFullset = ${isFullset ? 1 : 0}`);
    if (doneCostest !== undefined) updates.push(`doneCostest = ${doneCostest ? 1 : 0}`);
    if (doneEvent !== undefined) updates.push(`doneEvent = ${doneEvent ? 1 : 0}`);
    if (donePhotoSession !== undefined) updates.push(`donePhotoSession = ${donePhotoSession ? 1 : 0}`);

    // `imageUrls` is part of the Phase 5 upload flow: the image POST returns the
    // saved URL and the dashboard then PUTs the merged list back. Omitting it
    // from this whitelist made the thumbnail survive only until a page reload.
    const normalizedImages = normalizeImageUrls(imageUrls);
    if (normalizedImages !== null) {
      updates.push(`imageUrls = '${normalizedImages.replace(/'/g, "''")}'`);
    }

    const normalizedNotes = normalizeNotes(notes);
    if (normalizedNotes !== null) {
      updates.push(`notes = '${normalizedNotes.replace(/'/g, "''")}'`);
    }

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
    // Malformed input is a client error (400), not a server fault (500).
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

// ============================================================================
// DELETE /api/costumes/:id - Delete costume
// ============================================================================
router.delete('/:id', async (req, res) => {
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
