# WP2: testimonial ASCII art generator and Sanity Function

Status: **done**. The TypeScript generator reproduces the Django output **byte for byte** for all
9 testimonial photos when it runs through the real Sanity CDN. The `testimonial-ascii-art`
Function is deployed and was verified live on `staging`. No errors appear in its logs.

## What was built

| Path | Purpose |
| --- | --- |
| `studio/functions/testimonial-ascii-art/generate.ts` | The generator. It is an exact port of `ascii-magic==2.3.0` `to_html(columns=35)` and of lxml's pretty print, with the Sanity CDN helper. The migration imports it too. |
| `studio/functions/testimonial-ascii-art/pillow-resample.ts` | An exact port of Pillow's bicubic `Image.resize` for RGB (Pillow 13.0.0, `src/libImaging/Resample.c`). |
| `studio/functions/testimonial-ascii-art/trigger.ts` | The event filter, the projection and `planAsciiArtUpdate`, which makes the same decision as the filter. |
| `studio/functions/testimonial-ascii-art/index.ts` | The Function handler. |
| `studio/sanity.blueprint.ts` | The Blueprint, Stack `cjoshmartin-functions` (`ST-jc4gwa3c4t`), project `j3vdh6ti`. |
| `studio/functions/testimonial-ascii-art/test/` | 65 `node:test` tests. Their expected values come from the real Python libraries (`fixtures/make_fixtures.py`). |
| `studio/functions/testimonial-ascii-art/scripts/compare-with-python.ts` | The real-pipeline comparison. It writes `ascii-comparison.html`. |
| `studio/functions/testimonial-ascii-art/scripts/live-check.ts` | An end-to-end check of the deployed Function on a dataset. |
| `docs/sanity-migration/reports/ascii-comparison.html` | Old and new side by side for all 9 photos, with the metrics. |

The function has its own `package.json`. Its dependencies are `pngjs`, `@sanity/client` and
`@sanity/functions`, and the dev tools are `tsx`, `typescript`, `groq-js` and the types. It uses
no native modules. The `studio/package.json` file was not changed.

## The algorithm, as verified

These facts were checked against the source and against the Python libraries themselves.
ascii-magic was taken from a fresh `pip download` (wheel sha256 `c17d562b…6fc6`). Pillow 13.0.0
and lxml 5.1.0 were used, the same lxml pin as the backend.

- **Brightness floor:** `8 + p * 247 // 255` per channel. It is applied to the full-resolution
  image before the resize, as Django did.
- **Grid size:** `scalar = w * 2.2 / 35`, `cols = int(w * 2.2 / scalar)`,
  `rows = int(h / scalar)`. The same float operations run in the same order. Float rounding
  makes some widths give **34** columns, and the port reproduces that. It matches Python on
  6,900 cases.
- **Resize:** Pillow's default filter is BICUBIC (a = −0.5, support 2, scaled by the factor). It
  uses 22-bit fixed-point coefficients and rounds to 8 bits after each pass. Pillow 13 chooses
  the pass order itself: vertical first when the height shrinks more than twice as much as the
  width. The port is byte-identical to Pillow on 9 noise and gradient cases, including
  upscaling, an unchanged axis and the vertical-first order.
- **Brightness:** Pillow's `L` conversion `(r*19595 + g*38470 + b*7471 + 0x8000) >> 16` was
  checked against Pillow for all 2^24 colors (0 mismatches).
- **Character:** `CHARS_BY_DENSITY[int(L/255 * 93)]`. The ramp has 94 characters, and `)`
  appears twice. After the floor, the darkest character is `` ` ``, never a blank.
- **Color:** `#%02x%02x%02x` of `int(((v/255) ** 2.2) * 200 + 55)` per channel. It matches
  Python for all 256 values.
- **Markup:** ascii-magic joins `<span style="color: #rrggbb">c</span>` cells and puts `<br />`
  between rows. `lxml.html.fromstring` then wraps them in a `<span>`, and pretty print writes
  `<span>\n`, one child per line indented by two spaces, `<br/>` and `</span>\n`. It escapes
  `& < >` but not quotes or backslashes. The edge cases match lxml: a 1×1 grid gives the bare
  span, and a zero-row grid gives `""`, because lxml raises "Document is empty" and the
  serializer returned `""`.

A local Python run of the exact serializer code was compared with the live API HTML
(`live-api-snapshot/page-3.json`) for all 9 photos, and the two are byte-identical. The test
fixtures are therefore the real production output.

## Deviation from the plan: the CDN does not do the resize

The plan (§8) and the brief asked for a PNG at the grid size from the image CDN
(`?w=35&h=15&fit=scale&fm=png`). That approach was built and measured first, and it **failed
the thresholds for 5 of 9 photos**. The CDN's resampler is not Pillow's bicubic filter. On the
800 px photos it is closest to Pillow's Lanczos filter, and it is further off on the smaller
ones.

Measurements showed that the CDN's full-size PNG (`?fm=png`, no resize) decodes to exactly the
pixels Pillow decodes (MAE 0, max 0 for all 9 JPEGs). The final pipeline therefore asks the CDN
for the **whole image as a lossless PNG** and does the floor, the Pillow resize and the
rendering in JavaScript. The result is byte-identical. Sources whose longer edge is over
2048 px are first scaled down by the CDN (`w` or `h=2048&fit=max&fm=png`), and the exact
Pillow resize runs from there. This keeps the PNG at a few MB. The brief allowed this kind of
change ("improve the port (resize params, …) until they pass").

### Comparison metrics (9 testimonial photos, staging, real CDN)

The thresholds are: same grid, at least 90% of characters within ±1 ramp step, and a mean
per-channel color difference below 20. Color Δ is measured on the emitted `#rrggbb` values.
Pixel MAE compares the scaled pixels after the floor with Pillow's.

**Final pipeline:**

| ID | File | Source | Grid (old / new) | Exact chars | Within ±1 | Mean color Δ | Pixel MAE | Identical HTML | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 9 | Andy.jpg | 800×800 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 1 | austin.jpeg | 800×800 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 2 | 1642111059064.jpeg | 400×400 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 8 | 1727629759865.jpeg | 389×389 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 3 | 1610406382478.jpeg | 800×800 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 4 | 1560116632711.jpeg | 500×500 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 5 | 1516545766532.jpeg | 347×347 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 7 | 1621401722554.jpeg | 259×259 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |
| 6 | 1576182293557.jpeg | 500×500 | 35x15 / 35x15 | 100.0% | 100.0% | 0.00 | 0.00 | yes | pass |

**Rejected first approach** (the CDN scales straight to the grid):

| ID | File | Exact chars | Within ±1 | Mean color Δ | Pixel MAE | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 9 | Andy.jpg | 55.2% | 94.3% | 0.50 | 1.37 | pass |
| 1 | austin.jpeg | 60.0% | 94.5% | 1.56 | 1.36 | pass |
| 2 | 1642111059064.jpeg | 61.7% | 93.1% | 0.99 | 1.33 | pass |
| 8 | 1727629759865.jpeg | 50.5% | 67.4% | 1.93 | 4.31 | FAIL |
| 3 | 1610406382478.jpeg | 52.2% | 93.9% | 1.28 | 1.63 | pass |
| 4 | 1560116632711.jpeg | 32.8% | 64.2% | 2.62 | 4.67 | FAIL |
| 5 | 1516545766532.jpeg | 45.7% | 69.5% | 3.32 | 3.83 | FAIL |
| 7 | 1621401722554.jpeg | 29.7% | 58.3% | 4.36 | 5.15 | FAIL |
| 6 | 1576182293557.jpeg | 27.6% | 63.0% | 3.23 | 4.12 | FAIL |

The side-by-side images are in [`ascii-comparison.html`](ascii-comparison.html). Its cards show
the original photo, the old art, the new art and the rejected variant.

### Other image types (future uploads)

Six large originals from the bucket were also uploaded to `staging` and checked. They are real
content files, and their sha1 matches Wagtail's `file_hash`. They cover iPhone Display P3
JPEGs, an EXIF-rotated photo, an MPO and an RGBA PNG. "Reference" is the Python output; for the
EXIF-rotated photo it is the Python output of the upright image.

| File | Size | Source used | Reference | Grid | Exact chars | Within ±1 | Mean color Δ | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| IMG_9344.jpeg (P3, MPO) | 4032x3024 | CDN pre-scaled to 2048 | as is | 35x11 / 35x11 | 81.3% | 98.7% | 1.19 | 2.9 s |
| IMG_0070.jpeg (P3, EXIF 6) | 3024x4032 | CDN pre-scaled to 2048 | upright | 35x21 / 35x21 | 81.6% | 94.4% | 0.96 | 2.2 s |
| IMG_9932.JPG (P3) | 2075x3128 | CDN pre-scaled to 2048 | as is | 35x23 / 35x23 | 78.4% | 99.4% | 1.61 | 3.1 s |
| nextme-waitlist-app-1.png (RGBA) | 3200x3200 | CDN pre-scaled to 2048 | as is | 35x15 / 35x15 | 97.9% | 100.0% | 0.06 | 1.7 s |
| mastars-…-unsplash.jpg (sRGB) | 3680x2128 | CDN pre-scaled to 2048 | as is | 35x9 / 35x9 | 94.3% | 100.0% | 0.22 | 1.9 s |
| IMG_3736.jpg (P3) | 4032x3024 | CDN pre-scaled to 2048 | as is | 35x11 / 35x11 | 90.1% | 100.0% | 0.85 | 2.3 s |

These images still differ from Pillow for three reasons, all known and accepted:

- **Large images are pre-scaled.** At full size, the sRGB JPEG and the PNG above were
  byte-identical too. Full size was measured but not adopted, because a 4032×3024 PNG is about
  17 MB and took 3 to 7 s to fetch.
- **Non-sRGB ICC profiles (Display P3) are converted to sRGB by the CDN.** Pillow ignored ICC
  profiles. `cs=origin` was tested and makes no difference for PNG output. The new colors are
  the more accurate ones.
- **EXIF orientation is applied by the CDN.** Pillow ignored it, so the old site would have
  shown such photos sideways. Asset ids and asset metadata carry the oriented dimensions, which
  was checked with a probe upload (deleted afterwards).

None of the 9 current testimonial photos has an ICC profile or an EXIF orientation, and all are
at most 800 px. All other inputs, including PNGs, palette images and grayscale images, decode
identically: pngjs expands them like Pillow's `convert("RGB")` and drops alpha.

## The Function

- **Events:** `create` and `update`, with `includeDrafts: true`. With the default (`false`), only
  changes to published documents trigger. With `true`, draft edits trigger as well, so the
  Studio and the Presentation preview show the new art before publishing. `includeAllVersions`
  stays `false`; publishing a release still updates the published document, and that update
  triggers the Function.
- **Filter** (`TESTIMONIAL_ASCII_ART_FILTER`): `_type == "testimonial"`, dataset in
  `production` or `staging`, and one of two conditions:
  - the image has an asset, and `asciiArtSource` is missing or different, or `asciiArt` is
    missing;
  - the image has no asset, but `asciiArt` or `asciiArtSource` is still set.
- **Projection:** `{_id, _type, "imageAssetId": image.asset._ref, asciiArtSource, "hasAsciiArt": defined(asciiArt)}`.
  The handler never fetches the document.
- **Action:** the handler generates the art and patches `asciiArt` and `asciiArtSource` (the
  asset id). When there is no image, it unsets both fields.
- **Recursion guard:** after its own patch, the document no longer matches the filter. This was
  confirmed with groq-js in the tests and live: each live step caused exactly one invocation.
  If the image changes while art is being generated, the late patch still records which asset
  the art came from. The filter then matches again, and the next run catches up; a test covers
  this. `@sanity/client` adds the lineage header as a second guard.
- **Publishing:** if the art is already on the draft, publishing copies it and nothing runs. If
  the draft is published before the Function patched it, the patch to the deleted draft fails
  with 404. The handler logs this and stops. The published document then matches the filter and
  is fixed. This race was tested live (step 5 below).
- **Errors:** after 3 attempts, transient CDN failures (network errors, 429, 5xx) are thrown, so
  they appear in the logs, and the next edit retriggers the Function. When the CDN answers but
  cannot produce a PNG (an SVG, for example), the handler raises `UnsupportedImageError`. It then
  logs an error and stores `asciiArt: ""` with the asset id, which is what Django returned in
  that case.
- **Limits:** timeout 60 s and memory 1 GB. Live runs take 1 to 3 s.
- **Dry run:** `context.local` (`sanity functions test`) runs the generation but commits the
  patch with `dryRun`.
- **Blueprint location:** the blueprint is at `studio/sanity.blueprint.ts`, as the brief
  specifies. The CLI prints a notice that a Blueprint should not sit inside a Studio directory,
  because its lockfile rule targets pnpm workspaces. Here npm is used and `package-lock.json`
  sits next to the blueprint, so the rule is met. The project and Stack ids are in the file
  itself, through `defineBlueprint({projectId, stackId})`, so `plan` and `deploy` work from any
  checkout. `.sanity/blueprint.config.json` is gitignored by the Studio.

### Deploy

From `studio/`, `npx sanity@latest blueprints plan` showed `+ create testimonial-ascii-art`.
`blueprints deploy` completed with exit code 0. After a formatting-only change, the code was
redeployed, and that deploy also completed. `blueprints info --project-id j3vdh6ti --stack ST-jc4gwa3c4t`
shows the function with the filter and projection above.

### Live test on staging (`scripts/live-check.ts`, run after the final deploy)

1. Creating `testimonial-function-check` with photo `image-5893cbb9…-347x347-jpg`: the art and
   source appeared after 1.7 s and were **byte-identical to the Python HTML**.
2. Changing the image to `image-db2c8671…-500x500-jpg`: the art was regenerated after 1.8 s and
   was byte-identical.
3. Removing the image: `asciiArt` and `asciiArtSource` were unset after 1.6 s.
4. A draft with `image-e1ead7ad…-500x500-jpg`: the draft got its art after 1.7 s, and the
   published document was untouched. After publishing through the Actions API, the published
   art matched and the draft was gone.
5. A draft with `image-f7bf1da6…-800x800-jpg` and stale art, published immediately: the
   published document was fixed after 1.7 s.
6. The scratch document was deleted, both published and draft, and none remains.

The Function logs contain 12 invocations over the two live runs and 0 errors. One expected line
reads `drafts.testimonial-function-check no longer exists … nothing to patch` (the step 5 race).

Local `sanity functions test` runs covered three cases: create, which generated the art; an
update with unchanged art, where the filter skipped the invoke; and an image removal, which
took the clear path.

## Verification commands

```sh
cd studio/functions/testimonial-ascii-art
npm ci && npm test            # 65 tests pass (also passed in a clean copy after npm ci)
npm run typecheck             # tsc passes; studio's own tsc also passes over these files
npx tsx scripts/compare-with-python.ts --dataset staging --originals <dir> \
  --wagtail-export <export.json> --metrics <json> --report ../../../docs/sanity-migration/reports/ascii-comparison.html
npx tsx scripts/live-check.ts --dataset staging   # needs SANITY_PROJECT_ID and SANITY_WRITE_TOKEN
```

`studio/sanity.blueprint.ts` passes the Studio's ESLint, and all files follow the Studio's
Prettier config. No Next.js code was written in this package.

## Data written to Sanity

- **staging:** 15 image assets. Nine are the testimonial photos (`originalFilename` = the GCS
  file name, sha1 = Wagtail `file_hash`). Six are bucket originals used for the robustness
  check: IMG_9344.jpeg, IMG_0070.jpeg, IMG_9932.JPG, nextme-waitlist-app-1.png,
  mastars-CKlMpMn28CA-unsplash.jpg and IMG_3736.jpg, all with matching `file_hash`. Assets are
  content-addressed, so the migration's own uploads of these files reuse them. One EXIF probe
  asset was uploaded and then deleted. No documents remain.
- **production:** nothing.
- **Blueprints:** Stack `cjoshmartin-functions` (`ST-jc4gwa3c4t`), holding one function.
