# Review fixes

One section per review round. The findings and their status are listed in
[wp8-review.md](wp8-review.md). This file says what changed and how each change was verified.

## Round 1 (2026-11-25)

Branch `sanity-migration`. Commits, oldest first:

| Commit | What |
|---|---|
| `d925211` | Close the open redirect in the draft-mode disable route (R1-9) |
| `7f04159` | Guard migration reruns against Studio edits, add the narrow `videos` step, fix tag order, draft redirects, the Squid Games link and the Mux steady state (R1-1, 2, 5, 7, 19) |
| `549e2e8` | Refuse the GCS lockdown until every Wagtail video is on Mux (R1-10) |
| `500a61f` | Never restore another dataset's snapshot unless asked to; document the `secrets.mux` result (R1-14, 16) |
| `1fc4f4a` | Apply the Studio crop to image width and height (R1-13) |
| `a686e36` | Render testimonial ASCII art without injecting HTML (R1-15) |
| `3c4ae1b` | Load the resume's Charter fonts and favicon over HTTPS (R1-3) |
| `e0d3633` | Teach the parity check (`migration/verify`) the three differences the fixes cause on purpose |
| `a28f1cf` | Document how to validate after the `videos` step |
| the commit that adds this file | `wp8-review.md`, this file, and the WP3 report's video follow-up |

### What changed

**Frontend**
- `lib/sameOriginRedirect.ts` (new): `sameOriginRedirect(requested, siteOrigin): URL`. It
  resolves the `redirect` value and returns it only if it has the site's origin; otherwise it
  returns `/`. `app/api/draft-mode/disable/route.ts` uses it with `request.nextUrl.origin`.
- `sanity/lib/imageDimensions.ts` (new): `assetDimensions`, `croppedDimensions(assetRef, crop)`
  and `fitWidth`. `getImageDimensions` and `scaledDimensions` in `sanity/lib/image.ts` now return
  the size after the editor's crop. Their signatures are unchanged.
- `app/components/Testimonial/asciiArt.ts` (new): `parseAsciiArt(html)` returns
  `{ok: true, art}` or `{ok: false, reason}`. `TestimonialView.asciiArt` is now
  `AsciiArt | null` instead of an HTML string, and `Testimonial.tsx` renders it as elements.
- `app/resume/_lib/resume.ts` rewrites the resume's two broken links. The fonts are in
  `public/fonts/charter/`.
- Unit tests: `npm test` runs `node --test` on `test/**/*.test.ts` (Node's type stripping). Tests
  import modules with a `.ts` extension, so `tsconfig.json` sets `allowImportingTsExtensions`
  (the app already has `noEmit`). Modules under test must not use the `@/` alias.

**Migration (`migration/wagtail-to-sanity`)**
- `src/import-guard.ts` (new) and `src/steps/import.ts`: the Studio-edit check, and
  `state/imported-<dataset>.json` (`_rev` and content hash of every migration document).
  CLI flag `--discard-studio-edits`.
- `src/steps/baseline.ts` (new, `--steps baseline`) and `src/steps/videos.ts` (new,
  `--steps videos`). Neither runs by default.
- `src/wagtail.ts`: `wagtailTagOrder(names)`. `src/transform/documents.ts` uses it for tag
  references. It also migrates a redirect to an unpublished page as a draft, applies content
  fixes, and exports `muxVideoDocument(mediaId, entry)`.
- `src/content-fixes.ts` (new): `LINK_HREF_FIXES` and `linkHrefFix(pageId, blockId, href)`. Each
  fix is keyed by page id, StreamField block id and the exact href. A fix that no longer matches
  the export fails the transform.
- `src/steps/mux.ts`: `steadyStateAsset(asset)`.
- `src/steps/validate.ts`: counts and field parity know about draft redirects. Tag order is
  checked against the rule and against the live API snapshot. Content fixes are listed as
  explained in text parity.

**Backups (`scripts/backup`)**
- `resolveSnapshot(storage, {snapshot, latest, sourceDataset})`. It replaces the old
  `fromDataset` option, which only applied to `--latest`. `restore.mjs` passes `--from-dataset`,
  which defaults to `--dataset`. `parseMarker` is now exported from `lib/backup.mjs`.

**Decommission (`scripts/decommission`)**
- `lib.sh`: `decom_mux_videos_complete` and `DECOM_SANITY_QUERY_URL`. `04-gcs-lockdown.sh` checks
  it unless `--authenticated-users-only` is given. The fake `curl` in the tests answers the
  production query from `sanity/production.json`.

### Data written to Sanity

| When (UTC) | Dataset | What |
|---|---|---|
| 23:02 | staging, production | `--steps baseline`: read-only; both still equalled the NDJSON (sha256 `59bdab24…`) |
| 23:06–23:07 | (Mux) | `mux` step twice: 0 assets created; the free plan still refuses media 11–29 |
| 23:07 | staging | transform + import + validate: `project-43` technologies reordered, `project-6` link fixed, `redirect-1` became `drafts.redirect-1`. NDJSON sha256 `e18150f9…` |
| 23:08–23:09 | staging | guard test: a draft of `project-43` created and `drafts.blogPost-17` published to simulate Studio edits, then restored with `--discard-studio-edits` and re-imported |
| 23:10 | production | transform + import + validate with the same NDJSON as staging |
| 23:17 | staging | `secrets.wp8-viewer-check` (dummy values) and `wp8-createdat-check`, both created and deleted again |

Staging and production are identical again (`npm run compare`: 221 of 221 shared ids identical,
0 explained differences, NDJSON byte-identical). Both import records are in
`~/cjoshmartin-migration/state/imported-{staging,production}.json`.

### Verification

| Check | Result |
|---|---|
| Frontend `npm run lint` | 0 errors. 2 warnings, both pre-existing in files this round didn't touch (`LoadingImage.tsx` alt text, `postcss.config.mjs` default export) |
| Frontend `npx tsc --noEmit` | clean |
| Frontend `npm test` | 11/11 (redirect helper, crop dimensions, ASCII art parser) |
| `next build` of HEAD (`git archive` into `~/cjoshmartin-migration/tmp/fixes-r1-build`, production dataset) | passes; 18 app routes plus the proxy |
| Disable route on that build | `?redirect=/%09/evil.com` (GET and POST), `/%0A/evil.com`, `//evil.com`, `/%5Cevil.com` and `https://evil.com/` all answer 303 to `/`. `/blog/interview-practice?a=1` keeps its path and query |
| Redirects on that build | `/blog/add-a-background` is 404 (no redirect). The other 3 Wagtail redirects are 308 to their posts. `/about` is 308 and `/admin` is 307, as before |
| Content on that build | parametric picture frames: "Technologies: cricut, Fusion 360". Squid Games: the link is `https://pypi.org/project/face-recognition/` (PyPI's JSON API confirms the package `face-recognition` 1.3.0) |
| Testimonial art in a browser (Chrome for Testing, 1440 px) | new vs old site, same testimonial: 1 wrapper span, 525 colored spans, 14 `br`, 540 text nodes, identical color and character sequence, identical rendered width (194 px). Hover sets the art to opacity 0 |
| ASCII art round trip | all 9 production values parse and re-serialize byte for byte |
| Resume in a browser | `/resume` and `/resume/pdf`: `charterregular` and `charteritalic` load, the body font is `charterregular`, and no response is 400 or above. `/fonts/charter/*` is 200 with `text/css` and `font/woff` |
| Crop dimensions against the live CDN | 6 of 6 crop and width combinations on the production author photo: the predicted size equals the PNG the CDN returns. (This holds for those 6 cases only. Round 2 found that the CDN's `fit=max` height can differ, and changed the URLs to ask for the exact size; see R2-4.) |
| Migration `npm test` / `npm run typecheck` | 49/49 / clean |
| Migration validation, staging and production | 9 of 12 checks pass on each. The 39 failures (counts 1, references 19, mux 19) are exactly the 19 videos Mux refused, as before. textParity and fieldParity pass (938 fields, up from 912, because of the new live-API tag checks); convergence and studioValidation pass |
| Public read of production | 3 published redirects; `redirect-1` and `drafts.redirect-1` invisible without a token; `project-43` technologies are cricut, Fusion 360 |
| Import guard on staging | refused with the simulated edits listed (`blogPost-17` and `drafts.project-43` created, `drafts.blogPost-17` gone); the `videos` step ran and touched neither; `--discard-studio-edits` restored the dataset, and the next import found no edits |
| Backup `npm test` | 58/58 on Node 26.4.0 and on Node 24 (the CI version). ESLint is clean |
| Restore dataset rule on WP5b's real staging backups (`--build-only`) | `--latest --dataset staging` takes `20261125T224444Z`. `--latest --dataset production` is refused (no production snapshot there). `--snapshot 20261125T223956Z --dataset production` is refused ("is of dataset staging, not production") |
| Decommission `test/run.sh` | 93/93, including 7 new checks: refusals for missing videos, an unresolved block and a failed query, the passing case, and shellcheck |
| GCS lockdown check against real production | refuses: "10 of 29 Wagtail videos have a ready mux.videoAsset in production, and 19 of 29 published video blocks do not resolve" |
| WP7 parity crawl, rerun on that build against the live old site (47 routes, 1440 and 390 px) | **0 unexpected** (WP7 had 2): 3 same, 44 with expected differences only. Parametric picture frames is now EXPECTED (only the footer and og:image differ), and `/blog/add-a-background` is EXPECTED as a draft redirect. The classifier (`migration/verify/src/compare.mjs`) got three rules, each tied to a round-1 fix, with unit tests (`npm test` 14/14). R1-2: a Wagtail redirect to a never-published page must be a plain 404. R1-5: the Squid Games in-page link became the PyPI link; this only counts as explained when both halves are seen. R1-3: the resume page height may change only when the old page's Charter stylesheet 404'd and the new one didn't. Before these rules, the run showed exactly those three routes as unexpected |
| WP7 interactive checks, rerun | Same results as WP7. Mux videos: 20 of 20 play. STL models: 6 of 6 draw and rotate. YouTube: 18 of 18 load, and 16 play (the same 2 don't play on the old site either). Testimonials: 8 of 8 match both Sanity and the old site, with 525 spans each, and the hover reveal works 8 of 8. Rotation after 32 s works. Disqus: 20 of 20 threads identical |

All logs are in `~/cjoshmartin-migration/reports/fixes-r1/` (outside git). The parity report with
screenshots is `~/cjoshmartin-migration/reports/parity-fixes-r1/index.html`. Validation reports
are in `~/cjoshmartin-migration/reports/validation-{staging,production}.{json,md}`.

One staging import during the guard test printed no completion line and wrote no record. Its
output had been filtered through `grep`, so the reason was not captured. The rerun right after it
completed normally. Because the record was not updated, that rerun also exercised the guard's
same-content rule (new `_rev`s, unchanged content, accepted).

### Still open after round 1

1. **19 videos (R1-6).** This is blocked until the Mux environment leaves the free plan. Then:
   `cd migration/wagtail-to-sanity && npm run migrate -- --dataset staging --steps mux,videos`,
   then the same with `--dataset production --confirm-production`. Josh must resolve this or
   explicitly accept it before merge.
2. **Plausible (R1-4).** The server at `49.13.164.251` has to serve a certificate for
   `plausible.technicalchicago.com` again. Nothing in this repo changes.
3. **Local test backups (R1-18).** Josh can delete them after review (the command is in
   wp8-review.md, note 10).

## Round 2 (2026-11-26)

Branch `sanity-migration`. Commits, oldest first:

| Commit | What |
|---|---|
| `2b56f55` | Request the exact image size the `<img>` attributes state (R2-4) |
| `8911387` | Guard asset metadata, and check for Studio edits before any write (R2-3) |
| the commit that adds this section | the round-2 sections of this file and of `wp8-review.md`, and a pointer from round 1's CDN claim to R2-4 |

R2-1 (videos) and R2-2 (Plausible) are still blocked outside the repo, and no code changed for
them. See [wp8-review.md](wp8-review.md), round 2, notes 1 and 2.

### What changed

**Frontend**
- `sanity/lib/imageDimensions.ts`: `sizedTo(builder, size)` returns
  `builder.width(size.width).height(size.height).fit('crop')`. `fitWidth` never returns a height
  of 0, and its comment no longer says it matches `fit=max`.
- `sanity/lib/image.ts`: `imageUrl(image, maxWidth)` is now
  `sizedTo(urlFor(image), scaledDimensions(image, maxWidth)).auto('format').url()`. The signatures
  of `imageUrl`, `scaledDimensions` and `getImageDimensions` are unchanged. Every caller of
  `imageUrl` now gets a URL with `w`, `h` and `fit=crop`. The CDN delivers exactly
  `scaledDimensions(image, maxWidth)`, never wider than `maxWidth` and never scaled up.
- `test/imageDimensions.test.ts`: `sizedTo` is checked with 4 asset sizes, 5 crops, 2 hotspots and
  8 widths. For each case it asserts:
  - the URL asks for exactly the `fitWidth` size
  - the rect stays inside the editor's crop
  - the rect has the requested aspect ratio to within one source pixel
  - the rect loses only the height rounding
  - a crop no wider than the maximum is delivered as is

  `fitWidth` also has a test for the height clamp.

**Migration (`migration/wagtail-to-sanity`)**
- `src/steps/assets.ts`:
  - `uploadAssets(paths, dataset, secrets, {discardStudioEdits})` now takes options. Before any
    upload or patch, it compares the existing assets with `state/assets-<dataset>.json`, the map
    its last run wrote, and refuses on edits unless `discardStudioEdits` is set.
  - New exports: `findAssetMetadataEdits(planned, existingByKey, previous)` (pure),
    `differingMetadata(a, b)`, `readAssetMap(paths, dataset)`, `assetMapPath(paths, dataset)` and
    the `ExistingAsset` type.
- `src/cli.ts`:
  - when the steps include `import`, `checkForStudioEdits` runs once before the first step
  - `--discard-studio-edits` is passed to the `assets` step too
- `test/assets.test.ts` (new, 6 tests). The README describes the new check.

### Data written to Sanity and Mux

| When (UTC, 2026-11-26) | Where | What |
|---|---|---|
| 00:11 | Mux | `--steps mux --allow-pending-videos`: 10 reused, 0 created, media 11–29 refused again (free plan). `state/mux-map.json` unchanged apart from `updatedAt` |
| 00:12 | staging | Reproduction: the title of `image-02b16b06…` set to a test value. The `assets` step of `daf942a` reset it |
| 00:12–00:13 | staging | Guard test (below): the title edited again and `drafts.project-43` opened, then the draft deleted and the title restored with `--steps assets --discard-studio-edits` |
| 00:13 | staging | Default full run (no `--steps`). The `assets` step wrote nothing, and the import re-imported the same NDJSON (sha256 `e18150f9…`, the same as round 1). New revisions, same content hashes |
| 00:14 | production | `--steps assets,validate`: 0 uploaded, 0 metadata updates, so nothing was written; validation is read-only |

Staging and production are identical again (`npm run compare`: 221 of 221 shared ids identical,
NDJSON byte-identical). In both datasets, all 115 assets equal `state/assets-<dataset>.json`.

### Verification

| Check | Result |
|---|---|
| R2-3 reproduction on HEAD `daf942a` (staging) | After a title edit, `--steps assets` printed "updated metadata of image-02b16b06… (title)" and the title was back to `IMG_3367`. The edit was lost without a warning |
| R2-3 guard, default full run with a document edit and an asset edit (staging) | The new early check refused (`created since the last import: drafts.project-43`) before `extract`. The asset kept its edited title and `_rev` |
| R2-3 guard, default full run with only the asset edit | `extract` ran, then `assets` refused before writing: `image-02b16b06… (title): changed since the last run`. The import never ran: the import record and the asset map are byte-identical to before |
| R2-3 override | `--steps assets --discard-studio-edits` printed the warning, restored `IMG_3367`, and the asset map is byte-identical to before the test |
| R2-3 default full run without edits (staging) | Early check and import check both pass. The `assets` step reports 0 uploaded and 0 metadata updates. Import and validation ran (9 of 12; see below) |
| Migration `npm test` / `npm run typecheck` | 55/55 (6 new) / clean |
| R2-4: CDN before the fix (`w` + `fit=max`) | The 53 resized renditions the site serves: 3 heights off by 1 px. 121 random crop and width cases: 34 off, up to 10 px in height, and one returned 96 wide for `w=97` |
| R2-4: CDN after the fix (`w` + `h` + `fit=crop` via `sizedTo`) | 174 of 174 renditions are exactly the requested size |
| R2-4: animated GIFs | 6 GIF renditions × 3 `Accept` headers (AVIF, WebP, `*/*`): animated with both URL forms. The bytes are identical, both for renditions that are not resized and for one that is (800 → 400) |
| Frontend `npm run lint` / `npx tsc --noEmit` / `npm test` | 0 errors (the same 2 pre-existing warnings) / clean / 13/13 |
| `next build` of HEAD `8911387` (`git archive` into `~/cjoshmartin-migration/tmp/fixes-r2-build`, production dataset) | Passes: 18 app routes plus the proxy |
| Images on that build | 29 routes (every published page plus the listings), all 200. 89 Sanity `<img>` (69 distinct URLs), all with `w`, `h` and `fit=crop`, and 0 delivered sizes differ from the request. All 62 whose attributes come from `scaledDimensions` match the delivered pixels exactly. The other 27 use fixed layout sizes that are the same on `main` (portfolio previews 150x150, blog cards 480x320, author photo `width=400`). This round did not change them |
| Validation, staging and production | 9 of 12 checks pass on each. The 39 failures (counts 1, references 19, mux 19) are exactly the 19 videos Mux refuses (R2-1). textParity, fieldParity (938 fields), convergence and studioValidation pass |
| Mux recheck (R2-1) | 10 assets, and creating an eleventh is still refused |
| Plausible recheck (R2-2) | Still TLS alert 80 with no certificate, and HTTP 503 |
| WP7 parity crawl, rerun on that build against the live old site (47 routes, 1440 and 390 px) | **0 unexpected**, the same as round 1: 3 routes are the same, 44 have expected differences only. No new classifier rule was needed |

All logs and evidence are in `~/cjoshmartin-migration/reports/fixes-r2/` (outside git):
- `guard-test.log` (the R2-3 sequence)
- `route-images.json` (every `<img>` on the build)
- `exact-out-final.json`, `out1.json` and `out-site.json` (CDN sizes after and before the fix)
- `gif-animation.log`
- the Mux and Plausible rechecks

The parity report is in `~/cjoshmartin-migration/reports/parity-fixes-r2/`. Validation reports are in
`~/cjoshmartin-migration/reports/validation-{staging,production}.{json,md}`.

### Still open after round 2

1. **19 videos (R2-1, R1-6).** This is blocked until the Mux environment leaves the free plan.
   Then run `cd migration/wagtail-to-sanity && npm run migrate -- --dataset staging --steps mux,videos`,
   then the same with `--dataset production --confirm-production`. Josh must resolve this or
   explicitly accept it before merge.
2. **Plausible (R2-2, R1-4).** The server at `49.13.164.251` has to serve a certificate for
   `plausible.technicalchicago.com` again. Nothing in this repo changes.
3. **Local test backups (R1-18).** These are unchanged. Josh can delete them after review (the
   command is in wp8-review.md, round 1, note 10).
