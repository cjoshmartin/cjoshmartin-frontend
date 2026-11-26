# video-to-mp4

Sanity Function that converts every video uploaded in the Studio to an MP4 with the fixed
settings in `settings.ts` (video contract v2, `docs/sanity-migration/schema-contract.md`,
"Videos"). The site only plays `video.file`; after conversion that is the MP4, and the upload is
kept in `video.original` (read-only, never served).

| File | What it is |
| --- | --- |
| `settings.ts` | The MP4 settings, single source of truth (`SETTINGS_VERSION`, `buildFfmpegArgs`, ...). Owned by the Studio package; no imports. |
| `trigger.ts` | Event filter and projection, the watched fields per document type, and the same "which block needs work" rule in TypeScript. |
| `orchestrator.ts` | One run: pick the block, take the per-upload lease, mark `processing`, adopt / reuse / convert, deliver the result, release. |
| `patches.ts` | The patches the Function writes (by block `_key`) and the lease rules. |
| `convert.ts` | Download (or range proxy), `ffmpeg -i` description, conversion, MP4 checks, full decode check, frame-time check. |
| `frames.ts` | Frame times from ffmpeg's `showinfo` filter and the check that every input frame is in the MP4 at its own time. |
| `media-info.ts` | Parser for `ffmpeg -i` output (audio, displayed size after rotation, duration); replaces ffprobe. |
| `mp4.ts` | Minimal MP4 reader and the output checks (H.264 High 4:2:0 8-bit, size, no rotation, AAC stereo, faststart, duration). |
| `range-proxy.ts` | `127.0.0.1` HTTP proxy to the CDN for uploads too large for `/tmp` (static ffmpeg cannot resolve DNS in Lambda). |
| `ffmpeg.ts` | ffmpeg-static path, sha256 check of the binary, async runner with a deadline. |
| `sanity.ts` | Content Lake store (revision-checked patches, queries) and the MP4 upload. |
| `index.ts` | The handler. |
| `test/` | `npm test` (unit, in-memory store) and `npm run test:ffmpeg` (real ffmpeg). |
| `scripts/check-originals.ts` | Runs the conversion pipeline on a folder of videos and cross-checks with ffprobe. |
| `scripts/live-check.ts` | End-to-end check of the deployed Function on staging (scratch document, cleaned up). |

## How it works

1. **Trigger.** `create` and `update` of `blogPost`, `project`, `flexPage`, `testimonial` (field
   `body`), `homePage`, `person` (`bio`) and `service` (`description`), drafts included, in
   `production` and `staging`, when a `video` block needs work:
   - `file.asset._ref` is set and differs from `conversion.outputAssetId` (the contract rule), and
   - it is not `processing` for the current file with `updatedAt` less than 20 minutes old
     (timeout + 5 min; an older mark belongs to a run that died and is retried), and
   - it is not `pending` for the current file with `updatedAt` less than 10 minutes old (a
     retryable problem, see below), and
   - it has not `failed` for the current file with the current `SETTINGS_VERSION`.
2. **One block per run.** The first such block. Marking it `processing` is an update event, which
   starts a run for the next block, so several videos convert in parallel.
3. **Lease.** The run sets `videoToMp4Lease` on the upload's asset document with a
   revision-checked patch. Only one run can hold it, so one upload is never converted twice at
   once, even from different documents. A run that finds it held marks its block `processing`
   ("waiting") and stops; the holder delivers its result to every waiting block.
4. **MP4.** In order: the file already is an MP4 made by this converter with the current settings
   (adopt it as it is); the file is an MP4 this converter made with older settings and its
   original still exists (point `file` back at the original, which the next run converts); an
   asset with `source: {name: "video-to-mp4", id: <upload>}` and `videoToMp4SettingsVersion` =
   `SETTINGS_VERSION` exists (reuse it); otherwise convert: download to `/tmp` (sha1 checked) when
   the upload is at most 400 MB and it plus an MP4 1.5 times its size fit in the free space, else
   read through the range proxy (also the fallback when `/tmp` fills up during a downloaded
   conversion); describe with `ffmpeg -i`; run `buildFfmpegArgs` (preset `medium`) with a second
   output that logs every decoded input frame's time (`showinfo`); check the MP4 (`mp4.ts`); decode
   it completely, logging its frame times; require every input frame at its own time and no other
   frame (`frames.ts`, 1 ms); upload it as `<base>.mp4`, `video/mp4`, with that `source`; and record
   `videoToMp4SettingsVersion` on the new asset.
5. **Result.** Ready: `file` = the MP4, `original` = the upload, `conversion` = `{status: ready,
   message, sourceAssetId, outputAssetId, settingsVersion, updatedAt}`. Failed (the video itself
   cannot be converted): `conversion` = `{status: failed, message, sourceAssetId, settingsVersion,
   updatedAt}`, `file` left on the upload. Retry (not the video's fault: the ffmpeg binary check,
   a download, the CDN connection, an API error or any unexpected error): the same with `status:
   pending` and a message saying it is retried. The result goes to every draft or published block
   that still uses the upload (a draft published mid-conversion is converted in its published
   document, without a second conversion), and again after the lease is released for blocks that
   started waiting meanwhile.
6. Every write is a patch on `field[_key=="..."]` with `ifRevisionID`, re-read and retried on a
   conflict, so concurrent edits are kept and a block whose file changed meanwhile is left alone.

**Retrying.** A `failed` conversion is final for that upload and settings version (otherwise the
failure patch would trigger another run, and it would fail the same way). To retry, remove the
video block and add the video again, or upload another file. A new `SETTINGS_VERSION` retries
failed blocks once. A `pending` one (a retryable problem) is retried by the first event at least
10 minutes after it was written, so after a redeploy that fixes the converter the next save, or
opening the document in the Studio, converts it.

**Stuck blocks.** The Function only runs on a document event. While a document is open in the
Studio, the video block's input (`studio/components/VideoConversionInput.tsx`) checks every
minute for a block that is stuck: `processing` older than 20 minutes (a run that died),
`pending` older than 10 minutes (a retry that is due), or no status at all on a document unchanged
for 20 minutes (a missed event). It then writes `pending` to that block, which is the event that
starts the Function again. A scheduled sweep would also cover documents nobody opens, but
scheduled Functions need the Blueprint stack promoted to organization scope (one-way) and a robot
token; that is the site owner's decision.

**Limits.** 10 GB memory, 900 s timeout; ffmpeg is stopped 60 s before the timeout and the block
is marked failed. The worst case measured by the spike (60 s of 4K 10-bit HEVC) takes about 54 s.
`/tmp` is 512 MB: uploads that do not fit together with an MP4 1.5 times their size (or are above
400 MB) are read through the range proxy, so only the MP4 must fit; a downloaded conversion that
fills `/tmp` is converted again through the proxy.
Each block's run is started by the previous run's `processing` patch, and Sanity stops chains of
Function-caused runs after 16 (recursion guard, `@sanity/client` lineage header). So one save
should convert at most about 15 new videos of one document, and the next save picks up the rest.
This limit is from Sanity's documentation and was not tested here.

## Deploying

The Function runs on AWS Lambda **linux/arm64**. `blueprints deploy` installs the dependencies on
the deploying machine (`npm i --omit=dev` with install scripts), so ffmpeg-static downloads the
binary for that machine unless told otherwise. Always deploy from `studio/` with:

```sh
npm_config_platform=linux npm_config_arch=arm64 npx sanity@latest blueprints plan
npm_config_platform=linux npm_config_arch=arm64 npx sanity@latest blueprints deploy
```

npm 11 warns that these env configs "will stop working in the next major version". If a deploy
ships another binary anyway, every conversion fails closed with "the bundled ffmpeg ... is not the
expected linux/arm64 build ... redeploy" (sha256 checked at cold start against ffmpeg-static
5.3.0's linux-arm64 binary, John Van Sickle's ffmpeg 7.0.2, GPLv3). After a deploy you can check
`.build/function-video-to-mp4/node_modules/ffmpeg-static/ffmpeg` (ELF aarch64, sha256
`6bb182d0...fb8ce`). `ffmpeg-static` is pinned exactly because the build has no lockfile.

## Commands

```sh
npm ci                     # in this directory (installs this machine's ffmpeg-static binary)
npm test                   # unit tests
npm run test:ffmpeg        # needs ffmpeg >= 7.0 and ffprobe on PATH (libx264, libx265)
npm run typecheck

npx tsx scripts/check-originals.ts ~/cjoshmartin-migration/gcs/media --json report.json
SANITY_PROJECT_ID=... SANITY_WRITE_TOKEN=... npx tsx scripts/live-check.ts \
  --first <hevc.mov> --second <video> --json result.json

# from studio/
SANITY_PROJECT_ID=j3vdh6ti npx sanity@latest functions logs video-to-mp4 --stack ST-jc4gwa3c4t
```

ffmpeg 7.0 or newer is required wherever `buildFfmpegArgs` runs (`checkFfmpegVersion` in
`settings.ts`; the integration tests, `scripts/check-originals.ts` and the migration's convert
step refuse older ones): before 7.0, `-autorotate` took a value and swallowed the `-i` after it.
That is why the integration tests use the ffmpeg on PATH, not the ffmpeg-static 6.0 binary that
`npm ci` installs on macOS. The Function's own binary is pinned by sha256 (7.0.2).
