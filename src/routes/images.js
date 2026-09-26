const express = require('express');
const router = express.Router();
const upload = require('../middleware/imageUpload');
const { processImage, processImages } = require('../middleware/imageProcessor');

// ============================================================================
// POST /api/images/upload - Single image upload with processing
// ============================================================================
router.post('/images/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Process uploaded image
    const processedPath = await processImage(req.file.path);

    res.status(201).json({
      success: true,
      originalName: req.file.originalname,
      size: req.file.size,
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
});

// ============================================================================
// POST /api/images/upload-multiple - Multiple image upload
// ============================================================================
router.post('/images/upload-multiple', upload.array('images', 10), async (req, res) => {
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
router.get('/images/stats', async (req, res) => {
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

module.exports = router;
