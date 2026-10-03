<div align="center">

# 🧥 Cosplay CMS

### Every costume, prop and lens — all in one place

[![Live site](https://img.shields.io/badge/Website-live-8b5cf6?style=flat-square&logo=github&logoColor=white)](https://rielolita171.github.io/cosplay-cms/)
[![Pages](https://img.shields.io/badge/GitHub%20Pages-passing-2ea44f?style=flat-square&logo=github&logoColor=white)](https://rielolita171.github.io/cosplay-cms/)
[![Node](https://img.shields.io/badge/Node-22-5fa04e?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-CLI-003b57?style=flat-square&logo=sqlite&logoColor=white)](https://sqlite.org/)
[![License](https://img.shields.io/badge/License-ISC-blue?style=flat-square)](#license)
[![No build step](https://img.shields.io/badge/build-none%20required-6f42c1?style=flat-square)](#running-it)
[![Desktop](https://img.shields.io/badge/Release-v1.0.0-2ea44f?style=flat-square&logo=electron&logoColor=white)](https://github.com/rielolita171/cosplay-cms/releases/tag/v1.0.0)

[**Visit the project site →**](https://rielolita171.github.io/cosplay-cms/)

</div>

---

## 1. What is Cosplay CMS

A self-hosted inventory system for a cosplay collection. It tracks the outfit,
the props that go with it, the contact lenses you have open, and the makers who
built the props — plus the things that actually go wrong: a costume lent to a
friend and never returned, a vial of lenses a month past its date, a costume
marked *to be sold* with no price attached.

One Express server, one SQLite file, one self-contained HTML page. It runs three
ways from **the same server code**: as a Node process, as a Docker container
(**the primary target**), and as a packaged desktop app (Electron). The Windows
installer is **released as
[v1.0.0](https://github.com/rielolita171/cosplay-cms/releases/tag/v1.0.0)** — see
[`ELECTRON.md`](ELECTRON.md). **v1.1.0 is being prepared** and has no installer
yet, so v1.0.0 is still the artifact you can download; what v1.1.0 changes is
written down under "Release notes" below.

Seven tabs: Costumes, Props & Accessories, Contact Lenses, Maker Corner,
Wishlist, Reference Lists and Settings. Cards or a sortable list view, filterable
by brand, fandom and size, with a read-only detail preview from either.

<p align="center">
  <em>Live screenshots of a running instance are on the project site, not pasted
  here — the repository stays lean and nothing in it needs to be re-encoded.</em>
</p>

> ⚠️ **This deployment has no authentication.** There is no login, no password,
> no role ladder and no session token. Anyone who can reach the published port
> has full read *and* write access to every record. That is deliberate — it is a
> single-user box on a private network, and the boundary is the network or a
> reverse proxy, not the application. See "Security model" below, and do not
> publish this port to the internet.

## 2. Why it came about

Cosplay collections grow sideways. You finish one outfit, then the accessories
that go with it, then the lenses for the convention, then a commission from
someone who liked the last thing you built. None of that is a stock problem, and
that is exactly why the general tools fit badly:

- **A spreadsheet** cannot answer "which of my lenses expire this month?" or
  "what is still out on loan?" without you building the formula yourself, and it
  cannot hold a photo per record. It also stops being portable the moment anyone
  else touches it.
- **A generic inventory app** assumes a warehouse: a stock count, a reorder
  threshold, a purchase order. A costume collection has none of those. It has
  *condition*, *storage location*, *whether you currently own it*, and *whether
  the thing you made for it is still in the box*.
- **Photos are the actual memory.** Six months later, which outfit was the one
  with the detachable sleeve? Only a photo answers that, and a photo lives
  happily in a phone gallery where nothing can search it.
- **Lenses expire quietly.** They are consumables with a hard date, they are
  invisible in a cupboard, and wearing one past it is a real problem. Nothing in
  a spreadsheet is going to notice on its own.

So the honest answer was that nothing off the shelf did this job, and the
alternative was keeping the truth in a notes app and finding out the week of the
convention. This is the tool that replaced that.

## 3. How it solves it

- **One record per costume**, carrying fandom, character, brand, size, the
  full-set flag, buy/sell/mutual prices, notes and a reference link. Status moves
  a row between *In Possession*, *On Rent*, *To Be Sold* and *Wishlist* — and
  the **Wishlist is a filtered view of the same rows**, not a second copy, so an
  item moves between the two by changing one dropdown and nothing else.
- **Props are first-class and link to their costume.** Category, condition,
  storage location and notes, optionally attached to the costume it belongs to,
  so the Astesia sword shows up on the Astesia card instead of being lost in a
  drawer.
- **Contact lenses are tracked per vial**, with unopened / active /
  expiring-soon / expired / disposed states and a scheduled checker that pushes
  expiry warnings to Telegram — so a vial is never worn a month past its date.
- **Maker Corner** is a directory of the people who build your props, with real
  `tel:` and WhatsApp links, because the moment you need it is the moment a prop
  broke and you need someone to fix it.
- **Brands and fandoms are managed tables**, not free text sprinkled through a
  notes field. Near-string duplicate detection catches "1/3 Delusion" before it
  becomes "1/3  delusion ".
- **Photos on every record**, re-encoded by `sharp` and renamed to opaque UUIDs,
  with a detail preview and a gallery lightbox. They are the searchable memory,
  and you can finally answer the sleeve question.
- **Five independent milestones per costume**, each worth **20%** — *Costume
  Ready*, Fullset, *Costest Done*, *Event Done* and *Photoshoot Done*. No flag
  implies another, so owning only the garment is finally a state you can record,
  and completion is the plain count of ticked boxes over five. Each one carries
  a plain-English explanation, shown under its checkbox and again in the preview,
  so a flag is never presented bare.

> **There is no in-process SQLite binding.** Every query is a short-lived
> `spawn('sqlite3', [DB_FILE])` child process fed SQL on stdin, so the
> `sqlite3` **CLI binary must exist in the runtime image**. `better-sqlite3` is
> not used and is not a dependency.

## 4. Why Cosplay CMS

**Because it fits the actual problem, and because it will still run in five
years.**

- **No build step, no bundler, no CDN.** The frontend is one
  `public/index.html` with an inline stylesheet and one inline script. Clone it,
  run it, it works. Nothing to reinstall, nothing to rebuild when a transitive
  dependency publishes a breaking major.
- **No login to get through.** There is no auth surface to forget a password
  for, and nothing between you and the dashboard but the network boundary you
  already control.
- **One file of data.** `data/db/cms.db` plus `data/uploads`. Back it up by
  copying a directory. Move it with a built-in export/import button rather than
  hand-transferring a SQLite file next to an uploads tree.
- **Eight runtime dependencies**, and the ZIP writer is 350 lines of `zlib`
  rather than another package.
- **Validated and escaped on every write.** A malformed request is a `400`, never
  a half-written row. `esc()` is the only way a value reaches a string position.
- **It runs where you already are** — a NAS, a home server, a laptop, a Windows
  desktop — from identical code, so the container and the app can never drift
  into being different products.

## 5. The rest of it

### Running it

```bash
npm install
npm start          # node src/server.js, listens on PORT (default 4001)
npm run dev        # node --watch src/server.js
npm test           # 12 suites, 558 assertions: desktop token, makers, wishlist,
                    # lens expiry, transfer, costume rename, list-head contract,
                    # milestone ladder, brand assets, reference selects,
                    # view-control sync, combo search
```

### Desktop app (Electron)

A second way to run the *same* server code, packaged as a desktop app. The
Express server is not reimplemented: `electron/main.js` sets the environment and
then `require`s `src/server`, so every route, test and database behaves exactly
as it does in the container.

The app serves on **4101** by default (`http://127.0.0.1:4101`), bound to
loopback only. The web and container port is **4001**, and `PORT` overrides
either — it is read the same way in both targets, so nothing here is fixed by
build.

```bash
npm run electron:dev          # run the app against your checkout
npm run electron:build        # unpacked build in dist/ — fastest packaging check
npm run electron:dist         # real installers: AppImage, NSIS, DMG
npm run electron:dist:win     # Windows NSIS installer only
```

What is verified, and what is not, is written down in
[`ELECTRON.md`](ELECTRON.md) rather than guessed at. The short version: the
Windows installer is built, packages correctly, and is **published as
[v1.0.0](https://github.com/rielolita171/cosplay-cms/releases/tag/v1.0.0)**;
the Linux run works, **macOS has never been built**, and there is no AppImage
for Linux yet. The installers are unsigned and there is no auto-updater.

### Download

The Windows installer for the current release:

- [`Cosplay-CMS-Setup-1.0.0.exe`](https://github.com/rielolita171/cosplay-cms/releases/download/v1.0.0/Cosplay-CMS-Setup-1.0.0.exe) — 84 MB, unsigned (expect a SmartScreen warning on first run)

The **1.1.0 desktop build is in preparation** and has no download yet. What it
changes — including a fix that retroactively secures the two already-published
v1.0.0 installers — is in "Release notes" below; there is deliberately no
`1.1.0` download link here rather than a dead one.

`latest.yml` is published alongside it for a future `electron-updater` feed.
No auto-updater is wired into the app yet, so nothing will update itself.

> **Only the desktop app's own window can read the collection.** Two independent
> layers, because either alone leaves a gap. First, an **origin allowlist** — only
> the app's own serving origin is accepted, so no web page you visit in any browser
> can read or change anything; there is no login, so this is the boundary.
> Second, a **per-launch 256-bit token** generated by the Electron process and
> handed to its window through a preload bridge — without it, *any* browser can load
> the app, since typing the URL is a navigation that carries no `Origin` header and
> so was never subject to CORS at all. A browser pointed at the desktop server gets
> an empty shell and `403` on every request that returns data.
>
> This stops websites, the address bar, and other software on the machine. It does
> **not** stop you: you can read the database file directly. Non-browser callers
> (`curl`, the n8n workflow) are unaffected, and **Docker and `npm start` are
> completely unchanged** — the token is desktop-only. Sections 5 and 6 of
> [`ELECTRON.md`](ELECTRON.md) cover both, including the `CMS_ALLOW_ANY_ORIGIN=1`
> escape hatch (off by default, desktop-only).
>
> Both layers are only genuinely live **as of v1.1.0**: the token guard never
> activated in the two published v1.0.0 installers. See "Release notes" below.

### Moving a collection

**Settings → Move this collection** exports everything into one `.zip` — every
costume, prop, lens, maker, brand, fandom and image — and imports it on the other
machine. Use it to move between the desktop app and a self-hosted server in either
direction, instead of hand-copying a SQLite file next to a directory of uploads.

- **Export** needs no confirmation and changes nothing.
- **Import** replaces the data on the target, so it shows you what the archive
  contains first, asks you to confirm, and takes a backup of the current database
  before it writes anything. `merge` is available if you would rather keep what is
  already there.

The database travels as a SQL dump rather than a copy of `cms.db`, so it does not
carry a stale journal or a half-written page, and the import is atomic across
tables.

**The origin allowlist is host configuration and does not travel.** It names a
hostname and a port — true of the machine that wrote it and of no other — so it is
reconciled per direction:

| Direction | What happens |
|---|---|
| **self-hosted → desktop** | The incoming origins are **discarded**. They would be rules about a network this laptop is not on, and the desktop build enforces its own serving origin. |
| **desktop → self-hosted** | The **target server's own rules are preserved exactly**, and only `localhost` / `127.0.0.1` for that server's own port are added — and only if its list does not already permit them. |

Nothing is ever removed from the target's list, so your LAN or domain origins
survive a migration.


### Configuration

Configuration is read from `.env` at the repository root. The names that
matter are `PORT`, `NODE_ENV`, `DATABASE_PATH`, `CMS_DATA_DIR`,
`CMS_UPLOAD_DIR`, `API_KEY`, `CORS_ORIGIN` and `TELEGRAM_BOT_TOKEN`. **Their
values live in `.env` and must never be copied into this file, into a commit, or
into a ticket** — refer to them by name, as done here.

`CMS_DATA_DIR` and `CMS_UPLOAD_DIR` are the opt-in path overrides, read by
[`src/services/paths.js`](src/services/paths.js). They exist for the desktop
build, which cannot use `__dirname` because that resolves inside the read-only
`app.asar` archive. Every fallback is byte-for-byte the path the old hardcoded
literals produced, so leaving both unset changes nothing about `npm start` or
`docker compose up`.

`API_KEY` is the only credential the app still has, and **it is not a login.**
It guards exactly one thing: the three `/api/notifications/*` endpoints that
n8n calls server-to-server (`X-CMS-API-KEY`). It does not protect the CMS data
routes — those are open.

There is no `JWT_SECRET` and no `SESSION_SECRET` any more. The app has no login,
so there is no token to sign. A `JWT_SECRET` line left in an existing `.env` is
simply ignored; you can delete it.

> **The database variable is `DATABASE_PATH`, not `DATABASE_URL`.** `.env` does
> set `DATABASE_URL`, and several documents in this repository mention it, but
> **no code reads it** — the name is honoured nowhere and silently does
> nothing. Setting it does *not* move the database. See the `DATABASE_URL` entry
> under "Known issues and deferred fixes" before you trust it.

`data/db/cms.db` is the SQLite database and `data/uploads` is the image store.

> **Do not test uploads against a second/dev instance.** A dev server on
> another port writes into the *same* upload directory as production. Every
> internal path is resolved by [`src/services/paths.js`](src/services/paths.js),
> so you can now separate them — set `CMS_DATA_DIR` and `CMS_UPLOAD_DIR` to a
> scratch directory for the dev run, or simply do not exercise the upload
> endpoints there. Note the `CMS_` prefix is load-bearing: a bare `UPLOAD_DIR`
> is dead config that nothing reads, and this repository's `.env` still carries
> a container value for it. See
> [`ELECTRON.md`](ELECTRON.md#does-this-still-run-outside-electron) for why a
> key already sitting inert in someone's `.env` must not be given a meaning.

---

## Release notes

### What's in v1.1.0

**Not released yet.** No v1.1.0 installer has been built or published, so the
downloadable artifact is still v1.0.0. This is the list of what the release
contains.

**Desktop & security** — read this one first.

- **The token guard was never actually active in the packaged app.**
  `require` caching latched the module before the env var was set, so **both
  published v1.0.0 installers shipped with the guard off.** This release turns it
  on, which retroactively secures the desktop app you may already have
  installed.
- **The desktop app now requires a per-launch token to read data.** 256 bits,
  minted at launch and handed to the renderer only through a preload bridge.
  `/api` and `/uploads` answer `403 DESKTOP_TOKEN_REQUIRED` without it.
  Previously anyone could open `http://127.0.0.1:4101` in a browser, because a
  top-level navigation sends no `Origin` and so CORS never applied. `GET /` and
  `/health` stay open on purpose. Inert outside the desktop build.
- **The desktop build now enforces its CORS allowlist** instead of accepting
  every origin, including the opaque `null` that `file://`, `data:` and a
  sandboxed iframe all send, on an API with no auth.
- **The CORS allowlist editor is hidden in the desktop build only** — there is no
  cross-origin caller to allow in a single-window app. Docker and `npm start`
  keep the editor. Importing into a desktop build now discards an incoming
  allowlist, keyed on which build the target is, and the reason string became
  `desktop-allowlist-reset`.
- **A new Settings panel, "How this install is protected"**, where every badge is
  read from a value the server just sent (`isDesktopTarget`, `tokenGuardActive`,
  `corsDisabled`) rather than prose that went stale.

**Milestones**

- **Five independent checkboxes, each worth 20%** — *Costume Ready*, Fullset,
  *Costest Done*, *Event Done*, *Photoshoot Done*. Completion is the plain count
  of ticked flags over five, and no flag implies another. Completion used to be a
  hardcoded `/4` over four booleans starting at Fullset, so owning only the
  garment had no way to be recorded at all.
- **Each milestone carries a plain-English explanation**, under its checkbox and
  again in the preview.
- **Rows created before the new column now read 80% and are deliberately not
  backfilled.** Their real state is unknown to the code, and guessing it would be
  worse than an honest number.

**Costumes**

- **Costume names are editable.** The Edit Costume modal has a required
  `character` field prefilled from the stored row, and `PUT /api/costumes/:id`
  validates it exactly like `POST`. A typo used to mean delete-and-re-add, which
  threw away the images, prices and milestones along with the row.
- **A costume detail/preview modal** — click a costume name for a read-only
  preview: large cover photo, thumbnail strip with a position counter, property
  table, previous/next navigation, and the edit and delete actions. Reachable
  from card view and from list view.

**Finding things**

- **A Size filter**, exact match, ordered XS→3XL rather than alphabetically.
- **Brand and Fandom are searchable comboboxes** — substring filtering, an
  explicit no-results message, full keyboard support (arrows, Enter, Escape, Tab,
  Home, End, wrap-around), truthful `aria-expanded` / `aria-activedescendant`,
  and selection bound on `pointerdown` so a click cannot be lost to a re-render.
  The native `<select>` was replaced because Chrome on Windows hands its popup
  to the OS and ignores `option` padding.
- **"Reference Lists" is a real button** beside the field, instead of an
  `<option>` appended below all 24 fandoms.
- **The View (cards/list) control stays in sync when you switch tabs.** It used
  to say "List view" while the grid was drawn as cards.
- **The costume list header renders as a horizontal row again** — the element
  carried `costume-row-head` while the CSS styled `costume-row-list-head`, a
  class nothing emits, so it matched no rule and stacked vertically.

**Branding**

- **Real branding, from one hand-edited `assets/favicon.svg`.**
  `scripts/build_icons.js` derives the PNG ladder (16–512) and a multi-frame
  `favicon.ico` and copies them into `public/assets/`. The site gets
  `mark.svg`, `logo-dark.svg`, `logo-light.svg` and a 1200×630
  `og-image.png`. The Electron window, taskbar and Alt-Tab entry now show the
  icon instead of the generic Electron one.

**Verification.** `npm test` — 12 suites, 558 assertions, 0 failures: desktop
token (11), makers (85), wishlist (59), lens expiry (44), transfer (62), costume
rename (26), list-head contract (14), milestone ladder (67), brand assets (59),
reference selects (41), view-control sync (22), combo search (68).

## Security model

The warning at the top of this file is the short version. In detail: the
authentication system was **removed**, not disabled — the entire `/api/auth/*`
surface is gone and returns `404`, along with the `User` account columns, the
`RefreshToken` / `ConsumedToken` / `PasswordResetToken` tables, the
`viewer`/`user`/`curator`/`admin` ladder, the Telegram 2FA gate, the Users tab
and the login screen. The frontend boots straight into the dashboard.

Confirm both facts on a running instance:

```bash
curl -s http://localhost:4001/api/version | grep -A2 authentication
# "required": false, "scheme": "none"

curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:4001/api/auth/login
# 404 — gone, not merely disabled
```

### What is still enforced

Being unauthenticated is not the same as undefended. What remains:

- **Input validation on every write.** Length caps, type checks, and enum
  allowlists run before any SQL is built, so a malformed request is a `400` and
  never a partial row. See `src/services/sqlSafety.js`.
- **SQL escaping on every interpolated value.** All string-literal positions go
  through a single `esc()` helper; every query is parameter-shaped rather than
  concatenation-shaped.
- **Rate limiting** on `/api` (`src/middleware/rateLimit.js`) plus a tighter
  limiter on the CORS settings writes.
- **API key on the notification endpoints.** `/api/notifications/*` requires
  `X-CMS-API-KEY`; it fails closed (403) if `API_KEY` is unset.
- **Helmet, CORS, and `express.static` hardening** in
  [`src/server.js`](src/server.js).
- **Uploads are still image-processed and renamed** by `sharp` via
  `src/middleware/imageUpload.js` / `imageProcessor.js`.
- **`DELETE /api/images/discard` only ever deletes an unreferenced file.** It
  exists so a photo uploaded into an Edit dialog and then abandoned does not
  linger forever, and it checks `Costume`, `Prop` and `ContactLens` first: if a
  saved record still points at the file it answers `409` and leaves it alone. It
  also takes only a bare filename — with no authentication, accepting a path here
  would be a delete-any-file primitive.

### What is no longer enforced, and is a real change

- **`/uploads` is world-readable to anyone who can reach the port.** The
  per-image access middleware (`src/middleware/uploadAccess.js`) was deleted
  along with the role system, and `/uploads` is now a bare `express.static`
  mount ([`src/server.js:153`](src/server.js)). In earlier versions a
  viewer-tier account could not fetch an image directly. **This is a genuine
  regression in per-image access control**, accepted as part of removing auth —
  but it is the one to be aware of, because an image URL is now a bearer
  reference with no expiry. (The desktop build is the one case where the blast
  radius is smaller — it binds `127.0.0.1`, enforces its own origin allowlist,
  and since **v1.1.0** requires a per-launch token on `/api` and `/uploads`, so
  a browser pointed at it gets an empty shell and `403` on every request that
  returns data. Note that the two published v1.0.0 installers shipped with that
  guard off; see "Release notes".)
- **Every record is readable and writable by any client on the network.**

### Where the boundary is

The security boundary is the network, not the application. Three workable
options, in descending order of how much you have to remember to do:

1. **Trusted LAN or VPN only.** Bind the port to an interface your untrusted
   devices cannot reach.
2. **An authenticating reverse proxy.** Put Caddy/nginx/Authelia in front and
   let *it* terminate auth. The app keeps no session state, so an
   externally-authenticated proxy drops in cleanly.
3. **An SSH tunnel** for a single operator, leaving the port bound to loopback:
   `ssh -L 4001:127.0.0.1:4001 user@host`.

In Docker, `127.0.0.1:${CMS_PORT:-4001}:4001` in
[`docker-compose.yml`](docker-compose.yml) makes the port invisible to the LAN
and forces the tunnel.

### The Telegram chat id, which is the one thing auth was load-bearing for

Two-factor login is gone, but the **Telegram chat id was deliberately kept** —
it is what the n8n notification workflows send to. It now lives in its own
`TelegramChat` table rather than on the user row, and on an old database it is
migrated once at boot ([`src/services/db.js:197-213`](src/services/db.js:197)).
See "What happens to your Telegram chat id on upgrade" in
[`DOCKER.md`](DOCKER.md) for the verification and repair SQL.

## Publishing this site

The project site is `docs/`, published by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml). Its operational
instructions were repo-internal and have been removed from the published page,
so this section is now their only home.

**One-time setup**, in the repository settings: **Settings → Pages → Build and
deployment → Source: "GitHub Actions"**. Nothing can do this for you — the
workflow grants itself `pages: write` and `id-token: write` and cannot enable the
setting itself.

**Every deploy** is a push to `main` (or `workflow_dispatch` from the Actions
tab). The workflow checks out, configures Pages, verifies the assets, and hands
`docs/` to `actions/upload-pages-artifact` with `path: docs`. **There is no build
step and no dependency install** — `docs/` is already the artifact, so nothing in
it is compiled, bundled or regenerated. The live site is
<https://rielolita171.github.io/cosplay-cms/>.

**Concurrency** is one deploy at a time, and a newer push cancels an in-flight
one:

```yaml
concurrency:
  group: pages
  cancel-in-progress: true
```

### The deploy gate

The only thing standing between a broken commit and a broken public page is an
assertion pass that runs under `set -euo pipefail` and **fails the deploy** if
any of these are missing:

- `docs/assets/screenshots/dashboard.png`
- `docs/assets/screenshots/costumes.png`
- `docs/assets/screenshots/props.png`
- `docs/assets/screenshots/reference-lists.png`
- `docs/assets/mark.svg`
- `docs/assets/logo-dark.svg`
- `docs/assets/logo-light.svg`
- `docs/assets/favicon.svg`
- `docs/assets/og-image.png`

It prints one line per missing file (`Missing screenshot: …` /
`Missing brand asset: …`) and then exits non-zero with:

```
::error::Referenced assets are missing. Run scripts/capture-screenshots.js against a live instance, or update docs/index.html to match the files present.
```

> **The gate is an existence check and nothing more — every test is `if [ ! -f ]`.**
> A stale-but-present screenshot deploys silently and nobody finds out until a
> reader does, so re-shoot them after a UI change rather than trusting the fact
> that the deploy went green.

### Fixing a failed deploy

If the gate fired on a screenshot, re-capture it from a live instance:

```bash
node scripts/capture-screenshots.js            # all four
node scripts/capture-screenshots.js --only costumes.png,props.png
```

`scripts/capture-screenshots.js` starts `src/server.js` itself, drives a real
browser over the DevTools Protocol, and writes into `docs/assets/screenshots/`
by default. Three things about it are worth knowing before you run it:

- **`sqlite3` must be on `PATH`.** The app has no in-process SQLite driver —
  `src/services/db.js` spawns the `sqlite3` CLI once per query — so without it
  every data route 500s, the grids render empty, and there is nothing worth
  capturing. The script refuses to start and says so rather than writing four
  tidy screenshots of nothing.
- **No new dependency.** It finds the already-cached Chrome-for-Testing build
  (then a system Brave/Chromium) and speaks CDP using Node built-ins, rather than
  pulling Puppeteer or Playwright into `npm install` for anyone who clones the
  repo to work on the app itself.
- **It will not kill a server it did not start.** If something is already
  serving this app on the port it errors and leaves it alone; pass
  `--use-running` to adopt that server (it is then never stopped) or `--port` to
  shoot somewhere else. Other flags: `--out <dir>`, `--chrome <path>`,
  `--keep-server`, `--help`.

It also checks its own output: every capture must decode as a 2880×1800 PNG — the
2x of the 1440×900 viewport that `docs/index.html` declares in its `width` /
`height` attributes, so the reserved box stays the right size — and be at least
120 KB. A capture failing either test aborts without touching the existing file.

If the gate fired on a brand asset instead, those come from
`node scripts/build_icons.js`, which derives them from the one hand-edited
`assets/favicon.svg`.

**Both instructions used to be unrunnable.** `docs/index.html` and `pages.yml`
both pointed readers and maintainers at `scripts/capture-screenshots.js`, and
the file did not exist — so the published screenshots froze at whatever the UI
looked like when they were first taken, while the alt text kept describing
features that had changed underneath it. The script exists now, which is what
makes this section actionable.

### Updating the site

The site is [`docs/index.html`](docs/index.html) plus `docs/assets/*`. Edit,
commit, push — the deploy is the next thing that happens.

**Adding a new referenced asset means adding it to the workflow's assertion
list**, or the deploy will not catch its absence and the page will ship with a
silent blank where a missing image should be. Only `docs/` is published — the
root `assets/` directory is not, which is why the brand SVGs have copies in
`docs/assets/`.

## Known issues and deferred fixes

Engineer-facing notes. These are **real, unfixed defects** in the tree right now.
Severities are the honest ones, not the flattering ones: `[low]` means a comment
or a cosmetic value is wrong, and `[open]` means a known gap with no code behind
it at all.

> **Test coverage.** `npm test` runs **twelve suites, 558 assertions**: desktop
> token (11), makers (85), wishlist (59), lens expiry (44), transfer (62), costume
> rename (26), list-head contract (14), milestone ladder (67), brand assets (59),
> reference selects (41), view-control sync (22), combo search (68). The transfer
> suite covers the ZIP container, export, the inspect pre-flight, import in both
> modes, the ZIP-slip guard, the HTTP confirmation gate, and the CORS
> reconciliation in both migration directions. Each of its scenarios runs in its
> own process, because `paths.js` freezes `DB_FILE` at module load and one
> process could not test a desktop import and a server import without the first
> value staying frozen.
>
> **Not covered — and this is a real gap, not a formality.** There is no browser
> in CI and no headless one on this host, so the three UI fixes are verified only
> statically: the inline script parses, every `getElementById` target exists, and
> `DELETE /api/images/discard` was exercised over HTTP (200 for an orphan, 409 for
> a referenced file, traversal contained). **Not** verified: that the new
> Settings panel renders, that the progress bar actually paints above a dialog
> (a `showModal()` dialog lives in the browser's top layer, which outranks every
> z-index — that is *why* the bar is a popover now), and that opening a dialog no
> longer moves the page. Someone should click through all three once.

### `[low]` The z-index comment on the boot splash is wrong

- **Symptom.** None. This is a comment that misdescribes the code beneath it.
- **Mechanism.** [`public/index.html:792`](public/index.html:792) says the boot
  overlay is "the SAME `#loading-overlay` element (the same z-index and
  spinner)". The z-index is not the same: it is `9997` at
  [`public/index.html:799`](public/index.html:799) against the base overlay's
  `9998` at [`public/index.html:842`](public/index.html:842).
- **Blast radius.** Effectively zero. Only the toast at
  `z-index: 9999` outranks the boot splash, which is the correct ordering.
- **Fix.** Correct the comment, or unify the two values and then the comment is
  true. The next person to trust this comment will be wrong.

### `[low]` `z-index: 9997` on the boot splash is redundant

- **Symptom.** None.
- **Mechanism.** As above — 9997 exists only to be a slightly-lower duplicate of
  the base overlay's 9998, and nothing sits between the two values.
- **Fix.** Collapse to a single value; the distinction was never load-bearing.

### `[open]` Uploads are not garbage-collected, and the old config key still exists

- **Symptom.** Nothing ever deletes an uploaded image that is no longer
  referenced, so the store grows without bound.
- **Mechanism.** There is no GC pass anywhere. Because `/uploads` is a bare
  `express.static` mount
  ([`src/server.js:153`](src/server.js)), an image URL is also a permanent
  bearer reference with no expiry.
- **Partly resolved since this was first written.** The five hardcoded
  `path.join(__dirname, '../../data/uploads')` call sites are gone; they all
  resolve from [`src/services/paths.js`](src/services/paths.js) now, and the
  desktop build points them at its own `userData` directory. So *per-instance*
  isolation is achievable today with `CMS_UPLOAD_DIR` — it is just not applied
  to the dev-vs-production case above.
- **Still wrong.** A bare `UPLOAD_DIR` remains **dead config** that no code
  reads, yet it is still set in [`.env`](.env) and named in
  [`.env.example`](.env.example). It is not harmless-looking: it holds a
  container path, and a future edit that starts reading the bare name would
  break every non-Electron start. Either delete it from the docs and this
  `.env`, or leave it with a comment saying it is inert.
- **Also unverified.** Two files in `data/uploads` (mtimes 16:35:04 and 16:43:24)
  are of **unconfirmed reference status**. An earlier session quarantined two
  *confirmed* orphans, but whether these two are still referenced by any
  `Costume` row has not been checked. Do not delete them on the strength of this
  note.
- **Fix.** Decide `UPLOAD_DIR`'s fate, then add a scheduled pass that deletes
  unreferenced files. Both halves belong together: the store already relocates
  cleanly, so without GC an isolated directory just relocates the unbounded
  growth.

### `[open]` The Windows installer is released, but macOS has never been built

- **Status.** The Windows installer is built, packages correctly, and is
  **published as
  [v1.0.0](https://github.com/rielolita171/cosplay-cms/releases/tag/v1.0.0)**. The
  new modules are inside `app.asar` and the bundled `sqlite3.exe` has the
  Windows `MZ` header. Exactly one sharp package ships, `@img/sharp-win32-x64`,
  and it carries its own libvips: the `sharp-win32-x64.node` binding and the
  `libvips-42.dll` / `libvips-cpp.dll` pair all sit inside its `lib/`. No
  separate `@img/sharp-libvips-*` package is shipped, and no `*sharp-linux*`
  or `*sharp-darwin*` files ship at all — so nothing platform-mismatched is
  dead weight in the package. Verified against the built artifact, not
  inferred from a directory listing. Full detail in
  [`ELECTRON.md`](ELECTRON.md).
- **Not verified.** macOS has never been built or run at all — `PRECOMPILED.mac`
  points at the x64 SQLite build, so Apple Silicon would need Rosetta 2. Linux has
  an AppImage target configured but no AppImage has been produced.
- **Operational hazards while it holds.** Installers are **unsigned**, so
  SmartScreen warns on first run, and there is **no auto-updater**. **Resolved:**
  the icons were unset and builds used the default Electron icon; v1.1.0 derives
  a real icon set from `assets/favicon.svg` via `scripts/build_icons.js` (see
  "Release notes"). Still true of the downloadable v1.0.0 installer.
- **The published v1.0.0 installers shipped with the desktop token guard
  inactive** (`require` caching latched the module before the env var was set).
  Fixed in v1.1.0 — see "Release notes". Nothing about the packaging is wrong
  here; this is a code-level defect, and it is the most important line in the
  v1.1.0 release notes.
- **A desktop install does not see the Docker database.** Everything writable
  lives under Electron's `userData`, which is a *different* database and upload
  store from the container's Docker volume. They share nothing in either
  direction. **Settings → Move this collection** is the supported way to get
  data across: export on one side, import on the other. It carries every table
  and every image, takes a backup first, and handles the origin allowlist per
  direction — discarded when the target is a desktop app, and the target
  server's own rules preserved when it is self-hosted.
- **Fix.** Build and run a macOS DMG on a real Mac, run the installer once
  natively on Windows, and add code signing plus an `app-builder` update feed.
  The `latest.yml` shipped with v1.0.0 makes that feed possible, but no
  auto-updater is wired into the app yet.

### `[open]` No regression test covers the boot splash

- **Symptom.** The boot-splash behaviour has no automated proof and can silently
  regress.
- **Mechanism.** No test script asserts on the splash. There is also no headless
  browser available on this host — `node_modules/@puppeteer/` is present but
  empty — so nothing in the toolchain can assert on first-paint behaviour. The
  only automated check that exists is a static parse of the single inline
  `<script>` block, which proves the script is syntactically valid but says
  nothing about what it paints.
- **Fix.** Install a real headless browser, or add a jsdom-level test that
  asserts the splash is `display: none` after load and that the retry block is
  hidden on a successful boot. Until then, treat the boot splash as
  manually-verified-only and say so in release notes.

### `[open]` No process supervisor outside Docker

- **Symptom.** A bare-metal `npm start` does not come back after a crash or a
  reboot, and a restart means finding the PID by hand.
- **Mechanism.** There is no systemd unit and no `pm2` in this repository. A
  bare `node` process gets nothing: it dies with the shell that started it.
- **Not a gap in the container deployment.**
  [`docker-compose.yml`](docker-compose.yml) sets `restart: unless-stopped`,
  which already covers crash-restart and reboot for the supported deployment —
  adding a host supervisor on top of that would just put two things fighting
  over the same port.
- **Operational hazard while it holds no supervisor.** A restart must be a manual
  `kill -TERM <explicit PID>`. **Never** `pkill -f "src/server.js"` — that
  pattern matches a dev server on `:4139` as well as anything on `:4001` and
  takes both down. Read `/proc/<pid>/cwd` to confirm which process you are about
  to signal.
- **Fix.** If you deploy bare metal, write a unit with `Restart=on-failure` and
  an explicit `WorkingDirectory`. Note that systemd does not read a shell
  profile, so `ExecStart` needs an absolute `node` path or an nvm install will
  fail with `203/EXEC`.

### `[open]` The Docker build is automated but unproven against a real deployment

- **Status.** [`.github/workflows/docker.yml`](.github/workflows/docker.yml)
  builds the image on every change that could affect it, then **runs** it and
  asserts a data route, the `sqlite3` driver, `sharp` at require time, a
  non-root uid, a writable data dir, and a clean SIGTERM shutdown.
- **Why a data route and not just `/health`.** `/health` returns 200 without
  touching the database, so a green healthcheck does not prove the `sqlite3`
  driver or the schema work. The worst failure mode for this image is one that
  boots healthy and then 500s everywhere, and the smoke test hits
  `/api/costumes` for exactly that reason.
- **The image itself is now built and run locally.** A 292 MB image builds, the
  container reaches `Up (healthy)`, `/health` and `/api/costumes` return 200, it
  runs as `uid=1000(node)`, and `docker stop` drains and exits 0. The export /
  import round trip and the image-discard endpoint were exercised inside the
  container, including the 409 refusal for a referenced image and a contained
  path-traversal attempt.
- **Still unproven in CI.** The workflow has never run — and the local build is
  not a substitute for it, because a developer machine has a warm Docker cache
  and a different base-image pull. Until it passes on `main`, treat CI as the
  first independent evidence the image builds from a clean checkout.
- **Also unverified by CI.** [`docker-compose.yml`](docker-compose.yml) itself is
  never started by the workflow, only the image it builds. The volume layout and
  host-port remapping are still documented rather than demonstrated, and the run
  above used a plain `docker run` with no volume at all.

## Next

The order I would take the items above in, bundled by what each group unblocks
rather than by severity. None of it is committed work.

**1. Garbage-collect uploads.** This is the only remaining item that can lose
or corrupt someone's data, so it goes first. Two of the three halves are now
done: everything resolves from `src/services/paths.js`, so an instance can be
pointed at its own root, and `DELETE /api/images/discard` cleans up the
*predictable* orphan — a photo uploaded into a dialog and then abandoned. What is
still missing is a scheduled pass for everything else: a file that became
unreferenced by a deleted row, a failed write, or a crash between upload and
save. Add it while deciding `UPLOAD_DIR`'s fate.

**2. Get a browser into the loop.** This is now the biggest gap, and it is
bigger than it was: there is no headless browser on this host, so the boot
splash has no regression test, and the three UI fixes from the last change —
the new Settings panel, the popover progress bar, the scroll-preserving modal —
have never been rendered. Install one (Playwright or Puppeteer) and the first
test should assert the splash is `display: none` after load, since that is the
oldest unproven thing in the file.

**3. Get the first green CI run, then exercise compose.** The workflow builds and
runs the image, but it has never executed — so the first run is the first real
evidence any of this works, and it is worth watching rather than ignoring. After
it passes, bring [`docker-compose.yml`](docker-compose.yml) itself under test
too: the workflow runs the image directly, so the volume layout and the
`127.0.0.1` port remap remain configured but unexercised. Do this last: it is the
item that pays off most when the code behind it has stopped moving.

**Deliberately not planned.** No authentication, no roles, no multi-user. The
boundary is the network or a reverse proxy, and the cheapest correct answer to
"who can reach this" is still an authenticating proxy in front. Adding auth
back into an app that works on a private LAN would be solving a problem this
deployment does not have.

## Further reading

This file covers the application. The other two deployment targets are
documented separately:

- [`DOCKER.md`](DOCKER.md) — the container deployment and operations reference.
  This is the primary target.
- [`ELECTRON.md`](ELECTRON.md) — the desktop build: what the main process
  supplies, where the data lives, the packaging gotchas, and what has and has
  not been verified per platform.
- [`docker-compose.yml`](docker-compose.yml) — the deployment of record.
- [`workflows/n8n_contact_lens_expiry_alert.json`](workflows/n8n_contact_lens_expiry_alert.json)
  — the inbound n8n workflow that drives the lens-expiry alerts.
- [`docs/`](docs) — the GitHub Pages profile site, published from this repository.

## License

ISC, as declared in [`package.json`](package.json). The full text is in
[`LICENSE`](LICENSE).

## Security note

Nothing in this repository should ever contain a real API key, bot token or
Telegram chat id — not in this file, not in DOCKER.md, not in an example
that was "copied from a running system". Live values belong in `.env` (reference
them by name) and, for the chat id, in the `TelegramChat` table. Committing a
credential is the mistake this file exists to help avoid.

There are no longer any passwords, password hashes or TOTP seeds in the schema
at all, so the class of leak this file was originally guarding against no longer
applies to the account tables. `API_KEY` and `TELEGRAM_BOT_TOKEN` are what
remain worth protecting.
