/**
 * Frame timestamps, to check that a conversion kept every decoded input frame at its own time
 * (settings v2: `-fps_mode:v passthrough -enc_time_base:v demux`). The Function has no ffprobe, so
 * both lists come from ffmpeg's `showinfo` filter: the input's from a second output of the
 * conversion itself (no second decode or download), the MP4's from the full decode check.
 *
 * ffmpeg runs with `-loglevel level+info`, so every line carries its level tag and the showinfo
 * lines can be told apart from warnings and errors. Pure, no I/O; test/frames.test.ts covers the
 * output of ffmpeg 7.0.2 (the Function's binary) and 9.0.1.
 */

/** Filter that logs every frame's timestamp; the checksums are skipped because nothing uses them. */
export const SHOWINFO_FILTER = 'showinfo=checksum=0'

/**
 * Largest difference allowed between an input frame's time and its MP4 frame's time, both
 * measured from the first frame. With the input's own time base the times are exact; 1 ms leaves
 * room for a time base the MP4 muxer has to scale.
 */
export const FRAME_TIME_TOLERANCE_SECONDS = 0.001

export interface FrameTimes {
  /** Presentation time of every frame in seconds, in the order showinfo logged them. */
  seconds: number[]
  /** Frames logged without a timestamp (`pts:NOPTS`). */
  withoutTimestamp: number
}

const SHOWINFO_PREFIX = /^\[Parsed_showinfo_\d+ @ [^\]]+\]\s*(?:\[[a-z]+\]\s*)?(.*)$/
const TIME_BASE = /^config in time_base: (\d+)\/(\d+)/
const FRAME = /^n:\s*\d+\s+pts:\s*(NOPTS|-?\d+)\s/

/**
 * Collects the frame times from showinfo log lines. `push` returns true for every showinfo line
 * (so the caller can leave them out of the log it keeps) and false for any other line.
 */
export class FrameTimesCollector {
  private timeBase: {num: number; den: number} | null = null
  private readonly seconds: number[] = []
  private withoutTimestamp = 0

  push(line: string): boolean {
    const match = SHOWINFO_PREFIX.exec(line)
    if (!match) return false
    const message = match[1]
    const timeBase = TIME_BASE.exec(message)
    if (timeBase) {
      const num = Number(timeBase[1])
      const den = Number(timeBase[2])
      if (num > 0 && den > 0) this.timeBase = {num, den}
      return true
    }
    const frame = FRAME.exec(message)
    if (frame) {
      if (frame[1] === 'NOPTS') this.withoutTimestamp += 1
      else if (!this.timeBase) {
        throw new Error('showinfo logged a frame before its time base')
      } else {
        this.seconds.push((Number(frame[1]) * this.timeBase.num) / this.timeBase.den)
      }
    }
    return true
  }

  result(): FrameTimes {
    return {seconds: [...this.seconds], withoutTimestamp: this.withoutTimestamp}
  }
}

export interface FrameComparison {
  inputFrames: number
  outputFrames: number
  /** Input frames with no MP4 frame at the same time (dropped or moved). */
  missing: number
  /** MP4 frames at a time where the input has no frame (duplicated or moved). */
  added: number
  /** Largest time difference of matched frames, in seconds. */
  maxShiftSeconds: number
}

/**
 * Matches the frames of the input and the MP4 by time (each measured from its own first frame, so
 * a start offset does not count), within `tolerance` seconds.
 */
export function compareFrameTimes(
  input: readonly number[],
  output: readonly number[],
  tolerance = FRAME_TIME_TOLERANCE_SECONDS,
): FrameComparison {
  const relative = (times: readonly number[]) => {
    const sorted = [...times].sort((a, b) => a - b)
    return sorted.map((t) => t - sorted[0])
  }
  const a = relative(input)
  const b = relative(output)
  let i = 0
  let j = 0
  let matched = 0
  let maxShiftSeconds = 0
  while (i < a.length && j < b.length) {
    const difference = b[j] - a[i]
    if (Math.abs(difference) <= tolerance) {
      maxShiftSeconds = Math.max(maxShiftSeconds, Math.abs(difference))
      matched += 1
      i += 1
      j += 1
    } else if (difference < 0) {
      j += 1
    } else {
      i += 1
    }
  }
  return {
    inputFrames: a.length,
    outputFrames: b.length,
    missing: a.length - matched,
    added: b.length - matched,
    maxShiftSeconds,
  }
}

/** Problems that make the MP4's frames unacceptable (empty when every frame is kept at its time). */
export function frameTimeProblems(input: FrameTimes, output: FrameTimes): string[] {
  const problems: string[] = []
  if (input.seconds.length === 0) problems.push('no input frame times were logged')
  if (output.seconds.length === 0) problems.push('no MP4 frame times were logged')
  if (input.withoutTimestamp > 0) {
    problems.push(`${input.withoutTimestamp} input frames have no timestamp`)
  }
  if (output.withoutTimestamp > 0) {
    problems.push(`${output.withoutTimestamp} MP4 frames have no timestamp`)
  }
  if (problems.length > 0) return problems
  const comparison = compareFrameTimes(input.seconds, output.seconds)
  if (comparison.missing > 0 || comparison.added > 0) {
    problems.push(
      `the MP4 has ${comparison.outputFrames} frames for ${comparison.inputFrames} input frames: ` +
        `${comparison.missing} input frames are missing or moved and ${comparison.added} MP4 frames ` +
        `are not at an input frame's time (more than ${FRAME_TIME_TOLERANCE_SECONDS * 1000} ms off)`,
    )
  }
  return problems
}
