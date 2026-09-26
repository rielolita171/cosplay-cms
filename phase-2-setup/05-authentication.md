# Phase 2: Step 5 — Authentication & Authorization Middleware

## Objective
Implement JWT-based authentication and role-based access control (RBAC) for API endpoint protection.

---

## Security Overview

- **Authentication**: Verify user identity via JWT tokens
- **Authorization**: Control endpoint access based on user roles
- **Token Management**: Issue, validate, and refresh JWT tokens
- **Session Security**: Secure token storage and expiration

---

## Step 5.1: Create Authentication Middleware

Create `src/middleware/auth.js`:

```javascript
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const TOKEN_EXPIRY = '7d';

// ============================================================================
// Generate JWT Token
// ============================================================================
function generateToken(userId, role = 'user') {
  return jwt.sign(
    {
      id: userId,
      role: role,
      iat: Math.floor(Date.now() / 1000)
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// ============================================================================
// Verify JWT Token Middleware
// ============================================================================
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
}

// ============================================================================
// Authorization Middleware - Check User Role
// ============================================================================
function authorize(requiredRole) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const roleHierarchy = {
      'admin': 3,
      'curator': 2,
      'user': 1,
      'guest': 0
    };

    const userLevel = roleHierarchy[req.user.role] || 0;
    const requiredLevel = roleHierarchy[requiredRole] || 0;

    if (userLevel < requiredLevel) {
      return res.status(403).json({ 
        error: `Access denied. Required role: ${requiredRole}` 
      });
    }

    next();
  };
}

// ============================================================================
// Optional Auth Middleware (doesn't fail if no token)
// ============================================================================
function optionalAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (error) {
      // Silently continue without user context
    }
  }

  next();
}

module.exports = {
  generateToken,
  verifyToken,
  authorize,
  optionalAuth
};
```

---

## Step 5.2: Create Authentication Routes

Create `src/routes/auth.js`:

```javascript
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
// POST /api/auth/register - Create new user
// ============================================================================
router.post('/auth/register', async (req, res) => {
  try {
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
// POST /api/auth/login - Authenticate user
// ============================================================================
router.post('/auth/login', async (req, res) => {
  try {
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
// GET /api/auth/profile - Get current user profile (requires auth)
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
      role: req.user.role
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/auth/refresh - Refresh token
// ============================================================================
router.post('/auth/refresh', verifyToken, (req, res) => {
  try {
    const { id, role } = req.user;
    const newToken = generateToken(id, role);

    res.json({
      token: newToken,
      message: 'Token refreshed successfully'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// POST /api/auth/logout - Logout (invalidate token client-side)
// ============================================================================
router.post('/api/auth/logout', verifyToken, (req, res) => {
  res.json({
    message: 'Logged out successfully. Please discard the token.'
  });
});

module.exports = router;
```

---

## Step 5.3: Update server.js with Auth Middleware

Update `src/server.js` to use authentication:

```javascript
// Add at top of routes section
const authRoutes = require('./routes/auth');
app.use('/api', authRoutes);

// For protected routes, add middleware example:
// app.get('/api/protected', verifyToken, (req, res) => { ... });
// app.post('/api/admin', authorize('admin'), (req, res) => { ... });
```

---

## Step 5.4: Test Authentication Flow

### Step 1: Register new user
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "cosplayer123",
    "email": "cosplayer@example.com",
    "password": "SecurePass123!"
  }'
```

**Response:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "role": "user",
  "message": "User registered successfully"
}
```

### Step 2: Login with credentials
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "cosplayer123",
    "password": "SecurePass123!"
  }'
```

### Step 3: Access protected endpoint using token
```bash
curl http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**
```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "username": "cosplayer123",
  "email": "cosplayer@example.com",
  "role": "user",
  "createdAt": "2026-09-27T10:30:00Z"
}
```

### Step 4: Refresh token
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Step 5: Test invalid token
```bash
curl http://localhost:3000/api/auth/profile \
  -H "Authorization: Bearer invalid.token.here"
```

**Response:**
```json
{
  "error": "Invalid or expired token"
}
```

---

## Authentication Strategy Reference

### Role Hierarchy
```
admin (3)     → Full system access
curator (2)   → Manage costumes/props
user (1)      → View and update own items
guest (0)     → Read-only public access
```

### Token Structure
```json
{
  "id": "user-uuid",
  "role": "user",
  "iat": 1695555600,
  "exp": 1695900000
}
```

---

## Success Criteria

✅ User registration working  
✅ Login returns JWT token  
✅ Protected endpoints require valid token  
✅ Token validation middleware working  
✅ Token refresh mechanism functional  
✅ Invalid tokens rejected  
✅ Role-based access control ready  

---

## Next Step

Proceed to **Step 6: Comprehensive Endpoint Testing & Verification**.
