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
