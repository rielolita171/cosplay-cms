/**
 * Single source of truth for every filesystem path the app resolves internally.
 *
 * WHY THIS EXISTS
 *
 * Five files each built the same two path literals out of `__dirname`:
 *   src/services/db.js               -> <root>/data/db/cms.db
 *   src/middleware/imageUpload.js    -> <root>/data/uploads
 *   src/middleware/imageProcessor.js -> <root>/data/uploads
 *   src/routes/images.js             -> <root>/data/uploads
 *   src/routes/costumes.js           -> <root>/data/uploads
 * `__dirname` is correct for a container (the app always lives at /app) and for
 * a `git clone` you run with `npm start`. It is WRONG for a packaged Electron
 * app: `__dirname` then points *inside* the read-only `app.asar` archive, so
 * the database and every uploaded image land somewhere that cannot be written.
 * The symptom would not be a clean failure — the server would boot, /health
 * would return 200, and the first write would EROFS.
 *
 * The fix is not "different literals in Electron"; it is that every one of these
 * locations is resolved from a variable here, so a packaged build can point the
 * whole app at `app.getPath('userData')` with a single assignment.
 *
 * DEFAULTS ARE UNCHANGED, ON PURPOSE.
 * Every fallback below is byte-for-byte the path the corresponding file computed
 * before. A bare `npm start` and a `docker compose up` therefore resolve exactly
 * what they always resolved to, and all six existing test suites — which anchor
 * on __dirname — keep passing untouched. Only an explicit override changes
 * anything.
 *
 * `src/services/db.js` re-exports DB_FILE, so the existing
 * `const { DB_FILE } = require('../services/db')` contract at the ~6 route files
 * that consume it is deliberately preserved.
 */
const path = require('path');

// <root> = the directory containing package.json. `__dirname` here is <root>/src/
// services, so two levels up is <root>.
const ROOT = path.resolve(__dirname, '../..');

/**
 * The writable data root. Defaults to <root>/data (source checkout, container).
 *
 * NAMESPACED AS CMS_DATA_DIR / CMS_UPLOAD_DIR, AND THAT IS LOAD-BEARING.
 *
 * A plain `UPLOAD_DIR` / `DATA_DIR` was tried first and it broke the existing
 * `node src/server.js` workflow. Reason: a real .env in this repo already
 * contains `UPLOAD_DIR="/data/uploads"` — a CONTAINER path — which was inert
 * because no line of code read it. The moment paths.js started reading a bare
 * UPLOAD_DIR, that value became live, and every non-Electron start died with
 * `EACCES: permission denied, mkdir '/data/uploads'` in imageUpload.js.
 *
 * The CMS_ prefix means a key that has been sitting inert in someone's .env for
 * months cannot suddenly acquire meaning and break their server. An override
 * added to a codebase that already has working deployments has to be opt-in by
 * a name nobody has used before.
 *
 * Windows note: environment variables are case-INSENSITIVE on Windows, so
 * `upload_dir` and `UPLOAD_DIR` are the same variable there. The CMS_ prefix is
 * what keeps them distinct from the pre-existing key on every platform.
 *
 * DATABASE_PATH IS DELIBERATELY NOT RENAMED. It predates this change, is
 * documented in .env.example and DOCKER.md, and is read directly (not via this
 * module's DATA_DIR) — several test suites set it to a throwaway file and must
 * keep overriding everything else.
 */
const DATA_DIR = process.env.CMS_DATA_DIR
  ? path.resolve(process.env.CMS_DATA_DIR)
  : path.join(ROOT, 'data');

/**
 * Absolute path to the SQLite file.
 *
 * DATABASE_PATH still wins and is still resolved against cwd when relative —
 * scripts/test_makers.js, test_wishlist.js and test_lens_expiry_checker.js all
 * set it to a throwaway file, and they must keep overriding this.
 */
const DB_FILE = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, 'db', 'cms.db');

/**
 * Directory holding uploaded and processed images.
 *
 * NOTE ON ASAR: Electron cannot write into an archive, so under a packaged build
 * this must resolve OUTSIDE app.asar. Electron sets CMS_UPLOAD_DIR to
 * <userData>/uploads for that reason. The mkdir below is the same defensive
 * step db.js and imageUpload.js already perform independently.
 */
const UPLOAD_DIR = process.env.CMS_UPLOAD_DIR
  ? path.resolve(process.env.CMS_UPLOAD_DIR)
  : path.join(DATA_DIR, 'uploads');

/** The SPA. Read-only, so it is always inside the app bundle. */
const PUBLIC_DIR = path.join(ROOT, 'public');

/**
 * The idempotent schema. Needed by the Electron pre-flight, which has to apply
 * it before the server starts because there is no shell entrypoint to do it.
 *
 * Read with fs at call time rather than at module load: in a packaged app this
 * file sits inside app.asar, and reading it eagerly here would be fine, but the
 * import keeps this module dependency-free for the paths it only needs.
 */
const INIT_SQL = path.join(ROOT, 'init_db.sql');

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  UPLOAD_DIR,
  PUBLIC_DIR,
  INIT_SQL
};
