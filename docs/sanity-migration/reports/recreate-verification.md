# Work package VERIFY: independent verification of the recreated datasets and Functions

Date: 2026-11-26, 21:13 to 21:50 UTC. Branch `sanity-migration` at `8729ee1` (local; the
frontend was built from a `git archive` of it). This package changed no code and no content of
production. On staging it created scratch drafts and synthetic test media, and deleted all of them
(see [What the live tests left in staging](#what-the-live-tests-left-in-staging)).

It checks the recreate that the main session ran (staging import from 20:40:54 UTC, production from
21:00:07 UTC) and the Functions redeploy after it. [dataset-recreate.md](dataset-recreate.md) was
written before the recreate and describes the plan, not the result.

## Verdict

**The recreate did what it was for, and the restored Functions work.** One new medium finding:
a non-Studio upload can put a location back into the public History API.

- **History API.** No deleted id is known to it any more. 389 deleted ids on staging and 387 on
  production, 25,686 anonymous probes in all: 0 returned a document, and 0 ids have a transaction.
  Before the recreate, 344 (staging) and 192 (production) of them were readable without a token.
  Every current document's history starts at the dataset's creation or later.
- **Privacy scan.** All 173 assets of each dataset, downloaded through the public CDN without a
  token (plus `?dl=` and the stored bytes of the 110 images): 0 location fingerprints, 0 location,
  identifier or people tags apart from the 2 PDFs' `Creator`, 0 non-zero unused `mdat` bytes in the
  58 ISO BMFF files, and 0 problems from the Functions' own checks.
- **Validation and compare.** 13 of 13 on both datasets (staging again after the live tests). The
  two datasets are equal: 280 of 280 shared documents. The only differences are expected: each
  dataset's own schema document, and 2 Presentation preview-secret drafts in production.
- **Functions.** `blueprints info` lists the 4 Functions. `PRIVACY_LINK_KEY` is set on the 3 that
  need it, and it equals the key in `secrets.env` (the copies' digests match). No Function ran
  between the redeploy and the tests. The live tests on staging passed (details in
  [4](#4-functions)).
- **Frontend.** A production build against `production` serves every route.
  - All 35 pages loaded in WebKit at 1440 and 390 px and in Chrome for Testing at 1440 px.
  - All 29 videos played in every run (87 of 87).
  - 0 broken images, and 0 requests reached a deleted asset.
  - The redirects, the 404s, the sitemap, robots.txt and the resume PDF all answered as expected.
  - The only first-party request failures were Next.js prefetches that the browser cancelled.
- **CDN.** 0 of the 670 deleted asset paths are served now; 168 were served at 20:18 UTC, before the
  recreate. Deleting the dataset appears to have purged them (see [6](#6-old-cdn-paths-of-deleted-assets)).

## Findings

| # | Severity | Finding | Where |
|---|---|---|---|
| 1 | medium | An API upload that asks Sanity for `meta=location` (not the Studio) keeps its location readable without a token in the History API, although upload-privacy removes it from the asset document within 2 s and deletes the upload. | History API of any public dataset; `studio/functions/upload-privacy` cannot prevent it |
| 2 | medium (known, open) | 40 images per dataset have no `privacy` field, and their `_createdAt` is the import time. 25 documents per dataset now match the image-privacy filter: their next edit makes the Function check the unchecked images they use (36 images are used by documents). | [dataset-recreate.md finding 1](dataset-recreate.md#findings); `studio/functions/image-privacy/trigger.ts` (`UPLOADED_SINCE`) |
| 3 | low | `history-check` reports FAIL on a clean dataset: the 11 system documents that `datasets create` writes are 1.3 to 1.7 s older than the import start the script prints. | `migration/wagtail-to-sanity/scripts/recreate-dataset.sh` line 84; `src/recreate.ts` line 386 |
| 4 | low | upload-privacy stripped 2 of 4 referenced uploads itself instead of leaving them to the content Functions. The result was the same. | `studio/functions/upload-privacy/orchestrator.ts`, the wait before `handleUpload` |
| 5 | low (by design) | Every upload's asset document stays readable without a token in the History API after it is deleted, for the retention period (90 days): file name, sha1 (its CDN path), size, MIME type and the small previews (LQIP, BlurHash, ThumbHash, palette). | History API |

### 1. A location requested by an API client stays in the public History API (medium)

**Test T4** (staging, synthetic image with fake coordinates):

1. The fake-GPS JPEG was uploaded through the HTTP API with `meta=location&meta=exif`, as a
   non-Studio client might. The new asset document had `metadata.location` and `metadata.exif`.
2. upload-privacy removed both from the asset document 2.0 s after the upload ("removed the
   location and EXIF data extracted into the asset document"). After its 60 s grace period it
   stripped the unused upload and deleted it, 68.4 s after the upload.
3. Without a token, the History API returns the asset document at its first revision **with
   `metadata.location` and `metadata.exif`**, by time and by revision id. The fake coordinates and
   the fake serial number and owner from the EXIF are in that answer. The 3 later revisions are
   readable without them, and the deleted state returns nothing.

**Why it matters.** The recreate removed exactly this kind of history. A single upload like this
puts a location back for the dataset's retention period (90 days), and only another delete and
recreate removes it. Nothing a Function does can prevent it: the upload itself writes that first
revision.

**Not affected.** The Studio asks for no location or EXIF (`PRIVATE_IMAGE_OPTIONS`). The T2 upload,
made with the Studio's metadata options, had neither, and neither did any revision of it.

**What to do (owner).**

- Never upload with `meta=location` or `meta=exif` from scripts or other clients. The migration's
  tooling does not.
- The support email already asks whether a public dataset's History API can require a token.
  Making the datasets private, with a read token in the frontend, also closes it.

### 2. Images without a `privacy` mark (medium, known, still open)

Measured now, the same in both datasets, before and after the live tests:

- 40 images have no `privacy` field; 36 of them are used by documents. Their `_createdAt` is the
  import time, which is after `UPLOADED_SINCE` (2026-11-26T00:00:00Z).
- The image-privacy filter matches 25 documents (blog posts, projects, services and testimonials;
  2 of them drafts). The next create or update event of any of them starts the Function, which
  checks those images.
- **Expected outcome:** each is marked `clean` and nothing else changes. The Functions' own analyzer
  (`analyzeImage`) finds no personal item in the stored bytes of any of the 110 images (see
  [2](#2-privacy-scan-of-every-asset-public-cdn)).
- The other 3 Functions match nothing: the ASCII-art and video filters match 0 documents, and the
  upload-privacy sweep finds 0 uploads.

This is the open decision from dataset-recreate.md: accept one check per image, or let
image-privacy skip `source.name == "wagtail"`.

### 3. `history-check` false positive (low)

- **What.** Both datasets' `history-check` printed FAIL with 11 "transaction before the import"
  failures each. They are the 10 `_.groups.*` documents and `_.retention._maximum_project`. The
  dataset creation writes them: at 20:40:52.69 on staging and 21:00:05.34 on production, 1.3 and
  1.7 s before the import start the script printed (20:40:54, 21:00:07).
- **Checked independently.** No current document has a transaction before the dataset's first
  transaction. The first content transaction is at 20:40:58.9 (staging) and 21:00:11.0
  (production), both after the import start.
- **Fix (either):**
  - `scripts/recreate-dataset.sh`: take `import_start` (line 84) before `sanity datasets create`
    (line 75), and name it "dataset creation".
  - `history-check` (`src/recreate.ts`, line 386): accept `_.` documents whose first transaction is
    not older than the dataset's own first transaction.
- **Its other numbers are right.** The deleted-id part passed on both datasets, and this package's
  probe agrees with it (see [1](#1-history-api)).

### 4. upload-privacy took over two referenced uploads (low)

- **What.** In T1, the testimonial's two PNGs were referenced by the scratch draft 0.5 and 0.6 s
  after their upload. upload-privacy should then leave them to the content Functions ("used by a
  document; the content Functions handle it"), as it did for the JPEG of T2 and the video of T3.
- **What happened instead.** It took the lease 1.4 and 1.5 s after the uploads, so it did not wait
  even one poll interval (5 s). It stripped each image through image-privacy's own processing,
  moved the draft's references and `asciiArtSource` in one patch, and deleted the upload.
  image-privacy saw the lease and logged "no image needs work".
- **Effect.** None on the result: the same copy, the same patch and the same deletion as
  image-privacy would make. The ASCII art was not made again. No conflict, and no error in any log.
- **Cause.** Not determined: the logs have one-second resolution and do not say which condition
  ended the wait. A possible cause is that the reference query briefly did not see the draft.
- **Suggestion.** Log which condition ends the wait, and the reference count `handleUpload` saw.

### 5. Deleted uploads stay in the History API (low, by design)

See [What the live tests left in staging](#what-the-live-tests-left-in-staging). Every future
upload leaves the same trace.

## 1. History API

Script `history_probe.py` (local, `~/cjoshmartin-migration/recreate-verify/scripts/`), 21:19 to
21:40 UTC, 39,704 requests.

**Ids probed.** Every id in `dataset-exports/ids/local-ids.json` (625), plus every asset id and
document `_id` named anywhere under `~/cjoshmartin-migration/privacy/`. That search read file names
and all 71,886 non-media files, with no directory skipped, and found 33 more ids. They are mostly
test fixtures and 2 Presentation secrets. An id counts as deleted when the dataset does not hold it
now.

**For each deleted id:**

- its transaction log (read token);
- anonymous reads of `/data/history/<dataset>/documents/<id>` at:
  - every time and revision id the pre-delete baseline recorded for it;
  - every full hour of the old dataset's life (26 on staging, 28 on production);
  - one second before the new dataset's creation;
  - now.

| | staging | production |
|---|---|---|
| Deleted ids (asset ids) | 389 (335) | 387 (335) |
| Of the 356 ids the pre-delete baseline probed: with a transaction then | 346 | 192 |
| Of the 356: readable without a token then | 344 | 192 |
| **With a transaction now** | **0** | **0** |
| Anonymous probes now | 13,160 | 12,526 |
| **Probes that returned a document** | **0** | **0** |

**Current documents** (raw perspective: every published document, draft, asset and system document):

| | staging | production |
|---|---|---|
| Documents | 281 | 283 |
| Transactions | 555 | 557 |
| First transaction (dataset creation: `_.groups.*`, `_.retention.*`) | 20:40:52.689 | 21:00:05.337 |
| Import start printed by the script | 20:40:54 | 21:00:07 |
| First transaction of a content or asset document | 20:40:58.915 | 21:00:11.029 |
| Last transaction of a content or asset document | 20:42:31.405 | 21:01:36.570 |
| `_.schemas.<dataset>` (schema deploy) | 20:42:51.537 | 21:01:57.295 |
| `_.groups.*` updated (Functions redeploy adds their robots) | 21:07:02.586 | 21:07:02.582 |
| Documents with a transaction before the dataset's creation | 0 | 0 |
| Anonymous reads at the old documents' times and revisions, and one second before the creation | 8,553 | 4,123 |
| **Returned a document** | **0** | **0** |

The current documents' history therefore starts with the dataset's creation, then the import, the
schema deploy and the Functions redeploy, and nothing else. This was measured before the live
tests; they added their own transactions afterwards (see below).

## 2. Privacy scan of every asset, public CDN

Script `download_assets.py`, 21:19 to 21:25 UTC.

- **Listing.** The asset documents were listed with an anonymous query.
- **Downloads.** Without a token: each asset's plain URL, and `?dl=` for the 110 images. With the
  read token: the stored bytes of the images (`?dlRaw=true`), because the public plain URL
  re-encodes most images. Those stored bytes were then checked against `sha1hash`.

| | staging | production |
|---|---|---|
| Asset documents readable without a token | 173 (110 images, 63 files) | 173 (110 images, 63 files) |
| Plain URL, HTTP 200 without a token | 173/173, 479,028,451 bytes | 173/173, 479,028,451 bytes |
| Files equal to their `sha1hash` | 63/63 | 63/63 |
| Images: stored bytes equal to `sha1hash` / plain equal to stored / `?dl=` equal to stored | 110 / 22 / 18 | 110 / 22 / 18 |
| Asset documents with `metadata.location` / `metadata.exif` / `privacy.strippedFrom` | 0 / 0 / 0 | 0 / 0 / 0 |
| Image `metadata` keys | `blurHash`, `dimensions`, `hasAlpha`, `isOpaque`, `lqip`, `palette` | same |
| Asset ids and fields | the same 173 ids as the pre-recreate snapshot; every field equal apart from `_rev`, `_updatedAt`, `_createdAt`, `uploadId`, `path` and `url` | same |

**Scan 1, recheck 3's independent scanner** (`scan_cdn.py`, reusing
`privacy/recheck3/scripts/scan.py`), on 393 files per dataset (173 plain, 110 `dl`, 110 stored):

- **Fingerprints.** They were derived here from the 11 local originals that carry a location (found
  with exiftool in `~/cjoshmartin-migration/gcs`): 5 ISO 6709 strings, 12 EXIF GPS rationals and
  105 decimal texts.
- **Byte signatures:** ISO 6709, QuickTime location and device keys, `©xyz`, GPS text, `mebx`,
  `hoov`, EXIF, XMP and IPTC.
- **exiftool** `-a -u -G1 -ee3`, with tags grouped by kind.
- **ffprobe packet coverage** of every `mdat`.

| Result | staging | production |
|---|---|---|
| Location fingerprint hits | 0 | 0 |
| Location tags / identifier tags | 0 / 0 | 0 / 0 |
| Device tags | `ItemList:Encoder` (ffmpeg) in the 29 MP4s | same |
| People tags | `PDF:Creator` in the 2 PDFs (the printing browser, known R2-7) | same |
| Capture times | the 2 PDFs' dates | same |
| Byte signatures | `Exif` header in 4 files (orientation-only EXIF, known) | same |
| ISO BMFF files: `mdat` bytes outside the packets / of them not zero | 58 files: 2,168,815 / 0 | same |

**Scan 2, the Functions' own checks** (`functions-scan.mts`, importing `studio/functions/privacy`):

- Images: `analyzeImage` on all 330 image files per dataset (110 images in 3 variants). **0
  personal items.** Technical items only, over the 3 variants: 6 orientation-only EXIF blocks and
  2 Apple `iDOT` hints.
- The 29 video originals (`video-strip-v2`): `checkStrippedIsobmff`. **0 problems.** 2,168,815
  unused `mdat` bytes, all zero.
- The 29 converted MP4s: the converter's box rule (`checkIsobmffBoxes` with `allowEncoderTag`),
  **0 problems.** `checkStrippedIsobmff` lists only ffmpeg's `udta` (encoder `Lavf63.1.101`) and
  its handler names `VideoHandler`/`SoundHandler`. This is the known encoder tag, not personal.
- The 3 STL and 2 PDF files: `findMetadataSignatures` over all bytes, 0.

## 3. Validation and compare

| Run | Result |
|---|---|
| `npm run migrate -- --dataset production --confirm-production --steps validate` (21:24:33 to 21:26:52) | **13/13 pass.** `privacy`: 173 assets, 0 with personal metadata, 99/99 copies marked, 0 unstripped uploads left, 0 documents naming a missing asset (271 searched) |
| `npm run migrate -- --dataset staging --steps validate` (21:27:24 to 21:29:48, before the live tests) | **13/13 pass**, same figures (269 searched) |
| The same on staging after the live tests and their cleanup (21:42:24 to 21:44:42) | **13/13 pass** |
| Own compare, every document in the raw perspective including system documents (`compare_datasets.py`), before and after the live tests | 280/280 shared ids equal (ignoring `_rev`, `_createdAt`, `_updatedAt`, `uploadId`, and the dataset name in asset paths and URLs). Only in staging: `_.schemas.staging`. Only in production: `_.schemas.production` and 2 `sanity.previewUrlSecret` drafts (Presentation tool secrets, present before the recreate too) |
| `npm run compare -- --datasets staging,production` (21:45) | 269/269 shared ids identical, NDJSON byte-identical, Portable Text digest `0819ad48e7b0de27` in both (as in privacy review round 2) |

The `_.groups.*` documents are now equal between the datasets, including the Function robots that
the redeploy added.

## 4. Functions

**Deployment** (from `studio/`):

- `npx sanity@latest blueprints info --stack ST-jc4gwa3c4t` lists 4 Functions. Their filters and
  projections are character for character those of the repository's trigger modules (checked with
  `compare-blueprint-info.mts`). Last operation `COMPLETED`, 2026-11-26 21:07:06 UTC, 1 min 49 s.
- `functions env list` shows `PRIVACY_LINK_KEY` on `video-to-mp4`, `image-privacy` and
  `upload-privacy`; `testimonial-ascii-art` has no variables. The value is never shown. The live
  copies' `source.id` and `privacy.strippedFromDigest` equal the HMAC computed with the
  `secrets.env` key, so the deployed key is the same.
- `functions logs` at 21:21 UTC: "No logs found" for all 4. No Function ran between the redeploy
  and the live tests. After the tests, the logs hold only the tests' runs (4 + 8 + 10 + 30 entries),
  with no `ERROR` or `WARN`.

**Live tests on staging** (`live_test.py`, 21:32:15 to 21:33:19 UTC; T4 at 21:38 to 21:40).

- **Media.** `make_fixtures.sh` generated synthetic media with a fresh nonce and fake coordinates.
  No real photo, video or place was used.
- **Upload flow.** Every upload was made first and the reference set right after it, as the Studio
  does. Images were uploaded with the Studio's metadata options.
- **Scratch documents** were drafts (`drafts.recreate-verify-*`), which are not readable without a
  token.

| Input | Contents |
|---|---|
| `art-a.png`, `art-b.png` (900x900) | two different drawings; ImageMagick's PNG date chunks (`date:create`, `date:modify`, `date:timestamp`, `tIME`) |
| `gps.jpg` (2400x1600, orientation 6, Display P3) | EXIF GPS and altitude, make, model, 3 serials, owner, artist, unique id, dates with offset, software, user comment, thumbnail; XMP GPS, city, person, creator; IPTC city and by-line; JPEG comment |
| `phone.mov` (H.264 + AAC, 3 s, display matrix -90) | QuickTime Keys location (ISO 6709), location name, make, model, software and creation date; UserData location, make and model; ItemList location; an unreferenced 180-byte iOS-style `hoov` leftover with a location inside `mdat` |

**T1, testimonial ASCII art.** **Pass.**

- A scratch testimonial draft was created with image A. Art was made from A 3.4 s later.
- The image was then changed to B. New, different art was made from B 2.1 s later.
- `testimonial-ascii-art` ran exactly twice, once per image.
- The PNGs carry date chunks, so both were replaced by stripped copies. Each time, the image and
  `asciiArtSource` moved together in one patch, and the art was not made again (draft revisions
  read back from the History API). The two uploads were deleted.
- One check of the script failed: it expected A to be marked `clean`. That expectation was wrong:
  ImageMagick's date chunks are capture times, which the stripper removes. Who did the stripping is
  finding 4.

**T2, fake-GPS JPEG in `contentImage` and in a Portable Text `imageBlock`.** **Pass.**

- 4.9 s after the draft was created, both references pointed at one stripped copy. The upload was
  deleted 0.5 s later.
- Crop, hotspot, alt and caption of both, and the block's layout, are unchanged (compared as numbers
  in the draft's revisions). The script's own comparison reported the block as changed, because it
  compared `0.0` with `0` as text. The text block is unchanged.
- The copy is marked `source {name: "image-privacy", id: <digest>}` and
  `privacy {status: "stripped", version: "image-strip-v1", strippedFromDigest: <digest>}`. It does
  not name the upload's id or sha1. Its metadata has no location or EXIF.
- The copy's stored bytes (sha1 checked) and its public CDN bytes have 0 personal tags and 0 fake
  markers. Orientation 6 and the ICC profile are kept. The pixels are identical to the upload's
  (ImageMagick signature).
- The deleted upload answers 404, plain without a token and with `dlRaw` and the token.

**T3, fake-GPS phone video in a `video` block.** **Pass.**

- `ready` 10.3 s after the draft was created (`processing`, then `ready`). The upload was deleted
  1.9 s later.
- `conversion` names the stripped original as source and the MP4 as output, with
  `originalStripped: true`, `stripVersion: "video-strip-v2"` and settings `h264-crf23-max1920-v2`.
- **The stripped original** (`source.name` `video-to-mp4-original`, the digest as `source.id`,
  `privacy` stripped `video-strip-v2`):
  - only the video and audio streams; rotation -90 kept;
  - every packet identical to the upload's (framemd5 of a stream copy, both streams);
  - 0 personal tags and 0 fake markers;
  - `checkStrippedIsobmff`: 0 problems; the 180 unused `mdat` bytes are all zero, so the leftover
    is gone. The same check on the upload, as a positive control, reports 173 non-zero unused bytes
    and 4 location and device signatures.
- **The MP4:** H.264 720x1280 (the rotation applied) and AAC. It decodes without errors, has 0
  personal tags and 0 markers, and passes the converter's box rule.
- The deleted upload answers 404 without a token.
- Function log: lease taken, "stripped (in place)" (`moov/udta`, `moov/meta`, handler names,
  unused `mdat` bytes zeroed), converted, lease released, "unstripped upload deleted", ready.

**T4** is finding 1.

**Cleanup.**

- The script deleted the 3 drafts and the 3 assets it knew of: the T2 copy, the T3 MP4 and the
  T3 original.
- The two T1 copies were made by a Function, so the script did not know them. They were found by
  `_createdAt` and deleted after checking that nothing referenced them. The T4 copy was deleted the
  same way.
- The deletions of the drafts started 3 upload-privacy runs, which found "nothing to do".
- Afterwards staging has 0 `recreate-verify` documents, 0 assets created since the test started,
  and 173 assets. Validation passed again (13/13), the compare is unchanged, and every Function
  filter matches what it matched before.

### What the live tests left in staging

Expected for any future upload. Measured with `history_after_live.py` after the cleanup, before T4
and again after it.

- **Ids.** 12 ids have transactions:
  - 3 scratch drafts (3 to 7 transactions each);
  - 4 uploads: `image-b8eb992a`, `image-8109cb79`, `image-30001f5f` and `file-6fb34cbc`.
    `image-30001f5f` is the T2 upload and again the T4 upload: the same file gives the same id;
  - 4 copies: `image-0cf6c183`, `image-ac5b3d70`, `image-4188db8f` (T2, and again T4) and
    `file-8287054d`;
  - 1 MP4: `file-fa8ba276`.
- **A reused id.** Once an id is created again (T4), its transaction log lists only the new
  transactions. The probes of section 1 therefore also read at fixed times and at the baseline's
  revision ids, not only at the logged transactions.
- **Drafts:** 0 of 28 anonymous reads returned anything. Their content (synthetic) is readable only
  with a token.
- **Asset documents**, uploads and copies alike: every revision before the delete is readable
  without a token, by time and by revision id (4 to 8 of 6 to 10 probes each; the delete returns
  nothing). The fields are `_id`, `assetId`, `sha1hash`, `path`, `url`, `extension`, `mimeType`,
  `size`, `originalFilename`, `uploadId`, `_createdAt`, `_updatedAt`, `metadata` and `source`.
  - `metadata` holds dimensions, `lqip`, BlurHash, ThumbHash and palette. The LQIP is a tiny
    preview of the picture.
  - Some revisions also hold `privacy` (leases and status), `videoToMp4Lease` and
    `videoToMp4SettingsVersion`.
- **Location and EXIF in history.** With the Studio's options: none, in any revision of T1 to T3.
  T4 is the exception (finding 1).
- **The original file names are public in history.** Here they were synthetic and contained the
  nonce. For real uploads, this is the phone's file name (`IMG_1234.MOV`).
- **CDN, after the cleanup:**
  - The deleted uploads (4 ids) answer 404. The Functions read uploads only privately, so their
    bytes never entered the public cache.
  - The T2 copy and the T3 MP4, which this package downloaded publicly during the test, are still
    served from the CDN cache (200, `s-maxage=2592000`).
  - The other copies answer 404.
  - Deleting one asset does not purge its CDN path (compare 6).

## 5. Frontend against production

**Build.**

- `git archive` of `8729ee1` into `~/cjoshmartin-migration/recreate-verify/frontend-build`, with the
  repository's `.env.local` (dataset `production`), `npm ci`, then `next build`.
- Next.js 16.3.4 built 19 routes and the proxy; the build log has no errors.
- `next start -p 3000`.

**Routes.** `smoke.mjs` took them from the production dataset, read anonymously:

- 35 pages: `/`, `/?utm_source=test`, `/blog`, `/projects` (plain, `project_type=CLI`, `=PER`, one
  medium, one technology), `/screen`, `/ascii`, `/start-a-project`, `/resume`, `/settings`, the 7
  blog posts, the 13 projects and the 2 flex pages;
- 11 HTTP checks: `/sitemap.xml`, `/robots.txt`, `/resume/pdf`, three unknown slugs, `/info`,
  `/portfolio` and the 3 Sanity redirects.

**Browsers.** WebKit 27.2 at 1440 px and at 390 px (DPR 2), and Chrome for Testing 156.0.8078.4 at
1440 px, through `playwright-core` 1.65.1. For each page:

- status, console and page errors, failed requests;
- every image after a full scroll;
- requests to any of the 328 deleted asset sha1s;
- every `<video>`: it must reach `readyState` 3 or more, play (`currentTime` advances over 2 s),
  have no media error and have a size.

| | WebKit 1440 | WebKit 390 | Chrome for Testing 1440 |
|---|---|---|---|
| Pages answering 200 | 35/35 | 35/35 | 35/35 |
| Images loaded / broken | 135 / 0 | 135 / 0 | 135 / 0 |
| Videos playing (muted, loop, inline, controls) | 29/29 | 29/29 | 29/29 |
| Requests to a deleted asset | 0 | 0 | 0 |
| Failed first-party requests (`localhost`, `cdn.sanity.io`) | 0 | 0 | 28, all `net::ERR_ABORTED` on 7 pages |

- **The 29 videos** are on 6 pages: 2 blog posts (3 and 3) and 4 projects (1, 4, 8 and 10).
- **HTTP checks:** 11/11.
  - The sitemap lists 21 URLs.
  - The three unknown slugs answer 404.
  - `/info` and `/portfolio` answer 200.
  - The 3 redirects answer 308 to their destinations.
- **The aborted requests.** `smoke_extra.mjs` captured them again: 20 of 20 were Next.js prefetches
  (`_rsc`, `next-router-prefetch`) cancelled by the next navigation, not failures. The server log's
  5 "The destination stream closed early" errors most likely come from these cancelled streams;
  it has no other error.
- **Filters.** The first medium and technology in alphabetical order (`3D Printing`, `Arduino`)
  show no project. That is correct: no listed (developer-audience) project has them.
  `smoke_extra.mjs` checked the filters again with tags that listed projects use. `medium=Web` (3),
  `medium=Mobile` (2), `technologies=React Native` (2), `technologies=Next.JS` (2) and plain
  `/projects` (6) show exactly the expected projects, by title, in both browsers.
- **Third-party errors only, all known from WP7:**
  - the self-hosted Plausible script fails TLS (`plausible.technicalchicago.com`; also from `curl`);
  - Disqus frame access in WebKit;
  - `browsingTopics` from an ad script in Chrome;
  - Facebook 451, and requests blocked by ORB.

## 6. Old CDN paths of deleted assets

**Probe.** `node migration/verify/src/deleted-asset-cdn-probe.mjs --rounds 2`, 21:28:38 to
21:37:59 UTC, without a token.

- **Paths:** 670 in all, 335 per dataset. These are every asset id from the probe list that the
  dataset does not hold. 26 of them held a location: the 11 local originals by sha1, plus the
  location list of the recreate run.
- **Requests:** 2,168 (plain, and `?dl=` for files).

| | Before the recreate (20:18 UTC, recreate run) | Now |
|---|---|---|
| Deleted paths answering 200 at least once | 168 (81 staging, 87 production) | **0** |
| Of those that held a location | 0 | 0 |

**Second look** (`cdn_variants.py`):

- **What was probed.** The 168 paths served before, and the 26 with a location: 194 paths. Images
  were probed plain, with `?dl=` and with 6 rendition parameter sets (`w=800&auto=format`,
  `auto=format`, `fm=jpg`, the og:image crop, `w=2000&fit=max`, `w=400&q=75&auto=format`). Files
  were probed plain and with `?dl=`. 1,174 requests in all.
- **Result:** all 404.
- **Control:** 20 current assets, all 200.

**Expiry.** Nothing is left to expire on the paths probed from here.

- The cached copies were still served at 20:18 UTC and are gone after the delete. A single asset
  delete does not purge its path (see the T2 copy above), so deleting the dataset appears to have
  purged that dataset's paths.
- Only one network location was probed. For a CDN edge this package cannot see, the worst case is
  still the cache lifetime: `s-maxage=2592000` (30 days) after the last deletion, so
  **2026-12-26**.
- The drafted support email (purge request) is no longer needed for these paths. Its other
  question still is: can a public dataset's History API require a token? See finding 1.

## Not verified

- **No Google Chrome.** Google Chrome is not installed, so Playwright's channel `chrome` was not
  available. WebKit and Chrome for Testing were used.
- **CDN edges.** Only the edges that serve this machine were probed.
- **Production Functions.** The Functions were exercised only on staging, by design. Production's
  filter matches were counted (finding 2).
- **The main session's commits.** The 10 rewritten local commits and their push were not part of
  this package.

## Local files (not committed)

`~/cjoshmartin-migration/recreate-verify/` (mode 700):

| Path | What |
|---|---|
| `scripts/` | `collect_probe_ids.py`, `history_probe.py`, `download_assets.py`, `scan_cdn.py`, `functions-scan.mts`, `compare_datasets.py`, `filter-matches.mts`, `compare-blueprint-info.mts`, `make_fixtures.sh`, `inject_hoov.py`, `live_test.py`, `inspect_drafts.py`, `cleanup_leftovers.py`, `history_after_live.py`, `t4_api_location.py`, `cdn_variants.py`, `smoke.mjs`, `smoke_extra.mjs` |
| `data/` | probe ids, history results, scans, validation and compare results, live-test records, CDN probe results, smoke results |
| `cdn/<dataset>/` | the downloaded assets (`plain/`, `dl/`, `stored/`) and the anonymous asset listing |
| `live/` | the fixtures and the live tests' downloads |
| `logs/` | every run |
| `frontend-build/` | the built frontend |
