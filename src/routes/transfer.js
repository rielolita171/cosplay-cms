/**
 * Export / import of the whole collection, as one .zip.
 *
 * WHY A SEPARATE ROUTER
 *
 * An import REPLACES the operator's data. That is a different class of action
 * from anything else in this server, so it is a separate router with its own
 * limiter and its own explicit confirmation step rather than another route on
 * an existing surface.
 *
 * THE CONFIRMATION IS NOT DECORATIVE
 *
 * The app has no authentication, so these endpoints are as open as every other
 * data route — that is the accepted model of this deployment, not an oversight
 * (see the warning at the top of src/server.js). But "open" is a reason to make
 * the destructive one deliberate rather than casual: `inspect` reports exactly
 * what would change, and the import refuses to run without an explicit
 * confirmation naming the mode. A single accidental POST cannot replace a
 * collection.
 *
 * Both endpoints are slow, disk-bound and rare, so both are rate limited far
 * more tightly than the general /api limiter. A client that loops on them is
 * misbehaving, and the general limit of 300 per 15 minutes is far too generous
 * for an operation that rewrites everything.
 */
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const transfer = require('../services/transfer');
const settings = require('../services/settings');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

// Import files are held in the OS temp dir, never in the upload directory.
// Writing an upload into UPLOAD_DIR would be self-defeating: the import would
// be adding files to the very store it is about to enumerate, and a failed
// import would leave a .zip in the image library where the SPA would try to
// serve it.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, require('os').tmpdir()),
    filename: (req, file, cb) => cb(null, `cosplay-cms-import-${Date.now()}.zip`)
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024, files: 1 }
});

// Reuse the same MulterError normalisation idea as src/routes/images.js: without
// it an oversized upload reaches the global error handler as a 500, blaming the
// server for the caller's mistake and swallowing the actionable message.
function normalizeUploadError(error, req, res, next) {
  if (!error) return next();
  const isMulterError = (typeof multer.MulterError === 'function' && error instanceof multer.MulterError)
    || error.name === 'MulterError';
  if (!isMulterError) return next(error);
  return res.status(400).json({
    error: error.code === 'LIMIT_FILE_SIZE'
      ? 'That archive is larger than this server accepts (4 GB).'
      : (error.message || 'The upload was rejected.'),
    code: error.code || 'UPLOAD_REJECTED'
  });
}

const transferLimiter = rateLimit({
  name: 'transfer',
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many export/import attempts. Please slow down.'
});

/**
 * GET /api/transfer/export — download the whole collection as a .zip.
 *
 * The archive is built in the OS temp directory and streamed, then removed. It
 * is built to a file rather than assembled in memory because a collection with
 * a few hundred photographs is hundreds of megabytes, and buffering that to
 * hand it to res.send() is how the server runs out of memory on a legitimate
 * export.
 */
router.get('/transfer/export', transferLimiter, (req, res, next) => {
  let outPath;
  try {
    transfer.exportToTemp().then(({ outPath: built, summary }) => {
      outPath = built;

      const filename = `cosplay-cms-${new Date().toISOString().slice(0, 10)}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(fs.statSync(outPath).size));
      // `attachment` so a browser saves it rather than navigating to it. The
      // filename is generated from a date, never from caller input, so it
      // cannot carry a header injection.
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // The counts ride along in a header the UI reads to confirm what the
      // operator actually received — a 40 MB file is not evidence of how many
      // costumes are in it.
      res.setHeader('X-CMS-Export-Summary', JSON.stringify({
        tables: summary.tables,
        uploads: summary.uploads,
        bytes: summary.bytes
      }));

      // The temp file is removed on 'finish', NOT here: the stream below has not
      // read it yet. 'close' is used rather than 'finish' because a client that
      // disconnects mid-download fires 'close' without 'finish', and that is
      // exactly the case where the file would otherwise be left behind.
      res.on('close', () => { try { fs.unlinkSync(outPath); } catch (_) { /* already gone */ } });

      const stream = fs.createReadStream(outPath);
      // A read error after the headers are sent cannot be turned into a status
      // code, so it goes to the error handler, which sees headersSent and ends
      // the response rather than trying to write a second one.
      stream.on('error', next);
      stream.pipe(res);
    }).catch(error => {
      console.error('❌ export failed:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message, code: 'EXPORT_FAILED' });
      } else {
        res.end();
      }
    });
  } catch (error) {
    // Synchronous failures only (e.g. fs.statSync on the built file).
    console.error('❌ export failed:', error);
    res.status(500).json({ error: error.message, code: 'EXPORT_FAILED' });
  }
});

/**
 * POST /api/transfer/inspect — read an archive and report what it holds.
 *
 * Separate from the import so the UI can show "412 costumes, 88 images, made
 * on 2026-09-30 by the desktop app" and get an explicit yes before anything is
 * overwritten.
 */
router.post('/transfer/inspect', transferLimiter, upload.single('archive'), async (req, res) => {
  const cleanup = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} } };
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No archive provided. Attach a .zip file.', code: 'NO_FILE' });
    }
    const report = transfer.inspect(req.file.path);
    res.json(report);
  } catch (error) {
    // A malformed archive is the caller's problem, not a server fault, so it
    // is a 400 with the message that says what is wrong with the file.
    res.status(400).json({ error: error.message, code: 'INVALID_ARCHIVE' });
  } finally {
    cleanup();
  }
});


/**
 * POST /api/transfer/import — restore an archive over the current data.
 *
 * Body: { confirm: true, mode: 'replace' | 'merge' }
 *
 * `confirm: true` is REQUIRED. Without it this answers 409 and changes nothing.
 * That is the whole point of the flag: on a server with no authentication, an
 * import triggerable by an ordinary POST would be the most destructive thing
 * reachable without a credential, and the flag means the destructive path
 * always costs a second, deliberate act.
 */
router.post('/transfer/import', transferLimiter, upload.single('archive'), async (req, res) => {
  const cleanup = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} } };
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No archive provided. Attach a .zip file.', code: 'NO_FILE' });
    }

    const body = req.body || {};
    if (String(body.confirm) !== 'true') {
      return res.status(409).json({
        error: 'Import replaces the current data. Re-send with confirm=true once the operator has agreed.',
        code: 'CONFIRMATION_REQUIRED'
      });
    }

    const mode = body.mode === 'merge' ? 'merge' : 'replace';
    const report = await transfer.importFrom(req.file.path, { mode });

    // The in-memory allowlist now describes a database that no longer exists,
    // so the next request must not be judged against the cached copy.
    settings.invalidate();

    res.json({ ok: true, ...report });
  } catch (error) {
    // A malformed archive is the caller's problem, not a server fault, so it
    // is a 400 carrying the message that says what is wrong with the file.
    // The pattern is narrow on purpose: a real I/O or sqlite failure must stay
    // a 500, because that is the one where the operator needs to know the
    // server broke rather than that they picked the wrong file.
    const callerFault = /archive|data\.sql|manifest|ZIP|escape|absolute|nested|null byte|newer version|no expected tables/i;
    res.status(callerFault.test(error.message || '') ? 400 : 500).json({
      error: error.message,
      code: callerFault.test(error.message || '') ? 'IMPORT_REJECTED' : 'IMPORT_FAILED'
    });
  } finally {
    cleanup();
  }
});

// The upload middleware runs first, so a MulterError surfaces here.
router.use(normalizeUploadError);

module.exports = router;
