# A1 report: Studio video contract v2 and Mux removal

Status: **done**. Commit `fc6d06b Store Studio videos as MP4 file assets and remove Mux` (plus this
report). Schema deployed to `production` and `staging`, hosted Studio redeployed, headless browser
check 17 of 17.

Owner decision this package implements: drop Mux, store every video in Sanity as an MP4 file asset,
convert every video (the 29 migrated ones and every future Studio upload) with fixed settings, and
keep the original upload as a hidden, read-only reference that is never served.

## What changed

| Path | Change |
|---|---|
| `studio/schemaTypes/objects/video.ts` | `video` is now contract v2: `file` (file, `accept: "video/*"`, required, asset `mimeType` must start with `video/`), `original` (file, read-only, hidden while empty), `conversion` (read-only object, collapsed: `status` pending/processing/ready/failed, `message`, `sourceAssetId`, `outputAssetId`, `settingsVersion`, `updatedAt`). Block-level warning when the conversion failed for the current file. Preview: title = the file's `originalFilename`, subtitle = "No video file", "Converting to MP4...", "Ready" or "Conversion failed: <message>". |
| `studio/schemaTypes/shared/video-conversion.ts` (new) | Pure helpers: `videoNeedsConversion` (the contract rule), `videoConversionState`, `videoConversionLabel`. |
| `studio/schemaTypes/constants.ts` | `VIDEO_CONVERSION_STATUSES`, type `VideoConversionStatus`. |
| `studio/sanity.config.ts` | Removed the `muxInput` plugin (and with it the `mux.*` types and the Videos tool) and the `newDocumentOptions` filter that only hid `mux.videoAsset`. |
| `studio/package.json`, `package-lock.json` | Removed `sanity-plugin-mux-input`. Added `tsx` (dev) and the scripts `test`, `test:ffmpeg`. |
| `studio/functions/video-to-mp4/settings.ts` (new) | The MP4 settings, single source of truth (below). The only file in that folder. |
| `studio/test/` (new) | `video-to-mp4-settings.test.ts` and `video-conversion.test.ts` (`npm test`, 40 tests, no ffmpeg), `video-to-mp4-ffmpeg.integration.ts` (`npm run test:ffmpeg`, 5 tests with a real ffmpeg). |
| `studio/schema.json` | Re-extracted: `video` v2, no `mux.*` types. |
| `studio/README.md`, `schemaTypes/index.ts` | Mux text replaced. |
| `docs/sanity-migration/schema-contract.md` | `video` v2, new section "Videos (video contract v2)" with "MP4 settings" and a frontend query example, Mux rows and sections removed, validation lists updated. |

## MP4 settings (`studio/functions/video-to-mp4/settings.ts`)

`SETTINGS_VERSION = "h264-crf23-max1920-v1"`, `buildFfmpegArgs({input, output, preset, hasAudio})`:

```
-hide_banner -nostdin -y -autorotate -i <input>
-map 0:V:0 [-map 0:a:0 -c:a aac -b:a 128k -ac 2 | -an]
-vf scale=w='if(gte(iw,ih),max(2,2*trunc(min(iw,1920)/2)),max(2,2*trunc(min(ih,1920)*iw/ih/2)))':h='if(gte(iw,ih),max(2,2*trunc(min(iw,1920)*ih/iw/2)),max(2,2*trunc(min(ih,1920)/2)))':out_range=tv,format=yuv420p
-c:v libx264 -profile:v high -pix_fmt yuv420p -crf 23 -preset <preset>
-map_metadata -1 -map_chapters -1 -movflags +faststart -f mp4 <output>
```

Also exported: `expectedOutputSize` (the filter's arithmetic in TypeScript), `convertedFilename`
(`"IMG_0169.MOV"` → `"IMG_0169.mp4"`), `CONVERTED_ASSET_SOURCE_NAME = "video-to-mp4"`,
`OUTPUT_MIME_TYPE`, `X264_PRESETS`, `DEFAULT_PRESET = "medium"`, `isX264Preset` and the numeric
constants. The file has no imports and only erasable TypeScript, so the Function bundler, `tsx`,
Node's type stripping and migration scripts can all import it.

## Decisions and deviations

1. **`ultrafast` is not an allowed preset.** libx264's `ultrafast` turns off CABAC and 8x8
   transforms, so its output is **Constrained Baseline**, not High, even with `-profile:v high`
   (`-profile` is only an upper limit). Measured with ffmpeg 9.0.1: every other preset gives High.
   `buildFfmpegArgs` throws for `ultrafast`; `superfast` is the fastest allowed preset.
2. **Explicit scale expression instead of `-2` or `force_original_aspect_ratio=decrease`.**
   `-2` rounds the derived side to the nearest even number and can grow an odd side by 1 px
   (1000x599 → 1000x600, an upscale). `force_original_aspect_ratio` with `force_divisible_by`
   rounds differently across ffmpeg versions (918x2066 gives 854x1920 or 852x1920), so the
   Function's ffmpeg could disagree with a local one. The expression computes both sides with
   floor-to-even, which never upscales and is the same in every version. A side that would be
   below 2 px (aspect ratio beyond 960:1, or a 1 px video) becomes 2 px, the smallest libx264 can
   encode, instead of an invalid 0.
3. **`out_range=tv,format=yuv420p` in the filter.** With ffmpeg 9, `-pix_fmt yuv420p` alone kept
   full range on iPhone `yuvj420p` input (ffprobe reported `yuvj420p`). The filter converts to
   limited range. libx264 only writes the range flag when the source has colour tags, so outputs
   from untagged sources report `color_range` unknown, which H.264 defines as limited.
4. **Explicit stream selection and stripping.** `-map 0:V:0` (first video that is not cover art)
   and `-map 0:a:0` handle iPhone files where audio is stream 0 and files with data tracks.
   `-map_metadata -1 -map_chapters -1` removes GPS location, device and creation date (checked on
   `IMG_0169.MOV`, which has `com.apple.quicktime.location.ISO6709`). `-f mp4` makes the output
   format independent of the file extension. `-y` overwrites the output path; `-nostdin` keeps
   ffmpeg from waiting on input in a Function. `output` must not start with `-`.
5. **Tests live in `studio/test/`, not next to `settings.ts`.** The brief allowed only
   `settings.ts` (plus package files if needed) in `functions/video-to-mp4/`. The Studio's `tsc`
   checks `settings.ts` through the test imports, so no `package.json` or `tsconfig.json` was
   needed there. The scale filter tests evaluate the real `VIDEO_FILTER` string with a small
   evaluator for its expression subset, so they test the filter itself; a 5,000-size property
   test checks even sides, the 1920 limit, no upscaling and the aspect ratio. The integration test
   fails (does not skip) when ffmpeg is missing.
6. **Small Studio additions beyond the brief:** a validation **warning** on a block whose
   conversion failed for its current file; a failure recorded for an earlier file is ignored
   (`sourceAssetId` must match), so a replaced file shows "Converting to MP4..." again; the
   `conversion` object is collapsed by default; `conversion.status` values outside the list are a
   validation error (Sanity's list check).
7. **MIME validation reads the asset document** (`*[_id == $assetId][0]{mimeType}`) because file
   asset ids only carry the extension. It also runs in `sanity documents validate`. Sanity adds
   its own warning "File type ... is not accepted" from `accept`.
8. **`@mux/*` packages remain in `studio/package-lock.json`** as dependencies of `sanity@6.25.0`
   itself (`sanity` → `@mux/mux-player-react`, used by Sanity's own video features). Nothing in the
   Studio code, config or schema references Mux, and no deployed schema has a Mux type.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` (includes `settings.ts` and the tests) | pass |
| `npm run lint` | pass, 0 problems |
| `npm test` | 40 of 40 |
| `npm run test:ffmpeg` (ffmpeg 9.0.1, libx264) | 5 of 5: 4K landscape with mono audio and metadata (default preset) → 1920x1080, AAC stereo about 128 kb/s, no title/location/creation_time; 1080x2400 without audio → 864x1920, no audio track; 641x361 → 640x360; 90° rotated 1920x1440 → 1440x1920 with no rotation left; audio-first file with cover art → one video and one audio stream. Every output: H.264 High, yuv420p, limited range, `moov` before `mdat`. |
| Real originals from `~/cjoshmartin-migration/gcs/media` (8 of 29, preset `veryfast`, outputs in `/tmp/a1-ffmpeg/real`) | All High, yuv420p, sizes equal `expectedOutputSize`: `IMG_0169.MOV` (HEVC, rotated, mono PCM, 2 data tracks) 1440x1920 in 8.3 s; `IMG_3239.MOV` (audio first, rotated) 1440x1920 in 7.0 s; `IMG_3151.MOV` (10-bit HLG) 1080x1920 in 5.7 s; `deep_linking.MP4` (full-range HEVC) 886x1920; a VP9 `.mov` 720x1280 in 0.7 s; 3420x2080 screen recording → 1920x1166; 918x2066 → 852x1920; the `.mp4.webm` file → `...mp4.mp4` 640x320. Times are this Mac, not a Function. |
| `npx sanity@latest build` | pass (CLI 8.35.0, sanity 6.25.0, which is `latest`) |
| `sanity schemas validate` production / staging | 0 errors, 0 warnings each |
| `sanity schemas deploy` | `_.schemas.production` and `_.schemas.staging` updated 04:41:08 UTC: 22 types, 0 Mux types, `video` fields `file`, `original` (readOnly), `conversion` (readOnly, 6 fields) |
| `sanity deploy --yes` | Studio deployed to <https://cjoshmartin.sanity.studio/>; the served `static/sanity-aEZPgg_9.js` and `static/8d3b1b53.create-schema.json` are byte-identical (sha256) to the local build. The unversioned `static/create-manifest.json` is CDN-cached for up to a day (`max-age=86400`); with a cache-busting query it returns the new manifest (`createdAt` 04:42:06 UTC). |
| Headless browser, local `sanity preview` of the deployed build, Viewer token | 17 of 17, 0 page errors, 0 console errors (below) |
| `sanity documents validate --file` (nothing written) | a block with `conversion.status: "bogus"` and no file → "Value "bogus" did not match any allowed values" and "Upload or select a video"; a block whose file is a PDF → "Only video files can be used here (this file is application/pdf)" plus Sanity's accept warning |
| Secrets | The 14 committed files and this report contain none of the four token values in `secrets.env` |

Browser checks (screenshots in `~/cjoshmartin-migration/reports/a1-screenshots/`, scripts in
`~/cjoshmartin-migration/tmp/a1-browser/`):

- Navbar tools are Structure, Presentation, Vision, Releases (no Videos). `/production/mux` shows
  "Tool not found: mux". The create menu lists Blog post, Flex page, Medium, Person, Project,
  Redirect, Service, Technology, Testimonial, and no Mux type.
- Production `blogPost-19` (migrated, still old shape): its 3 video blocks show "No video file";
  the block dialog shows **Video file** and **MP4 conversion**, **Original upload** is hidden, and
  Sanity reports "Unknown field found" for the old `asset` field.
- Staging, temporary draft with four blocks: previews "a1-studio-check-original.mp4 / Ready",
  "Conversion failed: A1 check: simulated failure", and "Converting to MP4..." for the
  unconverted `.mov` and for a PDF. The converted block's dialog shows **Video file**
  (`a1-studio-check-original.mp4`, 68.24 KB), **Original upload** (`a1-studio-check-original.mov`,
  93.45 KB) and **MP4 conversion** with Status Ready, the asset ids and
  `h264-crf23-max1920-v1`; no input is editable (Viewer). The unconverted block hides
  **Original upload**. CLI validation of that draft gave exactly: PDF block error + accept warning,
  failed block warning, nothing on the ready and converting blocks.

**Temporary staging writes (all removed).** For the staging check the Editor token created
`drafts.a1-video-contract-check` and uploaded two generated 1 s test files
(`file-91aa38e980855c5ba37ae6513010bfe1dbced98e-mov` and the converted
`file-5edca04e2407510e7ba0971b15ae02bce9964c52-mp4`, made with `buildFfmpegArgs`). Before
uploading, the script refused to reuse an existing asset hash. Only the ASCII Function was deployed
at the time (`blueprints info`), so no converter ran on the draft. The draft and both assets were
deleted after the checks; a query for the three ids returns nothing. Nothing was written to
`production`.

## State the next packages start from

- **Both datasets fail `npm run validate` until the data is converted** (checked 2026-11-26 on
  `production` and `staging`): 29 errors "Upload or select a video" (23 in projects, 6 in blog
  posts, all old `{asset: {_type: "mux.video", ...}}` blocks) and 10 errors on the `mux.videoAsset`
  documents, whose type no longer exists. Both go away when the data package rewrites the blocks to
  v2 and deletes the Mux documents.
- The frontend still queries `asset.asset->playbackId`; it gets nothing for v2 blocks.
  `sanity.types.ts` (repo root) was not regenerated here; run `npm run typegen` in `studio/` after
  the frontend queries change.
- No video-to-mp4 Function is deployed yet; Studio uploads show "Converting to MP4..." until it is.

## Notes for the converter packages

- `IMG_3151.MOV` is 10-bit HLG (BT.2020, `arib-std-b67`). The settings convert it to 8-bit
  yuv420p and keep the HLG colour tags; there is no tone mapping (the local ffmpeg has no zimg).
  Browsers that support HLG show it; others may show flatter colours. Changing that would need a
  new `SETTINGS_VERSION`.
- `deep_linking.MP4` has a silent audio track (AAC about 2 kb/s after conversion); `hasAudio` is
  true for it, which is correct.
- Conversion with `veryfast` took 0.7–8.3 s per file on this Mac for clips up to 20 s. A Function's
  CPU is slower; measure there before choosing a preset (`superfast` is the fastest allowed).
- Two of my own shell commands were refused by Claude Code's safety check (an `ln -sfn` and a
  zsh-only secret scan). Neither deleted anything; both were rerun in plain form. No step was
  blocked.
