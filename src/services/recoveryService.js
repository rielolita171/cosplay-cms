const crypto = require('crypto');

let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (e) {
  bcrypt = null;
}

/**
 * Hash a secret key using bcryptjs or crypto.pbkdf2 fallback
 */
function hashKey(secretKey) {
  if (bcrypt) {
    return bcrypt.hashSync(secretKey, 10);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(secretKey, salt, 10000, 64, 'sha512').toString('hex');
  return `pbkdf2:${salt}:${hash}`;
}

/**
 * Verify a plain key against a stored hash
 */
function verifyRecoveryKey(plainKey, storedHash) {
  if (!plainKey || !storedHash) return false;

  if (storedHash.startsWith('pbkdf2:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, originalHash] = parts;
    const hash = crypto.pbkdf2Sync(plainKey, salt, 10000, 64, 'sha512').toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(originalHash));
    } catch {
      return false;
    }
  }

  if (bcrypt) {
    try {
      return bcrypt.compareSync(plainKey, storedHash);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Generate an emergency break-glass recovery key in format: CMS-XXXXXXXX-XXXXXXXX
 */
function generateBreakGlassRecoveryKey() {
  const p1 = crypto.randomBytes(4).toString('hex').toUpperCase();
  const p2 = crypto.randomBytes(4).toString('hex').toUpperCase();
  const secretKey = `CMS-${p1}-${p2}`;
  const keyHash = hashKey(secretKey);

  return { secretKey, keyHash };
}

module.exports = {
  generateBreakGlassRecoveryKey,
  verifyRecoveryKey,
  hashKey
};
