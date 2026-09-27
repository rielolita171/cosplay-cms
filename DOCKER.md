# Running cosplay-cms in Docker

This file is the operator's guide to the containerised deployment. It assumes you
have never seen this repository. Everything below is derived from the files in
the tree — the [`Dockerfile`](Dockerfile), [`docker/entrypoint.sh`](docker/entrypoint.sh),
[`docker-compose.yml`](docker-compose.yml) and the application source — and every
non-obvious claim cites the file and line it came from.

> **Read section 5 before your first `docker compose up`.** A brand new named
> volume boots a perfectly healthy, completely **empty** CMS. Nothing in the
> container will tell you that your data is missing.

---

## 1. What this is, and what you need

**cosplay-cms** is a private inventory system for cosplay costumes, props and
contact lenses: an Express 5 HTTP API plus a single self-contained
`public/index.html` frontend, with SQLite for storage and `sharp` for image
processing. It is a single service with no external dependencies at runtime — no
message broker, no cache, no separate database server.

The container image is self-contained. Once built, the container needs **no
outbound network access to start**: every database read and write is a
short-lived local `sqlite3` child process, and Telegram (the only outbound call
anywhere) is made on demand, never at boot.

### Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| **Docker Engine**, 20.10+ | Runs the container | The image uses only multi-stage builds and `COPY --from`, so nothing exotic is required. Any reasonably current Engine works. |
| **Docker Compose v2** (`docker compose`, *not* `docker-compose`) | Runs the stack | Every command in this document uses the v2 `docker compose …` subcommand syntax. The old standalone `docker-compose` v1 binary is end-of-life and is not supported here. Verify with `docker compose version` — it should print `Docker Compose version v2.x`. |
| Membership of the `docker` group | Lets you run `docker` without `sudo` | **Membership is not applied to a live session** — log out and back in (or `newgrp docker`) after being added, otherwise you get a confusing `permission denied while trying to connect to the Docker daemon socket`. |
| **Node 22** | *Only* if you develop outside the container | Declared in [`.nvmrc`](.nvmrc) and `engines.node: ">=22"` in [`package.json:17-19`](package.json:17). Inside the container this is irrelevant — the image ships its own Node. |
| `openssl` | Only to generate secrets | Any CSPRNG will do; the examples use `openssl rand`. |
| `sqlite3` CLI on the host | Only for the seeding/backup commands in section 5 | Not needed if you use the `docker run` recipes given, which run `sqlite3` inside the image. |

You do **not** need to install `sharp`, `node-gyp`, `python3`, `make` or `g++`
anywhere. See section 4.

---

## 2. Quick start

Run these four steps from the repository root. They are copy-pasteable as-is.

### Step 1 — create your `.env` with real secrets

```bash
cp .env.example .env

JWT_SECRET=$(openssl rand -hex 32)
API_KEY=$(openssl rand -hex 24)

# Write the generated values into .env, replacing the two placeholder lines.
sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${JWT_SECRET}|"  .env
sed -i "s|^API_KEY=.*|API_KEY=${API_KEY}|"          .env
```

Verify they landed, without echoing the secrets themselves:

```bash
grep -E '^(JWT_SECRET|API_KEY)=' .env | sed 's/=.*/=<set>/'
# JWT_SECRET=<set>
# API_KEY=<set>
```

> `JWT_SECRET` must be at least 32 characters or the process refuses to start
> ([`src/middleware/auth.js:86-88`](src/middleware/auth.js:86)).
> `openssl rand -hex 32` prints 64 hex characters, which comfortably clears it.
>
> `API_KEY` must not contain the literal substrings `your_`, `here` or `$(` — a key
> matching any of those is treated as an unfilled placeholder and rejected even if
> the client sends it back byte for byte
> ([`src/middleware/apiKeyAuth.js:28-30`](src/middleware/apiKeyAuth.js:28)).
> A hex string from `openssl rand` never will.

`.env` is excluded from git by [`.gitignore:3`](.gitignore:3) and from the Docker
build context by [`.dockerignore:25`](.dockerignore:25). See section 8.

### Step 2 — build and start

```bash
docker compose up -d --build
```

Watch the startup sequence — the entrypoint narrates it:

```bash
docker compose logs -f
```

A good boot looks like this:

```
[entrypoint] cosplay-cms starting (user 1000:1000, node v22.x.x)
[entrypoint] sqlite3 driver found: /usr/bin/sqlite3 (3.x.x)
[entrypoint] resolved database: /app/data/db/cms.db
[entrypoint] resolved uploads:  /app/data/uploads
[entrypoint] schema applied to /app/data/db/cms.db (10 tables present)
[entrypoint] exec: node /app/src/server.js (PID 1, receives SIGTERM)
```

If you see those five lines, the driver is present and the schema applied. If
`docker compose logs -f` shows `FATAL`, the container has already exited — go to
section 7.

### Step 3 — verify it is up

```bash
docker compose ps
curl -s http://localhost:4001/health
```

`/health` should answer with a JSON body containing `"status":"ok"`. It is public
and unauthenticated by design ([`src/server.js:158-166`](src/server.js:158)).

Then open <http://localhost:4001/> in a browser for the dashboard.

### Step 4 — verify the database actually works

`/health` does **not** touch the database. A green healthcheck proves only that
Node is running. The one call that proves driver + database + schema all work is
an API-key call, because it is the only unauthenticated-by-role path that
actually executes SQL:

```bash
curl -s -H "X-CMS-API-KEY: $(grep '^API_KEY=' .env | cut -d= -f2- | tr -d '\"')" \
  "http://localhost:4001/api/notifications/contact-lenses/expiring?days=14"
```

A working install answers with a JSON object containing a `count`. If you get
`{"error":"Internal server error","code":"INTERNAL_ERROR"}`, the database is
**not** working even though `/health` is green — go to section 7.

> If you changed the host port via `CMS_PORT`, substitute it in both the `curl`
> commands. The container-internal port is always `4001`
> ([`docker-compose.yml:31-32`](docker-compose.yml:31)); only the host side moves.

### A note on what you have just started

**If this is a fresh machine with no `data/` directory, you now have an empty CMS
with a valid schema.** That is not a failure state — the entrypoint applied
`init_db.sql` and created all 10 tables. It just contains no costumes, no
lenses and no users. To bring your real data in, go to **section 5** now.

---

## 3. Configuration reference

Configuration is read from `.env` via `dotenv` ([`src/server.js:1`](src/server.js:1)).
In Docker, that file is supplied by compose's `env_file` block
([`docker-compose.yml:35-36`](docker-compose.yml:35)).

### Real variables — these are actually read

| Variable | Purpose | Required? | Default | Read at |
|---|---|---|---|---|
| `PORT` | Port the server binds **inside** the container. | No | `4001` | [`src/server.js:12`](src/server.js:12) |
| `NODE_ENV` | Switches on production-only guards. | Yes, in practice — compose forces `production` | *(unset ⇒ development)* | [`src/server.js:25`](src/server.js:25), [`src/middleware/auth.js:25`](src/middleware/auth.js:25) |
| `JWT_SECRET` | Signs every session token. | **Yes** — the process will not start without it in production | *(none; dev-only placeholder off-production)* | [`src/middleware/auth.js:20-35`](src/middleware/auth.js:20), validated by [`src/middleware/auth.js:76-111`](src/middleware/auth.js:76) from [`src/server.js:20-36`](src/server.js:20) |
| `DATABASE_PATH` | Absolute path to the SQLite file. | No | `data/db/cms.db` (relative to cwd) | [`src/services/db.js:34`](src/services/db.js:34) |
| `API_KEY` | Authenticates server-to-server calls via the `X-CMS-API-KEY` header. | **Strongly recommended** — unset means every caller gets 403 | *(none; fails closed)* | [`src/middleware/apiKeyAuth.js:24-31`](src/middleware/apiKeyAuth.js:24) |
| `CORS_ORIGIN` | Comma-separated allowlist of browser origins. | No | *(empty ⇒ same-origin default)* | [`src/services/settings.js:260`](src/services/settings.js:260) |
| `TELEGRAM_BOT_TOKEN` | Enables Telegram alerts. | No | *(empty ⇒ disabled)* | [`src/services/telegramService.js:32`](src/services/telegramService.js:32), [`src/server.js:419`](src/server.js:419) |

Notes on the ones that surprise people:

- **`PORT` — do not change it.** The n8n workflow JSON hardcodes `4001`
  ([`workflows/n8n_contact_lens_expiry_alert.json:24`](workflows/n8n_contact_lens_expiry_alert.json:24)).
  To use a different port on the host, set `CMS_PORT` in `.env` and let compose
  remap the host side only ([`docker-compose.yml:32`](docker-compose.yml:32)).
  Changing the internal port silently breaks n8n while the container keeps working
  — the worst kind of failure, because it looks fine.

- **`CORS_ORIGIN` is not the only source.** A `"ServerSetting"` row in the
  database overrides it, and the override is editable at runtime by an admin via
  `PUT /api/settings/cors` with no restart
  ([`src/services/settings.js:13-15`](src/services/settings.js:13)). The boot
  banner prints which source won, and says so at
  [`src/server.js:466-471`](src/server.js:466). You do not need to set
  `CORS_ORIGIN` at all if the UI is served by this same process, which it is.

- **`TELEGRAM_CHAT_ID` is not a variable** — see below. The per-user chat id is a
  column (`"User".telegramChatId` in [`init_db.sql:51`](init_db.sql:51)), not an
  environment setting.

### Dead variables — set nothing, nothing reads them

These names appear in older documentation and in some live `.env` files. **No
line of application code reads any of them.** Setting them creates a false
impression that they configure something. Do not spend time on them.

| Variable | Reality |
|---|---|
| `DATABASE_URL` | **Not read.** The variable that works is `DATABASE_PATH`. Setting `DATABASE_URL` does *not* move the database; it is silently inert. ([`README.md:28-32`](README.md:28) calls this out explicitly.) |
| `UPLOAD_DIR` | **Not read.** The upload directory is resolved from `__dirname` at [`src/middleware/imageUpload.js:7`](src/middleware/imageUpload.js:7) and is therefore always `<app>/data/uploads`, regardless of env or cwd. |
| `IMPORT_DIR` | **Not read.** The importer resolves its input relative to the repo root at [`scripts/import_excel.js:95`](scripts/import_excel.js:95). |
| `SESSION_SECRET` | **Not read.** A real secret may sit in your live `.env` doing nothing; it is safe to delete from there. |
| `TELEGRAM_CHAT_ID` | **Not read.** The one mention in the codebase is inside a warning *string* at [`src/server.js:437`](src/server.js:437) that tells the operator to set the `telegramChatId` **column** on their `"User"` row. Do exactly that, and ignore the env var. |

This is why [`.env.example`](.env.example) deliberately omits all five: it lists
only variables that are genuinely read.

---

## 4. Architecture notes

### Why `node:22-slim` and not Alpine

[`Dockerfile:5-16`](Dockerfile:5) explains this, and the reasoning still holds.

`sharp@0.33.5` is the only package left with native code. It loads libvips at
require time from a platform-specific optional dependency, and the lockfile pins
every variant (linux-x64, linuxmusl-x64, darwin, win32, s390x, arm); npm selects
whichever matches the build platform. On Debian that is
`@img/sharp-linux-x64` + `@img/sharp-libvips-linux-x64`, which **bundle their own
libvips and need nothing from the distribution**. Alpine would resolve to the
musl build instead, which additionally requires `libc6-compat` from Alpine's own
repositories — an extra moving part for zero benefit.

### Why there is no build toolchain in the image

`better-sqlite3` was removed (it was required by zero lines of application code).
Nothing in this tree compiles any more. `sharp`'s only install step *loads* a
prebuilt binary and throws a descriptive error if it cannot — it never falls back
to compiling. So `node-gyp`, `python3`, `make` and `g++` are all absent, and that
is correct, not an oversight.

### The two build stages

| Stage | Base | What it does |
|---|---|---|
| `deps` | `node:22-slim` | Copies **only** `package.json` and `package-lock.json`, runs `npm ci --omit=dev`, then asserts `require('sharp')` loads ([`Dockerfile:41-53`](Dockerfile:41)). Copying only the manifests means `npm ci` is cached until a dependency actually changes, not on every source edit. The `require` assertion converts a would-be runtime failure on the first image upload into a build-time failure. |
| `runtime` | `node:22-slim` | Installs `sqlite3`, `ca-certificates` and `tzdata` ([`Dockerfile:76-81`](Dockerfile:76)); copies `node_modules` from `deps`, then `src`, `public`, `init_db.sql` and the entrypoint; creates and chowns the data directories; drops to the non-root `node` user. |

The image is Debian (glibc) in both stages. There is no Alpine stage and no
Alpine-compatible branch.

### The `sqlite3` CLI is the database driver, and it is mandatory

**This project has no in-process SQLite binding.** Every query is a short-lived
`spawn('sqlite3', [DB_FILE])` child process fed SQL on stdin — see
[`src/services/db.js:44-60`](src/services/db.js:44) and the equivalent helper
duplicated across the route files (for example
[`src/routes/notifications.js:9-25`](src/routes/notifications.js:9)).

That makes `apt-get install sqlite3` a hard requirement of the image, not an
optimisation. The failure mode it creates is nasty and worth internalising:

> **Without the `sqlite3` binary, `/health` still returns 200 while every data
> route fails with a 500.**

`/health` never touches the database ([`src/server.js:158-166`](src/server.js:158)),
so it cannot detect this. The entrypoint therefore proves the driver exists
*before* starting the server, converting a silent 500-everywhere into one clear
log line ([`docker/entrypoint.sh:48-49`](docker/entrypoint.sh:48)).

### The `/app/data` volume layout

One named volume, `cosplay-cms-data`, is mounted at `/app/data`
([`docker-compose.yml:85-86`](docker-compose.yml:85),
[`docker-compose.yml:115-117`](docker-compose.yml:115)). It covers two
subdirectories:

```
/app/data
├── db/            ← the SQLite database  (data/db/cms.db by default)
└── uploads/       ← uploaded costume photos
```

**Why one volume and not two.** The database and the uploaded images are one
logical unit: the database stores filenames that resolve *inside*
`data/uploads`. A single volume means one backup command and one restore that
cannot be half-applied. With two volumes it is entirely possible to restore a new
database that points at image files from the old one, and the only symptom would
be broken thumbnails. A single volume restores atomically in exactly the way
these two things need to be atomic.

The independent-backup argument is real but weaker than it looks: the images are
large and change rarely while the database changes constantly, so splitting them
invites backing up the database nightly and the images never. If you genuinely
need the split — uploads on a larger, slower disk, say — the compose file
documents the exact replacement at
[`docker-compose.yml:71-81`](docker-compose.yml:71), and it works because the
Dockerfile creates *both* subdirectories in the image.

**Uploads are not configurable.** The upload path is `__dirname`-relative
([`src/middleware/imageUpload.js:7`](src/middleware/imageUpload.js:7)) and the
static mount is likewise ([`src/server.js:146`](src/server.js:146)), so the
directory is always `<app>/data/uploads`. This is why the volume must be mounted
at `/app/data` and not somewhere else.

### The non-root user and how volume ownership is established

The image runs as `node`, which is **UID/GID 1000** in all `node:*` images
([`Dockerfile:116`](Dockerfile:116)). Compose restates this with
`user: "1000:1000"` as defence in depth ([`docker-compose.yml:56`](docker-compose.yml:56)),
so the container stays non-root even if someone later rebuilds from a modified
base image that drops the `USER` directive.

The ownership trick is at [`Dockerfile:105-113`](Dockerfile:105). The Dockerfile
creates `/app/data/db` and `/app/data/uploads` **in the image** and `chown`s them
to `node:node`. When Docker initialises a fresh named volume, it copies the
image's directory content **and its ownership** into it. Because those paths
already exist in the image and already belong to 1000:1000, a first-run empty
volume is *already writable by the non-root user*, with no `chown` step and no
privileged init container.

Creating those directories with `mkdir` as root instead would produce a
root-owned volume, and the app would fail on the very first upload with a
permission error. That is the single most common cause of a broken first run
with a bind mount — see section 7.

### Why the entrypoint must `exec` (PID 1 and SIGTERM)

[`docker/entrypoint.sh:83`](docker/entrypoint.sh:83) ends with:

```sh
exec node /app/src/server.js
```

`exec` replaces the entrypoint shell with the Node process. Node therefore
**becomes PID 1** and receives `SIGTERM` directly from `docker stop`.

This is load-bearing. Without `exec`, Node would be a child of a shell that
ignores the signal; `docker stop` would stall until the timeout and then
`SIGKILL` the process mid-write — a corrupted-shutdown risk on a
database-backed service. Note the Dockerfile uses the **shell** form of
`ENTRYPOINT` deliberately, and warns against ever wrapping this in `CMD` or an
`npm start` script: that would make `npm` the signal receiver, npm would not
forward `SIGTERM`, and every stop would wait out the full grace period and then
be killed ([`Dockerfile:125-130`](Dockerfile:125)).

The application side is already correct: `SIGTERM`/`SIGINT` handlers call
`server.close()` and exit 0 in milliseconds
([`src/server.js:536-559`](src/server.js:536),
[`src/server.js:561-562`](src/server.js:561)), with a 9-second failsafe that
exits hard if a keep-alive socket holds the close open
([`src/server.js:532`](src/server.js:532)). Compose allows 15 seconds
([`docker-compose.yml:92`](docker-compose.yml:92)) so the failsafe has real
headroom and a normal stop always completes on the application's own clean exit.

### What the entrypoint does, in order

Every step is idempotent, because the entrypoint runs on **every** start
([`docker/entrypoint.sh:1-20`](docker/entrypoint.sh:1)):

1. **Verify the `sqlite3` binary is on `PATH`.** Fails the boot with a clear
   message if not ([`:48-49`](docker/entrypoint.sh:48)).
2. **`mkdir -p` the data directories.** The image already created them; this is
   the defensive path for a bind-mounted host directory that arrives empty
   ([`:55-56`](docker/entrypoint.sh:55)).
3. **Apply `init_db.sql`** ([`:69`](docker/entrypoint.sh:69)).
4. **Verify at least 10 tables now exist** and refuse to start otherwise
   ([`:72-77`](docker/entrypoint.sh:72)). It does not trust the exit code alone —
   it reports what is actually in the file.
5. **`exec node`** ([`:83`](docker/entrypoint.sh:83)).

Step 3 deserves emphasis. **The application never applies `init_db.sql`
itself.** `db.js:initSchema()` only creates the auth/2FA tables — it does not
create `Costume`, `User`, `Prop` or `ContactLens`. Without the entrypoint step,
the container boots perfectly healthy and then 500s on every data route.
[`init_db.sql`](init_db.sql) is 100% idempotent (`CREATE TABLE IF NOT EXISTS`
throughout, no `DROP`, no `DELETE`, no seed `INSERT`s), which is precisely what
makes it safe to run unconditionally on every boot.

---

## 5. Seeding and migrating existing data — the hazard section

> ### ⚠️ A fresh named volume boots a healthy, completely EMPTY CMS
>
> There is no data baked into the image. [`.dockerignore:31-32`](.dockerignore:31)
> excludes `data` from the build context, and the volume starts empty. The
> entrypoint will happily create the schema and start the server, the healthcheck
> will go green, the dashboard will load, and there will be **zero** costumes,
> lenses, props and users.
>
> The system will not warn you about this at any point.

Decide which of the three situations below you are in **before** you start.

| Situation | What to do |
|---|---|
| Migrating an existing host install's `data/` into a new container | [5.1](#51-seed-a-new-volume-from-the-hosts-data) |
| Backing up / restoring a running deployment | [5.2](#52-back-up-and-restore-the-volume) |
| Importing the original Excel inventory for the first time | [5.3](#53-the-one-time-excel-import) |

### 5.1 Seed a new volume from the host's `data/`

This is the "I already had the CMS running with `npm start` and now want it in a
container" path. The host's `data/` directory holds both the database and the
uploads, and the volume is one unit, so both must come across together.

**Stop the application first.** If it is still running against the same files,
you are copying a database mid-write.

```bash
# 1. If the app is running on the host outside a container, stop it.
#    (systemd: sudo systemctl stop cosplay-cms, or Ctrl-C the npm start terminal)

# 2. Make sure the image exists so we can use it as the copy tool.
docker compose build

# 3. Take the app down so nothing is writing to the volume.
docker compose down
```

Then copy the host data into the named volume, preserving timestamps and fixing
ownership to the UID the container runs as:

```bash
docker run --rm --user 0:0 \
  -v cosplay-cms-data:/data \
  -v "$PWD/data:/src:ro" \
  --entrypoint sh cosplay-cms:local -c \
  'mkdir -p /data/db /data/uploads \
   && cp -a /src/db/. /data/db/ \
   && cp -a /src/uploads/. /data/uploads/ \
   && chown -R 1000:1000 /data/db /data/uploads'
```

Four things about that command, each of which matters:

- `--user 0:0` is required because a **freshly created named volume is
  root-owned**, and the copy has to write into it before anything can be
  chowned. This is a deliberate exception to the non-root posture, scoped to
  this one maintenance command.
- `-v "$PWD/data:/src:ro"` is read-only so the command cannot damage your host
  copy.
- `cp -a` (archive) preserves ownership, timestamps and mode, which matters
  because filenames inside the database must keep resolving to the same files.
- `chown -R 1000:1000` is what makes the result writable by the `node` user the
  container actually runs as. Skipping this is the usual cause of the
  permission-denied symptom in section 7.

Start it and confirm the data arrived:

```bash
docker compose up -d
docker compose logs -f | head -20

# How many rows came across? (adjust the port if you set CMS_PORT)
curl -s -H "X-CMS-API-KEY: $(grep '^API_KEY=' .env | cut -d= -f2- | tr -d '\"')" \
  "http://localhost:4001/api/notifications/contact-lenses/expiring?days=14"
```

Then log into the dashboard and confirm your costumes are there and their
**photos render**. Broken thumbnails mean the uploads did not make it across
even though the rows did.

> **Note on `data/` in the repository.** `data/` is gitignored
> ([`.gitignore:2`](.gitignore:2)) and `.xlsx` files are too
> ([`.gitignore:4`](.gitignore:4)). A fresh `git clone` on a new machine has an
> empty `data/` directory and no spreadsheet. You must move the directory across
> out of band — scp, rsync, a backup archive, whatever you already use.

### 5.2 Back up and restore the volume

#### Backing up

**Back up the whole `data/db` directory, not just `cms.db`.**

SQLite does not keep everything inside the single `.db` file. The application
never issues a `PRAGMA journal_mode`, so SQLite's default rollback journal
applies, and any write transaction creates a temporary sibling file next to the
database (`cms.db-journal`; if WAL mode is ever enabled, `cms.db-wal` and
`cms.db-shm` appear instead). Copying `cms.db` on its own, while another process
holds a write transaction, can capture a file that does not match its journal —
and SQLite will then refuse to open it.

The reliable way to avoid the question entirely is to stop the app first. That
makes the copy trivially consistent:

```bash
mkdir -p backups
docker compose stop

docker run --rm --user 0:0 \
  -v cosplay-cms-data:/data:ro \
  -v "$PWD/backups:/backup" \
  --entrypoint sh cosplay-cms:local -c \
  'tar czf /backup/cosplay-cms-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .'

docker compose start
```

That single tarball contains **both** the database and the uploads, which is the
whole reason they share a volume. Check what you produced:

```bash
tar tzf backups/cosplay-cms-data-*.tar.gz | head
# ./db/
# ./db/cms.db
# ./uploads/
# ./uploads/0a511c55-...-1790492223598.webp
# ...
```

If you cannot stop the app, at minimum copy the entire `db/` directory
including any `-journal`, `-wal` and `-shm` siblings. A single-file copy of
`cms.db` alone is **not** a safe backup.

#### Restoring

```bash
docker compose down

docker run --rm --user 0:0 \
  -v cosplay-cms-data:/data \
  -v "$PWD/backups:/backup:ro" \
  --entrypoint sh cosplay-cms:local -c \
  'rm -rf /data/db /data/uploads \
   && mkdir -p /data/db /data/uploads \
   && tar xzf /backup/cosplay-cms-data-YYYYMMDD-HHMMSS.tar.gz -C /data \
   && chown -R 1000:1000 /data/db /data/uploads'

docker compose up -d
docker compose logs -f | head -20
```

The `rm -rf` is deliberate: it guarantees a restore cannot leave a stale
half-old schema or orphaned uploads behind a new database.

#### Starting completely over

To discard the data and return to a pristine empty CMS:

```bash
docker compose down
docker volume rm cosplay-cms-data
docker compose up -d
```

This **destroys all data irreversibly**. Take a backup first (5.2 above).

### 5.3 The one-time Excel import

There is a backfill importer at [`scripts/import_excel.js`](scripts/import_excel.js)
that reads the original inventory spreadsheet and inserts costumes.

**It is dry-run by default and writes nothing without `--apply`**
([`scripts/import_excel.js:91-93`](scripts/import_excel.js:91)). This is
deliberate: the CMS already holds real costumes, and the script will cheerfully
add ninety more on top.

> **Never run the importer at container start.** The entrypoint does not invoke it
> and must not be modified to ([`docker/entrypoint.sh:14-19`](docker/entrypoint.sh:14)):
> seeding is a one-time manual operator step, and the importer is opt-in by
> design.

**On the input file.** The importer's default input is
`imports/Costume Inventory List (1).xlsx`
([`scripts/import_excel.js:95`](scripts/import_excel.js:95)). In the tree this
was authored against, that file is present on disk — but it is gitignored
([`.gitignore:4`](.gitignore:4)) and excluded from the build context
([`.dockerignore:47`](.dockerignore:47)), so **a fresh clone will not have it**. If
the file is missing the script prints `Spreadsheet not found: ...` and exits 1
before touching anything ([`scripts/import_excel.js:328-331`](scripts/import_excel.js:328)),
which is safe but means the import silently does nothing. Check for it first:

```bash
ls -l "imports/Costume Inventory List (1).xlsx"
```

**If you need to import, do it on the host, not inside the container.** The
image contains neither the importer nor the spreadsheet: the Dockerfile only
`COPY`s `package.json`, `src`, `public`, `init_db.sql` and the entrypoint
([`Dockerfile:90-99`](Dockerfile:90)), and `imports/` is excluded from the build
context entirely ([`.dockerignore:47`](.dockerignore:47)). (The `xlsx` *library*
is an ordinary dependency and is installed; the spreadsheet *file* is not in the
image.)

```bash
# 1. Dry run first. Reads the database read-only and reports what it would do.
node scripts/import_excel.js

# 2. If the report looks right, write.
node scripts/import_excel.js --apply
```

Useful flags ([`scripts/import_excel.js:20-32`](scripts/import_excel.js:20)):
`--dry-run` (explicit default), `--apply` (required for any write),
`--file <path>`, `--db <path>`, `--allow-duplicates`, `--limit-rows <n>`.
Without `--allow-duplicates`, a row matching an existing costume by
(character, fandom) is **skipped** — that is what stops a re-run from doubling
the table. Run it twice and it is idempotent.

If you instead need to import into a live container, mount the file and the
volume explicitly and keep the dry-run-first discipline:

```bash
docker compose exec cms node scripts/import_excel.js --help
```

Note that the scripts directory is not in the image, so the `exec` above will
fail with a module-not-found. The supported workflow is the host-side one above,
or run the importer against the volume from a container that has the repo
mounted read-write at `/repo`:

```bash
docker compose stop
docker run --rm --user 0:0 \
  -v cosplay-cms-data:/app/data \
  -v "$PWD:/repo" \
  --workdir /repo \
  --entrypoint node cosplay-cms:local scripts/import_excel.js --dry-run
docker compose start
```

---

## 6. Operations

All commands assume you are in the repository root with a modern Compose v2.

### Lifecycle

```bash
docker compose up -d --build     # build if needed, start detached
docker compose up -d             # start (uses the existing image)
docker compose stop              # graceful SIGTERM, container stays
docker compose start             # start it back up
docker compose restart           # restart in place
docker compose down              # remove the container and network (KEEPS the volume)
docker compose down -v           # ALSO DELETE THE DATA — irreversible
```

> `docker compose down` does **not** delete the `cosplay-cms-data` volume. That
> is deliberate and is why your data survives a redeploy. Only `down -v` destroys
> it. This is the single most common reason people lose data in Docker, so read
> it twice.

The service uses `restart: unless-stopped`
([`docker-compose.yml:25`](docker-compose.yml:25)): it comes back after a
reboot, but stays down after an explicit `docker compose stop`.

### Logs

```bash
docker compose logs -f            # follow all services
docker compose logs --tail=100    # last 100 lines
docker compose logs cms           # one service
docker logs -f cosplay-cms-cms-1  # raw, by container name
```

Entry point lines are prefixed `[entrypoint]`. Boot errors are prefixed
`[entrypoint] FATAL:` and are followed by the container exiting.

### Status and health

```bash
docker compose ps
```

The `STATUS` column is the healthcheck result:

| Status | Meaning |
|---|---|
| `starting` | Within the 20-second start period. Not yet a verdict. |
| `healthy` | The last probe returned 200 from `/health`. **Proves Node is alive only — it does not touch the database.** |
| `unhealthy` | Three consecutive failed probes (30s apart, after the 20s start period). |
| `Exited (1)` | The process exited with code 1 — usually the JWT guard or an entrypoint `FATAL`. |
| `Exited (137)` | SIGKILL — the graceful shutdown did not finish in 15s. |

Full health history:

```bash
# Overall verdict
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q cms)"

# The last three probe results, including any output the probe captured
docker inspect --format '{{range .State.Health.Log}}{{.Start}} exit={{.ExitCode}} {{.Output}}{{"\n"}}{{end}}' \
  "$(docker compose ps -q cms)"
```

The probe itself is defined at [`Dockerfile:122-123`](Dockerfile:122): every 30s,
5s timeout, 20s start period, 3 retries. It uses `node` rather than `curl` or
`wget` because **neither of those is present in `node:22-slim`**.

### A shell inside the container

```bash
docker compose exec cms sh
```

The image is Debian-based, so you get a real shell and the full userland:

```sh
# inside the container
id                                    # uid=1000(node) gid=1000(node)
command -v sqlite3                    # /usr/bin/sqlite3
ls -la /app/data/db /app/data/uploads # ownership should be 1000:1000
sqlite3 /app/data/db/cms.db ".tables" # the real schema
sqlite3 /app/data/db/cms.db "SELECT COUNT(*) FROM \"Costume\";"  # real row count
```

That `SELECT COUNT(*)` is the direct answer to "did my data actually come
across?" from section 5.

### Proving the database is reachable

`/health` is not a database check. This one call executes real SQL through the
real driver against the real schema:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-CMS-API-KEY: $(grep '^API_KEY=' .env | cut -d= -f2- | tr -d '\"')" \
  "http://localhost:4001/api/notifications/contact-lenses/expiring?days=14"
# 200 = driver + database + schema all work
# 403 = API_KEY wrong or unset (the database was never touched)
# 500 = the query itself failed — the database is NOT working
```

Note the 403 case: a rejected key means the request never reached SQL, so a 403
tells you nothing about the database. Get the 200 first, then investigate.

---

## 7. Verification and troubleshooting

### Verifying a fresh install

| Check | Command | Pass |
|---|---|---|
| Container running | `docker compose ps` | `Up ... (healthy)` |
| Entry point completed | `docker compose logs cms \| head -8` | 5 `[entrypoint]` lines, ending in `exec: node ...` |
| Schema applied | `docker compose logs cms \| grep 'tables present'` | `(10 tables present)` |
| HTTP responds | `curl -s http://localhost:4001/health` | `"status":"ok"` |
| **Database works** | The API-key call in section 6 | `200` |
| Data is present | `docker compose exec cms sqlite3 /app/data/db/cms.db "SELECT COUNT(*) FROM \"Costume\";"` | Non-zero, if you expected data |
| Images render | Open the dashboard gallery | Photos visible, not broken thumbnails |
| Running as non-root | `docker compose exec cms id` | `uid=1000(node)` |

### Symptom → cause → fix

| Symptom | Cause | Fix |
|---|---|---|
| **`/health` returns 200 but every data route 500s** | Two distinct causes with the same symptom. **(a)** The `sqlite3` binary is missing — the app has no in-process driver, it shells out to `sqlite3` per query. **(b)** The schema was never applied — the app never applies `init_db.sql` itself. | The entrypoint already guards both, so **read the logs first**: a missing driver prints `[entrypoint] FATAL: sqlite3 CLI not found` and a schema failure prints `expected at least 10 tables...`, both causing an immediate exit. If the container is running and healthy, then neither of those fired and the failure is elsewhere — capture the real error from `docker compose logs cms`. Verify directly with `docker compose exec cms sqlite3 /app/data/db/cms.db ".tables"`. |
| **Container healthy, dashboard shows no data at all** | Fresh named volume. Expected, not a bug — see section 5. | Follow [5.1](#51-seed-a-new-volume-from-the-hosts-data). |
| **`EACCES: permission denied, open '/app/data/uploads/...'`** | Volume ownership. The `node` user is UID 1000 and cannot write to a root-owned directory. Almost always caused by a **bind mount** of a host directory, or by a restore that skipped the `chown`. | `docker compose exec -u 0 cms chown -R 1000:1000 /app/data` then `docker compose restart`. Long-term, use the named volume (whose ownership is inherited from the image, [`Dockerfile:105-113`](Dockerfile:105)) rather than a host bind mount. |
| **Container exits immediately, restart loop** | Missing or weak `JWT_SECRET`. With `NODE_ENV=production` (which compose forces, [`docker-compose.yml:47`](docker-compose.yml:47)), an unset secret **throws while loading** the auth module ([`src/middleware/auth.js:25-30`](src/middleware/auth.js:25)) and a weak one **exits 1 at boot** ([`src/server.js:25-30`](src/server.js:25)). | Logs show `FATAL: JWT_SECRET is not set` or `JWT_SECRET is too short (N chars, need >= 32)`. Generate a real one: `openssl rand -hex 32`, put it in `.env`, `docker compose up -d --force-recreated`. |
| **API key rejected with 403 even though you set it** | Placeholder rejection, or a value that got truncated. | A key containing `your_`, `here` or `$(` is refused unconditionally ([`src/middleware/apiKeyAuth.js:28-30`](src/middleware/apiKeyAuth.js:28)). Note the value is `.trim()`ed on both sides, so a trailing newline is harmless but a leading space inside quotes is not. Compare byte for byte: `docker compose exec cms sh -c 'echo -n "$API_KEY" \| wc -c'`. |
| **Lost access after changing `JWT_SECRET`** | Every token is signed with it, so every existing session is now invalid. This is a feature, not a bug. | Users log in again. The 2FA secrets in `"User".twoFactorSecret` are stored separately and are unaffected, so nobody is locked out of their account — only out of their session. |
| **`database is locked` / `SQLITE_BUSY` under concurrent writes** | **Expected behaviour, and it is a real limitation.** Each query is a separate `sqlite3` process, and the application sets **no global `busy_timeout`** — the only `PRAGMA busy_timeout = 5000` in the codebase is inside one specific multi-statement transaction at [`src/services/db.js:578-593`](src/services/db.js:578). Ordinary single-statement writes therefore take a lock or fail immediately. | Under normal single-user use you will not hit it. If you do, it means genuinely concurrent writes. The honest fix is a code change — a global busy timeout in [`src/services/db.js:44-60`](src/services/db.js:44), or moving to a real in-process driver — and both are out of scope for this deployment guide. Do not "fix" it with SQLite pragmas at runtime; there is no supported hook for that here. |
| **Everything restarted when you ran `docker compose down`** | `down` stops *and removes* containers. That is what it is for. | `docker compose up -d`. The **data** is unaffected — `down` does not touch the volume unless you pass `-v`. See section 6. |
| **Data appears to have vanished after a rebuild** | You ran `docker compose down -v`, or removed the volume by hand. | Restore from a backup (section 5.2). If you have no backup, the data is gone — the image never contained it. |
| **Wrong port — `curl: connection refused`, or n8n cannot reach the CMS** | Host/container port confusion. The **container** port is always `4001`; only the **host** side is remapped by `CMS_PORT` ([`docker-compose.yml:32`](docker-compose.yml:32)). | Use `http://localhost:${CMS_PORT:-4001}` from the host, and `http://cms:4001` from another container. Never change `PORT` to move a host port — it silently breaks the n8n workflow. |
| **Browser CORS errors, or the SPA loads but no data** | UI and API on different origins. | Set `CORS_ORIGIN` in `.env` to a comma-separated list of **exact** origins and recreate the container. Remember the database `ServerSetting` row **overrides** the env var ([`src/services/settings.js:13-15`](src/services/settings.js:13)) — the boot banner says which source won. |
| **Uploads 404 but rows exist** | The database restored but the uploads did not. The `imageUrls` column holds filenames that resolve inside `data/uploads`. | Restore the **whole** volume (section 5.2), not just the database. This is the failure mode that the single-volume design exists to prevent. |
| **Rate limited (429) when testing repeatedly** | The in-memory limiter in [`src/middleware/rateLimit.js:32-42`](src/middleware/rateLimit.js:32) is a fixed window, per process. Login routes are capped especially low. | Wait out the window. The `Retry-After` and `RateLimit-*` response headers say when. |
| **`docker compose ps` shows `Exited (137)`** | SIGKILL — graceful shutdown exceeded the 15s grace period ([`docker-compose.yml:92`](docker-compose.yml:92)). | Normally this means a client held a keep-alive socket open past the app's own 9s failsafe ([`src/server.js:532`](src/server.js:532)). Rare; check the logs for the `failsafe` message. |
| **Build fails with `npm ci` errors** | `package.json` and `package-lock.json` out of sync, or the lockfile was excluded. | The lockfile must be in the build context — the `deps` stage installs strictly from it ([`Dockerfile:45-49`](Dockerfile:45)). Restore it from git and rebuild. |

---

## 8. Security notes

**`/health` is public by design.** It is unauthenticated, not rate-limited, and
returns only `status`, `timestamp`, `uptime` and `environment`
([`src/server.js:158-166`](src/server.js:158)). It exposes nothing sensitive and
it makes the container's health observable to Docker without credentials. That
is a deliberate trade: a healthcheck that needs a secret is a healthcheck that
fails for the wrong reason.

**`API_KEY` fails closed.** If `API_KEY` is unset, `requireApiKey()` refuses
every caller — 403 when a key is present and invalid, 401 when none is
([`src/middleware/apiKeyAuth.js:34-49`](src/middleware/apiKeyAuth.js:34)). There
is no default and no bypass. Comparison is constant-time over SHA-256 digests
([`src/middleware/apiKeyAuth.js:10-16`](src/middleware/apiKeyAuth.js:10)), so it
does not leak the key through response timing. This is the only path into
`/api/notifications` and into image reads for server-to-server clients.

**Uploaded images are not world-readable.** The `/uploads` static mount sits
behind `requireUploadAccess` ([`src/server.js:145-146`](src/server.js:145),
[`src/middleware/uploadAccess.js:35-69`](src/middleware/uploadAccess.js:35)),
which requires either a valid **access** token or a valid API key in the header.
A refresh token or a 2FA-pending token is refused. The API key is accepted from
the header only for image reads — never from a query string, which would put a
long-lived secret into browser history, logs and `Referer` headers.

**`JWT_SECRET` must never be committed.** Anyone holding it can mint a valid
admin token. The application enforces this from both directions: unset in
production **throws at module load**
([`src/middleware/auth.js:25-30`](src/middleware/auth.js:25)), and a value that
is too short, matches a known-weak list, or is an unexpanded `$(...)`
placeholder causes `exit(1)` at boot
([`src/middleware/auth.js:76-111`](src/middleware/auth.js:76),
[`src/server.js:20-36`](src/server.js:20)). A repetitive secret produces a
warning, not a failure.

**`TELEGRAM_BOT_TOKEN` is a real credential.** It is read at
[`src/services/telegramService.js:32`](src/services/telegramService.js:32) and
gives full control of the bot. It is strictly on-demand: never called at boot,
5-second timeout, and it cannot reject into the request path — a broken Telegram
integration can neither delay startup nor take the server down. Leaving it empty
disables Telegram entirely and changes nothing else.

**`.env` is excluded from both git and the build context.** It is gitignored
([`.gitignore:3`](.gitignore:3)) and excluded by [`.dockerignore:25-26`](.dockerignore:25).
The second exclusion is the one that matters most: a `.env` copied into an image
would bake credentials into an immutable layer, readable by anyone who can pull
the image or inspect its layer history. The build context additionally excludes
`data` entirely ([`.dockerignore:31-32`](.dockerignore:31)), and
[`.dockerignore:5-7`](.dockerignore:5) states a hard rule of never adding a `!`
negation for it, because `data/` plus a negation is the classic way to
accidentally ship a production database.

**What happens if `JWT_SECRET` changes:** every existing session token instantly
becomes invalid and every logged-in user is signed out. Nothing is lost — the
`"User"` rows, their `passwordHash` and their `twoFactorSecret` are stored in the
database, not derived from the signing key, so users simply log in again. Treat
rotation as a deliberate mass-logout and schedule it accordingly.

**Open, pre-existing, out of scope: `npm audit` reports 2 high-severity
advisories.** `npm audit` flags exactly two packages, and **`multer` is neither
of them**:

- **`sharp`** — 2 high advisories (GHSA-f88m-g3jw-g9cj, libvips CVE-2026-33327/33328/35590/35591; GHSA-rgj7-g3m4-5g8c, libheif). Fix is `sharp@0.35.5`, a semver-major bump.
- **`xlsx`** — 2 high advisories (GHSA-4r6h-8v6p-xvw6 prototype pollution, CVSS 7.8; GHSA-5pgg-2g8v-p4x9 ReDoS, CVSS 7.5). **No fix is published on npm.**

Separately and *not* an audit finding: `multer` is declared as `^1.4.5-lts.1`
([`package.json:29`](package.json:29)) and resolves to `1.4.5-lts.2`
([`package-lock.json:1191-1192`](package-lock.json:1191)). The lockfile marks that
version `"deprecated"` with the note that Multer 1.x is impacted by
vulnerabilities patched in 2.x
([`package-lock.json:1195`](package-lock.json:1195)). That is registry
deprecation metadata, not a severity-rated advisory, and `npm audit` does not
flag it. An upgrade to multer 2.x is a breaking change and needs validation
against the upload path
([`src/middleware/imageUpload.js`](src/middleware/imageUpload.js) configures
multer's disk storage directly; the field name and size limit are part of the API
contract [`public/index.html`](public/index.html) depends on).

---

## 9. Known unverified areas and open items

This section exists because an operator following a wrong command is worse than
an operator missing one. Here is exactly what has **not** been proven.

**The image has never been built by automation.** The repository contains no CI
workflow at all — [`.github/`](.github) holds only
`agents/qa-tester.agent.md`. The [`Dockerfile`](Dockerfile) and
[`docker-compose.yml`](docker-compose.yml) were authored by an agent that had no
access to a Docker daemon, so **the build itself is unverified**: it has not been
run end to end, and neither has any of the commands in this document. Expect to
iterate on the first build. The most likely thing to need a small adjustment is
apt package availability on the pinned Debian base, not the design.

**Named-volume ownership inheritance is inferred, not observed.** The reasoning
at [`Dockerfile:105-113`](Dockerfile:105) — that Docker copies both content and
ownership from the image into a fresh named volume — is documented Docker
behaviour and is the standard mechanism, but it was not observed in this
environment. If a first run fails with a permission error, that inference is the
first thing to check, and `docker compose exec -u 0 cms chown -R 1000:1000
/app/data` is the remedy (section 7).

**`sharp` was not exercised inside the image.** The `deps` stage asserts
`require('sharp')` loads at build time ([`Dockerfile:53`](Dockerfile:53)), which
is the right check, but the build has not run — so the claim that the glibc
prebuild resolves and loads on `node:22-slim` is **reasoned from the lockfile,
not demonstrated**. The first real image upload is the true test. `sharp` and
`xlsx` are the two dependencies where native/wasm resolution is most likely to
surprise.

**The docker-compose sketch in the old setup guide is wrong. Ignore it.** The
YAML at
[`cosplay_cms_phase_by_phase_implementation_server_setup_guide.md:408-432`](cosplay_cms_phase_by_phase_implementation_server_setup_guide.md:408)
is **not** a valid deployment for this codebase, in four separate ways:

| What it says | Why it is wrong |
|---|---|
| `ports: "3000:3000"`, `PORT=3000` | The app and image use `4001`; the n8n workflow hardcodes it. |
| `DATABASE_URL="file:/data/db/cms.db"` | `DATABASE_URL` is read by **no code**. The variable that works is `DATABASE_PATH`, and it is `DATABASE_PATH` that must point into the mounted volume. |
| Mounts host paths at `/data/db` and `/data/uploads` | The app reads and writes `/app/data/...` ([`src/services/db.js:34`](src/services/db.js:34), [`src/middleware/imageUpload.js:7`](src/middleware/imageUpload.js:7)). `/data` is not a path this app knows. |
| `docker exec -it cosplay_cms node scripts/import_excel.js` | The image never copies `scripts/` in ([`Dockerfile:90-99`](Dockerfile:90)), so the command cannot work; and the importer is dry-run by default and must never run at container start. |

Use [`docker-compose.yml`](docker-compose.yml). It is the deployment of record.

**Pre-existing test failures, unrelated to Docker.** Do not chase these while
working on the container:

| Suite | Reported failures | Relevance |
|---|---|---|
| `scripts/test_api.js` (`npm test`) | 2 | None — pre-dates the Docker work. |
| `scripts/test_phase3.js` (`npm run test:phase3`) | 8 | None — pre-dates the Docker work. |

> **Verified on 2026-09-27 under Node v22.23.3** against a live server on port
> 4001: `test_api` 22 passed / 2 failed, `test_phase3` 0 passed / 8 failed,
> `test_phase4` 5 passed / 0 failed, `test_phase5` 110 passed / 0 failed. These
> are re-runs, not reported figures. All four failures groups are **stale test
> expectations, not application defects** — `test_api` posts no body to
> `/auth/refresh` ([`scripts/test_api.js:121`](scripts/test_api.js:121)) and
> asserts 403 where the server correctly returns 401
> ([`scripts/test_api.js:352`](scripts/test_api.js:352)); `test_phase3` expects
> `recoveryKey` from `/api/auth/register`
> ([`scripts/test_phase3.js:92`](scripts/test_phase3.js:92)), which now only
> issues it from `/api/auth/break-glass/generate`
> ([`src/routes/auth.js:567-577`](src/routes/auth.js:567)), so its 8 failures
> are 1 root cause plus 7 cascades. None relate to Docker; none need chasing
> during container work. Note also that [`README.md:450`](README.md)'s recorded
> `109 passed / 0 failed / 2 skipped` is **stale**: the two skips were
> data-driven (no `ContactLens` rows) and the database now holds 7, so the
> current true figure is 110/0/0.

Also note that the test suites are **not shipped in the image** — the Dockerfile
copies no `scripts/` directory ([`Dockerfile:90-99`](Dockerfile:90)) — and are not
meaningful inside a container: several of them read a host `data/` directory and
drive a locally-spawned server. The Docker surface of this project is verified
by the manual checks in section 7, not by `npm test`.

---

## 10. n8n integration

### The direction of travel: inbound only

**The CMS never calls n8n.** The integration is strictly inbound: n8n calls the
CMS. The CMS makes no outbound request to n8n at any point. This matters
operationally — the CMS does not need to know n8n exists, does not need network
access to reach it, and continues to work if n8n is down.

The workflow is [`workflows/n8n_contact_lens_expiry_alert.json`](workflows/n8n_contact_lens_expiry_alert.json).
It runs daily at 08:00, calls the CMS for contact lenses expiring within a
threshold, and posts a Telegram alert if any are found.

### The call and its header

```
GET http://localhost:4001/api/notifications/contact-lenses/expiring?days=14
X-CMS-API-KEY: <your API_KEY>
```

| Detail | Value | Where |
|---|---|---|
| Endpoint | `GET /api/notifications/contact-lenses/expiring` | [`src/routes/notifications.js:42`](src/routes/notifications.js:42) |
| Companion endpoint | `GET /api/notifications/costumes/on-rent` | [`src/routes/notifications.js:118`](src/routes/notifications.js:118) |
| Auth header | `X-CMS-API-KEY` | [`workflows/n8n_contact_lens_expiry_alert.json:29`](workflows/n8n_contact_lens_expiry_alert.json:29) |
| `days` parameter | Non-negative integer, default 14 | [`src/routes/notifications.js:56-66`](src/routes/notifications.js:56) |
| Hardcoded URL | `http://localhost:4001/...` | [`workflows/n8n_contact_lens_expiry_alert.json:24`](workflows/n8n_contact_lens_expiry_alert.json:24) |
| Hardcoded key | `your_api_key_here` — a placeholder | [`workflows/n8n_contact_lens_expiry_alert.json:30`](workflows/n8n_contact_lens_expiry_alert.json:30) |

> The hardcoded key is a **placeholder that the application will reject** — it
> contains `your_` and `here`
> ([`src/middleware/apiKeyAuth.js:28-30`](src/middleware/apiKeyAuth.js:28)). You
> must replace it in the n8n UI with the real `API_KEY` from your `.env`. Leaving
> it produces a clean `403`, not a subtle misconfiguration.

The `apiKey` query-string parameter is also accepted on these routes
([`src/middleware/apiKeyAuth.js:35`](src/middleware/apiKeyAuth.js:35)), but
prefer the header: a secret in a URL ends up in logs and history.

### Why port 4001 is fixed inside the container

The workflow JSON hardcodes `localhost:4001`. Compose therefore remaps only the
**host** side and pins the container side
([`docker-compose.yml:31-32`](docker-compose.yml:31)):

```yaml
ports:
  - "${CMS_PORT:-4001}:4001"
```

This is what lets you run the CMS on a different host port without editing the
workflow. If you change `CMS_PORT`, nothing in the container changes. If you
change `PORT`, the container keeps working and n8n breaks — which is why the
compose file and [`.env.example`](.env.example) both say to leave `PORT` alone.

### If n8n runs in a container

`localhost` inside an n8n container is **the n8n container itself**. The
workflow will fail with a connection error. You have two options, and the first
is better:

**Option A — keep n8n on the host (recommended).** `localhost:4001` works
unchanged if n8n runs on the Docker host and the CMS publishes `4001` there. No
edits to the workflow at all.

**Option B — put n8n on the same Compose network.** Then replace `localhost`
with the CMS service name:

```
http://cms:4001/api/notifications/contact-lenses/expiring?days=14
```

`cms` is the service name from [`docker-compose.yml:16`](docker-compose.yml:16).
For this to resolve, both services must share a network:

```yaml
# in n8n's compose file — reference the CMS's external network
services:
  n8n:
    networks: [cosplay-net]
networks:
  cosplay-net:
    external: true
```

```yaml
# in this project's docker-compose.yml
services:
  cms:
    networks: [cosplay-net]
networks:
  cosplay-net:
    name: cosplay-net
```

That is a change to [`docker-compose.yml`](docker-compose.yml) and therefore
**outside the scope of this document** — it is shown so you know what the
alternative entails, not as an instruction to apply it. Note also that on a
shared user-defined network, Docker's embedded DNS resolves the service name, so
`cms` works without any extra configuration.

Whichever you choose, the `X-CMS-API-KEY` value must be the real `API_KEY` from
`.env`, and the CMS's own `API_KEY` must not contain `your_`, `here` or `$(`.

---

## Appendix — where things live

| Path | What it is |
|---|---|
| [`Dockerfile`](Dockerfile) | Multi-stage build. `deps` then `runtime`. Read the header comment first — it explains the Debian, toolchain and driver decisions. |
| [`docker/entrypoint.sh`](docker/entrypoint.sh) | Boot script. Idempotent, POSIX sh, ends in `exec node`. |
| [`docker-compose.yml`](docker-compose.yml) | The deployment of record. Heavily commented. |
| [`.env.example`](.env.example) | Copy this to `.env`. Contains only variables that are genuinely read. |
| [`.dockerignore`](.dockerignore) | Build-context exclusions. Read the two hard rules at the top before editing. |
| [`.gitignore`](.gitignore) | Excludes `data/`, `.env` and `*.xlsx`. |
| [`init_db.sql`](init_db.sql) | The schema, 10 tables, 100% idempotent. Applied by the entrypoint, never by the app. |
| [`src/server.js`](src/server.js) | App wiring, `/health`, boot guards, graceful shutdown. |
| [`src/services/db.js`](src/services/db.js) | The `sqlite3` CLI transport and `DB_FILE` resolution. |
| [`src/middleware/apiKeyAuth.js`](src/middleware/apiKeyAuth.js) | `X-CMS-API-KEY` verification, fail-closed. |
| [`src/middleware/auth.js`](src/middleware/auth.js) | JWT handling and the production secret guards. |
| [`workflows/n8n_contact_lens_expiry_alert.json`](workflows/n8n_contact_lens_expiry_alert.json) | The inbound n8n workflow. |
| [`README.md`](README.md) | Application documentation. |
