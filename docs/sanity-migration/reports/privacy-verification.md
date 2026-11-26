# Work package VERIFY: independent verification of the metadata stripping

Date: 2026-11-26, 12:23 to 13:15 UTC. Commit checked: `e521d46` (the deployed Functions and the
migration's privacy step, [wp3-migration.md](wp3-migration.md#privacy-personal-metadata-stripped-from-every-existing-asset-work-package-m-2026-11-26)
and [privacy-functions.md](privacy-functions.md)). This package changed no code and no content
except its own scratch data on staging, which it deleted.

## Verdict

**Not done yet: two public video originals still contain the exact GPS location.** Everything else
checked out.

- **High.** In both datasets, the stripped copies of `IMG_0169.MOV` and `IMG_3151.MOV` still
  contain the original's exact ISO 6709 location string. Anyone can download them from
  `cdn.sanity.io/files/...` without a token.
  - The location sits in a leftover iOS movie header (a `hoov` box) inside `mdat` that no track
    references.
  - exiftool does not read it, so the migration's `privacy` validation check passes anyway.
  - Details are in [Findings](#findings).
- **Other existing assets.** No other asset has location or personal tags (exiftool `-ee`,
  ffprobe, and a byte-level fingerprint search; 173 assets per dataset). The same goes for every
  CDN rendition tried (resized, `auto=format`, every `fm`, crops, the og:image) and for every
  asset document.
- **Lossless.** All 15 stripped images decode to the same pixels as the originals (ImageMagick and
  ffmpeg). Their coded JPEG/PNG data is byte-identical, with the same orientation and ICC profile.
- **Validation.** 13 of 13 checks pass on staging and production, and the compare finds the two
  datasets identical (twice for staging: before and after the live tests).
- **Live tests on staging** (fresh scratch documents, fake GPS on generated media):
  - The image-privacy Function stripped a JPEG and a PNG. It repointed three references with crop,
    hotspot, alt, caption and layout unchanged, and deleted both uploads within 14 s. Pixels,
    orientation 6 and ICC were unchanged.
  - The video-to-mp4 Function stripped a MOV. It had location in Keys, UserData and ItemList, a
    subtitle, a `gpmd` and a `tmcd` track, and an injected `hoov` leftover with a location. The
    streams stayed bit-identical, the rotation was kept, the MP4 was ready in 31 s and the upload
    was deleted.
  - Everything was cleaned up.
- **Frontend.** A production build renders the pages with the 6 formerly GPS-tagged photos (4 in
  page bodies, 2 as og:image), and the 5 phone videos play, in Chrome for Testing 156 and WebKit
  27.2 at 1440 and 390 px.
  - The documents equal their pre-strip versions except for the swapped asset ids.
  - Video sources, boxes and intrinsic sizes equal the last pre-strip crawl.
  - No request failed or reached a deleted asset.

## Findings

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | high | GPS location left in 2 public stripped video originals (unreferenced `hoov` box in `mdat`) | `migration/wagtail-to-sanity/src/privacy/isobmff.ts`, `src/privacy/video.ts`, `src/steps/validate.ts`; assets `file-ac229f1e…-mov` and `file-f09b0f33…-mov` in production and staging |
| 2 | medium | The 24 stripped copies' public asset documents link (`source.url`) to the unstripped originals in the public bucket, which still serves them (HTTP 200) | asset documents, `source.url`; bucket `images-for-cms` |
| 3 | medium | An upload that is never referenced, or loses its reference before a Function runs, is never stripped or deleted; for videos its file URL is public | `studio/functions/image-privacy/trigger.ts`, `studio/functions/video-to-mp4/trigger.ts` (known: privacy-functions open issues 2 and 4) |
| 4 | low | 7 macOS screen recordings also keep a `hoov` leftover (device make/model, OS version, creation date, no location) | same as 1 |
| 5 | low | Capture metadata is kept on the migrated assets under the migration's rules (camera and lens model, capture times with UTC offsets, software, Mac model and macOS version), while the Function removes it from new uploads | `migration/wagtail-to-sanity/src/privacy/rules.ts` (known: wp3 open 1, privacy-functions open issue 3) |

### 1. GPS location left in two public video originals (high)

- **What.** A byte search used fingerprints taken from the local originals that had a location: 12
  raw EXIF GPS rational values from the 6 photos and 5 ISO 6709 strings from the 5 videos. It
  found the original's exact ISO 6709 value in the public stripped copies of `IMG_0169.MOV`
  (media 15, blog post 19) and `IMG_3151.MOV` (media 7, project 6).
- **Where in the file.** The value sits inside `mdat`, in a `hoov` box: a copy of the movie header
  that iOS writes while recording.
  - `IMG_0169.MOV`: 6,251 bytes at offset 1,021,023.
  - `IMG_3151.MOV`: 13,950 bytes at offset 11,873,702.
  - Next to the value: the location accuracy, make, model, software and creation date keys. In
    `IMG_3151.MOV` also the `detected-face` key names. `IMG_0169.MOV` also keeps `moof` fragment headers
    (sample tables only).
- **Why it was missed.**
  - No track references these bytes, so exiftool `-ee` and ffprobe never see them.
  - `isobmff.ts` turns `moov/meta`, `moov/udta` and the removed tracks into zero-filled boxes, and
    zeroes those tracks' samples. It leaves every other byte as it is.
  - `video.ts` then requires "every byte outside the reported ranges is identical" and a clean
    exiftool scan, and the `privacy` validation check runs the same scan. Both pass.
- **Exposure.**
  - The file URLs are public and appear in the public dataset as the video blocks' `original`.
    The site itself never links them; it plays the MP4.
  - The 24 old asset URLs answer 404, so these two copies are the only place in the datasets with a
    location.
  - The converted MP4s, every other video and every image are clean (see 1 below).
- **Suggested fix (package M).**
  1. Zero every `mdat` byte that no kept sample references. A coverage pass with ffprobe packet
     positions found 105,657 and 85,868 such bytes. Ranges that are not all zeros total 59,135 and
     18,890 bytes: the `hoov` box, `moof` fragment headers and a tail. Every audio and video
     packet stays byte-identical. Take the referenced ranges from the kept tracks' sample
     tables (`stco`/`co64`, `stsc`, `stsz`): ffprobe does not list every data-track sample.
  2. Upload, repoint and delete as before.
  3. Add a byte-level check to `validate` and to `video.ts`: no non-zero unreferenced `mdat` bytes,
     no ISO 6709 pattern, no `com.apple.quicktime.location` key name.
  - An ffmpeg remux (`-c copy`, the Function's path) writes only packets. It also drops the
    leftover: checked locally on `IMG_0169.MOV`, and live with an injected `hoov` (see 4 below).
- **Studio uploads are not affected.** The Function's stripped copy had 0 unreferenced `mdat`
  bytes.

### 2. Asset documents point at the unstripped originals (medium)

- **What.** All 24 stripped copies keep `source {name: "wagtail", id, url}`. `url` is the public
  bucket object of the original, which still has its GPS and still answers HTTP 200 (`HEAD`
  checked for `IMG_7630.jpg` and `IMG_0169.MOV`).
- **Exposure.** The datasets are public, so anyone who reads the asset documents gets a direct link
  to the unstripped file.
- **Fix.** The WP6 bucket lockdown removes the exposure. Until then, the owner may want to lock down
  at least these 24 objects. Rewriting `source.url` is the migration's call, because the `assets`
  step protects `source`.

### 3. Unreferenced uploads are never processed (medium, known)

- **Shown live.** An image upload left unreferenced for 8 s got no `privacy` field. Both Functions
  start from content-document events by design.
- **Images.** An image that is uploaded but never saved into a document stays with its metadata. Its
  stored bytes need a token (`dlRaw`).
- **Videos.** A video whose block is removed before the conversion stays public at `/files/` with
  its location.
- **API clients.** A client that uploads with `meta=exif,location` (not the Studio) puts the
  location into the public asset document. In the live test that lasted until the Function deleted
  the upload, 14 s later.
- **Suggestion.** A scheduled sweep of `_createdAt >= UPLOADED_SINCE` assets without `privacy` that
  are older than a few minutes. This is already listed as privacy-functions open issues 2 and 4.

### 4. Device details in screen-recording leftovers (low)

The same `hoov` leftover exists in 7 `Screen_Recording_2025-05-05_*.mov` originals. It holds make,
Mac model, macOS version and creation date, but no location. The same values are still in their
`moov/meta` Keys, which the migration's rules keep. The fix for finding 1 removes these leftovers too.

### 5. Capture metadata kept on migrated assets (low, owner decision)

- **What is still there:**
  - Stored image bytes (token needed): camera make/model in 10, `DateTimeOriginal` in 14, UTC
    offsets in 12, lens in 7, `Software` in 30 and `HostComputer` in 7.
  - Public video originals: 10 screen recordings carry Keys `Make`, `Model` (a Mac model id),
    `Software` (macOS version) and `CreationDate`, and every original keeps its `mvhd` times.
  - PDFs: `Creator`, `Producer` and dates.
  - 2 to 3 files keep XMP editing ids.
- **Why it is reported.** None of this is location, a serial or a person. It is reported because
  the owner's wording ("other personal EXIF/XMP/IPTC") could cover capture times and the device
  model. The Function strips all of these from new uploads.

## 1. Every asset, downloaded through the public CDN and scanned

Scripts: `~/cjoshmartin-migration/privacy/verify/scripts/` (`list-assets.mjs`, `download.mjs`,
`check-scan.mjs`, `locate.mjs`, `mdat-coverage.mjs`, `lossless-images.mjs`). Downloads and results
are in `~/cjoshmartin-migration/privacy/verify/` (local only).

| Check | staging | production |
|---|---|---|
| Asset documents (raw perspective) | 173: 110 images (47 JPEG, 50 PNG, 8 GIF, 4 WebP, 1 AVIF), 36 MP4, 21 MOV, 1 WebM, 3 STL, 2 PDF | same ids and sha1 as staging |
| `metadata.location` / `metadata.exif` | 0 / 0 | 0 / 0 |
| Image `metadata` keys | only `blurHash`, `dimensions`, `hasAlpha`, `isOpaque`, `lqip`, `palette` | same |
| Public download, no token | 173/173 HTTP 200, 481.6 MB; the 63 files equal the stored sha1 | same |
| Image URL without parameters | 96 images re-encoded without metadata, 14 served as stored (8 GIFs, 2 JFIF-only JPEGs, 4 PNGs without EXIF) | same |
| Stored image bytes (`?dlRaw=true`, read token) | 110/110 equal the asset's sha1 and size | same |
| `?dlRaw=` without a token | 401 | 401 |
| exiftool `-j -a -u -G1 -ee` | 280 files (STL is not read by exiftool; its 80-byte headers are `STLB ATF <version> COLOR=`, no names or paths) | same |
| Location, maker-note, serial, owner, artist, author, copyright, face or person tags | 0 | 0 |
| ffprobe of the 58 videos | only video and audio streams; no data, subtitle or timed-metadata (`mebx`) track; no location, author or serial tag | same |
| Byte search: location fingerprints of the 11 originals, ISO 6709 pattern, QuickTime location keys, `©xyz`, XMP place names, `mebx`, Apple ids | hits only in `IMG_0169.MOV` and `IMG_3151.MOV` (finding 1) | same |
| The 29 converted MP4s | format tags only brands and `encoder`; no fingerprint | same |

- **Tag review.** All 484 distinct tag keys of all four scans were reviewed, not only matched
  against a list. Two keys looked like hits but are not: `XMP-hdrgm:HDRCapacity*` (the rule
  matched "City" in "Capacity") and `PDF:Creator`, which holds the browser that printed the PDF.
- **Images served as stored.** The CDN serves an image unmodified when it has no EXIF or XMP, and
  serves GIFs unmodified even with XMP. All 69 other images with EXIF or XMP are re-encoded.
  So a GIF with location in XMP would be public. None exists, and the image-privacy Function strips
  GIF XMP.

### Lossless (independent of the migration's own checks)

For each of the 15 stripped images in each dataset, the stored copy (`dlRaw`) was compared with the
local Wagtail original that has the sha1 in `privacy.strippedFrom`:

- the ImageMagick pixel signature and the ffmpeg `framemd5` (`-noautorotate`) are equal;
- the coded data is byte-identical: every JPEG segment except APPn/COM, and every PNG chunk except
  text, `eXIf` and `tIME`;
- the orientation is unchanged (6 on `IMG_0070`, `IMG_7630`, `IMG_8414`, `IMG_9514`);
- the ICC profile's sha256 is unchanged;
- the `IMG_9344.jpeg` gain map is unchanged too. Its embedded image (`-ee3`) has only MPF, AROT and
  `hdrgm` tags.

**Result: 15/15 per dataset.** The 9 video originals were not re-checked packet by packet here. The
migration's validation does that, and it passed (see 3).

### The replaced assets are gone

- **Asset documents.** None of the 24 `privacy.strippedFrom` ids exists in either dataset. No
  document references them, and no Portable Text contains them.
- **CDN URLs.** All 24 old URLs answer 404, plain and with a cache-busting query. The 15 images also
  answer 404 at `?w=800&auto=format`.
- **One stale response.** The plain URL of the deleted staging `IMG_0070.jpeg` asset once answered
  200 from the CDN edge (12:42 UTC). It answered 404 at 12:44 and on 3 later requests. That URL
  re-encodes any JPEG with EXIF (see above), so the response carried no metadata.

## 2. CDN renditions of the formerly GPS-tagged images

Fetched without a token for all 15 stripped images in both datasets (108 of them for the 6 GPS
photos), with 18 variants each:

- no parameters, `?dl=`, `?w=800`, `?h=600`, `?w=2000&fit=max`;
- `?auto=format` and `?w=800&auto=format`, with AVIF, WebP and no `Accept` header;
- `fm=jpg|pjpg|png|webp`, `fm=jpg&q=100`;
- the og:image crop `w=1200&h=630&fit=crop&fm=jpg`;
- a `rect` crop with `auto=format`.

Further renditions were fetched as well:

- 45 more `auto=format` renditions per dataset (30 AVIF, 15 WebP);
- the 8 renditions the production pages request (AVIF);
- the og:image of 4 production pages.

| Result | staging | production |
|---|---|---|
| HTTP 200 | 255 + 45 | 255 + 45 + 8 + 4 |
| HTTP 400 | 15 (`fm=avif` is not a Sanity parameter) | 15 |
| Tags other than format structure (no EXIF, XMP, IPTC, ICC, comments) | 0 | 0 |

## 3. Migration validation and compare

From `migration/wagtail-to-sanity` (logs in `~/cjoshmartin-migration/privacy/verify/logs/`):

| Run | Result |
|---|---|
| `npm run migrate -- --dataset staging --steps validate` (12:46:54 UTC) | all 13 checks pass. `privacy`: 173 assets, 0 personal, 24/24 copies marked, 0 unstripped left |
| `npm run migrate -- --dataset production --confirm-production --steps validate` (12:48:42) | all 13 checks pass, same numbers |
| `npm run compare -- --datasets staging,production` (12:48:52) | 269/269 shared ids identical, NDJSON byte-identical, Portable Text digest `6ce9db236331b857` in both |
| staging validate again after the live tests (13:09:11) | all 13 pass |
| compare again (13:09:20) | identical |

The `privacy` check passing is a false negative for finding 1.

## 4. Live tests on staging

Script: `scripts/live-test.mjs`. Fixtures were built by `scripts/make-fixtures.sh` from generated
images and video, with fake coordinates and fake names (no real photo or location). Each run used a
new nonce, so no upload could equal an existing asset.

- **Studio flow.** Every test uploads first and then patches the reference into a draft.
- **Two runs.** Run 1 passed every check but reported crop and hotspot as changed, because the
  script compared objects whose keys came back in another order. The script was fixed and run
  again. Run 2's results are below; both runs' raw data are kept locally.

| Input | Contents |
|---|---|
| `photo-a.jpg` (2000x1500, orientation 6, Display P3) | EXIF GPS and altitude, make, model, 3 serials, owner, artist, copyright, unique id, dates with UTC offset, software, user comment, thumbnail; XMP creator, city, country, location, GPS, person in image; IPTC by-line, city, country, sub-location; JPEG comment |
| `photo-b.png` (1200x900, Display P3) | `eXIf` GPS, make, model, serial, artist; XMP city, creator, GPS; `tEXt` author, artist, make, model, comment; `zTXt` raw ICC copy; `tIME` |
| `video.mov` (H.264 + AAC, 4 s, display matrix -90) | QuickTime Keys location (ISO 6709), location name, make, model, software, creation date, author; UserData location, make, model, author; ItemList location, artist; a `mov_text` subtitle with a location line; a `gpmd` data track and a `tmcd` timecode track; a 173-byte `hoov` leftover with a location and the location key name appended inside `mdat` (unreferenced, like the iPhone files) |

**Images.** `photo-a.jpg` went into `contentImage` (with crop and hotspot) and into a Portable Text
`imageBlock` (other crop and hotspot). `photo-b.png` went into a second `imageBlock`; it was uploaded
with `meta=exif,location`, as a non-Studio client might.

- **Timing.** 12.1 s after the references were set, all three references pointed at copies. The
  two uploads were deleted 0.6 s later (13.9 s in all).
- **Unchanged fields.** The crop, hotspot, alt, caption and layout of all three are unchanged.
  `photo-a.jpg`'s two references share one copy.
- **The copies.**
  - Asset documents: `source {name: "image-privacy", id: <upload>}`,
    `privacy {status: "stripped", version: "image-strip-v1", strippedFrom: <upload>, removed}`.
  - Metadata: only the placeholders and palette; no `location` or `exif`. On the upload of
    `photo-b.png`, `metadata.location` existed until the delete (finding 3).
  - Stored bytes (`dlRaw`, sha1 checked): 0 personal tags and 0 fake markers (coordinates, names,
    serials, nonce). The same pixels with both decoders, orientation 6 kept, ICC unchanged.
  - CDN renditions (`plain`, `w=800`, `w=800&auto=format`, `fm=jpg&q=100`): 0 tags, 0 markers.
  - `dlRaw` without a token: 401.
- **The deleted uploads.** Their URLs answer 404, plain and with `dlRaw`.

**Video.** `video.mov` went into a `video` block.

- **Timing.** `ready` 31.2 s after the reference; the upload was deleted 0.3 s later.
- **The block.**
  - `file` is an MP4 asset with `source {name: "video-to-mp4", id: <stripped copy>}`.
  - `original` is the stripped copy, with `source {name: "video-to-mp4-original", id: <upload>}`
    and `privacy` stripped `video-strip-v1`.
  - `conversion`: `sourceAssetId` is the copy, `originalStripped: true`,
    `stripVersion: "video-strip-v1"`, settings `h264-crf23-max1920-v2`.
- **The stripped original (public download, sha1 checked).**
  - Streams: only H.264 + AAC. `streamhash` (sha256 per stream) and `framemd5` of the video and the
    audio equal the upload.
  - Rotation -90 is kept. Format tags: only the brands.
  - 0 personal tags and 0 markers. 0 unreferenced `mdat` bytes, so the injected `hoov` is gone.
  - Its `privacy.removed` lists the Keys, UserData and ItemList entries, the subtitle, `bin_data`
    and `tmcd` streams, and the creation times.
- **The MP4.** H.264 720x1280 (the rotation applied) + AAC. Format tags are the brands and
  `encoder`. 0 personal tags and 0 markers. It decodes without errors.
- **Function logs.** image-privacy: one run replaced both images in run 1, and a second invocation
  found nothing left to do. In run 2, a second invocation took over the PNG through the lease (the
  first logged `skipped (already handled)`). video-to-mp4: lease taken,
  `stripped (mov)`, conversion, lease released, `unstripped upload deleted`, `ready`.
  testimonial-ascii-art did not run.

**Cleanup.** Both runs deleted their 2 drafts and their 4 remaining assets: 2 image copies, the MP4
and the stripped original. Before deleting, each asset was checked to be created after the test
started and referenced by nothing. Afterwards, staging had no `privacy-verify-*`, `privacy-live-*`
or probe document, no asset created after the test started, no `privacy` status other than
`stripped` or `clean`, and 173 assets. Validation and compare passed again (see 3).

## 5. Frontend against production

**Build.**

- Source: `git archive` of `e521d46` into `~/cjoshmartin-migration/privacy/verify/frontend-build`,
  with the repository's `.env.local` (dataset `production`), `npm ci`, then `next build`. Next.js
  16.3.4 built 19 routes and the proxy.
- Server: `next start -p 3000` (a CORS origin of the project). Its log has no errors.

**Browsers.** Chrome for Testing 156.0.8078.4 and WebKit 27.2 through `playwright-core` (the WP7
browsers). Google Chrome is not installed, so Playwright's channel `chrome` was not available.
Each page ran at 1440 px and at 390 px (DPR 2), with the crawl's user agent, waits, scroll and JPEG
settings. Scripts: `render-check.mjs`, `render-extra.mjs`, `render-webp.mjs`, `compare-shots.mjs`,
`compare-before.mjs`, `old-renditions.mjs`.

| Asset | Where it shows | Result (both browsers, both widths) |
|---|---|---|
| `IMG_0070.jpeg` | `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino`, body | loaded from the stripped copy, box unchanged |
| `IMG_3736.jpg`, `IMG_9514.jpg`, `IMG_8414.jpg` | `/projects/mazda-key-holder`, body | loaded, boxes unchanged |
| `IMG_7630.jpg` | `previewImage` of project 24: og:image of `/projects/rocket-powered-high-heels` | og:image 200, same crop parameters as before with the new asset id, no metadata |
| `IMG_3241_copy.jpg` | `contentImage` of project 6 (the page shows its hero): og:image of `/projects/squid-games-nerf-gun` | same |
| `IMG_0169.MOV` | blog post 19 | plays its MP4 |
| `IMG_3239.MOV`, `IMG_3151.MOV` | `/projects/squid-games-nerf-gun` | play their MP4s |
| `IMG_6810.MOV`, `IMG_7386.MOV` | `/projects/sba-power-badge` | play their MP4s |

- **Page loads.** 20 page loads in all: 5 pages, 2 browsers, 2 widths.
  - Every page answered 200 and all 180 images loaded.
  - No request to `cdn.sanity.io` or the site failed, and none went to a deleted asset.
  - The only page errors are third-party: Chrome's removed `browsingTopics` from an ad script, and
    the Disqus frame in WebKit. Both appeared in the earlier crawls too.
- **Videos.** Every video reached `readyState` 4 and was playing on its own. `currentTime` advanced
  over 2 s, or wrapped (they loop). Each was muted, `loop`, `playsInline` and with controls.
- **Not listed anywhere.** Projects 6 and 24 have the maker audience, which no listing page of the
  new site shows (`/`, `/projects` and `/screen` request neither photo). This was already the case
  before the strip.

**Same as before.**

- **Content.** The 15 documents the privacy step patched were compared with their pre-patch
  versions (`privacy/runs/replaced-*.json`). After swapping the 24 old asset ids for the new ones
  (37 places), every document is equal in both datasets. That covers crop, hotspot, alt text,
  captions and every video block's `file`. The 9 MP4 asset documents differ only in `source.id`.
- **Video.** The MP4 assets the pages play are the same files as before the strip (same ids, which
  are their sha1). Against the last crawl before the strip (`reports/parity-fix-r1`, 08:54 UTC),
  every video `src`, rendered box and intrinsic size is equal on all 4 video pages.
- **Layout.** Page heights at both widths and all desktop image boxes (count, size and loaded
  state) equal the pre-strip crawls.
- **Pixels.**
  - *Screenshots.* The four in-body photos are not pixel-identical to the 08:54 screenshots: PSNR
    35.4 to 40.6 dB, mean absolute difference about 1 level of 255, with no colour shift. The
    differences are symmetric, and a side-by-side view looks identical.
  - *Controls.* 23 of 44 unchanged images on the same pages also differ from their old screenshots,
    by 36.6 to 67.4 dB.
  - *CDN variation.* For the same source file, the CDN returns different renditions in production
    and staging: 18 of 37 unchanged images on these pages differ, 10 of them with the same format
    on both sides. For new URLs it serves WebP until it has made the AVIF.
  - *Old renditions.* The deleted assets' renditions are gone (404), so they cannot be compared
    directly.
  - *Conclusion.* The stored pixels, orientation and ICC are proven identical (1). The remaining
    differences come from the CDN's re-encoding, not from the stripped files.
- **Screenshots** (local, not committed): `~/cjoshmartin-migration/privacy/verify/render/` holds
  full pages per browser and width, element shots of each photo and video, side-by-side views
  (`sbs-*.png`) and comparison crops (`compare/`).
- **One old screenshot unreadable.** The old 390 px screenshot of blog post 19 (45,486 px tall at
  DPR 2) cannot be decoded: JPEG's height limit is 65,535 px. That pre-existing limit of the crawl
  tool, not of the site, is why that one page was not compared by pixels.

## Not verified

- **No Google Chrome.** Channel `chrome` (Google Chrome) was not run because Chrome is not
  installed; Chrome for Testing and WebKit were used instead.
- **No `mebx` track in the live test.** ffmpeg cannot write one. The `gpmd` and `tmcd` tracks stood
  in for it. The privacy-functions package already ran a real `mebx` file (`IMG_0169.MOV`) through
  the Function.
- **Publish paths not repeated.** Publishing in the middle of a strip and the Studio UI were covered
  by the privacy-functions package and were not repeated here.
- **Function ffmpeg not run locally.** The Function's own ffmpeg build (7.0.2, linux/arm64) was not
  run locally. The live tests ran it on Lambda.
- **Bucket not downloaded.** The public bucket and the backups were not downloaded. Only a `HEAD`
  of two objects was made, for finding 2.
