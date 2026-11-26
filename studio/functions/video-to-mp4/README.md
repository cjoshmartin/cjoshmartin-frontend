# video-to-mp4

Sanity Function that converts every video uploaded in the Studio to an MP4 with the fixed
settings in `settings.ts` (video contract v2, `docs/sanity-migration/schema-contract.md`,
"Videos"). The site only plays `video.file`; after conversion that is the MP4. The upload is kept
in `video.original` (read-only, never served) as a copy without its location and personal
metadata (`../privacy/isobmff-video.ts`, edited in place; `../privacy/video-strip.ts`, a stream
copy, for other containers), and the unstripped upload is deleted ("Privacy" in the contract).

| File | What it is |
| --- | --- |
| `settings.ts` | The MP4 settings, single source of truth (`SETTINGS_VERSION`, `buildFfmpegArgs`, ...). Owned by the Studio package; no imports. |
| `trigger.ts` | Event filter and projection, the watched fields per document type, and the same "which block needs work" rule in TypeScript. |
| `orchestrator.ts` | One run: pick the block, take the per-upload lease, mark `processing`, adopt / reuse / convert, deliver the result, release. |
| `patches.ts` | The patches the Function writes (by block `_key`) and the lease rules. |
| `convert.ts` | Download (or range proxy), `ffmpeg -i` description, conversion, MP4 checks (including no metadata boxes besides ffmpeg's encoder tag), full decode check, frame-time check. |
| `strip-original.ts` | The copy of the upload without location and personal metadata: download, `stripIsobmffInPlace` (or the `stripVideo` stream copy for other containers, also through the range proxy), upload with source `video-to-mp4-original`, `privacy` stripped, the upload marked `replaced` (or `clean`, kept as it is). Also used by the upload-privacy Function. |
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
   `body`), `homePage`, `person` (`bio`) and `service` (`description`), drafts and release versions
   included (`includeAllVersions`; a version in a scheduled, published or archived release is left
   alone), in `production` and `staging`, when a `video` block needs work:
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
4. **Private original.** Unless the file is an MP4 of this converter (adopted or swapped back as
   below): the upload already is a stripped copy or was found clean (`privacy` stripped or clean
   with `VIDEO_STRIP_VERSION`; use it), or the upload-privacy Function is stripping it right now
   (a fresh `processing` mark: wait up to 5 minutes for its copy), or an earlier stripped copy of
   it exists (`source: {name: "video-to-mp4-original", id: <upload>}` with the current strip
   version; reuse it), or the upload is stripped now: download to `/tmp` (sha1 checked), then
   `stripIsobmffInPlace` for QuickTime/MP4 (metadata boxes, data tracks, creation times, handler
   names and unused `mdat` bytes removed without moving a byte; checked: bytes outside the changed
   ranges, nothing personal left, the same streams and side data, every packet with its time
   stamps), or for other containers and refused files the `stripVideo` stream copy (through the
   range proxy when the copy fits in `/tmp` but the upload does not fit next to it); upload with
   that source (in place: the upload's file name and type); record `privacy` = {status: stripped,
   version, strippedFrom, removed, ...} on it and `privacy` = {status: replaced,
   replacementAssetId} on the upload. An upload with nothing personal is marked `clean` and is its
   own original. A file that cannot be stripped fails the conversion (`failed`); a problem that is
   not the file's fault is `pending`. The stripped copy is what is converted.
5. **MP4.** In order: the file already is an MP4 made by this converter with the current settings
   (adopt it as it is); the file is an MP4 this converter made with older settings and its
   original still exists (point `file` back at the original, which the next run converts); an
   asset with `source: {name: "video-to-mp4", id: <stripped copy>}` and `videoToMp4SettingsVersion`
   = `SETTINGS_VERSION` exists (reuse it); otherwise convert the copy: download to `/tmp` (sha1 checked) when
   the upload is at most 400 MB and it plus an MP4 1.5 times its size fit in the free space, else
   read through the range proxy (also the fallback when `/tmp` fills up during a downloaded
   conversion); describe with `ffmpeg -i`; run `buildFfmpegArgs` (preset `medium`) with a second
   output that logs every decoded input frame's time (`showinfo`); check the MP4 (`mp4.ts`); decode
   it completely, logging its frame times; require every input frame at its own time and no other
   frame (`frames.ts`, 1 ms); upload it as `<base>.mp4`, `video/mp4`, with that `source`; and record
   `videoToMp4SettingsVersion` on the new asset.
6. **Result.** Ready: `file` = the MP4, `original` = the stripped copy, `conversion` = `{status:
   ready, message, sourceAssetId (the copy), outputAssetId, settingsVersion, originalStripped: true,
   stripVersion, updatedAt}`. Failed (the video itself
   cannot be converted): `conversion` = `{status: failed, message, sourceAssetId, settingsVersion,
   updatedAt}`; once the stripped copy exists, `file` moves to the copy (and `sourceAssetId` is the
   copy), otherwise (the strip itself failed) it stays on the upload. Retry (not the video's fault:
   the ffmpeg binary check, a download, the CDN connection, an API error or any unexpected error):
   the same with `status: pending` and a message saying it is retried; `file` moves to the copy
   when it exists, so the retry converts the copy. The result goes to every draft, published or
   active-release block that still uses the upload (a draft published mid-conversion is converted
   in its published document, without a second conversion), and again after the lease is released
   for blocks that started waiting meanwhile. Then, whatever the outcome, the unstripped upload is
   deleted if no document (drafts, published, release versions) references it any more;
   otherwise the run for the block that still uses it, or the upload-privacy sweep once nothing
   does, deletes it.
7. Every write is a patch on `field[_key=="..."]` with `ifRevisionID`, re-read and retried on a
   conflict, so concurrent edits are kept and a block whose file changed meanwhile is left alone.

**Retrying.** A `failed` conversion is final for that upload and settings version (otherwise the
failure patch would trigger another run, and it would fail the same way). To retry, remove the
video block and add the video again, or upload another file. A new `SETTINGS_VERSION` retries
failed blocks once, on the next event of their document (the Studio sends one while the document
is open, see below; until then it shows the block as waiting, not failed). A `pending` one (a
retryable problem) is retried by the first event at least 10 minutes after it was written, so
after a redeploy that fixes the converter the next save, or opening the document in the Studio,
converts it.

**Stuck blocks.** The Function only runs on a document event. While a document's form is open in
the Studio, whichever field group, block or dialog is shown, the form's root input
(`studio/components/VideoConversionWatcher.tsx`, registered as `form.components.input` in
`studio/sanity.config.ts` for every type in `VIDEO_FIELDS_BY_TYPE`) checks the draft and the
published document right away and then every minute for a block that is stuck: `processing` older
than 20 minutes (a run that died), `pending` older than 10 minutes (a retry that is due), no status
at all on a document unchanged for 20 minutes (a missed event), or `failed` under another
`SETTINGS_VERSION` more than 10 minutes ago. It then writes to that block (`pending`, or for the
old-settings failure only a new `updatedAt`), at most once per block every 10 minutes, and that
write is the event that starts the Function again. Documents nobody opens are not checked. A
scheduled sweep would cover them, but scheduled Functions need the Blueprint stack promoted to
organization scope (one-way) and a robot token; that is the site owner's decision.

**Limits.** 10 GB memory, 900 s timeout; ffmpeg is stopped 60 s before the timeout and the block
is marked failed. Stripping needs the copy (about the upload's size) to fit in `/tmp` (512 MB), so
uploads above about 480 MB fail with a message. The worst case measured by the spike (60 s of 4K 10-bit HEVC) takes about 54 s.
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
