const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const { generateToken, verifyToken } = require('../middleware/auth');

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

let schemaChecked = false;
async function ensureUserSchema() {
  if (schemaChecked) return;
  try {
    await queryDb('ALTER TABLE "User" ADD COLUMN passwordHash TEXT;');
  } catch (e) {
    // Column already exists or table not ready
  }
  try {
    await queryDb('ALTER TABLE "User" ADD COLUMN role TEXT DEFAULT "user";');
  } catch (e) {
    // Column already exists or table not ready
  }
  schemaChecked = true;
}

// Hash password (simple - use bcrypt in production)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
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
// POST /auth/register - Create new user
// ============================================================================
router.post('/auth/register', async (req, res) => {
  try {
    await ensureUserSchema();
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const id = randomUUID();
    const passwordHash = hashPassword(password);
    const escapedUsername = username.replace(/'/g, "''");
    const escapedEmail = email.replace(/'/g, "''");
    const now = new Date().toISOString();

    const sql = `INSERT INTO "User" (id, username, email, passwordHash, createdAt, updatedAt)
                 VALUES ('${id}', '${escapedUsername}', '${escapedEmail}', '${passwordHash}', '${now}', '${now}');`;
    
    await queryDb(sql);
    const token = generateToken(id, 'user');

    res.status(201).json({
      id,
      username,
      email,
      token,
      role: 'user',
      message: 'User registered successfully'
    });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /auth/login - Authenticate user
// ============================================================================
router.post('/auth/login', async (req, res) => {
  try {
    await ensureUserSchema();
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }

    const passwordHash = hashPassword(password);
    const escapedUsername = username.replace(/'/g, "''");

    const sql = `SELECT id, username, email FROM "User" WHERE username = '${escapedUsername}' AND passwordHash = '${passwordHash}' LIMIT 1;`;
    const result = await queryDb(sql);

    if (!result) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const user = parseSqlResult(result, ['id', 'username', 'email'])[0];
    const token = generateToken(user.id, 'user');

    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      token,
      role: 'user'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// GET /auth/profile - Get current user profile (requires auth)
// ============================================================================
router.get('/auth/profile', verifyToken, async (req, res) => {
  try {
    const sql = `SELECT id, username, email, createdAt FROM "User" WHERE id = '${req.user.id}' LIMIT 1;`;
    const result = await queryDb(sql);

    if (!result) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = parseSqlResult(result, ['id', 'username', 'email', 'createdAt'])[0];
    res.json({
      ...user,
      role: req.user.role || 'user'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /auth/refresh - Refresh token
// ============================================================================
router.post('/auth/refresh', verifyToken, (req, res) => {
  try {
    const { id, role } = req.user;
    const newToken = generateToken(id, role || 'user');

    res.json({
      token: newToken,
      message: 'Token refreshed successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /auth/logout - Logout (invalidate token client-side)
// ============================================================================
router.post('/auth/logout', verifyToken, (req, res) => {
  res.json({
    message: 'Logged out successfully. Please discard the token.'
  });
});

module.exports = router;
