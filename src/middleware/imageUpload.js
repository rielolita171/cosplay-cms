const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');

// Ensure upload directory exists.
// Resolved through src/services/paths.js rather than inlined as
// path.join(__dirname, '../../data/uploads'). The default is that exact path, so
// a source checkout and the container are unaffected — but under a packaged
// Electron app __dirname is inside the read-only app.asar, and multer's
// destination would be unwritable. UPLOAD_DIR lets the desktop build redirect
// it to app.getPath('userData')/uploads.
const uploadDir = require('../services/paths').UPLOAD_DIR;
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
