const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;
const { randomUUID } = require('crypto');

/**
 * Process uploaded image: resize to max 1200px and convert to WebP
 * @param {string} filePath - Path to uploaded image
 * @returns {Promise<string>} - Path to processed WebP image
 */
async function processImage(filePath) {
  // The output name is derived from the input name, which is a trap for one
  // specific input: a file that is ALREADY .webp. Then stem + '.webp' IS the
  // input filename, and libvips refuses an in-place conversion outright —
  // "Cannot use same file for input and output". That is not a rare corner:
  // the MIME filter in imageUpload.js and the file input's `accept` attribute
  // both advertise image/webp as a supported input, so the API promised a
  // format it then rejected with a 500.
  const stem = path.basename(filePath).replace(/\.[^.]+$/, '');
  const webpFilename = `${stem}.webp`;
  const webpPath = path.join(path.dirname(filePath), webpFilename);
  const samePath = path.resolve(webpPath) === path.resolve(filePath);

  // On collision, write to a unique sibling first and rename it into place once
  // sharp has finished reading. The rename then overwrites the input, which is
  // safe precisely because the read is already complete. A dotfile name keeps
  // the half-written file out of the /uploads listing if the rename never runs.
  const writePath = samePath
    ? path.join(path.dirname(filePath), `.${stem}-${randomUUID()}.webp`)
    : webpPath;

  try {
    // Resize to max 1200px and convert to WebP
    await sharp(filePath)
      .resize(1200, 1200, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .webp({ quality: 85 })
      .toFile(writePath);
  } catch (error) {
    // Never leave the temp file behind on a failed conversion.
    await fs.unlink(writePath).catch(() => {});
    throw new Error(`Image processing failed: ${error.message}`);
  }

  try {
    if (samePath) {
      // The rename IS the delete here: the input and the output are one file.
      await fs.rename(writePath, webpPath);
    } else {
      // Delete original file
      await fs.unlink(filePath);
    }
  } catch (error) {
    // The processed image is on disk and the caller can still be handed its
    // URL, so a failed cleanup must not fail the whole upload. Report it
    // without pretending the upload failed.
    console.warn(`[imageProcessor] could not clean up ${filePath}: ${error.message}`);
  }

  // Return relative path for storage
  return `/uploads/${webpFilename}`;
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
 * Optimize an image that is ALREADY stored in data/uploads.
 *
 * Re-optimizing a stored .webp used to hit the same in-place collision as a
 * fresh .webp upload and throw. It is fixed by the same branch, but note this
 * rewrites a file that a Costume row already points at: the URL is unchanged
 * (same stem), so references survive, but the bytes on disk are replaced.
 *
 * @param {string} imagePath - Path to image (relative to data/uploads)
 * @returns {Promise<string>} - Path to optimized WebP
 */
async function optimizeExistingImage(imagePath) {
  // See src/services/paths.js — UPLOAD_DIR replaces a __dirname-anchored
  // literal so this resolves outside app.asar in a packaged Electron build.
  const { UPLOAD_DIR } = require('../services/paths');
  const fullPath = path.join(UPLOAD_DIR, imagePath);
  return await processImage(fullPath);
}

module.exports = {
  processImage,
  processImages,
  optimizeExistingImage
};
