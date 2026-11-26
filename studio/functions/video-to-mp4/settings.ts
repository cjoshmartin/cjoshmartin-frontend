/**
 * MP4 conversion settings: the single source of truth for every video conversion on
 * cjoshmartin.com, both the migration of the Wagtail videos and the video-to-mp4 Sanity Function
 * that converts videos uploaded in the Studio (see docs/sanity-migration/schema-contract.md,
 * "Video contract v2").
 *
 * Plain TypeScript with no imports and only erasable syntax, so it runs unchanged under the
 * Functions bundler, tsx and Node's own type stripping.
 *
 * The arguments need ffmpeg 7.0 or newer (MIN_FFMPEG_VERSION, checkFfmpegVersion).
 *
 * Any change to the arguments below changes the output files, so it must also change
 * SETTINGS_VERSION.
 */

/**
 * Stored in `video.conversion.settingsVersion` of every converted video, and on the converted MP4
 * asset itself (CONVERTED_ASSET_SETTINGS_FIELD), so a converter only reuses an MP4 made with the
 * current settings.
 *
 * - `h264-crf23-max1920-v1`: the first settings. ffmpeg chose a constant frame rate for the
 *   encoder, so variable-frame-rate input (screen recordings) lost frames (ffmpeg 9.0.1) or was
 *   resampled to evenly spaced frames (ffmpeg 7.0.2).
 * - `h264-crf23-max1920-v2`: as v1, plus `-fps_mode:v passthrough -enc_time_base:v demux`, so every
 *   decoded input frame is encoded once, at its own time.
 */
export const SETTINGS_VERSION = 'h264-crf23-max1920-v2'

/**
 * Field on a converted MP4's asset document (`sanity.fileAsset`) that records the SETTINGS_VERSION
 * it was made with. Converters write it right after uploading the MP4 and only reuse an MP4 whose
 * field equals the current SETTINGS_VERSION (MP4s made before the field existed have none and are
 * never reused). See docs/sanity-migration/schema-contract.md, "Videos".
 */
export const CONVERTED_ASSET_SETTINGS_FIELD = 'videoToMp4SettingsVersion'

/**
 * Oldest ffmpeg release the arguments of buildFfmpegArgs work with:
 * - `-autorotate` before `-i` is a value-less flag only since 7.0; in 6.x it takes a value, swallows
 *   the `-i` and ffmpeg fails with "Error parsing options for output file <input>";
 * - `-fps_mode:v passthrough -enc_time_base:v demux` keeps every frame at its own time with 7.0.2
 *   (the Function's binary) and 9.0.1 (Homebrew), checked frame by frame on the 29 Wagtail videos.
 * Every converter must check the version with checkFfmpegVersion before converting.
 */
export const MIN_FFMPEG_VERSION = {major: 7, minor: 0} as const

export interface FfmpegVersion {
  major: number
  minor: number
  patch: number
  /** The version as printed, e.g. `7.0.2-static` or `9.0.1`. */
  text: string
}

/**
 * The release version from the first line of `ffmpeg -version` ("ffmpeg version 9.0.1 Copyright
 * ..." or "ffmpeg version 7.0.2-static https://..."), or null for a build without a release number
 * (a git snapshot such as `N-112233-gabcdef`).
 */
export function parseFfmpegVersion(versionOutput: string): FfmpegVersion | null {
  const match = /^ffmpeg version n?(\d+)\.(\d+)(?:\.(\d+))?(\S*)/m.exec(versionOutput)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3]),
    text: `${match[1]}.${match[2]}${match[3] === undefined ? '' : `.${match[3]}`}${match[4]}`,
  }
}

/**
 * The parsed version when `ffmpeg -version` reports MIN_FFMPEG_VERSION or newer. Throws a
 * RangeError naming the problem otherwise, so no converter runs these arguments on an ffmpeg
 * that reads them differently.
 */
export function checkFfmpegVersion(versionOutput: string): FfmpegVersion {
  const firstLine = versionOutput.split('\n')[0]?.trim() ?? ''
  const version = parseFfmpegVersion(versionOutput)
  if (!version) {
    throw new RangeError(
      `cannot read a release version from "${firstLine}"; the MP4 settings need ffmpeg ` +
        `${MIN_FFMPEG_VERSION.major}.${MIN_FFMPEG_VERSION.minor} or newer (a release build)`,
    )
  }
  const tooOld =
    version.major < MIN_FFMPEG_VERSION.major ||
    (version.major === MIN_FFMPEG_VERSION.major && version.minor < MIN_FFMPEG_VERSION.minor)
  if (tooOld) {
    throw new RangeError(
      `ffmpeg ${version.text} is too old: the MP4 settings need ffmpeg ` +
        `${MIN_FFMPEG_VERSION.major}.${MIN_FFMPEG_VERSION.minor} or newer (older versions read ` +
        '-autorotate as taking a value and handle variable frame rates differently)',
    )
  }
  return version
}

/** Longest side of the output in pixels. Smaller videos are never scaled up. */
export const MAX_DIMENSION = 1920

/** libx264 constant rate factor (lower is better quality and larger files). */
export const CRF = 23

/** AAC bitrate used when the input has audio. */
export const AUDIO_BITRATE = '128k'

/** Audio is always encoded as stereo (mono is upmixed, surround is downmixed). */
export const AUDIO_CHANNELS = 2

/** MIME type and file extension of every converted file. */
export const OUTPUT_MIME_TYPE = 'video/mp4'
export const OUTPUT_EXTENSION = 'mp4'

/**
 * `source.name` of every converted MP4 asset. `source.id` is the `_id` of the original asset, so a
 * converter can find an earlier conversion of the same original and reuse it.
 */
export const CONVERTED_ASSET_SOURCE_NAME = 'video-to-mp4'

/**
 * libx264 presets allowed by these settings, fastest first. Presets trade encoding time for file
 * size, not quality. `ultrafast` is left out on purpose: it turns off CABAC and 8x8 transforms, so
 * its output is Constrained Baseline instead of High profile (checked with libx264 in ffmpeg 9.0.1).
 */
export const X264_PRESETS = [
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
  'slower',
  'veryslow',
  'placebo',
] as const

export type X264Preset = (typeof X264_PRESETS)[number]

export const DEFAULT_PRESET: X264Preset = 'medium'

export function isX264Preset(value: unknown): value is X264Preset {
  return typeof value === 'string' && (X264_PRESETS as readonly string[]).includes(value)
}

/**
 * Scale filter, evaluated by ffmpeg after autorotation (so `iw` and `ih` are the dimensions as
 * displayed). The longer side becomes at most MAX_DIMENSION, the shorter side keeps the aspect
 * ratio, and both are rounded down to an even number (H.264 with 4:2:0 chroma needs even
 * dimensions). Rounding down means no side ever grows, so small videos are never upscaled. The one
 * exception is a side that would end up below 2 px (a 1 px tall video, or an aspect ratio beyond
 * 960:1): it becomes 2 px, the smallest size libx264 can encode, instead of an invalid 0.
 *
 * Both sides are computed explicitly instead of with `-2` or `force_original_aspect_ratio`, whose
 * rounding differs between ffmpeg versions; expectedOutputSize mirrors this arithmetic exactly.
 *
 * `out_range=tv` and `format=yuv420p` convert full-range input (iPhone `yuvj420p`) to the
 * limited-range yuv420p every browser decodes; `-pix_fmt yuv420p` alone keeps full range.
 */
export const VIDEO_FILTER =
  `scale=` +
  `w='if(gte(iw,ih),max(2,2*trunc(min(iw,${MAX_DIMENSION})/2)),max(2,2*trunc(min(ih,${MAX_DIMENSION})*iw/ih/2)))':` +
  `h='if(gte(iw,ih),max(2,2*trunc(min(iw,${MAX_DIMENSION})*ih/iw/2)),max(2,2*trunc(min(ih,${MAX_DIMENSION})/2)))':` +
  `out_range=tv,format=yuv420p`

export interface VideoSize {
  width: number
  height: number
}

/**
 * Output size for an input of the given displayed size (after rotation), computed exactly like
 * VIDEO_FILTER. Useful for checking a converted file against its source.
 */
export function expectedOutputSize({width, height}: VideoSize): VideoSize {
  for (const [name, value] of Object.entries({width, height})) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer, got ${String(value)}`)
    }
  }
  const even = (value: number) => Math.max(2, 2 * Math.trunc(value / 2))
  if (width >= height) {
    const scaledWidth = Math.min(width, MAX_DIMENSION)
    return {width: even(scaledWidth), height: even((scaledWidth * height) / width)}
  }
  const scaledHeight = Math.min(height, MAX_DIMENSION)
  return {width: even((scaledHeight * width) / height), height: even(scaledHeight)}
}

export interface FfmpegArgsOptions {
  /** Path or URL ffmpeg reads the original video from. */
  input: string
  /** Local path the MP4 is written to. It is overwritten if it exists. */
  output: string
  /** libx264 preset. Defaults to DEFAULT_PRESET. */
  preset?: X264Preset
  /** Whether the input has an audio stream (from ffprobe). Without one the MP4 has no audio track. */
  hasAudio: boolean
}

/**
 * ffmpeg arguments (without the `ffmpeg` executable itself) that convert `input` to an MP4 with
 * the fixed settings of SETTINGS_VERSION:
 *
 * - the first real video stream (`0:V:0` skips cover art and thumbnails), autorotated so rotation
 *   metadata is applied to the pixels and the output needs none;
 * - H.264 (libx264) High profile, yuv420p, CRF 23, scaled by VIDEO_FILTER;
 * - every decoded frame is encoded once at its own time (`-fps_mode:v passthrough`), in the input
 *   stream's time base (`-enc_time_base:v demux`), so variable-frame-rate input such as a screen
 *   recording keeps its timing: no frame is dropped, duplicated or moved. Without both options
 *   ffmpeg picks a constant frame rate from the average (v1); `-enc_time_base:v demux` alone makes
 *   ffmpeg 7.0.2 encode a 90 kHz time base input at 90,000 frames per second;
 * - the first audio stream as AAC 128 kb/s stereo when `hasAudio`, otherwise no audio track;
 * - no data, subtitle or chapter streams, and no metadata copied from the input (iPhone videos
 *   carry GPS location, device and creation date);
 * - `+faststart`, so playback can start before the whole file has downloaded.
 */
export function buildFfmpegArgs({
  input,
  output,
  preset = DEFAULT_PRESET,
  hasAudio,
}: FfmpegArgsOptions): string[] {
  if (typeof input !== 'string' || input.length === 0) {
    throw new TypeError('input must be a non-empty path or URL')
  }
  if (typeof output !== 'string' || output.length === 0) {
    throw new TypeError('output must be a non-empty path')
  }
  if (output.startsWith('-')) {
    // ffmpeg would read it as an option instead of the output file.
    throw new TypeError(`output must not start with "-": ${output}`)
  }
  if (!isX264Preset(preset)) {
    throw new TypeError(`preset must be one of ${X264_PRESETS.join(', ')}, got ${String(preset)}`)
  }
  if (typeof hasAudio !== 'boolean') {
    throw new TypeError('hasAudio must be a boolean')
  }

  const audioArgs = hasAudio
    ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', String(AUDIO_CHANNELS)]
    : ['-an']

  return [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-autorotate',
    '-i',
    input,
    '-map',
    '0:V:0',
    ...audioArgs,
    '-vf',
    VIDEO_FILTER,
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    String(CRF),
    '-preset',
    preset,
    '-fps_mode:v',
    'passthrough',
    '-enc_time_base:v',
    'demux',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ]
}

/**
 * `originalFilename` of a converted asset: the original's base name with the extension replaced
 * by `.mp4` ("IMG_0169.MOV" becomes "IMG_0169.mp4"). `fallbackBaseName` (for example the original
 * asset `_id`) is used when the original has no usable file name.
 */
export function convertedFilename(
  originalFilename: string | null | undefined,
  fallbackBaseName: string,
): string {
  const name = (originalFilename ?? '').split(/[\\/]/).pop()?.trim() ?? ''
  const dot = name.lastIndexOf('.')
  // A leading dot (".mov") is a hidden file name, not an extension.
  const baseName = dot > 0 ? name.slice(0, dot) : name
  const chosen = baseName.trim() || fallbackBaseName.trim()
  if (!chosen) {
    throw new TypeError('fallbackBaseName must not be empty')
  }
  return `${chosen}.${OUTPUT_EXTENSION}`
}
