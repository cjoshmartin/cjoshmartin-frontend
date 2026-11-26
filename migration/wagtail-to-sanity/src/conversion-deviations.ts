/**
 * MP4s that fail a check of the convert step because of the contract settings themselves
 * (studio/functions/video-to-mp4/settings.ts, owned by the Studio package), each with its
 * evidence. The convert step accepts a failing MP4 only when an entry here names the same media
 * item, the same original bytes, the same settings version, the same output bytes and exactly the
 * same failing checks. Anything else fails the step, and an entry that no longer matches a
 * conversion (for example after the settings are fixed) fails it too, so it has to be removed.
 *
 * Validation lists every deviation as explained. They stay open issues for the settings owner:
 * the video-to-mp4 Function uses the same settings, so a Studio upload like these gets the same
 * result.
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
    settingsVersion: 'h264-crf23-max1920-v1',
    outputSha1: 'e0714608ff35c8bc70ecec48932b6703a84530b4',
    checks: ['videoDuration', 'fileDuration'],
    explanation:
      'media/step_count.mp4 (1004x2176 H.264, no audio) has a variable frame rate: 25 frames in its first 0.53 s, then ' +
      '6 frames about 0.5 s apart (31 frames, 3.4585 s, average 8.8 fps). With the contract settings ffmpeg 9.0.1 picks ' +
      '1/8.8 s (1/average frame rate) as the H.264 time base, so frames that fall into the same tick are dropped: the MP4 ' +
      'has 13 of the 31 frames and its container says 3.184 s, 0.275 s shorter than the original (the last frame starts ' +
      'at 3.411 s instead of 3.446 s). Every other check passes, and the other 28 videos keep all their frames except ' +
      'media 27 (1432 of 1433). Adding `-enc_time_base:v demux` keeps all 31 frames with their original timestamps ' +
      '(tested); that is a change to settings.ts and its SETTINGS_VERSION, which this package does not own.',
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
