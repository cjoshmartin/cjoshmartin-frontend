# Work package F: strip location and personal metadata from every future upload

Status: **done, deployed, live-tested on staging.** Every image added to a document after
2026-11-26 is checked by the new `image-privacy` Function and, when it carries personal metadata,
replaced by a lossless copy without it; the unstripped upload is deleted. Every video uploaded in
the Studio keeps its original as a stream copy without location and personal metadata; the
unstripped upload is deleted. The Studio only accepts image formats that can be stripped
losslessly and never asks Sanity to extract EXIF, camera or location data. Open issues are listed
at the end.

> **Later, 2026-11-26 (not reflected below).** The [privacy review](privacy-review.md) changed this
> design: video originals are stripped in place (`video-strip-v2`) instead of by a stream copy, a
> third Function (`upload-privacy`) handles uploads no document uses, copies record a keyed digest
> instead of the upload's id, and the Functions read uploads privately. Finding 3 below is wrong:
> the plain image CDN URL serves 22 of the 110 images per dataset as stored (review R2-6). Then
> both datasets were deleted and created again, so that the History API no longer serves the
> deleted uploads ([dataset-recreate.md](dataset-recreate.md), which has the current state). The
> rules in force are in "Privacy" in [`schema-contract.md`](../schema-contract.md).

Owner decision being implemented (2026-11-26): strip location and personal metadata from every
asset the public datasets serve, without re-encoding; keep orientation and ICC profile for photos
and the streams, rotation and colour tags for videos; delete an unstripped upload once a stripped
copy replaces it and nothing references it.

## Findings that shape the design

1. **No perl in the Function runtime.** In `public.ecr.aws/lambda/nodejs:24` (linux/arm64, Node
   v24.22.3, the same runtime facts as video-spike.md): `perl`, `python3`, `tar`, `gzip` and `file`
   are absent; `curl` and `ldd` are present. exiftool cannot run there, so the image stripper is
   pure TypeScript (no dependencies), and the video stripper uses the bundled ffmpeg 7.0.2.
2. **Formats Sanity accepts as images** (probe uploads to staging, deleted afterwards): JPEG, PNG,
   WebP, GIF, AVIF, TIFF and SVG are accepted. HEIC is refused with `422 Invalid image ... Support
   for this compression format has not been built in: HEVC`. BMP is refused (`Input buffer contains
   unsupported image format`).
3. **The image CDN never serves the stored image anonymously.** The plain asset URL (also with `?dl=`)
   returns a re-encoded rendition with no metadata at all, but also no EXIF orientation (pixels
   rotated), a different colour handling and different pixels. `?dlRaw=` returns the exact stored
   file (sha1 matches the asset) and requires a token: anonymous requests get `401 Missing or invalid
   token`. So an image's GPS was never downloadable from the CDN without a token; the stored bytes
   and the public asset document are what this package cleans. Videos (file assets under
   `/files/`) are served as stored, so their originals were publicly downloadable.
4. **ffmpeg 7.0.2's QuickTime muxer cannot write Dolby Vision `dvvC`**, even with `-strict
   unofficial`; its MP4 muxer can. A stream copy of `IMG_3151.MOV` (HEVC, Dolby Vision 8.4) as MOV
   loses the DOVI record; as MP4 it keeps it.
5. **ffmpeg's muxer moves packets whose source time stamps repeat.** macOS screen recordings have
   runs of packets with equal decode time stamps; ffmpeg must make them increasing and moves them by
   one tick each (at most 9.8 ms in the 29 Wagtail videos). Packet contents are identical. A few
   files also get another duration for their last packet (at most 0.66 ms).
6. **The video-to-mp4 frame check failed once on Lambda without a reproducible cause** (open issue
   1).

## What changed

All under `studio/` plus the contract.

| Path | Change |
| --- | --- |
| `studio/functions/privacy/` (new) | Shared strippers and constants, with `package.json`, tests and README. `constants.ts` (versions, asset `privacy` field, statuses, source names, accepted formats, image metadata options; no imports, so the Studio and the migration import it), `image-strip.ts` + `exif.ts`, `jpeg.ts`, `png.ts`, `webp.ts`, `gif.ts`, `isobmff-image.ts` (AVIF/HEIF), `tiff.ts`, `video-strip.ts`. |
| `studio/functions/image-privacy/` (new) | The Function: `trigger.ts`, `orchestrator.ts`, `sanity.ts`, `index.ts`, tests, README. |
| `studio/functions/video-to-mp4/` | New `strip-original.ts`; `orchestrator.ts` strips (or reuses a stripped copy) before converting, converts the copy, sets `original` to it and deletes the upload; `patches.ts`/`trigger.ts` add `conversion.originalStripped` and `conversion.stripVersion`; `sanity.ts` adds the stripped-copy lookup, the guarded delete and `strip`; `convert.ts` also checks the MP4's boxes for metadata; `scripts/live-check.ts` checks the new contract; tests and README updated. |
| `studio/sanity.blueprint.ts` | New `image-privacy` document Function (2 GB, 300 s, nodejs24.x, drafts included). |
| `studio/schemaTypes/` | Every image field and type (`person.image`, `testimonial.image`, `service.image`, `imageWithAlt`, `imageBlock`) gets `options` `{hotspot, accept, metadata}`, the `ImagePrivacyInput` and the privacy validation (`shared/image-privacy.ts`, `shared/image-validation.ts`); `video.conversion` gets `originalStripped` and `stripVersion`; the video preview says whether the original was stripped (`shared/video-conversion.ts`: `videoOriginalState`, `videoPreviewSubtitle`). |
| `studio/components/ImagePrivacyInput.tsx` (new) | Shows under each image what the Function is doing or found, live (listens to the asset document). |
| `studio/schema.json` | Re-extracted (the two new `conversion` fields). |
| `studio/test/image-privacy.test.ts` (new), `studio/test/video-conversion.test.ts` | Studio-side tests. |
| `docs/sanity-migration/schema-contract.md` | New "Privacy" section; image options, video fields, converter steps, preview, validation and imports updated. |

## Image stripper (`studio/functions/privacy/image-strip.ts`)

- Format detection from the bytes. Per format, the removed items with a personal/technical flag,
  the orientation, the ICC profile, the coded-image parts, and a deterministic `strip()`.
- **Kept**: the coded image byte for byte; the orientation (EXIF Orientation 2-8, rewritten as an
  orientation-only big-endian EXIF block; AVIF/HEIF use `irot`/`imir` properties, kept); the ICC
  profile; JFIF (without thumbnail), Adobe APP14; PNG colour, transparency, animation and physical
  size chunks; WebP VP8X (flags fixed), ANIM, ANMF, ALPH; GIF looping and graphic control; TIFF
  image tags (strips and tiles copied, offsets rewritten; nothing unreferenced is copied).
- **Removed**: EXIF beyond the technical tags (GPS, make, model, serials, maker notes, lens,
  settings, dates, software, authors, comments, thumbnails), XMP, IPTC/Photoshop, comments, MPF and
  everything after the end of the image (gain maps, depth maps, motion-photo videos), PNG text
  chunks, `tIME`, C2PA, unknown chunks and boxes, AVIF `Exif`/`mime`/`uri ` items (meta rebuilt
  and padded with a `free` box so every offset stays valid; removed item bytes zeroed).
- **Left alone** when nothing personal is found (an EXIF block with only orientation, size,
  resolution and colour-space tags counts as technical, as does Apple's `iDOT`).
- **Self-check before returning**: same format, nothing personal left, same coded-image sha256,
  same orientation and ICC profile, and stripping the result again changes nothing. Any failure
  throws (the Function records `failed`).
- **Not supported** (Studio refuses them): SVG (free-form XML metadata cannot be removed with a
  guarantee that the drawing is unchanged), HEIC (Sanity refuses it anyway), BMP, BigTIFF,
  old-style JPEG-in-TIFF.

## Video stripper (`studio/functions/privacy/video-strip.ts`)

`ffmpeg -i <in> -map 0:<each video and audio stream> -c copy -map_metadata -1 -map_chapters -1
-fflags +bitexact -strict unofficial -f <mov|mp4|webm|matroska> <out>`. Container: QuickTime brand
stays MOV, other ISO BMFF brands MP4, Dolby Vision becomes MP4 (keeps `dvvC`; with PCM audio it
stays MOV and reports the Dolby Vision record as dropped), Matroska stays Matroska/WebM, anything
else becomes Matroska. Removed: file and stream metadata (QuickTime keys and user data: location,
make, model, software, creation dates), data tracks (`mebx`), subtitles, attachments, cover art,
chapters, and every creation/modification time. Then it checks, with the same ffmpeg: the stream
list (kinds, codecs, pixel format and colour description, size, sample rate, layout), every side
data entry (rotation, HDR, ambient viewing, DOVI), the metadata keys left (only brand and handler
fields), the MP4/QuickTime boxes (no `meta`/`udta` content, `uuid` or non-video/audio track, zero
times), and every packet (framemd5: size, MD5, time stamps and duration; streamhash: sha256 per
stream). Moves of repeated time stamps and last-packet durations up to 50 ms are allowed and
reported (finding 5).

## image-privacy Function

- **Trigger decision: the content documents, not the asset documents.** A Studio upload creates
  the asset first and patches the reference in afterwards; a run started by the asset event could
  find no reference and, worse, deleting the upload then makes the Studio's reference patch fail.
  On the document's event the reference exists. The filter follows `asset->` (supported by deployed
  Function filters per the GROQ feature table, and proved live: the first run started about one
  second after the reference was patched in) and matches an image whose asset was uploaded since
  `UPLOADED_SINCE` (2026-11-26T00:00:00Z) and has no `privacy`, another strip version, `replaced`,
  a stale `processing` or a due `pending`. Proved live: an upload left unreferenced for 8 s got no
  run and no `privacy` field.
- **Why `UPLOADED_SINCE`:** the migration's privacy step was stripping the migrated assets in
  production and staging at the same time (copies with `privacy` stripped appeared during this
  work). All migrated originals were uploaded on 2026-11-25. Scoping the Function to later uploads
  means it never races that step over the same asset, and never re-checks the migrated images
  under different rules (open issue 3).
- **Run:** lease on the asset (`privacy.processing`, revision-checked) -> stored bytes via
  `?dlRaw=` with the Function's token (finding 3; sha1 and size checked) -> strip -> no personal
  metadata: mark `clean` and stop -> upload the copy (`source: {name: "image-privacy", id}`,
  `extract` without exif/image/location), require equal dimensions, mark it `stripped`, mark the
  upload `replaced` (and unset any extracted `metadata.location/exif/image`) -> repoint every
  reference in drafts, published documents and release versions (`<path>._ref` only, revision
  checked) -> delete the upload when nothing references it, repeating up to 5 rounds for references
  added meanwhile; otherwise the filter matches `replaced` on that document's next event.
- **Failures:** `failed` (file cannot be stripped; final for the version) or `pending` (download,
  upload, API; retried after 10 minutes), both shown in the Studio as a field warning and in the
  status line, and logged. No loops: the copy is marked before references move to it.

## video-to-mp4 changes

Before converting, the Function makes the original private: it uses the upload if it already is a
stripped copy, reuses an earlier stripped copy (`source.name == "video-to-mp4-original"`, current
`VIDEO_STRIP_VERSION`), or strips and uploads one (download when it and its copy fit in `/tmp`,
else the range proxy; uploads above about 480 MB fail with a message). It then converts the copy
with the unchanged settings, sets `original` to the copy and `conversion` to `{..., sourceAssetId:
<copy>, originalStripped: true, stripVersion}`, delivers to every draft and published block as
before, and finally deletes the unstripped upload if nothing references it. All existing guards
are unchanged (one block per run, lease per upload, revision-checked keyed patches, reuse by source
id and settings version, stale `processing` and `pending` recovery, failure is final per settings
version). A strip failure is a conversion failure; a strip problem that is not the file's fault is
`pending`. The converted MP4 is now also checked for metadata boxes (only ffmpeg's encoder name and
zero times are allowed). `SETTINGS_VERSION` is unchanged (the MP4 bytes do not change).

## Studio

- Image `options`: `hotspot: true`, `accept: image/jpeg,image/png,image/webp,image/gif,image/avif,image/tiff`,
  `metadata: [blurhash, thumbhash, lqip, palette]` (Sanity's defaults, now explicit: never `exif`,
  `image` or `location`).
- Validation: error for an asset whose format cannot be stripped ("This image's format (image/svg+xml)
  cannot be used: ... Upload it as JPEG, PNG, WebP, GIF, AVIF or TIFF."), warning for `failed`,
  `pending` and `replaced`.
- `ImagePrivacyInput`: "Checking this image for location and camera data..." (unchecked upload
  younger than 10 minutes), "Removing location and camera data...", "Location and camera data
  removed. The pixels, orientation and colour profile are unchanged.", the warnings; nothing for
  clean or older images.
- Video preview: "Ready. Original kept without location data" when `conversion.originalStripped` is
  true or the original's asset has `privacy.status` "stripped" (so the migration's stripped
  originals show it too), "Ready. The original upload still has its metadata" otherwise.

## Tests

| Suite | Result |
| --- | --- |
| `functions/privacy` unit (`npm test`): fixtures built byte by byte for JPEG (EXIF with GPS and thumbnail, XMP, IPTC, COM, MPF, trailing data, JFIF thumbnail), PNG, WebP, GIF, TIFF; EXIF rules; SVG/BMP refusal; video container parsing, planning, box and packet comparisons | 25/25 pass |
| `functions/privacy` media (`npm run test:media`): ImageMagick + exiftool fixtures with GPS position and altitude, make, model, serial, artist, dates, XMP creator and city, IPTC by-line, comments, an EXIF thumbnail, orientation 6 and an ICC profile, in JPEG (baseline, progressive, CMYK), PNG, APNG, WebP (lossy, lossless with alpha), animated GIF, AVIF, TIFF (LZW; tiled multi-page). Checked with exiftool `-ee -a -G1` (no personal tag, no marker string, no marker bytes anywhere), orientation, ICC sha256, ImageMagick pixel signature of every frame, ffmpeg framemd5 without autorotation, idempotence; clean images untouched | 12/12 pass |
| same, with `PRIVACY_ORIGINALS_DIR` = all 110 local originals (72 have something removable) | pass: every stripped file decodes to identical pixels (ImageMagick and ffmpeg), same orientation and ICC, no personal tags |
| `functions/privacy` video media: QuickTime with GPS keys, user data, timecode track, subtitles, chapters, rotation and colour tags; 10-bit HLG HEVC MP4 with rotation and GPS user data; PCM QuickTime; Matroska/WebM with tags, subtitles and an attachment. Checked with exiftool, ffprobe (stream list, codec, pixel format, colour, rotation, side data) and ffmpeg streamhash + framemd5 | 4/4 pass with local ffmpeg 9.0.1; 5/5 pass with the Function's ffmpeg 7.0.2 (Docker, linux/arm64) including all 29 Wagtail videos (`IMG_3151.MOV` keeps Dolby Vision) |
| `functions/image-privacy` (`npm test`): filter vs rule for every status (groq-js with `asset->`), fields vs `schema.json`, reference paths; orchestrator with the real stripper: replace and delete, clean left alone, publish mid-processing, release versions and other documents, a reference added while deleting, finishing a `replaced` upload, lease held, failed, pending and retried, unexpected error, dimension mismatch, extracted location removed | 29/29 pass |
| `functions/video-to-mp4` unit (`npm test`): updated and new orchestrator cases (strip then convert the copy, reuse a stripped copy and its MP4, upload already stripped, strip failure, strip retry, upload kept while a release version references it) | 109/109 pass |
| `functions/video-to-mp4` `npm run test:ffmpeg` (real ffmpeg, now including the MP4 box check) | 9/9 pass |
| Studio `npm test`, `npm run typecheck`, `npm run lint`; `schema:validate` both workspaces | 67/67 pass; clean; 0 errors, 0 warnings |
| `migration/wagtail-to-sanity` tests that import Studio modules (read only, not changed) | 32/32 pass |

## Deployment

| What | Result |
| --- | --- |
| `npx sanity@latest deploy --yes` (from `studio/`) | 2/2 schemas deployed, Studio deployed. The served `static/sanity-BV19De9-.js` has the same sha256 as the local build and contains the privacy input. |
| `npm_config_platform=linux npm_config_arch=arm64 npx sanity@latest blueprints deploy` | `OP-ekhtk7ipb7` (image-privacy created, the other two updated), then `OP-nknuw7fp6a` (the `dlRaw` fix). The bundles include `../privacy/*` modules; the video bundle's ffmpeg is ELF aarch64 with sha256 `6bb182d0...fb8ce`. |

## Live tests on staging

Inputs were unique copies (a JPEG COM segment or an ISO BMFF `free` box with a nonce added, media
untouched), so no upload could be the same asset as a migrated one. API calls follow the Studio's
flow (upload, then patch the reference into the draft).

| Test | Result |
| --- | --- |
| a) GPS JPEG (`IMG_7630.jpg`, orientation 6, 53 personal tags) into a draft blog post's `contentImage` (with crop, hotspot, alt, caption) and into a Portable Text `imageBlock` | Nothing happened while the upload was unreferenced (8 s). After the reference: both references on the copy in 5.7 s, upload deleted at 11.6 s. Crop, hotspot, alt, caption, layout unchanged. Copy: `source {name: image-privacy, id: <upload>}`, `privacy` stripped (`image-strip-v1`, removed EXIF incl. GPS and MakerNote, thumbnail, COM), metadata only dimensions/placeholders/palette, sha1 matches its id. Stored copy (via `dlRaw`): 0 personal tags, orientation 6, same ICC, identical pixels (ImageMagick and ffmpeg). Served rendition and `?w=400` / `?w=400&fm=jpg`: 0 personal tags. |
| b) `IMG_0169.MOV` (GPS keys, 2 `mebx` tracks) into a video block, draft published mid-conversion | Ready in 56 s from the reference (including the wait to publish); draft gone; published block: `file` MP4, `original` the stripped MOV (`source video-to-mp4-original`, `privacy` stripped), `originalStripped: true`, `stripVersion: video-strip-v1`, `sourceAssetId` the copy; upload deleted. Stripped original: 0 personal tags, 2 streams, streamhash identical to the upload, rotation -90 and colour tags identical. MP4: no location, zero dates, only ffmpeg's encoder name. |
| c) PNG without metadata into `heroMedia` | Marked `clean` in 2 s; reference unchanged; asset kept; no copy uploaded; stored bytes unchanged. |
| d) GPS JPEG (`IMG_8414.jpg`), draft published right after the reference | Published document's reference on the copy and the upload deleted 4.5 s after publishing; copy has 0 personal tags and identical pixels. |
| `video-to-mp4/scripts/live-check.ts` (updated to the new contract) | All six steps pass on the third run; see "Live check of video-to-mp4" below. |
| Logs | image-privacy: one invocation per test document, none for the Functions' own patches; the first attempt (before the `dlRaw` fix) recorded `pending` with the size mismatch. video-to-mp4: lease, "stripped (mov); removed ...", conversion, lease released, "unstripped upload deleted". testimonial-ascii-art: no invocations. |
| Cleanup | All scratch documents (12 ids over 3 runs) and test assets deleted after checking nothing referenced them, also the 3 format-probe images and the Dolby Vision probe's assets. Staging has no `privacy-live*` document and no asset created after the tests started. |

### Live check of video-to-mp4

`npx tsx scripts/live-check.ts --first IMG_3151.MOV --second deep_linking.MP4` (staging), three runs:

- **Run 1:** step 1 failed: the conversion of the stripped copy was recorded `failed` by the frame
  check (open issue 1). Cleanup complete.
- **Run 2:** the Function's part of step 1 passed; the script's own check "no display matrix in the
  output" rejected any side data, and IMG_3151's MP4 keeps an ambient-viewing-environment entry (as
  in video-spike.md). Fixed to look for a display matrix only.
- **Run 3: all six steps pass.**
  1. Draft with the HEVC Dolby Vision upload: processing after 4.3 s, ready after 25.1 s; `file` an
     H.264 High 1080x1920 MP4 with AAC stereo that decodes cleanly; `original` the stripped copy
     (written as MP4 to keep Dolby Vision), `sourceAssetId` the copy, `originalStripped` true; the
     upload deleted.
  2. Saving again: no new conversion in 45 s.
  3. Publishing: the published block is converted with the same original; no new conversion.
  4. Replacing the file (`deep_linking.MP4`) and publishing mid-conversion: the published document
     is ready after 11.2 s, converted once, from the replacement's stripped copy.
  5. Random bytes named `.mov`: `failed` after 4.3 s with "The location and personal metadata could
     not be removed from the original: ffmpeg could not read the file as a video"; saving again does
     not retry.
  6. A fresh `processing` mark starts no run in 45 s; aged past 1200 s, the next save retries and
     the block is ready after 6.8 s (it reuses the stripped copy and MP4 of step 4: the two uploads
     differ only in an appended `free` box, so their stripped copies are the same asset).
  No conversion lease is left; the script deleted its documents and the 5 remaining assets (the
  uploads had been deleted by the Function).

After all runs, staging has no scratch document, no asset created after the tests started, no
lease and no `processing`, `pending`, `replaced` or `failed` privacy state.

## Open issues

1. **Intermittent frame-check failure on Lambda (pre-existing check, final failure).** In one of
   five Lambda conversions of `IMG_3151.MOV` the frame check failed ("the MP4 has 470 frames for
   469 input frames"): the conversion's `showinfo` branch logged one frame fewer. The input (the
   stripped copy, sha1 `7e57a137...`) was byte-identical to one that converted cleanly on Lambda
   minutes later, and the Function's own built code with the same ffmpeg binary and file passes in
   the Lambda image locally (also with 6 decoder threads). A `failed` conversion is final for that
   upload and settings version, so an editor would have to upload the video again. Suggested
   follow-up for the video owner: treat a frame-count mismatch of this kind as retryable once
   (`pending`) or re-run the frame log in a separate decode before failing.
2. **A failed video conversion keeps its unstripped upload** (the block still references it; once
   the editor removes the block, the unreferenced upload stays in the dataset). No scheduled sweep
   exists (scheduled Functions need the one-way stack promotion, owner decision).
3. **Two rule sets.** The migration's privacy step (images before 2026-11-26) treats camera make,
   model, software, dates, comments and XMP editing ids as not personal; the Function (later
   uploads) removes everything but the technical tags. Both remove location, maker notes, serials
   and people.
4. **Exposure window.** An upload is in the public dataset from upload until the Function replaces
   it: about 6-15 s for images (whose stored bytes need a token anyway, finding 3), about 30-60 s
   for a short video (whose stored bytes are public at `/files/`).
5. **Not covered:** `fileLink` and `stlModel` files (PDF, STL) are not checked by any Function;
   videos above about 480 MB cannot be stripped in `/tmp` and fail with a message; the ICC profile is
   kept as decided, and a screenshot's profile can name the display it was taken on.
6. **Stream-copy side effects** (packets unchanged): QuickTime PCM sample entries become `sowt`,
   track time scales may change (exactly representable), `tapt` aperture boxes and edit lists are
   rewritten, the time stamps of repeated-time-stamp packets move (finding 5), and Dolby Vision
   videos become `.mp4` (finding 4).
7. **`sanity.types.ts` not regenerated** (outside this package's paths): `schema.json` now has
   `conversion.originalStripped` and `conversion.stripVersion`; the frontend does not query them.
8. The Studio UI (status line, validation) was verified by unit tests, a build and the deployed
   bundle, not by clicking through a browser.
