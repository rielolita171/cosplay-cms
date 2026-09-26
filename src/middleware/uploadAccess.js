/**
 * Access control for the `/uploads` static mount.
 *
 * WHY A DEDICATED MODULE INSTEAD OF THE EXISTING verifyTokenOrApiKey
 * ---------------------------------------------------------------
 * `/uploads` used to be `app.use('/uploads', express.static(...))` with no guard
 * at all, so any client that could reach the server could read every uploaded
 * costume photo by guessing its path. The obvious fix — `verifyToken` in front of
 * the static handler — is correct but NOT usable on its own, because the browser
 * cannot attach an `Authorization: Bearer` header to an `<img src>` request. The
 * frontend therefore fetches each image with the bearer header through api() and
 * paints it via an object URL (see "Authenticated image delivery" in
 * public/index.html). This module is the server half of that contract.
 *
 * It is intentionally NOT `verifyTokenOrApiKey`:
 *   * that helper also accepts the key in `?apiKey=`, i.e. in the URL. Putting a
 *     long-lived shared secret in a query string is exactly the "secret leaks
 *     into history / logs / Referer" mistake, and an image URL is the single most
 *     likely place for it to be copied out of the app. Here the key is accepted
 *     from the HEADER only.
 *   * it answers with a bare `{ error }` body. Every other surface in this app
 *     answers `{ error, code }` (see the 404/CORS handlers in src/server.js), and
 *     the frontend branches on `code`. This module keeps that contract.
 *
 * FAILURE MODE
 * An unauthenticated or bad-credential request is DENIED with 401/403 and a JSON
 * body. It is never redirected to a login page and never falls through to the SPA
 * static mount, because a silent "you are seeing the login HTML instead of your
 * photo" is the worst possible outcome: the caller has no way to tell it apart
 * from a corrupt image.
 */
const { verifyJwt, extractBearerToken, TOKEN_TYPE } = require('./auth');
const { isValidApiKey } = require('./apiKeyAuth');

function requireUploadAccess(req, res, next) {
  // n8n (and any other server-to-server client) reads images with the shared
  // API key, exactly as it does for the image upload endpoints.
  const apiKey = req.headers['x-cms-api-key'];
  if (apiKey) {
    if (isValidApiKey(apiKey)) return next();
    return res.status(403).json({
      error: 'Forbidden',
      code: 'INVALID_API_KEY'
    });
  }

  const token = extractBearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'Authentication required to read uploaded images',
      code: 'NO_TOKEN'
    });
  }

  let decoded;
  try {
    // Type-pinned: a refresh token or a 2FA-pending token must NOT be usable to
    // read files, only a real access token.
    decoded = verifyJwt(token, TOKEN_TYPE.ACCESS);
  } catch (error) {
    return res.status(401).json({
      error: 'Invalid or expired token',
      code: 'INVALID_TOKEN'
    });
  }

  req.user = { id: decoded.id || decoded.sub, role: decoded.role || 'user' };
  next();
}

module.exports = { requireUploadAccess };
