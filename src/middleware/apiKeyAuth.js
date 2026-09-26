/**
 * API Key Authentication Middleware for Server-to-Server Webhooks (n8n, Cron Jobs)
 * Header: X-CMS-API-KEY
 */
function requireApiKey(req, res, next) {
  const configuredKey = process.env.API_KEY;
  const providedKey = req.headers['x-cms-api-key'] || req.query.apiKey;

  if (!providedKey) {
    return res.status(401).json({
      error: 'API key required',
      message: 'Please provide X-CMS-API-KEY header'
    });
  }

  // Handle case where .env has a literal shell placeholder or clean key
  const validKey = configuredKey ? configuredKey.trim() : null;

  if (!validKey || providedKey.trim() !== validKey) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Invalid API key provided'
    });
  }

  next();
}

module.exports = {
  requireApiKey
};
