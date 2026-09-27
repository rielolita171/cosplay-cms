# syntax=docker/dockerfile:1
# ==============================================================================
# cosplay-cms — multi-stage image (Debian glibc, node:22-slim)
# ==============================================================================
# WHY DEBIAN AND NOT ALPINE:
#   `sharp@0.33.5` is the only package with native code left. It loads libvips at
#   require-time from a platform-specific optional dependency, and the lockfile
#   pins EVERY variant (linux-x64, linuxmusl-x64, darwin, win32, s390x, arm);
#   npm picks the one matching the build platform. Debian resolves to the glibc
#   build, @img/sharp-linux-x64 + @img/sharp-libvips-linux-x64, which bundle
#   their own libvips and need nothing from the distro. Alpine would resolve to
#   the musl build instead, which additionally requires libc6-compat from
#   Alpine's own repos — an extra moving part for zero benefit, since this
#   service also needs the real `sqlite3` package, which Alpine does not
#   package as `sqlite`/`sqlite3` in the same way. Debian is the path with the
#   fewest assumptions, and the one exercised by the lockfile.
#
# WHY THERE IS NO BUILD TOOLCHAIN:
#   `better-sqlite3` was removed in 42bee9f, so nothing in this tree compiles.
#   `sharp`'s only install script is `node install/check`, which LOADS the
#   prebuilt binary and throws a descriptive error if it cannot — it never falls
#   back to compiling. So no node-gyp, python3, make or g++ is needed, and none
#   is installed. The `require('sharp')` step below proves this at build time
#   rather than discovering it on the first image upload.
#
# WHY apt-get INSTALLS sqlite3:
#   THE CRITICAL REQUIREMENT. This project has NO in-process SQLite binding.
#   Every query is a short-lived `spawn('sqlite3', [DB_FILE])` child process
#   (src/services/db.js:46 and 11 equivalent call sites in the route files).
#   If the `sqlite3` binary is not on PATH, EVERY database operation fails and
#   every data route 500s — while /health still returns 200, because /health
#   does not touch the DB. A green healthcheck therefore does NOT prove the
#   database works; see the entrypoint, which proves it explicitly.
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1 — deps
# Only the manifests are copied, so `npm ci` is cached until a dependency
# actually changes rather than on every source edit.
# ------------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /app

# `npm ci` requires both files and installs strictly from the lockfile.
# --omit=dev: this project ships no devDependencies.
# Optional dependencies ARE installed (they are only skipped with --omit=optional);
# that is what pulls in the sharp linux-x64 prebuilds, so they must not be omitted.
COPY package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && node -e "require('/app/node_modules/sharp'); console.log('[deps] sharp loaded OK:', require('/app/node_modules/sharp/package.json').version)"

# ------------------------------------------------------------------------------
# Stage 2 — runtime
# ------------------------------------------------------------------------------
FROM node:22-slim AS runtime

LABEL org.opencontainers.image.title="cosplay-cms" \
      org.opencontainers.image.description="Cosplay inventory CMS (Express 5 + SQLite via the sqlite3 CLI + sharp)"

# The image is the single source of truth for the port. The value is
# deliberately NOT wired to a host mapping: the n8n workflow JSON hardcodes
# 4001, and compose publishes "${CMS_PORT:-4001}:4001" so the container-internal
# port never moves even when the host port does.
ENV NODE_ENV=production \
    PORT=4001

# sqlite3  -> the database driver itself (see the header note).
# ca-certificates -> TLS trust store for outbound HTTPS (Telegram is on-demand,
#                    5s timeout, and never blocks boot).
# tzdata  -> cheap insurance. The app is UTC-only today, but omitting it is a
#            class of bug that only shows up months later as a local-time
#            mystery inside a container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      sqlite3 \
      ca-certificates \
      tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies from the deps stage (owned by root: no reason for the app user to
# own its own dependency tree).
COPY --from=deps /app/node_modules ./node_modules

# Application files, owned by the runtime user.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# MANDATORY. The app never applies this itself (db.js:initSchema() creates only
# the auth/2FA tables). Without it the container boots perfectly healthy and then
# 500s on every data route, because Costume/User/Prop/ContactLens do not exist.
COPY --chown=node:node init_db.sql ./init_db.sql

COPY --chown=node:node docker/entrypoint.sh ./docker/entrypoint.sh
# chmod is repeated here on purpose: the git exec bit is authoritative for a
# clone, but a tar/CI hand-off can silently drop it, and a non-executable
# entrypoint fails the build at the last possible moment instead of here.
RUN chmod 755 /app/docker/entrypoint.sh

# Created IN THE IMAGE, owned by the runtime user. This is the whole trick
# behind named volumes: when Docker initialises a fresh named volume it copies
# the image's directory content AND its ownership into it. Because /app/data
# already exists here and is owned by 1000:1000, a first-run empty volume is
# already writable by the non-root user. Create it with `mkdir` as root instead
# and the volume would come up root-owned, and the app would fail on the very
# first upload.
RUN mkdir -p /app/data/db /app/data/uploads \
 && chown -R node:node /app/data

# Drop privileges. UID/GID 1000 = the `node` user in the node:*-slim images.
USER node

EXPOSE 4001

# curl and wget are NOT present in node:22-slim, so the probe uses node itself.
# /health is public, unauthenticated, not rate-limited and does not touch the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const r=require('http').get({host:'127.0.0.1',port:process.env.PORT||4001,path:'/health',timeout:4000},s=>process.exit(s.statusCode===200?0:1));r.on('error',()=>process.exit(1));"

# Shell form is required: it lets the entrypoint script be PID 1's parent and
# `exec` the real server, so Node itself becomes PID 1 and receives SIGTERM
# directly. Never wrap this in `CMD` or an npm script — `npm start` would make
# npm the signal receiver, npm would not forward SIGTERM, and every stop would
# wait out the full grace period and then SIGKILL the process.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
