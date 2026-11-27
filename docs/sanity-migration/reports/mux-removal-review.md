# Mux removal: review findings and fixes

## Round 1 (2026-11-26, 07:30 to 09:15 UTC)

Status: **19 of 19 findings handled.** 15 are fixed and verified, including the two high ones.
2 were already fixed and are confirmed: the import record race, and the harness part of the
decommission finding. 1 is not a defect (the `-autorotate` version note), but its rule is now
enforced. 2 need the owner: revoking the Mux token, and whether the kept originals may stay
public. The dead-run finding is fixed in the Studio. A scheduled sweep would need a one-way
Blueprint stack promotion, so that part is the owner's decision too.

The main change is **MP4 settings v2** (`h264-crf23-max1920-v2`): `buildFfmpegArgs` now adds
`-fps_mode:v passthrough -enc_time_base:v demux`. With both the Function's ffmpeg 7.0.2 and
Homebrew's 9.0.1, every decoded frame of all 29 Wagtail videos is in its MP4 at its own time:
27,286 of 27,286 frames, 0 missing, 0 added, 0 ms shift. Before, the v1 MP4s had 27,267 frames,
and 3,607 frame times in 9 files were moved or dropped.

Both datasets were reconverted and validated. The `video-to-mp4` Function, the Studio and the
Blueprint are redeployed. The live checks on staging pass.

### Commits (branch `sanity-migration`)

| Commit | What |
|---|---|
| `5c526d4` | Settings v2, the ffmpeg 7.0 floor, the Function's frame-time check, the settings version on MP4 assets, retryable failures, `/tmp` headroom and the ENOSPC fallback, and the trigger test that reads schema.json |
| `902a6f3` | The Studio restarts stuck conversions; a failed conversion is a validation error; the preview shows a pending retry |
| `a39ebbf` | Migration: frame-time check, ffmpeg floor, settings-aware reuse, the new `prune-mp4s` step, the media 14 v2 deviation |
| `d7a7933` | The verify harness's Function check: settings version on the asset, and a clean decode of VFR MP4s |
| `85555c4` | Decommission: the v2 video check replaces the Mux check (script, tests, README) |
| `e673fe0` | Site: only converted MP4s play; the `sanity-content` cache tag and `POST /api/revalidate` |
| `5eb36e3` | Morning report, schema contract, plan, WP3 note |
| `9fd0cc7` | The Studio's video helpers have no runtime imports again (a regression from `902a6f3`, found by the final smoke test; see below) |
| (this report's commit) | This report |

### Deployments

| What | Result |
|---|---|
| Blueprint `cjoshmartin-functions` (`ST-jc4gwa3c4t`) | Operation `OP-ygdjp879uy` (the code tested live below), then `OP-yjnn7v7shp`, so the deployed code equals the committed `5c526d4` (the first deploy predates its formatting and comment-only changes). `video-to-mp4` is now asset `AS-ajc9suydez`; `testimonial-ascii-art` is still `AS-dac26sc8in`, unchanged. Both deploys used `npm_config_platform=linux npm_config_arch=arm64`. The bundled binary is ELF aarch64, 51,134,160 bytes, sha256 `6bb182d0…fb8ce`, which equals the pin. After the second deploy, a live check with media 15 (`IMG_0169.MOV`, rotated HEVC with mono PCM) passed: `ready` after 32.5 s, 594 of 594 frames at their times, H.264 High 1440x1920, AAC stereo, no deviations, cleaned up. |
| Studio (`https://cjoshmartin.sanity.studio`) | `sanity deploy` twice (after `902a6f3`, then after `9fd0cc7`): 2 of 2 schemas deployed, Studio deployed. `schema.json` is unchanged. |
| `production` and `staging` datasets | Migration rerun; see finding 2 |

## Findings

| # | Finding (source) | Severity | Resolution |
|---|---|---|---|
| 1 | `buildFfmpegArgs` needs ffmpeg 7.0 or newer (A2) | medium | Not a defect for today's converters. The rule is now enforced: `checkFfmpegVersion` |
| 2 | v1 settings drop frames from variable-frame-rate input (B) | high | Fixed: settings v2, all 29 reconverted |
| 3 | Reuse-by-source cannot apply a settings change (B) | medium | Fixed: `videoToMp4SettingsVersion` on MP4 assets, version-aware reuse, `prune-mp4s` |
| 4 | Import record built from a lagging query (B) | medium | Already fixed in `25e2851`; seen working this round |
| 5 | Decommission lockdown check still expects Mux (B) | medium | Fixed: `decom_videos_complete` |
| 6 | Live data cache keeps content stale while no browser is connected (C) | medium | Fixed in code (webhook route + cache tag); the webhook and its secret are an owner step |
| 7 | `-enc_time_base:v demux` alone runs away on ffmpeg 7.0.2 (verify) | high | Fixed: v2 uses both options; checked with 7.0.2 |
| 8 | Function (7.0.2) and migration (9.0.1) time frames differently; checks miss it (verify) | medium | Fixed: v2 is exact with both; every converter compares frame times |
| 9 | Fixed settings drop frames on bursty VFR; the Function's check does not catch it (review) | medium | Fixed: same as 2 and 7, plus the Function's frame-time check |
| 10 | Kept originals are publicly downloadable, 5 with GPS tags (review) | medium | Confirmed; **owner decision**, nothing changed |
| 11 | Decommission step 04 still requires Mux; verify harness Mux-based (review) | medium | Fixed (04), and confirmed already fixed (harness, `30d53db`) |
| 12 | Owner checklist and schema contract still describe Mux (review) | medium | Fixed |
| 13 | Site plays the raw upload while unconverted or failed (review) | low | Fixed: only converted MP4s play; a failed conversion is a validation error |
| 14 | Infrastructure problems recorded as permanent failures (review) | low | Fixed: retryable `pending` with a 10 minute back-off |
| 15 | No sweep for a dead run (review) | low | Fixed in the Studio (stuck check while a document is open); a scheduled sweep is an owner decision. **Corrected in round 2:** the check only ran while the block's dialog was open; see R2-1 |
| 16 | Reused or adopted MP4s labelled with the current settings version (review) | low | Fixed |
| 17 | `/tmp` space for large low-bitrate uploads (review) | low | Fixed and reproduced on a RAM disk |
| 18 | Trigger test only checks its own field list (review) | low | Fixed: the expected fields come from `studio/schema.json` |
| 19 | A working Mux token is still stored (review) | low | Confirmed it still authenticates; **owner action** (dashboard) |

### 1. `buildFfmpegArgs` needs ffmpeg 7.0 or newer

**Not a defect** for the converters that run today: the Function pins ffmpeg 7.0.2 by sha256, and
the migration and the tests use 9.0.1. The rule was only a comment, so a local converter with the
macOS ffmpeg-static 6.0 binary would have failed with a confusing error. It is now enforced:

- `settings.ts` exports `MIN_FFMPEG_VERSION` (7.0), `parseFfmpegVersion` and `checkFfmpegVersion`.
  The check refuses older versions and builds without a release number, with a message that
  explains why.
- It runs in the migration's `toolVersion('ffmpeg')` (so the `convert` step refuses before
  converting), in the Function's integration tests and in `scripts/check-originals.ts`.
- `-fps_mode`/`-enc_time_base demux` (finding 2) add another reason for the 7.0 floor.

`-autorotate` stays as it is: autorotation is the contract, and the explicit flag documents it.

Unit tests cover 9.0.1, `7.0.2-static`, `n7.1`, 6.0, 6.1.2 and a git snapshot.

### 2, 7, 8 and 9. Variable-frame-rate input

**Confirmed.** With v1, ffmpeg chose a constant encoder time base from the average frame rate:

- 9.0.1 dropped frames that fell into the same tick (media 14: 13 of 31);
- 7.0.2 resampled to evenly spaced frames (media 14: 29 of 31 frame times moved) and filled pauses
  with duplicates (media 25: +5).

The fix the B report suggested, `-enc_time_base:v demux` alone, makes 7.0.2 encode media 14 at
90,000 fps (finding 7).

**Fix: settings v2.** `buildFfmpegArgs` adds `-fps_mode:v passthrough -enc_time_base:v demux`
after `-preset`, and `SETTINGS_VERSION` is `h264-crf23-max1920-v2`. Every other argument is the
same.

**Verification, all 29 originals, both ffmpeg versions.** Each original was converted with the
v2 arguments by the Function's own binary (ffmpeg 7.0.2 linux/arm64, the pinned sha256, in an
offline `python:3.13` container) and by Homebrew 9.0.1. Decoded frame times (ffprobe,
best-effort timestamps, each file measured from its first frame, 1 ms tolerance) were compared
with the original's:

| MP4s | Frames (input 27,286) | Input frames missing or moved | Frames at new times | Largest shift |
|---|---|---|---|---|
| v2, ffmpeg 9.0.1 (migration) | 27,286 | 0 | 0 | 0 ms |
| v2, ffmpeg 7.0.2 (Function) | 27,286 | 0 | 0 | 0 ms |
| v1, ffmpeg 9.0.1 (the MP4s migrated this morning) | 27,267 | 3,607 in 9 files | 3,588 | |

Durations: v2's movie header (`mvhd`) is within 0.035 s of the original for 28 videos with both
versions. Two need explaining:

- **Media 16** (`Untitled.mp4`): 9.0.1's `mvhd` is 0.475 s longer (13.774 s). The original's last
  sample lasts 0.532 s, and its own edit list cuts that to 0.057 s. 9.0.1 keeps the sample's
  length; 7.0.2 keeps the original's 13.299 s. v1 already did the same (13.780 s). ffprobe reports
  13.326 s, so no check flags it.
- **Media 14** (`step_count.mp4`): see the deviation below.

**Every converter now checks frame times** (finding 8 and the second half of finding 9):

- **Function:** the conversion has a second ffmpeg output that logs every decoded input frame
  (`showinfo`), in the same decode, so there is no second download. The full decode check logs
  every MP4 frame. `frameTimeProblems` (`frames.ts`) fails the conversion when any input frame is
  missing or moved, or an MP4 frame is at a new time. ffmpeg runs with `-loglevel level+info`;
  showinfo lines are routed to the parser, and only warnings and errors are kept for failure
  messages. This works the same with 7.0.2 and 9.0.1 (both covered by the unit tests).
- **Migration:** `verifyMp4` has a new `frameTimes` check, with ffprobe on the original and the MP4.
- **Verify harness:** `video-function-check.mjs` already compared frame times.

**Decode checks with VFR.** The first v2 convert run made the migration's decode check fail on
media 14, 16 and 27, with "non monotonically increasing dts to muxer". That came from the check's
null output, which retimes the frames, not from the MP4s. All three decode checks (Function,
migration, harness) now give the null output `-fps_mode:v passthrough -enc_time_base:v demux`.
They are clean on the same files, with both versions.

**Media 14 deviation (v2).** All 31 frames are kept at their own times. Two things still differ:

- **What ffprobe reports:** 3.025 s, against 3.4585 s for the original. ffmpeg reads the stream
  duration from the sample table, which ends at the last decode time. With B-frames and frames
  0.5 s apart, decode times end two frames (0.97 s) before the last presentation time.
- **What the file itself says:** the `mvhd` and the edit list say 3.525 s (9.0.1) or 3.459 s
  (7.0.2).

Players were checked in Chrome for Testing 156 and WebKit 27.2, with `requestVideoFrameCallback`
at quarter speed:

- Chrome reports 3.025 s at `loadedmetadata`, extends it to 3.446 s and presents the last frame.
  The original shows its last frame for 0.012 s, so the difference is not visible.
- WebKit reports 3.525 s and presents the last frame.

The migration lists this as an explained deviation, bound to the exact output sha1
(`src/conversion-deviations.ts`). v1's entry (13 frames) is gone. `-bf 0` would make the durations
agree, but it would cost bitrate on every video for this one edge.

**Live checks on staging** (`migration/verify/src/video-function-check.mjs`, deployed Function,
both cleaned up):

| Input | Result |
|---|---|
| media 14 (`step_count.mp4`) | `ready` after 13.1 s. 31 of 31 frames, 0 missing, 0 at new times. H.264 High, 884x1920, faststart, `crf=23.0`. The asset records `h264-crf23-max1920-v2`. One reported deviation: ffprobe duration 3.025 s (above). |
| media 25 (screen recording, 2,483 frames) | `ready` after 26.1 s. 2,483 of 2,483 frames, 0 missing, 0 at new times (v1 had added 5). No deviations. |

`scripts/check-originals.ts` (the Function's pipeline with 9.0.1, including the new frame check)
passes 29 of 29.

### 3 and 16. A settings change and the reuse rule

**Confirmed.** The lookup matched only `source.name`, `source.id` and `mimeType`, and
`conversionValue` always wrote the current version. Fixed:

- Every converter sets `videoToMp4SettingsVersion` (`CONVERTED_ASSET_SETTINGS_FIELD`) on the MP4
  asset document right after uploading it, and reuses only an MP4 whose field equals
  `SETTINGS_VERSION`.
  - Function: `findConvertedAsset`.
  - Migration: `currentConversionsOf`.
  - MP4s made before the field existed have none, and no converter reuses them.
- The Function's ready results carry the version of the MP4 they use.
- The Function adopts an existing converted MP4 only if it was made with the current settings.
  - An older one whose original still exists: the run points `file` back at the original (a new
    `restart` result; `conversion` and `original` are removed), and the next run converts the
    original under the original's own lease, so nothing is converted twice.
  - An older one whose original is gone: converted like any other upload.
- **Migration:** the `videos` step records the version on every MP4. `convertedAt` of a reused
  Function MP4 is now its asset's `_createdAt`, instead of a lookup through the blocks. The new
  `prune-mp4s` step, after `import`:
  - deletes the MP4s of the Wagtail originals made with other settings, once nothing references
    them;
  - refuses and deletes nothing if one is still referenced;
  - writes `reports/wp3/pruned-mp4s-<dataset>-<time>.json` before deleting.
  Validation requires the version on every MP4 and exactly one MP4 per original.
- `schema-contract.md` ("Videos") describes the field, the lookup and how an old conversion is
  redone.

The asset field produces no Studio validation warnings: with `--level warning` only the 2 known SEO
descriptions are reported.

**Migration runs** (`--steps assets,convert,videos,ascii,transform,import,prune-mp4s,validate`;
`extract` left out as before):

| Run | Result |
|---|---|
| `convert` | ffmpeg 9.0.1, 11 CPUs, preset `medium`. 28 pass every check; media 14 passes with its explained deviation. 261.21 MiB in, 86.01 MiB out. A rerun reused all 29. |
| staging 1 (08:23 UTC) | 29 MP4s uploaded, 29 versions recorded, 96 documents imported, **29 v1 MP4s pruned**, validation 12 of 12 |
| staging 2 | Converged: 0 converted, 0 uploaded, 0 patched, NDJSON sha256 `6bd2b7c9…` unchanged, 0 pruned, 12 of 12 |
| production 1 (08:32 UTC) | 29 uploaded, 96 imported, **29 v1 MP4s pruned**, 12 of 12 |
| production 2 | Converged as staging 2, 12 of 12 |
| `compare -- --datasets staging,production` | Identical: 96 documents and 173 assets each, 269 of 269 shared ids identical, NDJSON byte-identical |

The first compare ran while a live Function check had its scratch assets in staging, and it
reported 2 extra assets. It was rerun after the check's cleanup: identical.

The state files from before the rerun are kept in `~/cjoshmartin-migration/tmp/fix-r1/state-before/`.

**After the production rewrite, the Vercel Preview's Data Cache can still hold pages with the
deleted v1 MP4 URLs** (finding 6). A new Preview deployment starts with fresh data. This package
could not push the branch.

### 4. Import record race

**Already fixed** in `25e2851` (the read-back retries every 2 s for up to 60 s). It was seen
working this round: production run 2 logged "the dataset does not read back as imported yet,
retrying for up to 60 s" and recorded 96 revisions 3 s later. Validation and compare then passed.

### 5 and 11. Decommission step 04 and the verify harness

**Confirmed** for step 04: `decom_mux_videos_complete` counted `mux.videoAsset` documents, and
there are none on purpose, so the lockdown always refused. Fixed in `scripts/decommission/`:

- `decom_videos_complete` replaces it. It queries production's public API, read-only, published
  perspective, over every rich-text field of every watched type. It requires that:
  - every video block plays a converted MP4: `file.asset->mimeType == "video/mp4"`,
    `conversion.status == "ready"` and `file.asset._ref == conversion.outputAssetId`;
  - every video block keeps its `original` (it resolves);
  - production holds the original of every media item in the Wagtail export (file asset, source
    `wagtail`, id `media-<id>`).
- `04-gcs-lockdown.sh`, the README (prerequisite 5, step 6, the expected output) and the tests are
  updated. The README no longer mentions the Mux upgrade or the removed `--steps mux,videos`.
- `test/run.sh`: 96 of 96 pass, including shellcheck. There are new cases for an unconverted
  block, a missing original and both together.
- Against live production: "ok 29 published video blocks play converted MP4s; the 29 Wagtail
  originals are in production".

**The verify harness part was already fixed** in `30d53db` (after the review read the tree). No
`playbackId`, pending-Mux or "missing videos EXPECTED" logic is left in `migration/verify/src`.
`npm test` passes 18 of 18.

### 6. Live data cache

**Confirmed** in the next-sanity 13.5.1 source:

- `sanityFetch` fetches with `next: {revalidate: false, tags}`. The tags are only the Sanity sync
  tags plus the caller's.
- Only `<SanityLive>`'s server action expires them, and only for events a connected browser
  receives.
- `defineLive` has no option for a time bound, and a route-segment `revalidate` does not override a
  fetch's own `revalidate`, as the Next.js 16 guide says.

Fixed with Sanity's documented webhook pattern:

- `sanity/lib/live.ts` wraps `sanityFetch` so every result also carries the tag `sanity-content`.
- `app/api/revalidate/route.ts` validates the `sanity-webhook-signature` with `parseBody` and
  `SANITY_REVALIDATE_SECRET`. It answers 401 to an invalid signature and 500 if the secret is
  missing. Then it calls `revalidateTag('sanity-content', {expire: 0})`, so the next request
  fetches fresh content.

Checked on a clean production build of `e673fe0`, with a test secret, against `production`:

- unsigned POST: 401;
- signed with another secret: 401;
- correctly signed POST: 200, after `parseBody`'s 3 s wait for the Content Lake.

After the signed POST, one request to `/projects/squid-games-nerf-gun` rewrote that page's 2 of
the 14 Data Cache entries; a second request without a webhook rewrote none. 13 of the 14 entries
carry the tag. The 14th is the sync-tag lookup next-sanity makes before the sitemap's data fetch
(request tag `fetch-sync-tags`), which `next build` cached without tags; the sitemap's data fetch
itself carries the tag.

**Owner step** (morning report step 5, after the merge): create the secret, add it as a production
env var on Vercel, and add the GROQ webhook "Revalidate cjoshmartin.com" (`production`, create,
update, delete, projection `{_id, _type}`, POST to `https://cjoshmartin.com/api/revalidate`). This
package may not touch Vercel production, and the production domain still serves Wagtail, so it
could not set them.

### 10. The kept original is public, including GPS-tagged iPhone files

**Confirmed, and left for the owner to decide.** Without a token:

- a GROQ query on production returns all 29 Wagtail originals;
- 6 published documents reference one;
- a ranged GET of `IMG_0169.MOV` from the CDN answers 206.

Five originals have a location tag: `IMG_0169.MOV`, `IMG_3151.MOV`, `IMG_3239.MOV`, `IMG_6810.MOV`
and `IMG_7386.MOV`. The MP4s have no input metadata (checked on media 15: only `major_brand`,
`minor_version`, `compatible_brands`, `encoder`).

"Hidden, never served" holds for the Studio and the site, not for the public dataset. The owner's
brief says to keep the original, and the choice changes what "original" means, so nothing was
changed. The options:

- strip metadata from originals with a lossless remux before keeping them (the bytes and asset id
  change; the Function and the migration would do it);
- keep originals out of the public dataset (for example only in the private backup bucket, or a
  private dataset);
- accept it. The old site served the same files from the public bucket until the lockdown.

Every new iPhone upload adds a public original until this is decided.

### 12. Owner checklist and schema contract

**Confirmed and fixed.**

- **`morning-report.md`:** a "Superseded in part" note at the top lists what is history. Step 2
  is now "done", with read-only validation. Step 3 is now "revoke the Mux token". Step 5 adds the
  revalidation webhook. Step 6 drops the Mux secrets and records that the repository name is
  fixed (`d01626c`). Step 7's prerequisite is the v2 check.
- **`schema-contract.md`:**
  - settings v2, the 7.0 floor and the frame rule;
  - the settings-version field and the reuse rule;
  - how an old conversion is redone;
  - `pending` as a retry;
  - the Studio stuck check and the site rule;
  - the frontend query;
  - validation: a failed conversion is an error, and the stale "fails on purpose with 29
    old-shape blocks" paragraph is replaced with the current state;
  - the importable-modules table.
- **`sanity-migration-plan.md`:** an amendment note, D7 superseded, §9 step 4, §10 (layout and run
  logic), §11, test 30 and §16.
- **`wp3-migration.md`:** the "Open" list points here.

### 13. The site played the raw upload

**Confirmed and fixed.**

- **The video projection** (`sanity/lib/queries.ts`) returns `url` only when `file` is the
  block's converted MP4: `ready`, `file.asset._ref == conversion.outputAssetId`, `video/mp4`. It
  also returns `hasFile` and `status`.
- **`VideoBlock`** renders nothing otherwise, and logs why: no file, failed, or not converted
  yet.
- **TypeGen** regenerated (`sanity.types.ts`).

The projection was run against production assets for 6 block shapes:

- a converted block gets its MP4 URL;
- a new upload, a block being processed, a failed block, an MP4 without a recorded conversion and
  an empty block all get `url: null`.

In the Studio, a failed conversion is now a **validation error**, so a document with one cannot be
published. Before, it was a warning. Both datasets validate with 0 errors.

Combined with finding 6: a page published mid-conversion shows no video until the MP4 is ready.
Then SanityLive (browser connected) or the webhook (after it is set up) refreshes it.

### 14. Infrastructure failures were permanent

**Confirmed and fixed.**

- A new `RetryableConversionError` covers the problems that are not the video's fault:
  - the ffmpeg binary check (a deploy without the linux/arm64 env);
  - a download that failed 3 times;
  - reading the file running into the time limit;
  - an ffmpeg failure while the CDN connection had errors;
  - an asset without a URL;
  - any unexpected error (still rethrown for the logs).
- These are recorded as `conversion.status: "pending"` for the current file, with a message that
  ends "It is retried automatically, 10 minutes after this attempt or later: on the next change to
  the document, or while the document is open in the Studio."
- The filter (GROQ and TypeScript) skips a `pending` block for 10 minutes (`RETRY_DELAY_SECONDS`),
  so the Function's own patch and quick re-saves do not loop. After that, the first event retries
  it.
- `failed` stays final, and only for problems with the video itself.
- **Studio:** the preview shows "Waiting to retry the conversion: <message>".

**Tests:** unit tests for the GROQ filter and the TypeScript rule at the edges of the delay, and an
orchestrator test (broken binary, then retried after the delay with a working converter).

**Live check on staging** (`tmp/fix-r1/scripts/nudge-check.mjs`):

- a block that was `pending` for 9 min 40 s was left alone by the Function (no invocation);
- once it was due, the Studio's nudge patch started the Function, and the block was `ready` 6.9 s
  later;
- the MP4 records v2;
- cleaned up: 0 drafts, 0 assets, 0 leases left.

### 15. No sweep for a dead run

**Confirmed.** Partly fixed: the dead-run case is fixed in the Studio. The scheduled sweep is
**left for the owner**.

> **Corrected in round 2 (R2-1).** The input component below only ran while the video block's
> edit dialog was open, not while the document was open. Round 2 moved the check to the document
> form's root input.

**Done: the Studio checks open documents.** The `video` type has an input component,
`studio/components/VideoConversionInput.tsx`. While a document is open, it checks the block
in the draft and the published document right away and then every minute.
`videoConversionNudge` reports a block as stuck when:

- it has been `processing` for more than 20 minutes (a dead run);
- it has been `pending` for more than 10 minutes (a retry that is due);
- it needs conversion, has no status for its file, and the document has not changed for 20
  minutes (a missed event).

The component then writes `pending` (`nudgedConversion`) to that block, with a revision check,
at most once every 10 minutes per block. That write is the event that starts the Function. A
unit test checks with groq-js that every nudged state matches the Function's filter. The Studio
is deployed.

**Not done: a scheduled sweep.** It would also cover documents nobody opens. Scheduled Functions
need the Blueprint stack promoted to organization scope (`sanity blueprints promote`, which the
docs call one-way), an organization admin and a new robot token with editor rights. That is
irreversible and outside this brief.

### 17. `/tmp` space

**Confirmed and fixed** in `convert.ts`:

- **Choosing the mode** (`chooseInputMode`): the upload is downloaded only when it is at most
  400 MB and it plus room for an MP4 of `max(64 MB, 1.5 × upload)` fit in the free space. The
  factor covers the largest growth seen on the 29 videos, +46 %. Otherwise ffmpeg reads the upload
  through the range proxy.
- **ENOSPC fallback:** if a downloaded conversion still fails with "No space left on device", the
  run frees the work directory and converts again through the proxy.
- **When even the MP4 alone does not fit:** a clear permanent failure.

Unit tests cover the mode choice. The fallback was reproduced on an HFS RAM disk, 97,292 KiB
free:

- input: a 35.5 MB H.264 noise video, whose MP4 is 65.1 MB;
- download mode was chosen (35.5 + 64 MB fits), and the encode hit ENOSPC;
- the run converted again through the proxy: 720 of 720 frames at their times;
- the RAM disk was detached afterwards.

### 18. The trigger test

**Confirmed and fixed.** "Watches exactly the blockContent fields of the Studio schema" reads
`studio/schema.json`, collects every document field whose type is `blockContent`, and compares
that set with `VIDEO_FIELDS_BY_TYPE`. The per-field filter test iterates over the schema's list
too. It passes: the 7 fields match.

### 19. Mux token

**Confirmed:** `GET https://api.mux.com/video/v1/assets?limit=1` with the token answers 200 (only
the status was printed). No code reads `MUX_TOKEN_*`.

Revoking it needs the Mux dashboard (Settings, Access Tokens), which this package cannot reach.
The two lines stay in `secrets.env` until the owner has revoked the token, so the owner can still
match it in the dashboard. It is morning report step 3.

## Verification summary

| Check | Result |
|---|---|
| Function: `npm run typecheck`, `npm test` | pass, 103 of 103 |
| Function: `npm run test:ffmpeg` (9.0.1) | 9 of 9, including a new bursty-VFR case (26 of 26 frames at their times) and the retryable download error |
| Function: `scripts/check-originals.ts` on the 29 originals (9.0.1) | 29 of 29 pass the full pipeline, frame-time check included |
| Studio: `npm test`, `npm run typecheck`, `eslint .`, prettier on the changed files, `npm run build` | 55 of 55, pass, pass, pass, pass |
| Studio validation, production and staging (`--level error`) | 96 valid documents each, 0 errors. With `--level warning`: only the 2 known SEO descriptions. |
| Migration: `npm test`, `npm run test:ffmpeg`, `npm run typecheck` | 71 of 71; 5 of 5 (new: VFR kept, and a 10 fps resample of it rejected by `frameTimes`); pass |
| Migration runs and compare | finding 3: 12 of 12 on both datasets, converged, identical |
| Verify harness `npm test` | 18 of 18 |
| Decommission `test/run.sh` | 96 of 96, shellcheck included; the live check of production passes |
| Frontend: `tsc --noEmit`, `eslint` on the changed files, `npm test` | pass, pass, 13 of 13 |
| Frontend: clean `next build` of `e673fe0` (production dataset, Viewer token, process env only) | pass, 19 app routes plus the proxy, including `/api/revalidate` |
| Parity crawl of that build against the old site (`migration/verify`, Chrome for Testing) | 47 routes: 3 the same, 44 with expected differences only, **0 unexpected** (the same result as the video verification report) |
| Interactive video checks of that build, Chrome for Testing and WebKit | **58 of 58** videos OK in each: they start on their own, are muted, inline and looping, with controls, and `currentSrc` is the block's v2 MP4. Video counts equal Sanity and the old site on 12 of 12 page visits. 0 forbidden requests (1,483 in Chrome, 1,375 in WebKit). The console errors are the known third-party ones (Disqus, YouTube, Plausible TLS). |
| Both ffmpeg versions on all 29 originals, frame by frame | finding 2 |
| Live Function checks on staging, and the Function logs | Media 14 and media 25 as in finding 2, the retry and nudge as in finding 14, all cleaned up. The logs show exactly one invocation per conversion and none for the not-yet-due retry. No errors. |
| Mux | 0 assets were already confirmed by package B; the token still authenticates (finding 19) |

Outputs outside git, in `~/cjoshmartin-migration/`:

- `tmp/fix-r1/`: the ffmpeg 7.0.2 and 9.0.1 runs and their comparison (`run1/`), the browser
  frame test (`browser/`), the ENOSPC test, migration and Function-check logs, the Function logs,
  the nudge check, the build and its server log;
- `reports/parity-fix-r1/`: the parity crawl and the video checks of the new build;
- `reports/wp3/`: the pruning records.

### Regression found and fixed during the final check

The live smoke test after the second Blueprint deploy first failed before reaching Sanity. Commit
`902a6f3` had made `studio/schemaTypes/shared/video-conversion.ts` import the timing constants from
the Function's `trigger.ts`. `migration/verify` loads that file with Node's own type stripping,
which cannot resolve an extensionless import. The Studio build, `tsx` and the migration were not
affected, which is why the earlier checks passed. `9fd0cc7` moves the two constants into the
helpers. A test now checks that the helpers have only type imports and that the constants equal
the Function's; Node loads the file again, and the smoke test above then passed. Both validations
were rerun afterwards: 12 of 12 each.

## Owner actions

1. **Revoke the Mux token** in the Mux dashboard, then delete `MUX_TOKEN_ID` and
   `MUX_TOKEN_SECRET` from `secrets.env` (finding 19).
2. **Decide what happens to the kept originals** (finding 10): strip metadata, keep them private,
   or accept that they are public.
3. **After the merge, set up the revalidation webhook** and `SANITY_REVALIDATE_SECRET` (finding 6;
   morning report step 5).
4. **Optional: a scheduled sweep** for conversions nobody looks at (finding 15). It needs a one-way
   stack promotion and a robot token.
5. **Push the branch.** This package did not push. A new Preview deployment then shows the v2
   MP4s; the current one may still have pages with the deleted v1 URLs in its Data Cache.

## Round 2 (2026-11-26, 09:20 to 10:10 UTC)

Status: **6 of 6 findings from recheck 1 handled.** 3 are fixed and verified: the stuck check,
the settings version of failed conversions, and the plan's risk table. 3 are owner steps, and each
was re-confirmed read-only with nothing changed: the public originals, the revalidation webhook and
the Mux token.

The main change: the Studio's stuck-conversion check is now the **document form's root input**.
Round 1 attached it to the video block's input, but Sanity mounts that input only inside the
block's edit dialog. The real Studio build was tested live on staging this time, not a script that
imitates it.

### Commits (branch `sanity-migration`)

| Commit | What |
|---|---|
| `f67bd9b` | The stuck check moves to `VideoConversionWatcher` (root input of every document type that can hold videos); a failed conversion is final only for its settings version (R2-1, R2-5); tests, the contract and the Function README |
| `63f9b68` | Plan §15: the quotas row with the measured asset volume and the new bandwidth risk, and the Mux backup-cost row marked superseded (R2-6) |
| (this report's commit) | This section, correction notes on round 1's finding 15, and a bandwidth note in the morning report's current-state summary |

### Deployments

| What | Result |
|---|---|
| Studio (`https://cjoshmartin.sanity.studio`) | `npx sanity@latest deploy --yes` (6.25.0, the same as the local version) after `f67bd9b`: 2 of 2 schemas deployed, Studio deployed. `schema.json` is unchanged. The served `static/sanity-DV5W5ioL.js` has the same sha256 as the local build (`306c2c2e…`) and contains the watcher's request tags. |
| Blueprint `cjoshmartin-functions` (`ST-jc4gwa3c4t`) | `f67bd9b` changed a comment in `trigger.ts`, so the stack was redeployed to keep the deployed code equal to the commit: operation `OP-z27urztvpm`, with `npm_config_platform=linux npm_config_arch=arm64`. The plan showed the same filter. `video-to-mp4` is now asset `AS-4nz5puavgi`; `testimonial-ascii-art` is still `AS-dac26sc8in`. The bundled ffmpeg is ELF aarch64, 51,134,160 bytes, sha256 `6bb182d0…`, the pinned binary. |
| Datasets | No migration rerun was needed. No content changed, apart from the scratch documents of the live checks, which were cleaned up. |

### Findings

| # | Finding (source) | Severity | Resolution |
|---|---|---|---|
| R2-1 | The stuck check only runs while the video block's edit dialog is open (recheck 1) | medium | Fixed: document-level root input; verified live in the Studio build |
| R2-2 | Kept originals are publicly downloadable, 5 with GPS tags (recheck 1, finding 10) | medium | Re-confirmed, unchanged; **owner decision** |
| R2-3 | Revalidation webhook and secret not configured (recheck 1, finding 6) | low | Re-confirmed: no webhook exists, the code is unchanged and correct; **owner step** after the merge |
| R2-4 | Mux token still stored and valid (recheck 1, finding 19) | low | Re-confirmed: both lines set, the token still authenticates; **owner action** (Mux dashboard) |
| R2-5 | The Studio treats a failed conversion as final under any settings version; the Function does not (recheck 1) | low | Fixed: the Studio compares the settings version the way the Function does, and nudges an old-settings failure |
| R2-6 | Plan risk table still says videos live on Mux (recheck 1) | low | Fixed, plus the bandwidth risk this change introduces |

### R2-1. The stuck check ran only while the block's dialog was open

**Confirmed** in the installed `sanity` 6.25.0 (`lib/PerspectiveProvider-iaAV2XW5.js`).
`BlockObject` passes the member's input (`memberItem.input`) as `children` to the block component.
`DefaultBlockObjectComponent` renders `children` only in `open && jsx(ObjectEditModal, ...)`. So
`VideoConversionInput` was mounted only while an editor had that block's edit dialog open. Round
1's live check sent the nudge patch from a script, so it never exercised the component.

The effects were as the recheck said. A dead run, a due retry or a missed event waited for the next
edit of the document, so a published video could stay missing. The retry note shown to editors
("or while the document is open in the Studio") promised a retry that did not happen.

**Fix** (`f67bd9b`):

- **`studio/components/VideoConversionWatcher.tsx`** is registered as `form.components.input` in
  both workspaces (`sanity.config.ts`). This follows Sanity's documented root-input pattern (guide
  "Create a document form progress component"). It wraps the input with `id === 'root'` of every
  document type in `VIDEO_FIELDS_BY_TYPE`, the list the Function watches, which a test compares
  with `schema.json`. Every other input renders as before.
- **While the document's form is open**, in any field group, with no block or dialog needed, it
  checks the draft and the published document right away and then every minute. That works
  whichever version the form shows (draft, published, or a release version through
  `getPublishedId`).
- It covers every video block of the watched fields, in **one patch per document**, with
  `ifRevisionId`. A 409 is skipped: the other change is itself an event, and the next check looks
  again.
- **Rate limits:**
  - each block is nudged at most once per `RETRY_DELAY_SECONDS`, tracked across the browser tab,
    so a document open in several panes or tools is nudged once;
  - a check never overlaps a slow previous one.
- The block-level `VideoConversionInput.tsx` and the `components.input` of the `video` type are
  removed.
- **What the retry note says** (`RETRY_NOTE`, unchanged): "on the next change to the document, or
  while the document is open in the Studio". That is now true.
- **Docs:** the comment in `trigger.ts`, the Function README ("Stuck blocks", "Retrying"), the
  contract's Studio paragraph and its module table, and a pointer in `video.ts`.

**Live check on staging** (`~/cjoshmartin-migration/tmp/fix-r2/scripts/watcher-check.mjs`). It ran
on the real Studio build (`sanity preview` on localhost, headless Chrome for Testing, signed in
with the editor token through the Studio's token storage). The script wrote nothing after creating
the draft. **11 of 11 checks pass:**

| Step | Result |
|---|---|
| A scratch draft blog post with a unique `step_count.mp4` upload, `pending` for that file, due 75 s later | Function: no invocation while it was not due |
| The document opened, then the form switched to the **SEO group** | 0 video block previews on the page, no video dialog: the rich text is not rendered at all |
| The first check | Sent 4.2 s after opening (`sanity.studio.video-conversion.check`, 200); no nudge, the retry was not due |
| Once the retry was due | The Studio's next check sent the nudge (`video-conversion.retry` mutation, 200) **3.6 s after the retry was due**, with the SEO group still shown. It was the only nudge. The listener showed the write came from the Studio's token: `pending`, "Retry requested by the Studio at 09:49:45.033Z (the retry was due)." |
| The Function | `processing` 3 s later, `ready` 7.0 s after the nudge. The MP4 is `video/mp4`, source `video-to-mp4`/the upload, `videoToMp4SettingsVersion` `h264-crf23-max1920-v2`. The block preview shows "Ready". No page errors. |
| Cleanup | 0 drafts, 0 assets, 0 leases left |

Two earlier attempts stopped before the nudge: the Studio's "free upgrade" card covered the group
tab, so the script now selects the tab with a DOM click event. Both attempts cleaned up after
themselves. In both, the first check request was sent on open.

**Cost:** one query per open document form per minute (about 1,440 a day for a form left open all
day). The Free plan includes 250k API requests a month, and Sanity's docs exempt requests made by
the Studio.

**Still not covered:** documents nobody opens wait for their next edit. A scheduled sweep would
cover them. It needs the one-way promotion of the Blueprint stack to organization scope and a robot
token, so it stays the owner's decision (round 1, finding 15).

### R2-5. A failed conversion and the settings version

**Confirmed.** The Function treats `failed` as final only when `conversion.settingsVersion` equals
`SETTINGS_VERSION` (`isFailedForCurrentFile`, `PENDING_VIDEO_PREDICATE`). The Studio treated every
`failed` for the current file as final: it was a validation error, and the stuck check skipped it.
The Function always records the settings version on a failure (`conversionValue` in `patches.ts`).
No failed blocks exist today (0 in each dataset, checked anonymously).

**Fix** (`f67bd9b`, `studio/schemaTypes/shared/video-conversion.ts`):

- **The settings version is a parameter.** `videoConversionState` and `videoConversionNudge` take
  `currentSettingsVersion`, and every caller passes `SETTINGS_VERSION` from
  `functions/video-to-mp4/settings.ts`. That keeps one source of truth, and the helpers keep only
  type imports, so `migration/verify` can still load them with Node's type stripping.
- **What the Studio shows.** A failure under other settings, or with no settings version, is
  `waiting`. The preview reads "Waiting to retry the conversion: it failed with older settings
  (<version>) and is converted again with the current settings. The last error: <message>". It is
  not a validation error, so the document can be published. The preview now selects
  `conversion.settingsVersion`.
- **The nudge.** The stuck check has a new reason, `settings-changed`, used once the failure is
  older than `RETRY_DELAY_SECONDS`. The nudge keeps `failed` and only sets `updatedAt` to now.
  The write is the event, and the Function decides with its own `SETTINGS_VERSION`. So while the
  Studio and the Function are deployed with different settings, in either order:
  - the block is not converted again with the settings it already failed with;
  - it is touched at most once per retry delay, and since `updatedAt` is in the document, this
    holds across tabs too.

**Tests** (`studio/test/video-conversion.test.ts`, 27 tests):

- labels for failures under the current, an older and no settings version;
- the Studio's final-failure rule equals `isFailedForCurrentFile` for every combination of
  settings version and source;
- nudge cases at the edges of the delay. Each nudged block matches the Function's GROQ filter
  (groq-js) and `isPendingVideo`, and is not nudged again right away;
- a Studio deployed with newer settings than the Function nudges, but the Function's filter skips
  the block.

The migration's test (`documents.test.ts`) passes the version too.

**Live:** not exercised. The live Function retries an old-settings failure on the event that
creates it, so the Studio-only path cannot be set up without a settings change. Both datasets
validate with 0 errors under the new rule.

### R2-2. Kept originals are public (round 1, finding 10)

**Re-confirmed, read-only, unchanged.** An anonymous GROQ query on the API CDN returns the 29
Wagtail originals in each dataset. An anonymous ranged GET of `IMG_0169.MOV` from production
answers 206. The options and the owner action are as in round 1. Nothing was changed: the owner's
brief says to keep the original, and the choice changes what "original" means. One addition:
making the datasets private would also hide the originals' listing, but the Free plan only allows
public datasets (Sanity's pricing page lists "2 datasets (public only)").

### R2-3. Revalidation webhook (round 1, finding 6)

**Re-confirmed.** `sanity hook list` returns no webhooks, and the route and the cache tag are
unchanged since round 1. Setting them up needs the production Vercel env var, which this package
may not touch, and the route only exists after the merge. So it stays morning report step 5.

The sitemap note is not a code defect. In next-sanity 13.5.1, `sanityFetch` first looks up the
sync tags with a plain `client.fetch`, without `next` options
(`dist/live/conditions/react-server/index.js`). That lookup is the entry without the tag that
`next build` stored, and it only decides which sync tags the data fetch gets. The data fetch itself
carries `sanity-content`, so the webhook refreshes the sitemap's content.

### R2-4. Mux token (round 1, finding 19)

**Re-confirmed.** `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` are still set in `secrets.env` (checked for
presence only). `GET https://api.mux.com/video/v1/assets?limit=1` with them still answers 200
(only the status was printed). No code reads them. Revoking needs the Mux dashboard (Settings,
Access Tokens). Morning report step 3.

### R2-6. The plan's risk table

**Fixed** (`63f9b68`). The quotas row now gives the measured volume, read anonymously from both
datasets: 465.9 MiB each, of which 110 images are 108.5 MiB, the 29 kept originals 261.2 MiB, the
29 MP4s 86.0 MiB and 5 other files 10.2 MiB. That is about 0.9 GiB for the project, and 96
documents per dataset. The neighbouring "Mux master-access cost for backups" row was stale too, and
is marked superseded.

**New risk, recorded in that row: bandwidth.** The Free plan's 100 GB/month bandwidth covers API,
CDN and asset traffic. Without Mux, the site serves the MP4s from Sanity's CDN, and every video
autoplays:

- one full view of `squid-games-nerf-gun` (8 videos) downloads up to 58.35 MiB of MP4s, so about
  1,600 such views in a month use the whole quota;
- on the Free plan that blocks the public API and CDN until the month resets (Sanity's "Plans and
  payments" docs), so the site's content stops loading;
- Sanity emails the admins at 80 % and 100 %, and Growth turns the block into overage.

The other pages with videos carry 9.0, 8.7, 6.0, 3.2 and 0.8 MiB. The 100 GB asset and 10k
document quotas are not at risk.

### Round 2 verification summary

| Check | Result |
|---|---|
| Studio: `npm test`, `npm run typecheck`, `eslint .`, prettier on the changed files, `npm run build` | 61 of 61, pass, pass, pass, pass |
| Studio: `schema:extract` | `schema.json` unchanged |
| Function: `npm run typecheck`, `npm test` | pass, 103 of 103 |
| Migration: `npm test`, `npm run typecheck` | 71 of 71, pass |
| Verify harness: `npm test`, and loading the helpers with Node's type stripping | 18 of 18; loads |
| Studio validation, production and staging (`--level error`) | 96 valid documents each, 0 errors |
| Live Studio check on staging (R2-1) | 11 of 11, cleaned up |
| Live Function check on staging after the redeploy (`video-function-check.mjs`, media 15 `IMG_0169.MOV`) | All checks pass: `ready` after 32.5 s, H.264 High 1440x1920, AAC stereo, 594 of 594 frames at their times, decodes cleanly, the only MP4 of the upload; 63 file assets and 269 documents before and after |
| Served Studio bundle | Same sha256 as the local build |

Outputs outside git: `~/cjoshmartin-migration/tmp/fix-r2/` (the scripts, the Studio check's log,
`result.json` and screenshots, the probes and the Function check's JSON).

### Owner actions after round 2

The round 1 list stands, with one addition:

1. **Revoke the Mux token** in the Mux dashboard, then delete both lines from `secrets.env` (R2-4).
2. **Decide what happens to the kept originals** (R2-2).
3. **After the merge, set up the revalidation webhook** and `SANITY_REVALIDATE_SECRET` (R2-3).
4. **Optional: a scheduled sweep** for conversions in documents nobody opens (R2-1).
5. **Push the branch** (this package did not push).
6. **New: keep an eye on bandwidth** once the site serves videos from Sanity (R2-6). Upgrading to
   Growth, or moving the heaviest page's videos off autoplay, would remove the hard stop.
