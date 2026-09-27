#!/bin/sh
# ==============================================================================
# cosplay-cms container entrypoint
#
# POSIX sh, no bashisms, `set -e`. Runs on EVERY start, so every step below must
# be idempotent. All of them are.
#
# The last line is `exec node ...`. That is load-bearing: it replaces this shell
# with the Node process, which then becomes PID 1 and receives SIGTERM/SIGINT
# directly. Without `exec`, the app would be a child of a shell that ignores
# the signal, and `docker stop` would stall until the 9s failsafe and then
# SIGKILL it — a corrupted-shutdown risk on a database-backed service.
#
# Deliberately NOT done here:
#   - no `npm` anything: the image is already built, and there is no guarantee
#     of network access at runtime.
#   - no `import_excel.js`: imports/ is empty, seeding is a one-time manual
#     operator step, and the importer is dry-run by default.
# ==============================================================================
set -e

APP_DIR="/app"
INIT_SQL="${APP_DIR}/init_db.sql"

# Absolute path, resolved from DATABASE_PATH. The app's own default is the
# RELATIVE 'data/db/cms.db' (deliberately cwd-sensitive so the test suites can
# isolate a run by changing cwd). Because WORKDIR is /app, the relative form
# resolves to exactly this absolute path — so using it here can never disagree
# with what the app is about to open.
DB_FILE="${DATABASE_PATH:-${APP_DIR}/data/db/cms.db}"

# NOT configurable: src/middleware/imageUpload.js resolves the upload dir from
# __dirname, so it is always <app>/data/uploads regardless of env or cwd.
UPLOAD_DIR="${APP_DIR}/data/uploads"

log() { echo "[entrypoint] $*"; }
fail() { echo "[entrypoint] FATAL: $*" >&2; exit 1; }

log "cosplay-cms starting (user $(id -u):$(id -g), node $(node --version))"

# ------------------------------------------------------------------------------
# 1. Prove the database driver exists.
#    This is the single most critical runtime requirement: the app has no
#    in-process SQLite binding, it shells out to the `sqlite3` CLI. Without it
#    every query fails while /health still reports healthy. Checking here turns
#    a silent, hard-to-diagnose 500-everywhere into one clear line of log.
# ------------------------------------------------------------------------------
command -v sqlite3 >/dev/null 2>&1 || fail "sqlite3 CLI not found on PATH. The app has no in-process SQLite driver and spawns the sqlite3 binary for every query. Install it in the image."
log "sqlite3 driver found: $(command -v sqlite3) ($(sqlite3 --version))"

# ------------------------------------------------------------------------------
# 2. Ensure the data directories exist. The image already creates them, but a
#    bind-mounted host directory arrives empty, so this is the defensive path.
# ------------------------------------------------------------------------------
mkdir -p "$(dirname "${DB_FILE}")" "${UPLOAD_DIR}"
log "resolved database: ${DB_FILE}"
log "resolved uploads:  ${UPLOAD_DIR}"

# ------------------------------------------------------------------------------
# 3. Apply the schema. init_db.sql is 100% idempotent — CREATE TABLE IF NOT
#    EXISTS throughout, no DROP/DELETE/ALTER and no seed INSERTs — so it is safe
#    to run unconditionally on every boot. The app never does this itself, which
#    is why it runs here.
#
#    `set -e` means a non-zero sqlite3 exit fails the boot loudly rather than
#    starting a server whose data routes will all 500.
# ------------------------------------------------------------------------------
[ -f "${INIT_SQL}" ] || fail "missing ${INIT_SQL}. Without it the app boots healthy and then 500s on every data route."
sqlite3 "${DB_FILE}" < "${INIT_SQL}"

# Do not trust the exit code alone: report what is actually in the file now.
TABLE_COUNT="$(sqlite3 "${DB_FILE}" "SELECT COUNT(*) FROM sqlite_master WHERE type='table';")"
log "schema applied to ${DB_FILE} (${TABLE_COUNT} tables present)"

if [ "${TABLE_COUNT}" -lt 10 ]; then
  fail "expected at least 10 tables after init_db.sql, found ${TABLE_COUNT}. The schema did not apply correctly — refusing to start."
fi

# ------------------------------------------------------------------------------
# 4. Hand off. From here on this shell is gone; Node is PID 1.
# ------------------------------------------------------------------------------
log "exec: node ${APP_DIR}/src/server.js (PID 1, receives SIGTERM)"
exec node "${APP_DIR}/src/server.js"
