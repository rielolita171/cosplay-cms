const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = require('../middleware/imageUpload');
const { processImage, processImages } = require('../middleware/imageProcessor');
const { esc } = require('../services/sqlSafety');

// ============================================================================
// POST /api/images/upload - CANONICAL single image upload
// POST /upload              - ALIAS, kept because the phase-5 frontend spec and
//                             the old /api/version manifest referenced it.
// Both share one handler and one response shape, so the two names can never
// drift apart. Multipart field name is `image` on both.
// ============================================================================
async function handleSingleUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Process uploaded image (resize + WebP), returns '/uploads/<name>.webp'
    const processedPath = await processImage(req.file.path);

    res.status(201).json({
      success: true,
      originalName: req.file.originalname,
      size: req.file.size,
      url: processedPath,
      processedUrl: processedPath,
      format: 'WebP',
      message: 'Image uploaded and optimized successfully'
    });
  } catch (error) {
    // Clean up uploaded file if processing failed
    if (req.file) {
      const fs = require('fs');
      fs.unlink(req.file.path, () => {});
    }
    res.status(500).json({ error: error.message });
  }
}

// ============================================================================
// Multipart error normalisation
// ============================================================================
// Multer reports client-side upload problems — an unexpected field name
// (LIMIT_UNEXPECTED_FILE), an oversized file (LIMIT_FILE_SIZE), or a rejected
// MIME type from the fileFilter — as plain errors with no `status`. Without this
// they fall through to the global error handler in server.js, which has no
// status to read and answers 500 "Internal server error". That is wrong twice
// over: it blames the server for the caller's mistake, and it swallows the
// actionable message ("Unexpected field - notimage"). They are 400s.
// NOTE: `MulterError` is a property of the multer FACTORY, not of the configured
// instance returned by `multer({...})` — reading it off `upload` yields undefined
// and this check would silently never match. `name` is the stable fallback.
function normalizeUploadError(error, req, res, next) {
  if (!error) return next();

  const isMulterError = (typeof multer.MulterError === 'function' && error instanceof multer.MulterError)
    || error.name === 'MulterError';
  const isRejectedMime = /Invalid file type/.test(error.message || '');

  if (isMulterError || isRejectedMime) {
    return res.status(400).json({
      error: error.message,
      code: 'INVALID_UPLOAD'
    });
  }
  next(error);
}

// Middleware chain for a single image; exported so the POST /api/upload alias
// in server.js is byte-for-byte the same pipeline as the canonical route.
const singleUploadChain = [upload.single('image'), normalizeUploadError, handleSingleUpload];

router.post('/upload', singleUploadChain[0], singleUploadChain[1], singleUploadChain[2]);

// ============================================================================
// POST /api/images/upload-multiple - Multiple image upload
// ============================================================================
router.post('/upload-multiple', upload.array('images', 10), normalizeUploadError, async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No images provided' });
    }

    const filePaths = req.files.map(f => f.path);
    const processedPaths = await processImages(filePaths);

    res.status(201).json({
      success: true,
      count: processedPaths.length,
      images: req.files.map((file, i) => ({
        originalName: file.originalname,
        originalSize: file.size,
        url: processedPaths[i],
        processedUrl: processedPaths[i],
        format: 'WebP'
      })),
      message: `${processedPaths.length} images uploaded and optimized`
    });
  } catch (error) {
    // Clean up uploaded files if processing failed
    if (req.files) {
      const fs = require('fs');
      req.files.forEach(f => {
        fs.unlink(f.path, () => {});
      });
    }
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// GET /api/images/stats - Image storage statistics
// ============================================================================
router.get('/stats', async (req, res) => {
  try {
    const fs = require('fs').promises;
    const path = require('path');
    // UPLOAD_DIR replaces the previous __dirname-relative literal so this
    // resolves outside app.asar in a packaged Electron build. `path` is still
    // needed below to join each filename — dropping it here made this endpoint
    // fail with "path is not defined".
    const { UPLOAD_DIR } = require('../services/paths');
    const uploadDir = UPLOAD_DIR;

    const files = await fs.readdir(uploadDir);
    let totalSize = 0;
    let imageCount = 0;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stat = await fs.stat(filePath);
      totalSize += stat.size;
      imageCount++;
    }

    const totalSizeMB = (totalSize / (1024 * 1024)).toFixed(2);

    res.json({
      imageCount,
      totalSize: `${totalSizeMB} MB`,
      uploadDirectory: uploadDir
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===========================================================================
// DELETE /api/images/discard - Drop an image the operator decided not to keep
//
// WHY THIS EXISTS
// A photo chosen in an Edit dialog is uploaded to the server IMMEDIATELY, so
// that the user can see it while deciding. If they then press Cancel, the file
// is already on disk and already in the session cache. Without this endpoint
// the file is an orphan: nothing references it, nothing will ever collect it,
// and the upload directory grows by one image per abandoned dialog.
//
// The refusal to delete a REFERENCED image is the whole point of this
// endpoint existing at this layer. A filename alone is not enough to know
// whether an image is in use — costume, prop and lens rows each hold their own
// JSON array of URLs — so the check has to ask the database, and it has to ask
// ALL THREE tables. Deleting a file that a row still points at would leave a
// broken image on a saved record, which is far worse than a wasted file.
//
// This is deliberately narrow: one filename, only a basename (never a path),
// and only files inside the resolved UPLOAD_DIR.
// ===========================================================================
router.delete('/discard', async (req, res) => {
  try {
    const raw = String((req.query && req.query.url) || (req.body && req.body.url) || '').trim();
    if (!raw) {
      return res.status(400).json({ error: 'No image url given.', code: 'NO_URL' });
    }

    // Only the FILENAME is used, and only a bare basename. Accepting a path
    // here would be a delete-any-file primitive, and this app has no
    // authentication, so that would be catastrophic rather than merely careless.
    let filename;
    try {
      filename = decodeURIComponent(raw.split('/').pop() || '');
    } catch (_) {
      return res.status(400).json({ error: 'The image url is malformed.', code: 'BAD_URL' });
    }

    if (!filename || filename === '.' || filename === '..' || filename.indexOf('/') !== -1
        || filename.indexOf('\\') !== -1 || filename.indexOf('\0') !== -1) {
      return res.status(400).json({ error: 'That is not a valid image name.', code: 'BAD_URL' });
    }

    const { UPLOAD_DIR } = require('../services/paths');
    const path = require('path');
    const fs = require('fs');
    const { runSql } = require('../services/db');

    // Belt and braces on the resolved path: even a basename that survived the
    // checks above (an encoded separator, a symlinked name) cannot point
    // outside the upload directory.
    const target = path.resolve(UPLOAD_DIR, filename);
    if (target !== path.resolve(UPLOAD_DIR)
        && !target.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
      return res.status(400).json({ error: 'That is not a valid image name.', code: 'BAD_URL' });
    }

    // Referenced by ANY record? Then it is not ours to delete. Each of the three
    // tables stores its image URL(s) in a differently-named TEXT column —
    // Costume/Prop hold a JSON array in "imageUrls", ContactLens a single
    // "imageUrl" — so all three are asked. A LIKE on the filename is sufficient
    // here, and a false positive (a shared substring) only means we decline to
    // delete, which is the safe direction to err in.
    const needle = esc(filename);
    const references = await runSql(
      `SELECT (SELECT COUNT(*) FROM "Costume" WHERE imageUrls LIKE '%' || ${needle} || '%')`
      + ` + (SELECT COUNT(*) FROM "Prop" WHERE imageUrls LIKE '%' || ${needle} || '%')`
      + ` + (SELECT COUNT(*) FROM "ContactLens" WHERE imageUrl LIKE '%' || ${needle} || '%');`
    );
    const inUse = parseInt(String(references).trim(), 10) || 0;
    if (inUse > 0) {
      return res.status(409).json({
        error: 'That image is still used by a saved record, so it was not deleted.',
        code: 'IMAGE_IN_USE'
      });
    }

    if (!fs.existsSync(target)) {
      // Already gone. Reported as success on purpose: the caller's intent —
      // "this file should not exist" — is already satisfied, and a 404 here
      // would make an abandoned-dialog cleanup look like a failure.
      return res.json({ ok: true, deleted: false, reason: 'already-absent' });
    }

    fs.unlinkSync(target);
    res.json({ ok: true, deleted: true });
  } catch (error) {
    console.error('❌ discard image error:', error);
    res.status(500).json({ error: error.message, code: 'DISCARD_FAILED' });
  }
});

// The single-upload handler is exported so src/server.js can mount the
// POST /api/upload alias (documented in the phase-5 frontend spec) under its
// own prefix with the same guard as /api/images.
module.exports = router;
module.exports.singleUploadChain = singleUploadChain;
