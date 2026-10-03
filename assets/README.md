# Brand assets — canonical source

These are the **source** files. The site does **not** publish this folder: the
Pages workflow uploads `docs/` only (see `.github/workflows/pages.yml`), so
anything here is unreachable from the live site.

| Source file | Used by | Published as |
|---|---|---|
| `cosplay-cms-icon-light.svg` | site nav mark | `docs/assets/mark.svg` |
| `cosplay-cms-logo-dark.svg` | wordmark for dark backgrounds | `docs/assets/logo-dark.svg` |
| `cosplay-cms-logo-light.svg` | wordmark for light backgrounds | `docs/assets/logo-light.svg` |
| `cosplay-cms-full-logo-dark.png` | share card (white wordmark) | `docs/assets/og-image.png` |
| `cosplay-cms-full-logo-light.png` | not currently used | — |
| `cosplay-cms-icon-dark.png` | source for the favicon | `docs/assets/favicon.svg` |

## The favicon set

`favicon.svg` is the **only hand-edited icon file**. Everything else is derived
from it by `scripts/build_icons.js`:

| Source file | Published as | Consumer |
|---|---|---|
| `favicon.svg` | `public/assets/favicon.svg` | Chrome / Edge / Firefox |
| `favicon.ico` | `public/assets/favicon.ico` | Windows shell, older Safari |
| `favicon-{16,32,48,64}.png` | same names in `public/assets/` | browsers that take neither SVG nor ICO |
| `favicon-180.png` | same name | iOS home screen (`apple-touch-icon`) |
| `favicon-256.png` | same name | `sizes="any"` fallback |
| `favicon-512.png` | same name | the Electron window / taskbar icon |

Regenerate the whole set — source and published copies — with:

```sh
node scripts/build_icons.js
```

Two things that bit us and are now asserted by `scripts/test_brand_assets.js`:

- **A `.ico` must be a real ICO.** A previous hand-exported `favicon.ico` was a
  PNG with the extension renamed. Some consumers accept that; the Windows shell
  and older Safari do not, and they fail *silently* by showing the default globe
  icon. `file` and the extension both lie — only the magic bytes tell the truth.
- **The `.ico` stops at 64×64.** A 256px frame is stored uncompressed and took the
  file from 34KB to **172KB** for a size no favicon consumer ever samples.

## The app's own copies: `public/assets/`

The running server mounts **only** `public/` (`express.static(PUBLIC_DIR)` in
`src/server.js`). The root `assets/` folder is therefore unreachable from the
app — a header `<img src="../../assets/...">` renders fine on the Pages site and
404s in the app. The app needs its own copy:

| App file | Source | Used by |
|---|---|---|
| `public/assets/mark.svg` | mascot from `cosplay-cms-logo-dark.svg` | app header |
| `public/assets/favicon*` | the favicon set above, copied verbatim | the app's tab, iOS, Electron |

`public/assets/mark.svg` is **derived, not copied**: the mascot is lifted out of
the dark wordmark onto its own square `viewBox` with the wordmark removed,
because the header already sets the product name in HTML text and a 320x70
canvas beside it would be mostly empty. It uses the **dark-background accents**
(`#38BDF8`, `#FBBF24`), not the muted light-background ones, which wash out
against the app's `#0f1117` background.

`assets/favicon.svg` is **also** not a copy. The version in
`docs/assets/favicon.svg` uses `viewBox="13 4 56 56"`, which frames the artwork
with no margin — as a tab icon that clips both ears and shaves the hem, and at
16px the result is unrecognisable. The canonical one is redrawn on a padded
68×68 square so the silhouette survives being scaled to a tab.

`public/assets/` holds **copies, not symlinks**, because the Pages artifact and
the Electron asar must each be self-contained. `scripts/build_icons.js` writes
both the source and the published copies, and `scripts/test_brand_assets.js`
asserts they are still byte-identical — a stale published icon is invisible,
because the page loads perfectly and simply shows yesterday's artwork.

`scripts/test_brand_assets.js` also asserts every icon the page references
exists at the size it claims. A missing one fails **silently** in the browser — a
404 favicon just renders as the default globe — so it needs an assertion rather
than a look.

## The `-dark` / `-light` suffix

It describes **the background the wordmark sits on**, not the artwork:

- `-dark` = **white** wordmark, for dark backgrounds
- `-light` = **navy** wordmark, for light backgrounds

The mascot mark itself is identical in both — only the wordmark changes. So
`cosplay-cms-icon-dark.png` and `cosplay-cms-icon-light.svg` are the same
picture, and the suffix on the *icon* carries no meaning.

## If you regenerate these

`docs/assets/` holds **copies**, not symlinks, because the Pages artifact must be
self-contained. After changing anything here, re-copy the four files above into
`docs/assets/` or the live site will keep serving the old artwork. The deploy
workflow asserts the files exist, but it cannot tell they are *current*.
