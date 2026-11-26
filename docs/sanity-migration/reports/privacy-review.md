# Privacy review: findings and their resolution

Owner decision (2026-11-26): strip location and personal metadata from every asset the public
datasets serve, without re-encoding, for the existing assets and for every future upload.

## Round 1 (2026-11-26, 13:30 to 16:30 UTC)

Fix package for the 16 findings of the metadata-stripping work: package M (the migration's privacy
step), the independent verification (`privacy-verification.md`) and the code review. Commits
`45be6a8`, `5d834c0`, `144a0b3` and this report. Inputs:
[wp3-migration.md](wp3-migration.md#privacy-personal-metadata-stripped-from-every-existing-asset-work-package-m-2026-11-26),
[privacy-functions.md](privacy-functions.md), [privacy-verification.md](privacy-verification.md).

### Verdict

- **No public asset of either dataset carries location or personal metadata any more.** The two
  video originals that still held their exact location (an iOS draft movie header in `mdat`) were
  replaced and their old URLs answer 404 in both datasets.
- **One policy for old and new assets.** The migrated assets now get exactly what a new upload
  gets: the image-privacy Function's image stripper, and one in-place video stripper shared by the
  migration and the video-to-mp4 Function. Per dataset, 99 assets were replaced (70 images, 29 video
  originals) and the old ones deleted. Every copy is lossless: identical decoded pixels, or
  identical packets with their time stamps.
- **No copy links to its unstripped original.** `source.url` is gone from every stripped copy; the
  45 assets that keep one are byte-identical to the bucket object it names.
- **New uploads.** Videos are stripped in place (container, edit lists, time stamps and Dolby
  Vision kept). A new Function, `upload-privacy`, strips and deletes uploads no document uses.
  Release versions are processed. A failed or pending conversion no longer keeps the upload. File
  links accept PDFs only. Everything was deployed and tested live on staging.
- **Checks.** All unit and media test suites pass. Validation passes 13/13 on both datasets, and
  compare finds them identical. An independent byte-level scan of every asset of both datasets
  finds no location fingerprint, no personal tag and no non-zero unused `mdat` byte.

### Findings

| # | Sev. | Finding | Source | Resolution |
|---|---|---|---|---|
| 1 | high | 24 public assets per dataset carried location or personal metadata | M | Confirmed (status report). Done: with finding 6 fixed, no asset has any (independent scan). |
| 2 | medium | ffmpeg stream copy is not lossless for container data | M | Confirmed with the Function's ffmpeg 7.0.2. Fixed: videos are stripped in place in the Function too. |
| 3 | medium | Migration and image-privacy Function apply different policies | M | Confirmed. Fixed: one policy (the stricter one), with the same strippers. |
| 4 | low | Migration depended on an uncommitted constants file | M | Confirmed, resolved by `e521d46`. Every module the migration imports is committed. |
| 5 | low | Presentation preview secrets broke the dataset comparison | M | Not a defect now: compare lists them by id only (production 2) and passes. |
| 6 | high | GPS location left in two public stripped video originals (`hoov` in `mdat`) | verify | Confirmed. Fixed at the root: every unused `mdat` byte is zeroed, with a byte-level check. Data replaced. |
| 7 | medium | Public asset documents link to the unstripped originals in the bucket | verify | Confirmed. Fixed: copies have no `source.url`; validation enforces it. |
| 8 | medium | Uploads that never get (or lose) a reference are never stripped or deleted | verify | Confirmed. Fixed: new `upload-privacy` Function. A scheduled sweep remains the owner's call. |
| 9 | low | Device details in `hoov` leftovers of 7 screen recordings | verify | Confirmed. Fixed with finding 6. |
| 10 | low | Capture metadata kept on migrated assets | verify | Confirmed. Fixed with finding 3: removed. |
| 11 | high | Stripped copies keep `source.url` to the GPS originals | review | Same as 7. Fixed. |
| 12 | medium | Release versions and Scheduled Drafts not processed | review | Confirmed. Fixed: both Functions run on versions; locked releases are left alone, and the sweep catches discarded ones. |
| 13 | medium | Unstripped video uploads that stop being referenced (failed conversion, replaced or removed block) | review | Confirmed. Fixed: once the copy exists the block moves to it on any outcome and the upload is deleted; unused uploads go to `upload-privacy`. |
| 14 | medium | `fileLink` accepts any file type, and no Function strips file assets | review | Confirmed. Fixed: PDF only (accept and validation); `upload-privacy` strips images and videos uploaded as files. PDF metadata stays an open point. |
| 15 | low | image-privacy repoint leaves `asciiArtSource` behind | review | Confirmed. Fixed: it moves with the image (live: the art is made once). |
| 16 | low | AVIF/HEIF self-check never compares `mdat`/`moov` with the input | review | Confirmed. Fixed: both parts come from each file's own bytes; tested with an animated AVIF. |

### 1. 24 public assets carried location or personal metadata (high)

This finding reports package M's own clean-up. It was incomplete because of finding 6, and the
rules behind it were narrower than the Functions' (finding 3). Both are fixed below.

- **Result.** The independent scan of every asset of both datasets (section "Verification") finds
  none of the 17 location fingerprints of the 11 originals that had a location.
- **Old URLs.** The two copies with the `hoov` leftover (`file-ac229f1e…-mov`,
  `file-f09b0f33…-mov`) answer 404 in both datasets.

### 2. ffmpeg stream copy is not lossless for container data (medium)

- **Confirmed with the Function's binary** (ffmpeg-static 5.3.0, ffmpeg 7.0.2, linux/arm64, in the
  Lambda Node image), running the Function's own `stripVideo`:
  - `deep_linking.MP4`: the audio track lost its initial empty edit (81 ticks) and one AAC
    priming packet lost its discard flag. The video edit list was rewritten, and the time base went
    from 1/600 to 1/19200, with another duration.
  - `IMG_3151.MOV`: written as MP4 to keep `dvvC`, with rewritten edit lists and time bases.
  - A macOS screen recording: 96 packets moved by up to 8 ms.
  - In every case the packets stayed identical.
- **Fix: the Function strips QuickTime/MP4 in place**
  (`studio/functions/privacy/isobmff-video.ts`, `stripIsobmffInPlace` in `video-strip.ts`).
  - This is the migration's in-place box stripper, moved into the shared privacy package. The
    migration's copy (`src/privacy/isobmff.ts`) is deleted, so both use one implementation.
  - It is extended with `mdat` zeroing (finding 6), zeroed creation times, cleared handler names,
    a check that each kept track's samples are in this file (`dref`), and a stricter allowlist of
    track, media and sample-table boxes.
  - Nothing moves, so the container, edit lists, time stamps, display matrix, colour, HDR and
    Dolby Vision boxes stay byte for byte. A Dolby Vision MOV stays MOV.
  - The Function checks the result:
    - every byte outside the changed ranges is unchanged (sha256);
    - nothing personal is left, and no location or device signature is outside the samples;
    - the audio and video streams have the same description and side data;
    - every packet is identical with its time stamps and duration (framemd5, streamhash).
  - The ffmpeg stream copy is now only the fallback, for other containers (Matroska/WebM) and for
    ISO BMFF files the in-place stripper refuses (fragmented files, unknown boxes). Its copy says
    in `privacy.message` that the container was rewritten.
  - `VIDEO_STRIP_VERSION` is now `video-strip-v2`.
- **Verified.**
  - Unit tests: 36 in the privacy package.
  - Media tests with the local ffmpeg 9.1 and with the Function's 7.0.2 in Docker. The in-place
    strip of all 29 Wagtail originals passes with 7.0.2: same size, every packet with its time
    stamps, edit lists and Dolby Vision byte-identical, no personal tag. The stream-copy fallback
    passes on all 29 with 7.0.2.
  - Live on staging (tests T2, T4).

### 3 and 10. One privacy policy for migrated assets and new uploads (medium, low)

- **Confirmed.** The migration kept the following, which the Function removes from new uploads:
  - camera make, model, lens, software and host computer;
  - capture times with their UTC offsets (a time zone is a coarse location);
  - free-text comments and XMP editing ids;
  - for videos: the Keys make, model, macOS version and creation date, the `mvhd` times and the
    handler names.
- **Decision taken in this round.** The stricter policy applies to everything. The owner's
  wording ("other personal EXIF/XMP/IPTC", "similar personal tags") covers device and capture
  data. Two rule sets for one decision were the defect. Everything removed is metadata, the
  pixels and samples are untouched, and the bucket originals allow an undo.
- **Fix.**
  - `migration/wagtail-to-sanity` rules `personal-metadata-v2`:
    - new categories `device`, `capture-time` (a zero QuickTime time is no time) and `comment`;
    - XMP editing ids count as identifiers;
    - `metadata` findings: what the Functions' strippers would remove, the container check, and
      the signatures outside the samples.
  - Copies are made with the Functions' strippers: `image-strip.ts` and `isobmff-video.ts`.
  - The migration checks every copy independently:
    - images: identical decoded pixels with ImageMagick and ffmpeg; the same effective
      orientation (no tag, 1 and Android's invalid 0 all mean "not rotated"); a byte-identical ICC
      profile; every tag left unchanged (WebP may only clear its EXIF/XMP flags); a clean rescan;
    - videos: the ffprobe checks of package M (packets with byte positions, stream descriptions,
      format), the unchanged bytes outside the changed ranges, and the new byte-level scan.
  - A copy made under older rules or stripper code is replaced by the current copy of its bucket
    original, never by a copy of the copy.
  - The privacy map records a fingerprint of the stripper sources (`5d834c0`) and starts over when
    it changes. A copy that comes out with the same bytes keeps its strip time, so nothing
    changes in the dataset.
  - The PDFs' `Creator`, `Producer` and dates stay (see open points).
- **Consequences.**
  - EXIF thumbnails are removed.
  - The HDR gain maps of `IMG_9344.jpeg` and `IMG_5509.jpg` are removed with the rest of the data
    after the primary image (MPF). The primary image's pixels are unchanged. The CDN renditions
    of the copies carry no MPF data (spot check). The old assets' renditions cannot be compared,
    because those assets are deleted.

### 4. Uncommitted constants file (low)

Confirmed for `fb1e00d` alone: that commit imported `studio/functions/privacy/constants.ts`, which
was committed in the next commit, `e521d46`. History is not rewritten (the branch is pushed). At
`144a0b3`, every file the migration imports from `studio/functions` is tracked.

### 5. Presentation preview secrets and the comparison (low)

This finding describes a change package M made, not an open defect. `npm run compare` reports
"`sanity.previewUrlSecret` documents (Presentation tool sessions, not compared): staging 0,
production 2" and finds the two datasets identical (16:21 UTC). The documents are not read.

### 6 and 9. Location in unused `mdat` bytes: the iOS draft movie header (high, low)

- **Confirmed.** On the local originals, the planner reports non-zero unused `mdat` bytes:
  - 60,970 in `IMG_0169.MOV` and 48,893 in `IMG_3151.MOV` (with their location);
  - 6,552 to 14,970 in each of the 7 `Screen_Recording_2025-05-05_*` files that have a leftover
    (device details).
- **Root cause.** The in-place stripper kept every byte it did not remove explicitly, and its check
  ("nothing else changed", exiftool, ffprobe) could not see bytes that no track references.
- **Fix.**
  - `planIsobmffStrip` computes every `mdat` byte that no kept track's sample tables reference.
    The ranges come from `stco`/`co64`, `stsc` and `stsz`/`stz2`, not from ffprobe, which does not
    list every data-track sample. The plan sets those bytes to zero.
  - `checkStrippedIsobmff` requires no non-zero unused byte. It also requires that no ISO 6709
    pattern, `com.apple.quicktime.location`/make/model/... key, `©xyz`, XMP GPS name or `mebx`
    appears anywhere outside the kept samples.
  - The migration's scan and the validation's `privacy` check use the same check, so validation
    now fails on such a file.
- **Data.**
  - The privacy step replaced all 29 video originals in both datasets, then once more after
    handler names were added to the strip. 29 replacements and 35 patched documents per dataset
    each time; the MP4s keep their bytes and their `source.id` moved.
  - Old copies deleted; old URLs 404.
- **Verified.**
  - The independent `mdat` coverage check of the verification package reads ffprobe sample
    positions (58 videos per dataset): 0 non-zero unused bytes, 0 markers.
  - The independent byte search finds 0 fingerprint hits.

### 7 and 11. Copies linked to the unstripped bucket objects (medium, high)

- **Confirmed.** All 24 copies had `source.url` = the public bucket object with the GPS.
- **Fix.**
  - `withStrippedCopy` (assets and videos steps) and `descriptiveFields` (privacy step) drop `url`
    from a copy's `source`.
  - Validation expects no `url` on a copy.
  - The `privacy` check requires every `source.url` to name a bucket object with exactly the
    asset's bytes, which are scanned clean.
- **Result.** Both datasets: 0 stripped copies with `source.url`. The 45 assets with one are
  byte-identical to their bucket object.
- **Still true.** The unstripped originals remain public in the bucket until the WP6 lockdown
  (bucket permissions are outside this package). Nothing in the datasets points at them any more,
  but their paths are the Wagtail ones the old site used.

### 8, 12, 13. Uploads the Functions never saw, release versions, failed conversions (medium)

- **Confirmed.** All three are true of the deployed `e521d46` code. Finding 12 matches the docs:
  without `includeAllVersions`, version events do not start a Function, and video-to-mp4 skipped
  versions in delivery.
- **New `upload-privacy` Function** (`studio/functions/upload-privacy`):
  - **Trigger.** `create` of an image or file asset since 2026-11-26 that the migration or a
    Function did not make (by `source.name`), and `delete` of any content document, draft or
    release version. The filter uses delta functions.
  - **On an upload.** Any `metadata.location`, `exif` or `image` an API client asked Sanity to
    extract into the public asset document is removed at once (live: 5.1 s). The run then waits up
    to 60 s for a document to use the upload.
  - **An upload still unused** is stripped like the content Functions do it:
    - images through image-privacy's own processing, now `createImageAssetProcessor`;
    - videos through video-to-mp4's `stripOriginal`, with the same verified ffmpeg;
    - images uploaded as file assets through the image stripper into a file copy.

    The copy stays in the media library and the upload is deleted.
  - **Sweep.** Every run then sweeps up to 5 earlier unused uploads that still have their metadata:
    unchecked, `replaced` but not deleted, a due retry, or a stale lease.
- **video-to-mp4.**
  - A clean upload (nothing personal) is kept as it is and marked `clean`.
  - Once the stripped copy exists, every result moves the block off the upload:
    - `ready`: `file` = the MP4, `original` = the copy;
    - `failed` or `pending`: `file` = the copy, so a retry converts the copy.

    The upload is then deleted on any outcome.
  - The upload is marked `replaced` by its copy.
  - A run waits up to 5 minutes for a strip that the upload sweep is running on the same upload,
    instead of stripping it twice.
- **Release versions.**
  - Both content Functions run with `includeAllVersions`.
  - video-to-mp4 delivers to versions too.
  - A version whose release is not `active` (scheduled, published, archived) is never written
    (`privacy/releases.ts`). Its upload stays `replaced` until the release publishes (the
    published document's event) or is archived (the delete event's sweep).
- **Tests.**
  - Unit tests: video-to-mp4 115 (new: failure and retry after the strip, strip failure, clean
    upload, the wait for the sweep, active and locked releases); image-privacy 31; upload-privacy
    15 (the filter and sweep query with groq-js in delta mode, and the orchestrator with the real
    image stripper).
  - Live: T1 to T5 below.
- **Not closed: a scheduled sweep.** It needs the Blueprint stack promoted to the organization
  (one-way) and a robot token, which is the owner's call. Until then one rare case waits for the
  next upload or deletion in the dataset: a `replaced` or unchecked upload whose last reference is
  removed by an edit (not a deletion) while no Function is working on it.

### 14. File links (medium)

- **Confirmed.** No `options.accept`, and no Function looked at file assets other than video blocks.
- **Fix.**
  - `fileLink.file` has `options.accept: ".pdf,application/pdf"`.
  - A validation error (`fileLinkProblem`) names photos and videos and sends them to their blocks.
  - No document has a file link today, so nothing breaks.
  - `upload-privacy` strips images and videos that reach the dataset as file assets anyway (an API
    client, or a pick before this change). Live T5: a GPS JPEG uploaded as a file and linked from
    a draft was left alone while linked; after the draft's deletion the sweep replaced it with a
    clean file copy in 5.6 s and deleted it.
- **Open.** PDF and STL files are not stripped by any Function. The migration checks STL headers
  and people's names in PDFs; the two résumé PDFs keep `Creator` (the printing browser),
  `Producer` and their dates.

### 15. `asciiArtSource` (low)

- **Confirmed.** The repoint moved only `_ref`.
- **Fix.** `repointSet` moves a testimonial's `asciiArtSource` in the same patch as its image.
- **Verified live (T6).** The image and `asciiArtSource` moved to the copy within 8.7 s. The
  testimonial-ascii-art Function ran once, for the upload, and not again after the repoint.

### 16. AVIF/HEIF self-check (low)

- **Confirmed.** The input-side digest of `mdat` and `moov` came from the built output, so the
  check compared the output with itself.
- **Fix.** The digests now come from each file's own bytes:
  - `mdat` with only the removed items' extents zeroed;
  - `moov` without its metadata boxes and with its creation times zeroed.
- **Verified.** New media test with an animated AVIF (an image sequence): it strips losslessly
  (every frame), and a changed sample byte or a changed sample-table entry changes the digest.
  Image media tests: 14/14 pass.

### Verification

**Tests.**

| Suite | Result |
|---|---|
| `studio/functions/privacy` `npm test` | 36/36 |
| `studio/functions/privacy` media: images | 14/14 (local tools) |
| `studio/functions/privacy` media: videos | 7/7 with local ffmpeg 9.1. With the Function's 7.0.2 in Docker and all 29 originals, 9/9: the in-place strip of all 29, and the stream-copy fallback of all 29 in a second run (the first failed in the test's own helper on ffmpeg 9.1's new `streamhash` format, then on a stopped Docker daemon) |
| `studio/functions/image-privacy` | 31/31 |
| `studio/functions/video-to-mp4` unit / `test:ffmpeg` | 115/115 / 9/9 |
| `studio/functions/upload-privacy` | 15/15 |
| Studio `npm test`, typecheck, lint | 69/69, clean, clean |
| `migration/wagtail-to-sanity` `npm test` / `test:ffmpeg` | 93/93 / 12/12 |

**Datasets.**

| Check | staging | production |
|---|---|---|
| Privacy step, rules v2 | 99 replaced (70 images, 29 originals), 50 documents patched; then 29 originals again for the handler names (35 documents) | same |
| Rerun | nothing to replace | same |
| `validate` (13 checks) | pass (16:11 UTC) | pass (16:17 UTC) |
| `privacy` check | 173 assets, 0 with personal metadata, 99/99 copies marked, 0 unstripped left, 45 source URLs each serving the asset's own bytes | same |
| `hashes` | 44 equal to `file_hash`, 67 stripped copies with the Wagtail original's decoded pixels, 5 explained | same |
| `compare` | 269/269 shared ids identical, NDJSON byte-identical, Portable Text digest `0819ad48e7b0de27` | same |
| Independent scan (verification scripts, own rules; public CDN bytes and `dlRaw`) | 173 assets, 0 location fingerprint hits (17 fingerprints from 11 originals), 0 personal tags; 2 `PDF:Creator` hits are the printing browser | same |
| Independent `mdat` coverage (58 videos) | 0 non-zero unused bytes, 0 markers | same |
| CDN renditions (4 formerly GPS-tagged or MPF images × plain, `w=800&auto=format`, og crop, `fm=png`) | n/a | 0 metadata tags |

**Live on staging** (scratch documents, generated media with fake location data; everything
cleaned up, 0 documents and 0 assets left):

| Test | Result |
|---|---|
| T1: image uploaded with `meta=exif,location`, never used | Extracted location gone after 5.1 s. After 65 s: a stripped copy and the upload deleted (dlRaw 404). Copy: 0 personal tags, 0 markers. |
| T2: video (Keys, UserData and ItemList location, subtitle, `gpmd` and timecode tracks, `hoov` leftover), never used | After 68 s: in-place copy (`video-strip-v2`) with the same size, the same packets with time stamps and the same edit lists; 0 personal tags, 0 markers; the upload is deleted (404). |
| T3: audio-only clip in a video block | Stripped in place; the conversion failed ("no video stream"); `file` moved to the copy; the upload was deleted within 3 s. |
| T4: image and video in a version of an active release | The image moved to a stripped copy (alt kept). The video was stripped in place and converted, so `original` is the copy. Both uploads were deleted in 12.9 s. A first run hit the known frame-check failure (see open points); the block then moved to the copy and the upload was deleted, which is the finding 13 fix. |
| T5: JPEG uploaded as a file, linked by `fileLink`, then the draft deleted | Left alone while linked; the delete event's sweep replaced it with a clean file copy in 5.6 s. |
| T6: testimonial with a GPS photo | Image and `asciiArtSource` on the copy in 8.7 s; ASCII art made once. |

**Deployment.**

- `npx sanity@latest deploy --yes`: 2/2 schemas, Studio deployed. The served bundle equals the
  local build (sha256), which contains the file link rule.
- `npm_config_platform=linux npm_config_arch=arm64 npx sanity@latest blueprints deploy`: operation
  `OP-n7izrdkkaa`, 4 Functions updated or created. The video-to-mp4 and upload-privacy bundles
  carry the linux/arm64 ffmpeg (sha256 `6bb182d0…`).

**Environment events during the round.**

- **ffmpeg 9.1.** Homebrew upgraded the local ffmpeg from 9.0.1 to 9.1 at 13:49 UTC, in the middle
  of the first staging run. ffmpeg 9.1's file demuxer reads a JPEG's MPF index and then decodes
  the primary image's last row of blocks wrong ("overread 8"). The migration's pixel check
  therefore decodes JPEGs with the plain JPEG demuxer, first frame only. ImageMagick and ffmpeg
  9.0.1 agree on it.
- **streamhash.** ffmpeg 9.1 writes a new `streamhash` format (version 2). The parser reads both;
  the Function's 7.0.2 writes the old one.
- **Docker.** Docker stopped once during the media tests. The affected run was repeated after a
  restart.

### Open points for the owner

1. **Scheduled sweep (finding 8).** Promote the Blueprint stack to the organization (one-way) and
   add a robot token, then a scheduled Function can run the same sweep (`SWEEP_QUERY`) hourly.
   Without it, a leftover waits for the next upload or document deletion.
2. **Bucket.** The unstripped originals stay public in `images-for-cms` until the WP6 lockdown.
   No dataset links to them any more.
3. **PDFs.** No Function strips PDF metadata. The two résumés keep the printing browser, the
   producer and their dates.
4. **Intermittent frame-check failure (pre-existing, privacy-functions open issue 1).** It was
   seen again once on Lambda: "the MP4 has 120 frames for 119 input frames", for a file that
   converts cleanly with the same bundle and ffmpeg 7.0.2 in the Lambda image (3 runs) and on the
   second live try. The failure is final for that file, so the editor has to upload again.
   Privacy is no longer affected: the block moves to the copy and the upload is deleted.
5. **Gain maps.** The stored copies of `IMG_9344.jpeg` and `IMG_5509.jpg` have no HDR gain map
   any more (the unified policy removes everything after the primary image).
