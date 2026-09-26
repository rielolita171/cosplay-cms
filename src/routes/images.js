const express = require('express');
const router = express.Router();
const multer = require('multer');
const upload = require('../middleware/imageUpload');
const { processImage, processImages } = require('../middleware/imageProcessor');

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
    const uploadDir = path.join(__dirname, '../../data/uploads');

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

// The single-upload handler is exported so src/server.js can mount the
// POST /api/upload alias (documented in the phase-5 frontend spec) under its
// own prefix with the same guard as /api/images.
module.exports = router;
module.exports.singleUploadChain = singleUploadChain;
