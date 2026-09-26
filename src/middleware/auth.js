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
