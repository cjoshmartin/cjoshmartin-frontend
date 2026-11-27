# A2 report: automatic convert-to-MP4 on upload (Sanity Function)

Status: **done**. Commit `a1fa289 Convert every Studio video upload to MP4 with a Sanity Function`
(plus this report). Deployed to Stack `cjoshmartin-functions` (`ST-jc4gwa3c4t`) by operation
`OP-htqaa3e4gd`; the Function `video-to-mp4` (asset `AS-m5i4czmpea`) is live for `production` and
`staging`. The live check on staging passed all 6 steps on the final deployment, and the Function
logs show no errors.

Every video uploaded in the Studio is now converted to an MP4 with the fixed settings in
`studio/functions/video-to-mp4/settings.ts` (`h264-crf23-max1920-v1`), automatically. The site
plays `video.file`, which becomes the MP4; the upload is kept in `video.original` (read-only,
never served).

## What changed

| Path | Change |
|---|---|
| `studio/functions/video-to-mp4/` (new, except A1's `settings.ts`, unchanged) | The Function: `index.ts` (handler), `trigger.ts` (filter, projection, the rule in TypeScript), `orchestrator.ts` (one run), `patches.ts` (patches and the lease), `convert.ts`, `media-info.ts`, `mp4.ts`, `range-proxy.ts`, `ffmpeg.ts`, `sanity.ts`; `package.json` (`ffmpeg-static` 5.3.0, `@sanity/client` 8.17.0, `@sanity/functions` 1.11.1, all pinned), `tsconfig.json`, `README.md`, `test/`, `scripts/check-originals.ts`, `scripts/live-check.ts` |
| `studio/sanity.blueprint.ts` | New resource `video-to-mp4`: `memory: 10`, `timeout: 900`, `runtime: 'nodejs24.x'`, `on: create, update`, the filter and projection from `trigger.ts`, `includeDrafts: true`. `testimonial-ascii-art` is unchanged (still asset `AS-dac26sc8in` after both deploys). |

## How it works

**Trigger** (`trigger.ts`, `VIDEO_TO_MP4_FILTER`). `create`/`update`, drafts included, in
`production` or `staging`, for a document with a `video` block that needs work:

- the contract rule: `file.asset._ref` set and different from `conversion.outputAssetId`;
- and not `processing` for the current file with `updatedAt` newer than `now() - 1200 s`
  (timeout 900 s + 5 min; an older mark is a dead run and is retried);
- and not `failed` for the current file with the current `SETTINGS_VERSION`.

The projection is only `{_id, _type, _rev}`; the handler re-reads the document because its
patches need the current revision.

**One run, one block** (`orchestrator.ts`):

1. Re-read the document; take the first block that needs work. Marking it `processing` is an
   update event, which starts the run for the next block, so several videos convert in parallel.
2. Take a **lease on the upload's asset document**: field `videoToMp4Lease {holder, documentId,
   acquiredAt, expiresAt}` on the `sanity.fileAsset`, set with an `ifRevisionID` patch, so only one
   run can hold it. It lasts 1200 s and is removed when the run ends. A run that finds it held marks
   its block `processing` ("Waiting for another conversion of this upload"), looks at the lease
   again, and stops; the holder delivers to it.
3. Mark the block `processing` (`conversion` = `{status, message, sourceAssetId, settingsVersion,
   updatedAt}`; an `original` left from a replaced file is removed).
4. Produce the MP4: **adopt** the file if it already is an MP4 this converter made (an editor
   picked an existing converted file); else **reuse** the oldest asset with
   `source: {name: "video-to-mp4", id: <upload>}` and `mimeType: video/mp4`; else **convert**:
   - upload up to 400 MB: download to `/tmp`, check size and the asset's `sha1hash`; larger: ffmpeg
     reads through a `127.0.0.1` range proxy to the CDN that resumes broken responses (static ffmpeg
     cannot resolve DNS in Lambda);
   - `ffmpeg -i` describes the input (audio present, displayed size after rotation, duration);
   - `buildFfmpegArgs({input, output, preset: 'medium', hasAudio})` with `-loglevel warning`
     prepended; ffmpeg is killed 60 s before the timeout;
   - the MP4 is checked (`mp4.ts`): `ftyp` first, `moov` before `mdat`, exactly one `avc1` video
     track with H.264 profile_idc 100 (High), 4:2:0, 8 bit, the exact `expectedOutputSize`, even
     sides, at most 1920, identity display matrix, frames present; one AAC-LC stereo track exactly
     when the input has audio; no other tracks; duration within max(0.5 s, 1 %) of the input;
   - the MP4 is decoded completely (`ffmpeg -v error -xerror ... -f null -`);
   - it is uploaded as `<base>.mp4` (`convertedFilename`), `video/mp4`,
     `source: {name: "video-to-mp4", id: <upload>}`, and the returned asset must be
     `file-<sha1 of the local MP4>-mp4` with the same size.
5. **Deliver** to every draft or published block whose `file` is still that upload: ready sets
   `file` = MP4, `original` = the block's previous `file` value, `conversion` = `{status: ready,
   message, sourceAssetId, outputAssetId, settingsVersion, updatedAt}`; failed sets only
   `conversion` (`file` stays on the upload) and only for the origin block and waiting blocks.
   Release the lease, then deliver once more for blocks that started waiting meanwhile.

Every document write is a patch on `field[_key=="..."]` with `ifRevisionID`, re-read and retried
on a conflict (up to 10 times), so a concurrent edit is never overwritten and a block whose file
changed meanwhile is left alone. In local `sanity functions test` runs the handler only logs what
it would do.

## Decisions and deviations

1. **All rich-text fields, not only `body` of blogPost/project/flexPage.** `blockContent` offers
   the `video` block everywhere it is used, so the Function also watches `testimonial.body`,
   `homePage.bio`, `person.bio` and `service.description`. The owner asked for every upload to be
   converted; without this, a video added to a bio would stay "Converting to MP4..." forever.
2. **`failed` is final for that upload and settings version.** The brief's filter ("needs
   conversion and not fresh processing") would match a failed block again, so the failure patch
   would start another run, and every later save would retry. The filter and the code therefore
   also exclude `failed` for the current file with the current `SETTINGS_VERSION`. To retry: remove
   the video block and add the video again, or upload another file. A new `SETTINGS_VERSION`
   retries failed blocks once. Unexpected errors (API errors, bugs) are recorded as `failed` with
   "Remove the video block and add the video again to retry", and rethrown so they show in the logs.
3. **Lease on the asset document** (above) instead of only the block's `processing` mark: the mark
   is per document, but the brief requires that one upload is never converted twice at once,
   including the draft and published copies and other documents using the same upload. The field
   exists only while a conversion runs (none is left in either dataset).
4. **No ffprobe.** ffmpeg-static ships only ffmpeg. Instead: `ffmpeg -i` parsing (`media-info.ts`,
   both ffmpeg 7.0 `displaymatrix:` and 9.x `Display Matrix:` spellings), the MP4 reader in
   `mp4.ts`, and a full decode. On the 29 originals the parser agrees with ffprobe on every
   displayed size, audio presence and duration (below).
5. **Deadline 60 s before the timeout** (the spike suggested about 30 s), to leave time for the
   upload and the deliveries.
6. **Adopting an existing MP4.** If `file` is already an MP4 with `source.name == "video-to-mp4"`,
   it is used as is (no re-encode), with `original` pointing at its `source.id` when that asset
   exists.
7. **A replaced file's `original` is removed** when the new file starts converting, so `original`
   always describes the current `file`. The old asset itself is not deleted.

**`settings.ts`: no change.** `buildFfmpegArgs` puts `-autorotate` before `-i`. In ffmpeg 6.x and
older, `-autorotate` takes a value, so it swallows `-i` and ffmpeg fails ("Error parsing options for
output file <input>"). In 7.0 it became a value-less boolean (`OPT_TYPE_BOOL`, checked in the
`n7.0.2` sources), so it works with the Function's 7.0.2 and with ffmpeg 9.0.1. The integration
tests therefore use the ffmpeg on PATH (must be 7.0 or newer) rather than the macOS ffmpeg-static
6.0 binary that `npm ci` installs.

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` (function package) | pass |
| `npm test` (function package) | 74 of 74: filter vs. TypeScript rule vs. the Studio's `videoNeedsConversion` on 15 block cases (groq-js), field and dataset scope, the Function's own patches stop the filter (no loops); orchestrator on an in-memory store with revisions: convert, reuse, adopt, failure written once, unexpected error, missing upload, fresh vs. stale processing, one block per run, two runs on one upload (converted once), draft published mid-conversion and before the first run, file replaced mid-conversion, revision conflicts, concurrent edits kept, waiter takeover, block changed before the mark; patches and lease; `ffmpeg -i` parser; MP4 parsers and checks; range proxy incl. resume after a cut connection |
| `npm run test:ffmpeg` (ffmpeg 9.0.1) | 8 of 8: rotated HEVC `.MOV` with mono PCM and a location tag (download mode) → 1440x1920 High yuv420p, AAC stereo, no rotation, no location; 4K without audio with `moov` at the end through the range proxy → 1920x1080, only the output in the work dir; audio-first file with cover art → one H.264 and one AAC track; random bytes `.mov` → "could not be read as a video", work dir removed; audio-only file and `audio/*` MIME type rejected; sha1 mismatch on download rejected; deadline kills ffmpeg; wrong binary sha256 and the local (non-Lambda) ffmpeg-static binary rejected |
| `scripts/check-originals.ts` on the 29 originals (`gcs/media`, ffmpeg 9.0.1, preset medium) | 29 of 29 pass the full pipeline. The parser matches ffprobe on every input; ffprobe confirms every output (H.264 High, yuv420p, `expectedOutputSize`, no rotation, AAC stereo exactly when the input has audio). 273.9 MB in, 90.2 MB out. Includes VP9 in `.mov`, rotated 10-bit HLG HEVC, mono PCM, audio-first, `step_count.mp4` (90k timebase), the `.mp4.webm` file |
| Studio `npm test`, `npm run typecheck`, `eslint sanity.blueprint.ts` | 40 of 40, pass, pass |
| `blueprints plan` / `deploy` (with `npm_config_platform=linux npm_config_arch=arm64`) | Deploys `OP-iid65uwb42` (first) and `OP-htqaa3e4gd` (final), both completed. The build's `node_modules/ffmpeg-static/ffmpeg` is an ELF aarch64 static binary, 51,134,160 bytes, sha256 `6bb182d0...fb8ce`; bundle 70 MB of the 200 MB limit |
| Filter before deploy | 0 documents matched in `production` and `staging` (the Content Lake also accepted its `now()`/`dateTime` arithmetic). After the data agent's rewrite started (46 converted v2 blocks, 17 old blocks left at the time), still 0 |
| Live check on staging (`scripts/live-check.ts`, 3 runs; run 3 on the final deployment) | All steps pass, below |
| Function logs | 10 invocations, exactly one per conversion or failure; none for re-saves, publishes or the fresh processing mark; no errors |

Live check, run 3 (final deployment). Uploads were copies of the originals with an ISO BMFF `free`
box appended (new bytes and asset ids, same media), so they never shared an asset with the
migration's uploads:

1. Draft `drafts.blogPost-video-function-check` with a video block on a fresh upload of
   `IMG_0169.MOV` (HEVC 1920x1440, rotated -90, mono PCM, 26.4 MB): `processing` after 2.9 s,
   `ready` after 24.4 s. `file` = `IMG_0169.mp4` (9.14 MB), `original` = the `.mov`,
   `sourceAssetId`/`outputAssetId`/`settingsVersion` correct. The MP4 fetched from the CDN: sha1
   matches its id, `video/mp4`, H.264 High yuv420p 1440x1920, AAC stereo, 19.82 s, no rotation, no
   location, `ftyp/moov/free/mdat`, decodes without errors. In the Function: download 0.4 s,
   encode 18.1 s, decode check 1.0 s, upload 0.6 s; handler 24.5 s.
2. Saving the draft again: no run in 45 s, `conversion.updatedAt` unchanged, one MP4.
3. Publishing: published document has the MP4, the original and `ready`; draft gone; no run.
4. Replacing the file with a fresh upload of `IMG_3239.MOV` (H.264, audio first, rotated) in a new
   draft, and publishing it while `processing` (seen after 4.2 s): the published document was
   `ready` after 26.1 s with a new MP4 (1440x1920, AAC stereo, 15.88 s, all checks), converted once;
   the run delivered to the published document because the draft was gone.
5. Random bytes uploaded as `not-a-video.mov` (`video/quicktime`): `failed` after 6.1 s with
   "This file could not be read as a video: moov atom not found / Error opening input: Invalid data
   found when processing input / ...", `file` left on the upload, no MP4; saving again: no run.
6. A fresh `processing` mark written by hand: no run in 45 s. The same mark aged past 1200 s: the
   next save retried it and it was `ready` after 26.9 s (converted once).

Runs 1 and 2 passed steps 1 to 5 as well. Run 1 (first deployment) showed one flaw, fixed before
the final deployment: the failure was written twice (by the first delivery and again after the
lease was released). Deliveries now skip a block that already records the failure, and a unit test
checks that the failure is written once. The same input converted in the Function gave the same MP4
bytes every time (same asset id in all runs), as the spike found.

**Cleanup.** After each run the script deleted both scratch documents and every asset it uploaded
or the Function made from them, each only after `count(*[references($id)]) == 0`. Afterwards, in
both datasets: no `*video-function-check*` document, none of the 10 uploads, no MP4 with their
`source.id`, no `videoToMp4Lease`. Nothing was written to `production`.

**Secrets.** The 25 committed files and this report contain none of the four token values in
`secrets.env` (checked file by file).

## Limits and follow-ups

- **Retry after a failure** needs an editor action (remove and re-add the block, or upload another
  file); see decision 2.
- **A run that dies without recording anything** (only possible if Lambda kills it, since ffmpeg is
  stopped 60 s early) leaves `processing`; it is retried on the first save after 20 minutes.
- **Release versions** (`versions.*`) are not converted; their videos convert when the release is
  published (the published document gets an update event).
- **Many videos in one save:** each block's run is started by the previous run's patch; Sanity's
  recursion guard stops such chains after 16, so about 15 new videos per document per save (from
  the Sanity docs; not tested).
- **HDR**: iPhone HLG sources come out as 8-bit H.264 still tagged HLG/BT.2020 (no tone mapping in
  the settings); a change would need a new `SETTINGS_VERSION` (settings owner).
- **Deploys** must set `npm_config_platform=linux npm_config_arch=arm64` (npm 11 warns these will
  stop working in the next major). Without them the binary check fails every conversion with a
  "redeploy" message, it never runs a wrong binary. A comment in `sanity.blueprint.ts` and the
  function README say so.
- **Cost:** about 10 GB × 25 s = 250 GB-s for a 20 s phone clip; the spike's worst case (60 s of
  4K 10-bit HEVC) is about 540 GB-s.
