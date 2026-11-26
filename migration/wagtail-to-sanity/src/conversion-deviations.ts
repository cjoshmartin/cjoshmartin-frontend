/**
 * MP4s that fail a check of the convert step because of the contract settings themselves
 * (studio/functions/video-to-mp4/settings.ts, owned by the Studio package), each with its
 * evidence. The convert step accepts a failing MP4 only when an entry here names the same media
 * item, the same original bytes, the same settings version, the same output bytes and exactly the
 * same failing checks. Anything else fails the step, and an entry that no longer matches a
 * conversion (for example after the settings are fixed) fails it too, so it has to be removed.
 *
 * Validation lists every deviation as explained. The video-to-mp4 Function uses the same settings,
 * so a Studio upload like these gets the same result.
 */
import type {VerificationProblem} from './video/ffmpeg'

export interface ConversionDeviation {
  mediaId: number
  /** sha1 of the original file in the bucket. */
  sourceSha1: string
  settingsVersion: string
  /** sha1 of the MP4 the settings produce (ffmpeg 9.0.1, 11 CPUs: the bytes are reproducible). */
  outputSha1: string
  /** The checks that fail, exactly. */
  checks: VerificationProblem['check'][]
  /** What goes wrong and why, with the evidence. */
  explanation: string
}

export const CONVERSION_DEVIATIONS: readonly ConversionDeviation[] = [
  {
    mediaId: 14,
    sourceSha1: '7b6075d008ca3736c08bf5e23ef47e5145b48383',
    settingsVersion: 'h264-crf23-max1920-v2',
    outputSha1: '51f03c9b2dab54d5864685dd9e58d4450384d869',
    checks: ['videoDuration', 'fileDuration'],
    explanation:
      'media/step_count.mp4 (1004x2176 H.264, no audio, 3.4585 s) has a variable frame rate: 25 frames in its first ' +
      '0.53 s, then 6 frames about 0.5 s apart. With settings v2 the MP4 keeps all 31 frames at their own times ' +
      '(frameTimes passes; v1 kept 13), and its movie header (mvhd) and edit list say 3.525 s: the last frame at 3.446 s ' +
      'plus its 0.078 s from the original. ffprobe reports 3.025 s instead, because ffmpeg reads the stream duration from ' +
      'the sample table, which ends at the last decode timestamp; with B-frames and frames 0.5 s apart, decode times run ' +
      'two frames (0.97 s) behind presentation times at the end. Players are not affected: Chrome for Testing reports ' +
      '3.025 s at loadedmetadata, extends it to 3.446 s and presents the last frame; WebKit reports 3.525 s and presents ' +
      'it. The Function (ffmpeg 7.0.2) writes the same frames with a 3.459 s movie header.',
  },
]

/** The deviation that explains exactly these failing checks of this conversion, if any. */
export function matchingDeviation(options: {
  mediaId: number
  sourceSha1: string
  settingsVersion: string
  outputSha1: string
  problems: readonly VerificationProblem[]
}): ConversionDeviation | undefined {
  const failing = [...new Set(options.problems.map((p) => p.check))].sort()
  return CONVERSION_DEVIATIONS.find(
    (d) =>
      d.mediaId === options.mediaId &&
      d.sourceSha1 === options.sourceSha1 &&
      d.settingsVersion === options.settingsVersion &&
      d.outputSha1 === options.outputSha1 &&
      [...d.checks].sort().join(',') === failing.join(','),
  )
}
