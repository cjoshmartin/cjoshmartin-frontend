/**
 * Reads the stream list that `ffmpeg -hide_banner -i <input>` prints (to stderr, exiting with
 * code 1 because no output is given). The Function bundles only ffmpeg (ffmpeg-static has no
 * ffprobe), so this replaces ffprobe for the three facts the conversion needs: whether the input
 * has an audio stream (buildFfmpegArgs' `hasAudio`), the displayed size of the video stream that
 * `-map 0:V:0` picks, and the duration. Pure; test/media-info.test.ts covers ffmpeg 6, 7 and 9
 * output.
 */

export interface InputVideoStream {
  /** `0:1` style index as printed by ffmpeg. */
  index: string
  codec: string
  /** Coded size as printed (before rotation). */
  width: number
  height: number
  /** Rotation from the display matrix side data, in degrees (0 when there is none). */
  rotation: number
  /** Size as displayed, after rotation: what `-autorotate` hands to the scale filter. */
  displayWidth: number
  displayHeight: number
}

export interface InputDescription {
  /** The ffmpeg demuxer name list, e.g. `mov,mp4,m4a,3gp,3g2,mj2`. */
  format: string
  /** Container duration in seconds, or null when ffmpeg prints `N/A`. */
  durationSeconds: number | null
  /** The first video stream that is not attached cover art (what `-map 0:V:0` selects). */
  video: InputVideoStream | null
  /** Number of video streams that are attached pictures (cover art), which are skipped. */
  attachedPictures: number
  audioStreams: number
  /** Codec of the first audio stream (what `-map 0:a:0` selects). */
  firstAudioCodec: string | null
  hasAudio: boolean
}

/** Thrown when the text has no `Input #0` section: ffmpeg could not open or recognise the file. */
export class UnreadableInputError extends Error {
  override name = 'UnreadableInputError'
}

const STREAM_LINE =
  /^\s*Stream #(\d+:\d+)(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio|Data|Subtitle|Attachment): (.*)$/
const ROTATION_LINE = /(?:displaymatrix|display matrix):\s*rotation of (-?\d+(?:\.\d+)?) degrees/i
const DURATION_LINE = /^\s*Duration: (?:(\d+):(\d{2}):(\d{2}(?:\.\d+)?)|N\/A)/
const INPUT_LINE = /^Input #0, ([^ ]+), from /

/**
 * ffmpeg's own error lines, for a failure message: without the `[in#0 @ 0x...]` prefixes, without
 * "Error opening input file <path>" (it only names the temporary file) and without repeats.
 */
export function ffmpegErrorLines(text: string, max = 4): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:\[[^\]]+ @ 0x[0-9a-f]+\]\s*)+/i, '').trim()
    if (
      line === '' ||
      line === 'At least one output file must be specified' ||
      /^Error opening (?:input|output) file /.test(line) ||
      !/error|invalid|not found|unsupported|failed|could not|no such|denied|refused|unknown/i.test(
        line,
      )
    ) {
      continue
    }
    if (!lines.includes(line)) lines.push(line)
  }
  return lines.slice(-max)
}

/** Whether a rotation (degrees) turns the picture sideways, so width and height swap. */
export function rotationSwapsSides(rotation: number): boolean {
  const quarterTurns = Math.round(rotation / 90)
  return Math.abs(rotation - quarterTurns * 90) < 1 && Math.abs(quarterTurns) % 2 === 1
}

export function parseFfmpegInputDescription(text: string): InputDescription {
  const lines = text.split(/\r?\n/)
  const inputIndex = lines.findIndex((line) => INPUT_LINE.test(line))
  if (inputIndex === -1) {
    const reasons = ffmpegErrorLines(text)
    throw new UnreadableInputError(
      reasons.length > 0 ? reasons.join(' / ') : 'ffmpeg did not recognise the file as media',
    )
  }
  const format = INPUT_LINE.exec(lines[inputIndex])![1]

  let durationSeconds: number | null = null
  let video: InputVideoStream | null = null
  let attachedPictures = 0
  let audioStreams = 0
  let firstAudioCodec: string | null = null
  /** The video stream whose side data is being read (only the selected one matters). */
  let current: InputVideoStream | null = null

  for (const line of lines.slice(inputIndex + 1)) {
    // Another input or the output section ends the description of input #0.
    if (/^(Input|Output) #\d+/.test(line)) break

    const duration = DURATION_LINE.exec(line)
    if (duration) {
      durationSeconds =
        duration[1] === undefined
          ? null
          : Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
      continue
    }

    const stream = STREAM_LINE.exec(line)
    if (stream) {
      current = null
      const [, index, kind, rest] = stream
      if (kind === 'Audio') {
        audioStreams += 1
        if (firstAudioCodec === null) firstAudioCodec = rest.split(/[ ,(]/)[0]
      } else if (kind === 'Video') {
        if (/\(attached pic\)/.test(rest)) {
          attachedPictures += 1
        } else if (video === null) {
          // `, 1920x1440` (the codec tag `0x31637668` never follows a comma).
          const size = /, (\d{1,5})x(\d{1,5})(?=[\s,[]|$)/.exec(rest)
          if (!size)
            throw new UnreadableInputError(
              `ffmpeg printed no frame size for stream ${index}: ${rest}`,
            )
          video = {
            index,
            codec: rest.split(/[ ,(]/)[0],
            width: Number(size[1]),
            height: Number(size[2]),
            rotation: 0,
            displayWidth: Number(size[1]),
            displayHeight: Number(size[2]),
          }
          current = video
        }
      }
      continue
    }

    const rotation = ROTATION_LINE.exec(line)
    if (rotation && current) {
      current.rotation = Number(rotation[1])
      const swap = rotationSwapsSides(current.rotation)
      current.displayWidth = swap ? current.height : current.width
      current.displayHeight = swap ? current.width : current.height
    }
  }

  return {
    format,
    durationSeconds,
    video,
    attachedPictures,
    audioStreams,
    firstAudioCodec,
    hasAudio: audioStreams > 0,
  }
}
