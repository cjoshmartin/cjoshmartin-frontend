# Video verification after the Mux removal

Status: **done, with two findings for the owner of `settings.ts` and the Function**.

All 29 videos play on a fresh production build, from Sanity MP4 file assets, in Chrome for Testing
and in WebKit: muted, looping, inline, with controls, and starting on their own. Every page has as
many videos as the old site. The parity crawl of 47 routes has **0 unexpected differences**. No
request goes to Mux or to the old bucket. Migration validation passes **12 of 12 on both
datasets**, before and after the live check. The live check of the `video-to-mp4` Function on
staging converted the screen recording correctly and cleaned up after itself, with one deviation:
the Function's ffmpeg 7.0.2 adds 5 duplicate frames.

That led to finding 1, which matters before anyone ships the planned variable-frame-rate fix.
`-enc_time_base:v demux` on its own makes the Function's ffmpeg 7.0.2 encode `step_count.mp4` at
a constant 90,000 frames per second. Use `-fps_mode passthrough -enc_time_base:v demux` instead.
It is exact with both ffmpeg 7.0.2 and 9.0.1 on both test inputs.

Everything here ran from 06:31 to 07:25 UTC on 2026-11-26, against commit `66549cc`, with
`SETTINGS_VERSION` `h264-crf23-max1920-v1`.

## Setup

| Item | Value |
|---|---|
| New site | `next build` and `next start -p 3000` of commit `66549cc` (`git archive HEAD` into `~/cjoshmartin-migration/tmp/video-verify-build`, `npm ci`). Built at 06:34 UTC, after the 06:14 production rewrite, with an empty `.next/cache`, so the stale Data Cache from work package C's medium finding cannot apply. Next.js 16.3.4. The build passed with 18 app routes plus the proxy. The server log has no errors and no "has no video file" lines. |
| Env | `NEXT_PUBLIC_SANITY_PROJECT_ID=j3vdh6ti`, `NEXT_PUBLIC_SANITY_DATASET=production`, `NEXT_PUBLIC_SANITY_STUDIO_URL=https://cjoshmartin.sanity.studio`, and `SANITY_API_READ_TOKEN` from the Viewer token. They were passed as process environment only: no `.env` file was written, and the write and Mux tokens were unset. |
| Old site | `https://www.cjoshmartin.com` (live Wagtail site) |
| Browsers | Google Chrome is not installed, so Playwright's channel `chrome` cannot be used. Instead: **Chrome for Testing 156.0.8078.4** (Playwright cache `chromium-1248`, the WP7 build; `canPlayType('video/mp4; codecs="avc1.640028"')` = `probably`), and **WebKit 27.2** (`webkit-2388`, also `probably`). Both run through `playwright-core` 1.65.1, headless. |
| Method | The WP7 method ([wp7-verification.md](wp7-verification.md)): crawl, report, interactive checks. The crawl and the full interactive run used Chrome for Testing at 1440 and 390 px. A second interactive run used WebKit, videos only. |
| Outputs (outside git) | `~/cjoshmartin-migration/reports/parity-video/` (`index.html` with side-by-side screenshots, `parity-results.json`, `summary.md`, `interactive-results.json`, `interactive-results-webkit.json`, logs; 58 MB) and `~/cjoshmartin-migration/reports/video-verification/` (validation runs, Function check logs and JSON, Function logs, ffmpeg 7.0.2 experiments, build and server logs) |

## Changes to `migration/verify/` (commit `30d53db`)

| File | Change |
|---|---|
| `src/forbidden.mjs` (new) | One rule for what the new site must never contact: any `*.mux.com` host, Mux Data (`*.litix.io`), and the old bucket (`storage.googleapis.com/images-for-cms/...` and `images-for-cms.storage.googleapis.com`). Also checks HTML for those strings. |
| `src/config.mjs` | `launchBrowser(kind)` with `chrome-for-testing` (default), `chrome` (Playwright channel) and `webkit`. `VERIFY_BROWSER` sets the default. The comment now says that Chrome for Testing is needed for H.264, not for Mux HLS. |
| `src/page-extract.mjs` | Each video records its `<source>` elements (src and type), its fallback links, `preload`, rendered box, `videoWidth`/`videoHeight`, `readyState` and media error. A video's fallback download link is left out of the page's links and text, because browsers that play video never show it; it is checked with the video instead. |
| `src/crawl.mjs` | `--browser`. Records every request host, the media requests and any forbidden request, on every route at both widths, and forbidden strings in every HTML or text response. The mobile pass also records the video boxes. |
| `src/sanity-reference.mjs` | The Mux fields (`pendingVideoBlocks`, `asset->playbackId`) are replaced by each video block's contract v2 fields: the file URL, MIME type, extension and source; the original and its file name; and the conversion status, ids and `settingsVersion`. |
| `src/compare.mjs` | The pending-Mux exception is gone, so **video count must equal the old page**. New checks: the count equals the published Sanity blocks; `autoplay`, `muted`, `loop`, `playsInline` and `controls` on every video; the autoplay attribute is the same as on the old site; each video passes `videoContractProblems`; **video order** (each old file name equals the block's `original.originalFilename`, in order); and video boxes within ±2 px. `videoContractProblems` checks that the source is the block's `cdn.sanity.io/files/j3vdh6ti/<dataset>/<sha1>.mp4` with `type="video/mp4"`, that the asset is `video/mp4` `.mp4` with source `video-to-mp4` and the original's id, that the conversion is `ready` with `outputAssetId` = file, `sourceAssetId` = original and the current `SETTINGS_VERSION`, that the fallback link is right, and that there is no media error. A page height difference is explained only by video boxes that are each within tolerance. A **forbidden hosts** check runs on every route kind. `mux.com` is no longer counted as the site's own infrastructure. |
| `src/interactive.mjs` | `--browser` and `--videos-only`. For each video: it must reach playing without the script ever calling `play()` (not paused, more than 0.5 s played, `readyState` at least 3, decoded size). It must be muted (property and attribute), have `loop`, `playsInline` and controls, never be fullscreen, and its `currentSrc` must be the block's MP4. After a seek to 0.6 s before the end, it must wrap to the start and keep playing without `ended`. The page's video count must equal the Sanity blocks and the old page. Every request is checked against `forbidden.mjs`. Results go to `interactive-results.json` (Chrome for Testing) or `interactive-results-<browser>.json`. |
| `src/report.mjs` | Shows one interactive table per browser file, with videos OK, video count and forbidden requests. |
| `src/video-function-check.mjs` (new) | The live Function check described below. |
| `test/compare.test.mjs` | Replaces the Mux test with 5 tests: contract v2 videos; missing, reordered, untyped, unconverted and non-autoplay videos and oversized boxes; page height from video boxes; forbidden requests and HTML; and the `forbiddenRequest` rule. `npm test`: **18 of 18**. |
| `README.md`, `package.json` | Updated for the above. Also fixed `npm run parity`, which pointed at a missing `src/parity.mjs`. It now runs crawl and then report. |

## 1. Parity with the old site (fresh production build)

The crawl ran from 06:39 to 06:47 UTC. Result: **47 routes: 3 the same, 44 with expected
differences only, 0 unexpected.** Every expected difference is one already listed in WP7 and the
fix rounds (footer credit, Sanity CDN images and og:image crops, flex titles and canonicals, bugs
2 to 6, redirects, Charter fonts, the R1-5 link fix). The only new expected one is "video sources",
below. The old crawl's "19 videos missing" exception no longer exists.

| Route | Old | New | Sanity blocks | Order (old file = Sanity original) | Files (contract v2) | Boxes | Autoplay attribute |
|---|---|---|---|---|---|---|---|
| `/projects/squid-games-nerf-gun` | 8 | 8 | 8 | same | 8 ready MP4s, `type="video/mp4"` | same | 8 of 8 on both |
| `/projects/mazda-key-holder` | 1 | 1 | 1 | same | 1 | same | 1 of 1 |
| `/projects/sba-power-badge` | 4 | 4 | 4 | same | 4 | same | 4 of 4 |
| `/projects/v2-of-mobile-app-for-ios-and-andriod` | 10 | 10 | 10 | same | 10 | same | 10 of 10 |
| `/blog/bluetooth-low-energy-ble-with-react-native-and-arduino` | 3 | 3 | 3 | same | 3 | same | 3 of 3 |
| `/blog/ios-universal-links-with-expo-react-navigation-and-react-native` | 3 | 3 | 3 | same | 3 | same | 3 of 3 |
| **Total** | **29** | **29** | **29** | | | | |

- **Video sources:** expected. The old site plays the originals from
  `storage.googleapis.com/images-for-cms/media/`. The new site plays converted MP4s from
  `cdn.sanity.io/files/j3vdh6ti/production/`.
- **Video sizes:** the rendered boxes are identical at 1440 px on every page. No ±2 px allowance
  was needed.
- **Old originals:** all 29 decoded in Chrome for Testing, including VP9 and HEVC `.mov` files, so
  every box was compared.
- **Page heights:** the 6 video pages differ by at most 4 px at both widths, from image rounding
  as before.
- **Every other route:** no videos on either site.
- **New site:** every video has `preload="metadata"`, and its fallback link is its own MP4.

## 2. No Mux, no old bucket

| Where | Requests | To `*.mux.com` / `*.litix.io` | To `storage.googleapis.com` (any bucket) |
|---|---|---|---|
| Crawl, new site, 47 routes × 2 widths, Chrome for Testing | 6,421 | 0 | 0 |
| Interactive, Chrome for Testing, 22 pages × 2 widths | 5,228 | 0 | 0 |
| Interactive, WebKit, 6 video pages × 2 widths | 1,369 | 0 | 0 |
| HTML of every route (HTTP probe, every redirect hop) | n/a | 0 occurrences | 0 occurrences of `images-for-cms` |

- **Media requests:** the only media requests on the new site are the 29 MP4 URLs under
  `cdn.sanity.io/files/j3vdh6ti/production/`. In Chrome for Testing they are seen in the crawl and
  in the interactive run.
- **WebKit:** WebKit loads media in a separate process that Playwright does not see. There, each
  video's `currentSrc` was checked against its Sanity MP4 instead.
- **Build output:** `.next/static` and `.next/server` contain no `mux.com`, `litix.io`, `@mux/`,
  `mux-video` or `mux-player`. The production `node_modules` has no `@mux` package.
- **`images-for-cms` in the build:** it appears only in one source map, from commented-out JSX in
  `app/page.tsx` (lines 119 to 129, two links to the old résumé PDF). That code is never rendered;
  see finding 3.

## 3. Interactive checks

| Check | Chrome for Testing 156 | WebKit 27.2 |
|---|---|---|
| Videos OK (all conditions below) | **58 of 58** (29 × 2 widths) | **58 of 58** |
| Started on their own (no `play()` call), playing within | at most 0.5 s after scrolling into view | at most 0.5 s |
| Muted (property and attribute), `loop`, `playsInline`, controls, `autoplay` | all | all |
| Looped: after a seek to 0.6 s before the end, wrapped to the start, still playing, never `ended` | 58 of 58 | 58 of 58 |
| Inline (never fullscreen) | 58 of 58 | 58 of 58 |
| `currentSrc` is the block's production MP4, `<source type="video/mp4">`, contract v2 | 58 of 58, 0 problems | 58 of 58, 0 problems |
| Video count = Sanity blocks = old page | 12 of 12 page visits | 12 of 12 |
| STL models drawn and rotating | 6 of 6 | not run (`--videos-only`) |
| YouTube | 18 of 18 load, 16 play. The third embed on `/blog/interview-practice` does not start at either width, and it does not start on the old site either (old site: 8 of 9 play). Same as WP7. | not run |
| Testimonial art = Sanity = old site, and the hover/touch reveal | 8 of 8; on `/` Andy Fate rotated to Justin Zalewski after 32 s | not run |
| Disqus thread = old site | 20 of 20 | not run |
| Site console errors | none. The only page errors are Disqus's `browsingTopics` (also on the old site). | none from the site. The only errors are from Disqus and YouTube frames and Plausible TLS, all known third-party. |

The results above are from the final runs: WebKit from 07:09:50 to 07:11:49 UTC, and Chrome for
Testing from 07:11:49 to 07:23:16 UTC. The first runs (Chrome for Testing 06:49 to 07:02, WebKit
to 07:09, kept in `parity-video/run1/`) gave the same 58 of 58 in both browsers. They were
repeated because their JSON overwrote the loop-check details with the element's `loop` property.
The pass/fail verdicts were computed correctly in both runs.

## 4. Migration validation

`npm run migrate -- --dataset <d> [--confirm-production] --steps validate` (read-only). Copies of
each report are in `reports/video-verification/validation-*`.

| Run | Result |
|---|---|
| `staging`, 06:32 UTC (before the live check) | **12 of 12 pass** |
| `production`, 06:33 UTC | **12 of 12 pass** |
| `staging`, 07:10 UTC (after the 4 live-check runs and their cleanup) | **12 of 12 pass** |
| `production`, 07:24 UTC (after the crawl and the interactive runs) | **12 of 12 pass** |

Every run matched in detail:

- **Documents and assets:** 96 documents, 110 image and 34 Wagtail file assets.
- **Content checks:** 279 references, 0 unresolved; 764 key arrays; 581 Portable Text blocks;
  291 text-parity values; 938 fields.
- **Videos:** 29 of 29 ready MP4s (`h264-crf23-max1920-v1`), 29 of 29 served by the CDN, and 0
  Mux documents.
- **ASCII art:** 9 of 9.
- **Convergence:** pass.
- **Studio validation:** 0 errors.

## 5. Live check of the `video-to-mp4` Function (staging)

`node src/video-function-check.mjs --input gcs/media/Screen_Recording_2025-05-05_at_3.46.43PM.mov
--reference video-mp4/media-25/…mp4 --keep-mp4 …` with the write token. The final run was from
07:07:17 to 07:09:00 UTC.

The input is media 25 with an ISO BMFF `free` box (an 8-byte header and a short text payload)
appended. That gives it new
bytes and a new asset id, so it never shares an asset with the migration's upload of the same
file, and the Function's reuse rule cannot pick up the migrated MP4. The input is H.264,
918x2066, no audio, 41.467 s, 2,483 frames, variable frame rate (one 0.1 s pause at 40.8 s).

| Step | Result |
|---|---|
| Upload and scratch draft | New asset `file-e4498e93…-mov` (`video/quicktime`). Created `drafts.blogPost-video-verification-check` with a text block and a video block whose `file` is the upload. |
| Function | `processing` after 5.7 s, **`ready` after 26.5 s**. The log shows exactly one invocation: lease taken, encode 17 s, decode check, upload, lease released, then "ready ... patched". |
| Block (contract v2) | `file` = `file-1143510d…-mp4` = `conversion.outputAssetId`; `original` = the upload = `conversion.sourceAssetId`; `status` `ready`; `settingsVersion` `h264-crf23-max1920-v1` (= `settings.ts`); `updatedAt` inside the run; message "Converted … to MP4 852x1920 H.264, no audio, 3.7 MB, in 20 s."; the Studio's `videoNeedsConversion` is false; nothing was published |
| MP4 asset | `Screen_Recording_2025-05-05_at_3.46.43PM.mp4`, `video/mp4`, `.mp4`, source `{name: "video-to-mp4", id: <upload>}`. It is the only MP4 made from the upload, and no lease is left. |
| MP4 from the CDN | 3,707,800 bytes, sha1 = asset id. **H.264 High** (level 4.2), **yuv420p**, limited range. **852x1920**, which equals `expectedOutputSize(918x2066)`: even sides, longest side 1920, no rotation. **No audio track** (the input has none) and no other streams. Format tags only `major_brand`, `minor_version`, `compatible_brands` and `encoder`. Boxes `ftyp/moov/free/mdat` (**faststart**). The x264 SEI has **`crf=23.0`**, and its preset options equal the local `medium` conversion (`ref=3 subme=7 me=hex me_range=16 trellis=1 rc_lookahead=40 bframes=3 b_adapt=1 direct=1 weightp=2 mixed_ref=1 8x8dct=1`). Duration 41.467 s, the same as the input. It decodes completely without errors. |
| Deviation | **2,488 frames for 2,483 input frames.** No input frame is lost, but 5 frames are added at 40.833 to 40.9 s: duplicates that fill the 0.1 s pause at a constant 60 fps. The migration's local conversion of the same file (ffmpeg 9.0.1) keeps exactly the 2,483 input frame times. The bytes differ too, because the Function uses x264 core 164 and the local conversion core 165. See finding 2. |
| Cleanup | Deleted the draft, the MP4 and the upload, each only after `count(*[references($id)]) == 0`. Afterwards there were 63 file assets and 269 documents, the same as before, and 0 leases. Before and after, no document has a video that needs conversion in any rich-text field the Function watches. |

Other runs, all cleaned up the same way, each leaving the counts as they were:

- **Runs 1 and 2 (06:42 and 06:46 UTC).** Same input, earlier versions of the script, same result.
  The Function made the same MP4 (`file-1143510d…`) each time, so its output is deterministic.
- **Extra run (06:51 UTC), with media 14 (`step_count.mp4`).** This is the known
  variable-frame-rate case. The script was run to see what the Function itself does with it:
  - `ready` after 6.4 s, and every contract and settings check passes;
  - 31 frames, and the duration is 3.525 s instead of 3.458 s;
  - but the frame times show **29 of the 31 input frames retimed**. The Function's MP4 is a
    constant 8.8 fps resample (one frame every 0.114 s). That retiming is what finding 2
    describes. The local migration MP4 of media 14 has 13 frames instead.

The Function log (`reports/video-verification/function-logs.txt`, fetched at 07:26 UTC) has
exactly 4 invocations after 06:21 UTC, one for each of these 4 uploads (06:44, 06:47, 06:51,
07:07), and nothing else. There were no invocations for the deletes and no
errors.

## Findings

### 1. High (planned change, not deployed): `-enc_time_base:v demux` alone makes the Function's ffmpeg 7.0.2 encode `step_count.mp4` at 90,000 fps

The brief tells the `settings.ts` and Function owners to add `-enc_time_base:v demux` and bump
`SETTINGS_VERSION`. That was tested only with ffmpeg 9.0.1. I ran the Function's own binary in an
offline linux/arm64 container. The binary is
`studio/functions/video-to-mp4/.build/function-video-to-mp4/node_modules/ffmpeg-static/ffmpeg`,
ffmpeg 7.0.2, and its sha256 `6bb182d0…fb8ce` equals the pin in `ffmpeg.ts`. I used
`buildFfmpegArgs` with preset `medium` and added options before `-f mp4`.

"Missing" means input frame times with no output frame within 2 ms. "Added" means output frames at
a time where the input has no frame.

| Input | Extra options | ffmpeg 7.0.2 (Function) | ffmpeg 9.0.1 (migration) |
|---|---|---|---|
| media 14 | none (v1) | 31 frames, 29 missing, 29 added (constant 8.8 fps); matches the live Function output | 13 frames (B's known deviation) |
| media 14 | `-enc_time_base:v demux` | **runaway:** constant 90000/1 fps. The first 2,000 frames cover only 0.022 s, about 311,000 frames for the clip. Without a frame limit it ran more than 10 minutes and was stopped. In the Function it would run into the 840 s deadline and mark the upload `failed`. | 31 frames, 0 missing, 0 added |
| media 14 | `-fps_mode passthrough` | 31 frames, 29 missing, 24 added | not run |
| media 14 | `-fps_mode passthrough -enc_time_base:v demux` | **31 frames, 0 missing, 0 added** | **31, 0, 0** |
| media 25 | none (v1) | 2,488 frames, 0 missing, 5 added; matches the live Function output | 2,483, 0, 0 |
| media 25 | `-fps_mode passthrough` | 2,483, 0, 0 | not run |
| media 25 | `-fps_mode passthrough -enc_time_base:v demux` | **2,483, 0, 0** | **2,483, 0, 0** |

**Fix:** put `-fps_mode passthrough -enc_time_base:v demux` in `buildFfmpegArgs`, not
`-enc_time_base:v demux` alone. Before deploying, check it:

- run all 29 originals through the Function's 7.0.2 binary, not only 9.0.1, comparing frame
  times. The commands are in
  `~/cjoshmartin-migration/reports/video-verification/ffmpeg-7.0.2/run702.mjs`; it needs Docker
  with the Python image that is already local;
- run `src/video-function-check.mjs` once with `step_count.mp4` and once with the screen
  recording.

Inputs with odd timestamps (the `.mp4.webm` file, VP9 `.mov`, HEVC with B-frames) were not tried
with passthrough here.

### 2. Medium: the same settings give different frame timing in the Function and in the migration, and frame-count checks do not catch it

With the current v1 arguments:

- **The Function (ffmpeg 7.0.2) outputs a constant frame rate.** It duplicates frames into pauses
  (media 25: +5) and resamples bursts (media 14: the 25-frame burst in the first 0.53 s is shown
  with about 6 frames, and 29 of 31 frame times change).
- **The migration's converter (9.0.1) keeps the frame times.** It drops frames that share a time
  tick (media 14: 13 of 31 frames).

So a video uploaded in the Studio and the same video migrated are not converted the same way, and
iPhone screen recordings are typically variable frame rate. None of the existing checks sees the
Function's behaviour:

- A2's `scripts/check-originals.ts` and `scripts/live-check.ts` compare neither frames nor frame
  times.
- The migration's `convert` step compares frame counts, and the Function's media 14 output has 31
  of 31 frames.

`src/video-function-check.mjs` now compares frame times. The fix is the one in finding 1, with a
new `SETTINGS_VERSION`. After that, B's plan applies: delete media 14's old MP4 in each dataset and
rerun.

### 3. Low: commented-out JSX still links the old bucket

`app/page.tsx` lines 119 to 129 (links on lines 120 and 125) contain two commented-out links to
`https://storage.googleapis.com/images-for-cms/documents/Josh_Martin_-_Resume.pdf`. They are not
rendered, so no request goes there today. If someone uncomments them after the bucket lockdown,
they will be broken links. The repository rule keeps comments, so this is noted, not changed. That
file belongs to another package.

### Not findings (checked)

- **Pre-existing issues.** WP7's pre-existing issues are unchanged and are not caused by the
  videos: Plausible TLS, Disqus `browsingTopics` and its ad partners, and the one YouTube embed
  that does not start in headless browsers.
- **Third-party frame errors in WebKit.** WebKit logs "Permission policy 'Camera'/'Microphone'"
  and "enumerateDevices" errors from the YouTube iframes on `/projects/squid-games-nerf-gun`, and
  Disqus's cross-origin frame errors on `http://localhost`. Both are third-party and also seen in
  work package C.

## Blocked steps

None.

## How to reproduce

```sh
cd migration/verify && npm ci && npm test
# production build on :3000 (README), then:
node src/crawl.mjs --out ~/cjoshmartin-migration/reports/parity-video
node src/report.mjs --dir ~/cjoshmartin-migration/reports/parity-video
node src/interactive.mjs --dir ~/cjoshmartin-migration/reports/parity-video
node src/interactive.mjs --dir ~/cjoshmartin-migration/reports/parity-video --browser webkit --videos-only
node src/report.mjs --dir ~/cjoshmartin-migration/reports/parity-video
set -a; . ~/cjoshmartin-migration/secrets.env; set +a
node src/video-function-check.mjs --dataset staging \
  --input ~/cjoshmartin-migration/gcs/media/Screen_Recording_2025-05-05_at_3.46.43PM.mov \
  --reference ~/cjoshmartin-migration/video-mp4/media-25/Screen_Recording_2025-05-05_at_3.46.43PM.mp4 \
  --json function-check.json --keep-mp4 function-media25.mp4
cd ../wagtail-to-sanity
npm run migrate -- --dataset staging --steps validate
npm run migrate -- --dataset production --confirm-production --steps validate
```

Left on disk, outside git:

- the build copy `~/cjoshmartin-migration/tmp/video-verify-build` (1.2 GB, with `node_modules`);
- `~/cjoshmartin-migration/tmp/video-verify-ffmpeg702` (92 MB: a copy of the Function's ffmpeg
  binary, the two inputs and the test outputs).

Both can be deleted.
