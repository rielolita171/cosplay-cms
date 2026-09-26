# Phase 2: Step 4 — Image Optimization with Sharp

## Objective
Implement image processing middleware to resize and convert costume/prop images to WebP format for optimized storage and delivery.

---

## Why Image Optimization?

- **Reduce file size**: WebP is 25-35% smaller than JPEG/PNG
- **Faster delivery**: Smaller images = faster downloads
- **Consistent sizing**: All images scaled to max 1200px × 1200px
- **Storage efficiency**: Smaller database image URLs storage
- **Bandwidth savings**: Important for photo-heavy cosplay inventory

---

## Step 4.1: Install Sharp

```bash
npm install sharp
```

Verify installation:
```bash
npm list sharp
```

---

## Step 4.2: Create Image Upload Middleware

Create `src/middleware/imageUpload.js`:

```javascript
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../../data/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = `${randomUUID()}-${Date.now()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// File filter - only allow images
const fileFilter = (req, file, cb) => {
  const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  
  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed: JPEG, PNG, WebP, GIF`), false);
  }
};

// Multer configuration
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB max
  }
});

module.exports = upload;
```

---

## Step 4.3: Create Image Processing Module

Create `src/middleware/imageProcessor.js`:

```javascript
const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

/**
 * Process uploaded image: resize to max 1200px and convert to WebP
 * @param {string} filePath - Path to uploaded image
 * @returns {Promise<string>} - Path to processed WebP image
 */
async function processImage(filePath) {
  try {
    const filename = path.basename(filePath);
    const webpFilename = filename.replace(/\.[^.]+$/, '.webp');
    const webpPath = path.join(path.dirname(filePath), webpFilename);

    // Resize to max 1200px and convert to WebP
    await sharp(filePath)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 85 })
      .toFile(webpPath);

    // Delete original file
    await fs.unlink(filePath);

    // Return relative path for storage
    return `/uploads/${webpFilename}`;
  } catch (error) {
    throw new Error(`Image processing failed: ${error.message}`);
  }
}

/**
 * Process multiple images (batch)
 * @param {Array<string>} filePaths - Array of file paths
 * @returns {Promise<Array<string>>} - Array of processed image paths
 */
async function processImages(filePaths) {
  const processed = [];
  
  for (const filePath of filePaths) {
    const result = await processImage(filePath);
    processed.push(result);
  }

  return processed;
}

/**
 * Optimize existing image
 * @param {string} imagePath - Path to image (relative to data/uploads)
 * @returns {Promise<string>} - Path to optimized WebP
 */
async function optimizeExistingImage(imagePath) {
  const fullPath = path.join(__dirname, '../../data/uploads', imagePath);
  return await processImage(fullPath);
}

module.exports = {
  processImage,
  processImages,
  optimizeExistingImage
};
```

---

## Step 4.4: Create Image Upload Route

Create `src/routes/images.js`:

```javascript
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
```

---

## Step 4.5: Register Image Routes in server.js

Update `src/server.js`:

```javascript
// Add after other routes
const imageRoutes = require('./routes/images');
app.use('/api', imageRoutes);
```

---

## Step 4.6: Test Image Upload & Optimization

### Upload single image
```bash
curl -X POST http://localhost:3000/api/images/upload \
  -F "image=@/path/to/costume.jpg"
```

**Expected Response:**
```json
{
  "success": true,
  "originalName": "costume.jpg",
  "size": 2500000,
  "processedUrl": "/uploads/a1b2c3d4-1234567890.webp",
  "format": "WebP",
  "message": "Image uploaded and optimized successfully"
}
```

### Upload multiple images
```bash
curl -X POST http://localhost:3000/api/images/upload-multiple \
  -F "images=@image1.jpg" \
  -F "images=@image2.png" \
  -F "images=@image3.jpg"
```

### Check storage stats
```bash
curl http://localhost:3000/api/images/stats
```

**Expected Response:**
```json
{
  "imageCount": 12,
  "totalSize": "45.32 MB",
  "uploadDirectory": "/data/uploads"
}
```

---

## Image Processing Examples

### Costume Images
- **Input**: High-res JPEG from phone camera (5MB+)
- **Output**: WebP formatted, max 1200×1200px (~300-500KB)
- **Benefit**: 90% size reduction, preserved quality

### Props & Accessories
- **Input**: Multiple angles, various formats
- **Output**: Consistent WebP, uniform size
- **Benefit**: Faster gallery loading

### Verification
```bash
# Check uploaded WebP file
ls -lh data/uploads/
```

---

## Success Criteria

✅ Sharp installed and working  
✅ Single image upload processing  
✅ Batch image upload processing  
✅ Images converted to WebP format  
✅ Images resized to max 1200×1200px  
✅ Original files deleted after processing  
✅ Storage stats endpoint working  
✅ Error handling for invalid file types  

---

## Next Step

Proceed to **Step 5: Authentication & Authorization Middleware**.
