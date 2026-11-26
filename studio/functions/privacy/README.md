# privacy

Lossless removal of location and personal metadata, shared by the `image-privacy`,
`video-to-mp4` and `upload-privacy` Sanity Functions and the Wagtail migration's privacy step
(owner decision 2026-11-26). Not a Function itself: the Functions
import these modules and the Blueprint bundler includes them. No runtime dependencies and no
network.

| File | What it is |
| --- | --- |
| `constants.ts` | Versions (`IMAGE_STRIP_VERSION`, `VIDEO_STRIP_VERSION`), the asset `privacy` field and its statuses, source names, accepted image MIME types, image metadata options. No imports; the Studio and the migration import it too. |
| `image-strip.ts` | `stripImage(bytes)`: detects the format from the bytes, lists what it would remove, and when something personal is found builds and verifies the stripped file. |
| `exif.ts` | TIFF/EXIF reader, the technical-versus-personal EXIF rule, the minimal orientation-only EXIF block. |
| `jpeg.ts`, `png.ts`, `webp.ts`, `gif.ts`, `isobmff-image.ts` (AVIF/HEIF), `tiff.ts` | One module per format. |
| `isobmff-video.ts` | `planIsobmffStrip(reader)`: the in-place strip of a QuickTime/MP4 video (metadata boxes, data tracks and their samples, creation times, handler names, every unused `mdat` byte); `applyIsobmffPlan`/`applyIsobmffPlanToFile`; `checkStrippedIsobmff` (nothing personal left, no location or device signature outside the samples). Also used by the Wagtail migration's privacy step. |
| `video-strip.ts` | `stripIsobmffInPlace(...)`: the in-place strip of a file on disk, checked with ffmpeg (same streams and side data, every packet with its time stamps) and byte by byte. `stripVideo(...)`: the fallback ffmpeg stream copy without metadata, data tracks, subtitles, chapters and creation times, with its checks. Also `checkIsobmffBoxes`, used on the converted MP4s. |
| `releases.ts` | Release versions: which release a `versions.*` id belongs to, and when a Function may write to it (the release is `active`). |
| `test/` | Unit tests (`npm test`) and media tests (`npm run test:media`). |

## Images

What is removed and kept is in each format module's header. In short: everything except the
coded image, the orientation (EXIF Orientation 2-8, rewritten as a minimal EXIF block; AVIF/HEIF
keep `irot`/`imir`), the ICC profile, and the chunks and segments a decoder needs (JFIF without
thumbnail, Adobe APP14, PNG colour/transparency/animation/physical-size chunks, WebP VP8X/ANIM/ANMF,
GIF looping, TIFF image tags). The coded image is copied byte for byte, so it decodes to the same
pixels.

An image counts as having personal metadata when stripping would remove anything other than
technical items: an EXIF block with only orientation, size, resolution and colour-space tags, or
Apple's PNG `iDOT` hint. Such images are left alone.

Every result is verified before it is returned: same format, nothing personal left, the same
coded-image sha256, the same orientation and ICC profile, and stripping it again changes nothing.
A file that fails any check throws `ImageStripError`.

Not supported (the Studio does not accept them): SVG, HEIC (Sanity cannot process HEVC images),
BMP (rejected by Sanity), BigTIFF and old-style JPEG-in-TIFF (compression 6).

## Videos

QuickTime/MP4 (ISO BMFF) videos are stripped in place (`isobmff-video.ts`, `stripIsobmffInPlace`):
`moov/udta`, `moov/meta`, track and media `udta`/`meta`, XMP and top-level `meta` boxes and every
track that is not video or audio become `free` boxes of the same size with zero content; the
removed tracks' samples, every other `mdat` byte no kept sample uses (iOS leaves a draft movie
header with the location there, which exiftool and ffprobe do not read) and padding are set to
zero; the creation and modification times and the handler names are cleared. Nothing moves, so the
container, edit lists, time stamps, display matrix, colour, HDR and Dolby Vision boxes and every
sample stay byte for byte. Anything unknown (another top-level box, a fragmented file, an unknown
box in a track, samples in another file) is refused. The result is checked: every byte outside the
changed ranges unchanged (sha256), nothing personal left and no location or device signature
outside the samples, the same audio and video streams with the same description and side data, and
every packet identical with its time stamps (framemd5 and streamhash).

Other containers, and ISO BMFF files the in-place stripper refuses, fall back to a stream copy with
the Function's ffmpeg 7.0.2 (`stripVideo`: `-map` of every video and audio stream, `-c copy
-map_metadata -1 -map_chapters -1 -fflags +bitexact -strict unofficial`). That rewrites the
container: measured with 7.0.2 on the Wagtail videos, it changes edit lists (an iPhone screen
recording lost its audio's initial empty edit and the discard flag of an AAC priming packet), track
time scales and durations, and moves repeated time stamps; and ffmpeg 7.0's QuickTime muxer cannot
write Dolby Vision `dvvC`, so a Dolby Vision video becomes MP4 (with PCM audio, which MP4 cannot
hold for QuickTime players, the configuration is dropped and the result says so). Matroska stays
Matroska (WebM when every codec allows it); other containers become Matroska. Packets whose source
time stamps are equal or decreasing move by at most `MAX_TIMESTAMP_ADJUSTMENT_SECONDS` (50 ms). The
Function's copy says in `privacy.message` that the container was rewritten.

## Commands

```sh
npm ci
npm test               # unit tests, no tools needed
npm run test:media     # needs exiftool, ImageMagick 7, ffmpeg/ffprobe on PATH
npm run typecheck

# The media tests with the Function's own ffmpeg (ffmpeg-static 5.3.0 linux-arm64) in Docker, and
# every real original (the in-place strip of all 29 Wagtail videos takes about half an hour):
FFMPEG_LINUX_ARM64=<path to that binary> \
PRIVACY_VIDEOS_DIR=~/cjoshmartin-migration/gcs/media \
PRIVACY_ORIGINALS_DIR=~/cjoshmartin-migration/gcs/original_images npm run test:media
```

The linux-arm64 binary can be fetched with `npm_config_platform=linux npm_config_arch=arm64 npm i
ffmpeg-static@5.3.0` in an empty directory (sha256 `6bb182d0...fb8ce`).
