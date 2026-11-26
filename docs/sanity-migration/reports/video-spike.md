# Spike: converting videos to MP4 inside a Sanity Function

Status: **done. Verdict: feasible.** A Sanity Function can run a bundled static ffmpeg. It
converted the worst case (60 s, 3840x2160, 10-bit HEVC, rotated, with audio) with the video
contract v2 settings, at preset `medium`, in **136 s at 4 GB** and **54 s at 10 GB** (whole
handler: download, convert, verify, upload). The criterion was under 600 s. All 16 successful
conversions passed every output check.

Spike window: 2026-11-26 04:30 to 05:18 UTC. Everything it created in Sanity has been removed
(see "Cleanup").

## Recommendation for the production `video-to-mp4` Function

| Setting | Value | Why |
| --- | --- | --- |
| Bundling | `ffmpeg-static@5.3.0` (pinned exactly) in the function's own `package.json`, deployed with `npm_config_platform=linux npm_config_arch=arm64` set in the environment of `npx sanity@latest blueprints deploy` | The runtime is **linux/arm64**, but the deploy hydrates `node_modules` on the deploying machine (see "How ffmpeg was bundled") |
| Binary check | At cold start, compare the binary's sha256 with `6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce` and fail closed (`conversion.status = failed` with a clear message) | The ffmpeg-static install script verifies nothing. A deploy without the env vars would ship a macOS binary. Hashing costs about 0.4 s per cold start |
| `memory` | **10** (GB) | CPU scales with memory, and the work is CPU-bound, so cost in GB-seconds is about the same at 4 and 10 GB. 10 GB is 2.4 to 2.6 times faster (worst case 54 s instead of 136 s), so the editor waits less |
| `timeout` | **900** (s) | Maximum. Kill ffmpeg about 30 s before it and record `failed`, as the spike did, so a timeout never leaves `processing` behind |
| preset | **`medium`** (the `buildFfmpegArgs` default) | Fast enough at either size. A faster preset saved 15 to 30% but is not needed; using one preset everywhere keeps local and Function output on one setting |
| `runtime` | `'nodejs24.x'`, set explicitly | The spike's functions ran Node v24.22.3 without a runtime set, but the `@sanity/blueprints@0.35.0` types document `nodejs26.x` as the default |
| Input handling | Download to `/tmp` when `asset.size` is at most about 400 MB. Above that, let ffmpeg read through a localhost range proxy (below), or fail with a message | `/tmp` is fixed at 512 MB whatever the memory size, and static ffmpeg cannot resolve DNS |
| Spawning | Run ffmpeg with async `spawn`, never `spawnSync` | A synchronous spawn blocks the event loop, which also blocks the proxy |

**GitHub Actions fallback: not needed.**

## Runtime facts (first invocation)

Measured by the `probe` mode of the scratch function at both memory sizes:

| Fact | 4 GB | 10 GB |
| --- | --- | --- |
| `process.platform` / `process.arch` | linux / **arm64** | linux / **arm64** |
| Node | v24.22.3 | v24.22.3 |
| Host | AWS Lambda (`AWS_Lambda_nodejs24.x`), eu-central-1, kernel 5.10 amzn2 aarch64 | same |
| `os.cpus().length` / `availableParallelism()` | 3 / 3 | 6 / 6 |
| CPU that ffmpeg actually got | about 1.95 cores (2.27 in URL mode) | about 4.9 cores |
| Total memory (`os.totalmem()`) | 4.30 GiB | 10.46 GiB |
| Writable temp dir | `/tmp` (ext4, read-write) | same |
| `/tmp` size / free | 512 MiB volume, 525 MiB free reported by `df`, 538 MB by `statfs` | same (does **not** grow with memory) |
| Code directory | `/var/task`, squashfs, read-only (`EROFS` on write), exec allowed | same |
| Child processes | allowed (`/bin/sh`, ffmpeg) | same |
| Tools present | `curl`, `ldd`; no `file`, `tar`, `xz` or `gzip` | same |
| Process limits | 1024 processes, 1024 open files | same |

Blueprints has no option for architecture or ephemeral storage. Its function options are
`timeout`, `memory`, `env`, `robotToken` and `runtime`, so arm64 and the 512 MB `/tmp` are fixed.

## How ffmpeg was bundled

- **Package:** `ffmpeg-static@5.3.0`, GPL-3.0-or-later, binary release tag `b6.1.1`. Its install
  script downloads `ffmpeg-<platform>-<arch>.gz` from the package's GitHub releases. It picks the
  platform from `npm_config_platform` / `npm_config_arch` when set, otherwise from the host. At
  runtime, `index.js` uses `os.platform()` and `os.arch()`, so it returns
  `/var/task/node_modules/ffmpeg-static/ffmpeg` in the Function.
- **Binary that ran:** John Van Sickle's static build `ffmpeg-7.0.2-arm64-static`, 51,134,160
  bytes, sha256 `6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce`.
  - Built with `--enable-gpl --enable-version3`, so the licence is GPLv3.
  - Includes libx264 0.164, libx265, libzimg (zscale), libdav1d, libvpx and gnutls.
  - `ffmpeg -version` exited 0 in the Function in 8 ms. The `libx264` and `aac` encoders and the
    `h264`, `hevc`, `vp9`, `vp8`, `prores` and `pcm_s16le` decoders are all present.
- **Size:** the deployed function asset was about **70 MB** uncompressed, against the
  200 MB limit. About 51 MB is the binary; the rest is `@sanity/client` and `@sanity/functions`.
  The x64 build (first deploy) is 79.8 MB, for an asset of about 100 MB.
- **Executable bit:** survives packaging (mode 755 in `/var/task`), so ffmpeg runs in place. No
  copy to `/tmp` is needed.
- **Why the env vars are needed:** `blueprints deploy` (runtime-cli 17.23.0) transpiles a TS
  function into `.build/function-<name>/` and then hydrates its dependencies with Architect's
  hydrate. Hydrate runs `npm i --omit=dev` on the deploying machine, with install scripts enabled,
  and inherits the shell's environment.
  - Without the variables, the macOS arm64 binary is shipped. The first spike deploy guessed
    x64 and shipped a working-looking but wrong x86-64 binary.
  - With `npm_config_platform=linux npm_config_arch=arm64`, the build directory gets the right
    ELF aarch64 binary.
  - The variables also apply to `testimonial-ascii-art` when it is deployed in the same run. That
    is harmless: its dependencies are pure JavaScript.
- **Caveats for production:**
  1. **npm deprecation.** npm 11.17 prints `npm warn Unknown env config "platform"/"arch". This will
     stop working in the next major version of npm.` The download works today. Keep the sha256
     check above so a future npm cannot silently ship the wrong binary.
  2. **No lockfile in the build.** The lockfile is not copied into the build directory, so
     hydrate resolves version ranges at deploy time. Pin `ffmpeg-static` exactly.
  3. **GitHub at deploy time.** The binary is downloaded from GitHub on every deploy.
- **Native-module rule:** the CLI rejects only packages that contain `*.node` or `binding.gyp`.
  An executable inside `node_modules` passes.
- **Not recommended:** committing the binary to the repository (51.1 MB, just over GitHub's
  50 MB warning size).
- **Licence:** the Function runs the binary for this site only; it is not distributed. If the
  binary is ever shipped elsewhere, the GPLv3 terms apply. The licence text comes with the package
  as `ffmpeg.LICENSE`.

## Test inputs

Each input was uploaded to `staging` as a file asset. Before upload, a top-level ISO BMFF `free`
box was appended to each copy. That made the bytes, and so the content-addressed asset id, unique
to the spike, without touching any media data. A spike asset could therefore never be the same
asset as the migration's own upload of the same original.

| Label | File | What it is | Size |
| --- | --- | --- | --- |
| a | `media/Screen_Recording_2025-05-05_at_2.55.11PM.mov` | H.264 Main, 3420x2080, 60 fps, 30.8 s, no audio | 12.1 MB |
| b | `media/deep_linking.MP4` | HEVC Main, 886x1920 (yuvj420p), 60 fps, 6.6 s, AAC stereo | 1.8 MB |
| c | synthetic worst case | HEVC **Main 10** (yuv420p10le), 3840x2160, 30 fps, 60.0 s, **rotation −90** (displayed portrait), HLG / BT.2020 tags, 28 Mbps, **moov at the end**, AAC stereo 48 kHz. Content: `testsrc2` plus temporal noise, so the encoder does not get an easy picture | 211.5 MB |
| d (extra) | `media/IMG_3151.MOV` | A real iPhone clip: HEVC Main 10, 1920x1080, 29.97 fps, rotation −90, HLG plus Dolby Vision 8.4, AAC stereo, 15.7 s | 20.2 MB |

The synthetic file was made locally with Homebrew ffmpeg 9.0.1 and VideoToolbox:

```sh
ffmpeg -f lavfi -i "testsrc2=size=3840x2160:rate=30:duration=60" \
  -f lavfi -i "anoisesrc=color=pink:sample_rate=48000:amplitude=0.1:duration=60" \
  -filter_complex "[0:v]noise=alls=10:allf=t+u,format=p010le[v];[1:a]aformat=channel_layouts=stereo[a]" \
  -map "[v]" -map "[a]" -c:v hevc_videotoolbox -profile:v main10 -b:v 30M -maxrate 40M -bufsize 60M \
  -tag:v hvc1 -c:a aac -b:a 192k synthetic-raw.mov
ffmpeg -display_rotation:v:0 -90 -i synthetic-raw.mov -map 0 -c copy \
  -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9 \
  synthetic-4k-hevc-60s.mov
```

It is kept at `~/cjoshmartin-migration/tmp/video-spike/inputs/synthetic-4k-hevc-60s.mov`, outside
git, for the live test of the production Function.

## Conversion settings used

These are the video contract v2 settings, `h264-crf23-max1920-v1`. The spike's argument list, in
`buildFfmpegArgs` in the scratch function:

```text
-hide_banner -nostdin -y -i <input> -map 0:v:0 [-map 0:a:0]
-map_metadata -1 -map_metadata:s -1 -map_chapters -1
-vf scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p
-c:v libx264 -profile:v high -preset <preset> -crf 23 -pix_fmt yuv420p
[-c:a aac -b:a 128k -ac 2 | -an] -sn -dn -movflags +faststart <output>.mp4
```

Autorotation is ffmpeg's default and was left on. `hasAudio` came from parsing the stream list
printed by `ffmpeg -hide_banner -i <input>` (that command exits 1 by design). No ffprobe binary
was bundled.

## Measurements

The functions ran in the scratch stack, triggered in `staging`. Each queue ran one conversion at
a time per function; the 4 GB and 10 GB queues ran at the same time. All times are wall-clock
times inside the handler.

- **Container**: the invocation number within one Lambda container. #1 is a cold start.
- **Handler**: from the start of the handler to just before the final patch.
- **Peak ffmpeg**: the highest `VmHWM` of the ffmpeg process, sampled from `/proc` every 250 ms.
- **System**: MemTotal minus the lowest MemAvailable seen while ffmpeg ran.
- **CPU s**: ffmpeg's utime + stime.
- **GB-s**: memory × handler time, the billed unit.

| Input | Mem | Preset | Input mode | Container | Download s | Encode s | Upload s | Handler s | GB-s | Peak ffmpeg MiB | System MiB | CPU s | Cores used | Output MB | Output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| c synthetic | 4 | medium | download | #2 | 4.2 | **130.8** | 0.8 | **136.0** | 544 | 945 | 1277 | 255.6 | 1.95 | 23.04 | 1080x1920 |
| c synthetic | 4 | fast | download | #3 | 1.0 | 116.8 | 0.7 | 118.6 | 474 | 773 | 1099 | 228.2 | 1.95 | 24.06 | 1080x1920 |
| c synthetic | 4 | veryfast | download | #4 | 4.1 | 92.5 | 0.7 | 97.4 | 390 | 640 | 970 | 180.5 | 1.95 | 20.31 | 1080x1920 |
| c synthetic | 4 | medium | url (proxy) | #1 (cold) | – | 181.6 | 0.8 | 183.7 | 735 | 884 | 1209 | 411.6 | 2.27 | 23.04 | 1080x1920 |
| c synthetic | 10 | medium | download | #2 | 1.7 | **51.6** | 0.8 | **54.2** | 542 | 1215 | 1576 | 252.2 | 4.89 | 23.02 | 1080x1920 |
| c synthetic | 10 | fast | download | #3 | 0.6 | 46.0 | 0.7 | 47.4 | 474 | 1116 | 1487 | 224.3 | 4.88 | 24.04 | 1080x1920 |
| c synthetic | 10 | veryfast | download | #4 | 4.3 | 36.7 | 0.7 | 41.9 | 419 | 975 | 1352 | 178.4 | 4.86 | 21.00 | 1080x1920 |
| c synthetic | 10 | medium | url (proxy) | #1 (cold) | – | 51.9 | 0.8 | 53.7 | 537 | 1221 | 1607 | 249.9 | 4.81 | 23.02 | 1080x1920 |
| a screen recording | 4 | medium | download | #5 | 0.5 | 36.1 | 0.5 | 37.1 | 149 | 916 | 1255 | 70.2 | 1.94 | 0.84 | 1920x1168 |
| a screen recording | 4 | fast | download | #6 | 0.3 | 39.5 | 0.5 | 40.4 | 162 | 841 | 1182 | 76.9 | 1.95 | 0.76 | 1920x1168 |
| a screen recording | 4 | veryfast | download | #7 | 0.3 | 26.6 | 0.5 | 27.5 | 110 | 703 | 1047 | 51.6 | 1.94 | 0.68 | 1920x1168 |
| a screen recording | 10 | medium | download | #5 | 0.2 | 15.0 | 0.5 | 15.9 | 159 | 1090 | 1461 | 71.6 | 4.76 | 0.84 | 1920x1168 |
| b deep_linking (HEVC) | 4 | medium | download | #8 | 0.2 | 5.2 | 0.5 | 6.0 | 24 | 488 | 832 | 9.8 | 1.87 | 0.32 | 886x1920 |
| b deep_linking (HEVC) | 10 | medium | download | #6 | 0.2 | 2.5 | 0.5 | 3.2 | 32 | 594 | 964 | 9.4 | 3.74 | 0.32 | 886x1920 |
| d iPhone HDR (extra) | 4 | medium | download | #9 | 0.7 | 41.4 | 0.7 | 42.8 | 171 | 616 | 963 | 80.4 | 1.94 | 6.02 | 1080x1920 |
| d iPhone HDR (extra) | 10 | medium | download | #7 | 0.4 | 17.4 | 0.6 | 18.4 | 184 | 761 | 1135 | 81.0 | 4.66 | 6.02 | 1080x1920 |

Other numbers:

- **Overhead.** From document creation to the result being visible to the driver, the time was 1
  to 5 s longer than the handler time. That covers event delivery, two patches and 3 s polling.
- **Cold starts.** The two cold invocations (the URL-mode rows) prepared the binary in 494 and
  605 ms, almost all of it the sha256. The observed overhead was the same as on warm containers.
  Lambda reused warm containers for up to 9 invocations in a row.
- **Memory.** ffmpeg peaked at 1.2 GiB and Node at 184 MiB (`process.resourceUsage().maxRSS`).
  The system as a whole used at most 1.6 GiB. Memory size only buys CPU here.
- **Network.** Downloading the 211 MB input from `cdn.sanity.io` took 0.6 to 4.3 s at either
  memory size. Uploading a 23 MB MP4 to the assets API took 0.8 s.
- **Local reference.** On an M3 Pro with 11 cores, using ffmpeg-static's macOS 6.0 build, the
  synthetic file took 23.4 s (medium), 38.9 s (fast) and 26.5 s (veryfast) wall time, with 194,
  206 and 122 CPU-seconds.

### Output checks

Every output was downloaded from the CDN and checked locally with ffprobe 9.0.1 and an MP4 box
parser. **All 16 runs pass all checks.**

| Check | Result |
| --- | --- |
| sha1 of the file matches the asset id | pass |
| `h264`, profile `High` | pass |
| `yuv420p` | pass |
| Longest side ≤ 1920, both sides even | pass |
| Exact dimensions as ffmpeg's scale computes them | pass |
| No display matrix left, picture upright | pass (c and d came out 1080x1920 from −90 sources) |
| Faststart: top-level boxes `ftyp, moov, free, mdat` | pass |
| Audio: one AAC stereo track if the input has audio, none otherwise | pass (a has none; b, c and d have AAC LC, 2 channels) |
| Duration within 0.2 s of the input | pass |

The check "exact dimensions" first failed for input a because the check was wrong, not ffmpeg.
For 3420x2080, ffmpeg's `force_original_aspect_ratio=decrease` computes `av_rescale(1920, 2080,
3420)`. That is 1167.7 rounded to the nearest whole number, **1168**, then floored to even, so
**1920x1168**. The check had floored to 1166. It now mirrors ffmpeg, and all 16 runs were
re-checked. Tests for the production Function should use the same arithmetic.

## Limits and sizing

- **Time.** At 10 GB/medium, the worst case needs about 0.86 s of encode per second of 4K 10-bit
  HEVC footage. At 4 GB it needs about 2.2 s (download mode) or 3.0 s (URL mode).
  - A 600 s handler budget therefore covers about 11 minutes of such footage at 10 GB, and 3 to
    4.5 minutes at 4 GB.
  - The site's 29 videos are 2.9 to 164 s long, mostly screen recordings at or below 3420 px
    (see "Real inputs" below). Each will take seconds to tens of seconds.
- **Disk.** `/tmp` is 512 MB, so in download mode input plus output must fit in about 500 MB.
  - For an iPhone 4K30 clip at about 28 Mbps, that is about 2 minutes.
  - In URL mode only the output lives in `/tmp`. The spike used 10 MB there for the synthetic
    file, against 211 MB in download mode. At this output rate (about 3 Mbps), the output limit
    is about 20 minutes.
- **DNS.** The static ffmpeg cannot resolve host names in Lambda: `Failed to resolve hostname
  cdn.sanity.io: System error`. This is the known limit of a fully static glibc, which cannot load
  the NSS modules. Node resolves names normally. URL mode therefore runs a tiny HTTP server on
  `127.0.0.1` in the handler, and ffmpeg reads `http://127.0.0.1:<port>/input` from it.
  - The server forwards each request, including its `Range` header, to the CDN with `fetch` and
    `accept-encoding: identity`.
  - On the moov-at-end synthetic file, ffmpeg made 6 range requests and read 217.4 MB for a
    211.5 MB file, with 0 proxy errors.
  - At 4 GB this mode was about 39% slower (181.6 s against 130.8 s), and ffmpeg itself used more
    CPU time (412 against 256 s). The cause was not investigated. At 10 GB it made no
    difference (51.9 against 51.6 s).
- **Determinism.** With the same input, settings and CPU count, the output was byte-identical:
  URL mode and download mode produced the same asset id at both 4 GB and 10 GB. The 4 GB and
  10 GB outputs differ from each other (x264 threads), with the same size and the same checks.
  - The content-addressed asset therefore dedupes a repeated conversion in the same
    configuration.
  - Changing `memory` changes the output bytes.
- **Cost.** Billing is memory × duration. Because the encode is CPU-bound and Lambda CPU grows
  with memory, a conversion costs about the same at 4 and 10 GB:
  - worst case: about 540 GB-s;
  - screen recording a: 150 to 160 GB-s;
  - iPhone clip d: 170 to 185 GB-s;
  - deep_linking: 24 to 32 GB-s.

  Check the organization's Functions quota (Usage > Compute in sanity.io/manage) before
  converting large batches through the Function.

## Findings for other packages

1. **HDR iPhone sources.** IMG_3151.MOV (one of the 29) and the synthetic HLG file both came out
   as 8-bit H.264 still tagged HLG (`arib-std-b67`) with BT.2020 primaries. The contract settings
   do no tone mapping.
   - The IMG_3151 output also keeps an "Ambient viewing environment" side-data entry and a `dby1`
     (Dolby Vision) compatible brand in `ftyp`. Its sample entry is plain `avc1`.
   - Browsers interpret the HLG tag, but 8-bit HLG can band, and SDR screens depend on the
     browser's tone mapping.
   - The settings owner should decide whether `settings.ts` tone-maps HDR to BT.709. The build has
     libzimg, so `zscale` and `tonemap` are available; their CPU cost was not measured.
   - New iPhone recordings are HDR by default.
2. **Real inputs.** The 29 originals include VP9 in `.mov` (5 files), rotated 10-bit HEVC, mono
   PCM audio (`IMG_0169.MOV`, converted to stereo AAC locally), mono AAC, a file with a 90000/1
   timebase (`step_count.mp4`), and a 164 s H.264 file named `.webm`.
   - Locally, with the same arguments and ffmpeg-static's macOS build (ffmpeg 6.0),
     `step_count.mp4` kept its variable frame rate (34 frames; no duplicated frames), and the
     rotated clips came out upright.
   - Only a, b and d were run in the Function.
3. **Audio detection.** `ffmpeg -i <file>` without an output always exits 1. In a shell with
   `set -o pipefail`, `ffmpeg -i … | grep Audio` therefore always fails. Capture the output first,
   or map audio as `-map 0:a:0?`.
4. **Retries and the recursion guard.** The scratch handler first patched `run.requestId` (which
   stops the filter matching) and skipped duplicate deliveries of a request it had already seen.
   The logs show 22 invocations (12 at 4 GB, 10 at 10 GB) and no duplicate delivery. The production function needs the same kind
   of guard; the contract's `conversion.status` and `outputAssetId` provide it.
5. **The migration's videos.** Nothing in this spike changes how the 29 videos are migrated.
   Converting them in the Function would take seconds to tens of seconds each at 10 GB. Converting
   them locally with the same arguments also works for the files tried: ffmpeg 6.0 on macOS
   produced correctly sized, upright H.264 High outputs with stereo AAC for `IMG_3151.MOV`,
   `IMG_0169.MOV`, `step_count.mp4` and the screen recording. The full check suite was run only on
   the Function outputs. Local bytes differ from Function output, because of the ffmpeg version
   and the thread count.

## Method

- **Scratch Blueprint.** It lived at `~/cjoshmartin-migration/tmp/video-spike/stack/`, outside
  git, as Stack `video-spike-scratch` (`ST-tabgr9haiw`), created with `blueprints init . --project-id
  j3vdh6ti --stack-name video-spike-scratch`.
  - It held two document functions, `video-spike-4gb` and `video-spike-10gb`, both built from the
    same source with `timeout: 900`.
  - Event: `create` and `update`, `resource: {type: 'dataset', id: 'j3vdh6ti.staging'}`, filter
    `_type == "videoSpike" && memoryGb == <n> && defined(requestId) && requestId != run.requestId`.
  - The projection followed `input.asset->` to get the URL, file name and size.
- **Deploys.** Four deploys, all to the scratch stack: `OP-c4ieticqx3` (probe plus an x64 binary,
  a wrong guess), `OP-ggec2cqif8` (arm64), `OP-cfbq24suq7` (URL mode) and `OP-5ea4252me7` (URL
  mode through the proxy).
  - The first URL-mode attempt failed on DNS as described; its result is not in the table.
- **Handler modes.** `probe` reported the runtime. `version` ran ffmpeg. `convert` downloaded the
  input or started the proxy, described the input with `ffmpeg -i`, ran the conversion with an
  internal deadline 30 s before the timeout, and checked the box order and sha1. It then uploaded
  the MP4 with `source: {name: 'video-spike', id: <input asset id>}` and patched the timings and
  results into the document as one JSON string.
- **Driver.** `~/cjoshmartin-migration/tmp/video-spike/scripts/spike.mjs` uploaded the inputs,
  created the documents, waited for results, downloaded the outputs and ran the checks. It
  recorded every document and asset it created; cleanup deleted only recorded items that still
  carried the spike markers.
- **Raw results.** One JSON file per run is in `~/cjoshmartin-migration/tmp/video-spike/results/`,
  outside git.

## Cleanup

All of this was verified after cleanup, at 05:18 UTC:

- **Scratch stack destroyed.** `blueprints destroy --stack ST-tabgr9haiw --force` destroyed the 2
  functions (`OP-ikzimfg27i`) and exited 0. `blueprints stacks --project-id j3vdh6ti` now lists
  only `cjoshmartin-functions` (`ST-jc4gwa3c4t`).
- **Staging data deleted.** The 20 `videoSpike` documents (2 probe, 2 version and 16 convert) and
  the 18 spike assets (4 inputs and 14 distinct outputs) were deleted. Each asset was deleted only
  after a check that nothing referenced it.
- **Staging back to baseline.** `count(*[_type == "videoSpike"])` is 0. No file asset has a
  `video-spike*` source or title. Staging again holds 5 file assets and 110 image assets, the
  numbers in the morning report.
- **Existing stack untouched.** `blueprints info --stack ST-jc4gwa3c4t --json` is identical before
  and after the spike. `testimonial-ascii-art` still has source asset `AS-dac26sc8in`, resource
  `updatedAt` 2026-11-25T19:29:20.813Z, and last operation `OP-74uqdsja4u`. Its logs show no
  invocation since 2026-11-25 22:47 UTC and no errors.
- **Nothing in production.** Nothing was written to `production`. No tracked file in the
  repository changed; this report is the only file committed.

During the window 04:43 to 05:17 UTC, `staging` temporarily held these `videoSpike` documents and
the spike's file assets. Any staging count or validation run in that window should be rerun.
