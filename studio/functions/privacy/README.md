# privacy

Lossless removal of location and personal metadata, shared by the `image-privacy` and
`video-to-mp4` Sanity Functions (owner decision 2026-11-26). Not a Function itself: the Functions
import these modules and the Blueprint bundler includes them. No runtime dependencies and no
network.

| File | What it is |
| --- | --- |
| `constants.ts` | Versions (`IMAGE_STRIP_VERSION`, `VIDEO_STRIP_VERSION`), the asset `privacy` field and its statuses, source names, accepted image MIME types, image metadata options. No imports; the Studio and the migration import it too. |
| `image-strip.ts` | `stripImage(bytes)`: detects the format from the bytes, lists what it would remove, and when something personal is found builds and verifies the stripped file. |
| `exif.ts` | TIFF/EXIF reader, the technical-versus-personal EXIF rule, the minimal orientation-only EXIF block. |
| `jpeg.ts`, `png.ts`, `webp.ts`, `gif.ts`, `isobmff-image.ts` (AVIF/HEIF), `tiff.ts` | One module per format. |
| `video-strip.ts` | `stripVideo(...)`: ffmpeg stream copy without metadata, data tracks, subtitles, chapters and creation times; checks the result (stream list, metadata left, MP4/QuickTime boxes, every packet). Also `checkIsobmffBoxes`, used on the converted MP4s. |
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

A stream copy with the Function's ffmpeg 7.0.2 (`-map` of every video and audio stream, `-c copy
-map_metadata -1 -map_chapters -1 -fflags +bitexact -strict unofficial`). The container stays
QuickTime or MP4 (by the file's major brand) and becomes MP4 when the video has a Dolby Vision
configuration, because ffmpeg 7.0's QuickTime muxer cannot write `dvvC` (with PCM audio, which MP4
cannot hold for QuickTime players, the Dolby Vision configuration is dropped and the result says
so). Matroska stays Matroska (WebM when every codec allows it); other containers become Matroska.

ffmpeg's muxer needs increasing decode time stamps, so packets whose source time stamps are equal
or decreasing (macOS screen recordings have runs of them) move by a few ticks, at most
`MAX_TIMESTAMP_ADJUSTMENT_SECONDS` (50 ms; at most 9.8 ms in the 29 Wagtail videos). A stream's last
packet may get another duration within the same limit. Both are reported.

## Commands

```sh
npm ci
npm test               # unit tests, no tools needed
npm run test:media     # needs exiftool, ImageMagick 7, ffmpeg/ffprobe on PATH
npm run typecheck

# The media tests with the Function's own ffmpeg (ffmpeg-static 5.3.0 linux-arm64) in Docker, and
# every real original:
FFMPEG_LINUX_ARM64=<path to that binary> \
PRIVACY_VIDEOS_DIR=~/cjoshmartin-migration/gcs/media \
PRIVACY_ORIGINALS_DIR=~/cjoshmartin-migration/gcs/original_images npm run test:media
```

The linux-arm64 binary can be fetched with `npm_config_platform=linux npm_config_arch=arm64 npm i
ffmpeg-static@5.3.0` in an empty directory (sha256 `6bb182d0...fb8ce`).
