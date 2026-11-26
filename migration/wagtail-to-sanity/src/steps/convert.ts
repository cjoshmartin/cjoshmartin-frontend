/**
 * Step 3: convert.
 *
 * Converts every Wagtail video (media/ in the bucket mirror) to an MP4 with the contract settings
 * (studio/functions/video-to-mp4/settings.ts, the same module the video-to-mp4 Sanity Function
 * uses), then checks each output (src/video/ffmpeg.ts verifyMp4): H.264 High, yuv420p, longest
 * side at most 1920 px with even dimensions equal to the settings' own arithmetic, no rotation
 * left, moov before mdat, stereo AAC only when the input has audio, no other streams, no metadata
 * copied from the input, durations within 0.1 s of the input and every frame decoding without
 * an error. Any failing check fails the step, unless src/conversion-deviations.ts explains exactly
 * that failure of exactly those bytes (a defect of the contract settings, reported to their
 * owner); an entry there that matches nothing fails the step too.
 *
 * The MP4s are written to video-mp4/media-<id>/<name>.mp4 in the migration data folder and
 * described in state/video-mp4.json. Conversion does not depend on the dataset, so both datasets
 * get the same files. A rerun reuses an MP4 whose source bytes, settings version, preset and
 * ffmpeg arguments are unchanged and whose bytes still have the recorded sha1, after checking it
 * again; anything else is converted again. `convertedAt` is kept from the conversion that made
 * the file, so the documents the transform writes stay the same across reruns.
 *
 * Also writes reports/wp3/video-mp4.{json,md} with the before/after size table and the decoded
 * frame counts of each original and MP4 (outside git).
 */
import {existsSync, mkdirSync, renameSync, rmSync, statSync} from 'node:fs'
import {availableParallelism} from 'node:os'
import path from 'node:path'

import {
  convertedFilename,
  DEFAULT_PRESET,
  SETTINGS_VERSION,
  type X264Preset,
} from '../../../../studio/functions/video-to-mp4/settings'
import type {DataPaths} from '../config'
import {CONVERSION_DEVIATIONS, matchingDeviation, type ConversionDeviation} from '../conversion-deviations'
import {mapLimit} from '../sanity'
import {hashFile, log, readJson, stableStringify, writeJson, writeText} from '../util'
import {
  conversionArgs,
  convertToMp4,
  countVideoFrames,
  describeProblems,
  probe,
  summarizeInput,
  toolVersion,
  verifyMp4,
  type InputSummary,
  type OutputSummary,
  type VerificationProblem,
} from '../video/ffmpeg'
import {loadExport} from '../wagtail'
import type {Inventory} from './extract'

/** Conversions that run at the same time. libx264 already uses every core for each one. */
const PARALLEL_CONVERSIONS = 2

export interface ConvertedVideo {
  mediaId: number
  /** Wagtail media title. */
  title: string
  source: {
    /** Bucket path, e.g. "media/IMG_3151.MOV". */
    path: string
    filename: string
    sha1: string
    bytes: number
    probe: InputSummary
  }
  output: {
    /** Path relative to the migration data folder, e.g. "video-mp4/media-7/IMG_3151.mp4". */
    path: string
    filename: string
    sha1: string
    bytes: number
    summary: OutputSummary
  }
  /** Decoded frames of the original's video stream and of the MP4. */
  frames: {input: number; output: number}
  /** Set when a check fails and src/conversion-deviations.ts explains it. */
  deviation?: {checks: VerificationProblem['check'][]; problems: string[]; explanation: string}
  settingsVersion: string
  preset: X264Preset
  /** The ffmpeg arguments with the input and output paths replaced by <input> and <output>. */
  ffmpegArgs: string[]
  /** First line of `ffmpeg -version` of the conversion. */
  ffmpeg: string
  /** CPU count of the machine; libx264's thread count, and so the exact bytes, depend on it. */
  cpus: number
  convertedAt: string
  conversionSeconds: number
  verifiedAt: string
}

export interface Mp4Map {
  settingsVersion: string
  preset: X264Preset
  updatedAt: string
  /** Wagtail media id -> its MP4. */
  videos: Record<string, ConvertedVideo>
}

export function mp4MapPath(paths: DataPaths): string {
  return path.join(paths.state, 'video-mp4.json')
}

export function readMp4Map(paths: DataPaths): Mp4Map {
  const file = mp4MapPath(paths)
  if (!existsSync(file)) throw new Error(`${file} does not exist; run the convert step first`)
  const map = readJson<Mp4Map>(file)
  if (map.settingsVersion !== SETTINGS_VERSION) {
    throw new Error(`${file} was made with settings ${map.settingsVersion}, the current settings are ${SETTINGS_VERSION}; run the convert step again`)
  }
  return map
}

/** The ffmpeg arguments with the two paths replaced, so runs on other paths compare equal. */
export function argsTemplate(args: readonly string[], input: string, output: string): string[] {
  return args.map((arg) => (arg === input ? '<input>' : arg === output ? '<output>' : arg))
}

function relativeToData(paths: DataPaths, file: string): string {
  return path.relative(paths.root, file).split(path.sep).join('/')
}

export async function convertVideos(paths: DataPaths, options: {preset?: X264Preset} = {}): Promise<Mp4Map> {
  const preset = options.preset ?? DEFAULT_PRESET
  const data = loadExport(paths.exportJson)
  const inventory = readJson<Inventory>(path.join(paths.state, 'inventory.json'))
  const previous = existsSync(mp4MapPath(paths)) ? readJson<Mp4Map>(mp4MapPath(paths)) : null
  const [ffmpeg, ffprobe] = await Promise.all([toolVersion('ffmpeg'), toolVersion('ffprobe')])
  const cpus = availableParallelism()
  log(`convert: ${data.media.length} videos, settings ${SETTINGS_VERSION}, preset ${preset}; ${ffmpeg}; ${ffprobe}; ${cpus} CPUs`)

  const media = [...data.media].sort((a, b) => a.id - b.id)
  const failures: string[] = []
  const usedDeviations = new Set<ConversionDeviation>()
  let converted = 0
  const results = await mapLimit(media, PARALLEL_CONVERSIONS, async (item): Promise<ConvertedVideo | null> => {
    const where = `media ${item.id}`
    const sourcePath = inventory.mediaFiles[String(item.id)]
    if (!sourcePath) throw new Error(`${where}: no file in the bucket mirror (inventory.json)`)
    const recorded = inventory.files.find((f) => f.path === sourcePath)
    if (!recorded) throw new Error(`${where}: ${sourcePath} is not in the inventory`)
    const input = path.join(paths.gcs, sourcePath)
    const sha1 = await hashFile(input, 'sha1')
    if (sha1 !== recorded.sha1) throw new Error(`${where}: ${sourcePath} has sha1 ${sha1}, the inventory recorded ${recorded.sha1}; run the extract step`)
    const sourceProbe = summarizeInput(await probe(input), sourcePath)
    /**
     * Runs every check on an MP4. Returns its summary and the deviation that explains its failing
     * checks, or null after recording the failure.
     */
    const check = async (file: string): Promise<{summary: OutputSummary; sha1: string; deviation?: ConversionDeviation; problems: VerificationProblem[]} | null> => {
      const result = await verifyMp4(file, sourceProbe)
      const outputSha1 = await hashFile(file, 'sha1')
      if (result.ok && result.output) return {summary: result.output, sha1: outputSha1, problems: []}
      const deviation = result.output
        ? matchingDeviation({mediaId: item.id, sourceSha1: sha1, settingsVersion: SETTINGS_VERSION, outputSha1, problems: result.problems})
        : undefined
      if (deviation && result.output) {
        usedDeviations.add(deviation)
        log(`  ${where}: WARNING known deviation (${describeProblems(result.problems)}); see src/conversion-deviations.ts`)
        return {summary: result.output, sha1: outputSha1, deviation, problems: result.problems}
      }
      failures.push(`${where} (${sourcePath} -> ${relativeToData(paths, file)}, sha1 ${outputSha1}): ${describeProblems(result.problems)}`)
      return null
    }
    const filename = path.posix.basename(sourcePath)
    const outputFilename = convertedFilename(filename, `media-${item.id}`)
    const outputDir = path.join(paths.videoMp4, `media-${item.id}`)
    const output = path.join(outputDir, outputFilename)
    const args = conversionArgs({input, output, preset, hasAudio: sourceProbe.audio !== null})
    const template = argsTemplate(args, input, output)

    const before = previous?.videos[String(item.id)]
    let reuse = false
    if (
      before &&
      before.source.sha1 === sha1 &&
      before.settingsVersion === SETTINGS_VERSION &&
      before.preset === preset &&
      stableStringify(before.ffmpegArgs) === stableStringify(template) &&
      before.output.path === relativeToData(paths, output) &&
      existsSync(output)
    ) {
      const outputSha1 = await hashFile(output, 'sha1')
      if (outputSha1 === before.output.sha1) reuse = true
      else log(`  ${where}: ${relativeToData(paths, output)} has sha1 ${outputSha1}, the record says ${before.output.sha1}; converting again`)
    }

    let convertedAt: string
    let conversionSeconds: number
    let checked: Awaited<ReturnType<typeof check>>
    if (reuse) {
      convertedAt = before!.convertedAt
      conversionSeconds = before!.conversionSeconds
      // A reused MP4 is checked again, against the current checks.
      checked = await check(output)
      if (!checked) return null
    } else {
      mkdirSync(outputDir, {recursive: true, mode: 0o700})
      const partial = path.join(outputDir, `partial-${outputFilename}`)
      const partialArgs = conversionArgs({input, output: partial, preset, hasAudio: sourceProbe.audio !== null})
      if (stableStringify(argsTemplate(partialArgs, input, partial)) !== stableStringify(template)) {
        throw new Error(`${where}: the ffmpeg arguments depend on the output path`)
      }
      const started = Date.now()
      try {
        await convertToMp4({input, output: partial, preset, hasAudio: sourceProbe.audio !== null})
      } catch (error) {
        rmSync(partial, {force: true})
        throw error
      }
      conversionSeconds = Math.round((Date.now() - started) / 100) / 10
      convertedAt = new Date().toISOString()
      // Checked before it replaces anything, so a failed conversion never becomes the output.
      checked = await check(partial)
      if (!checked) {
        log(`  ${where}: FAILED checks, kept for inspection at ${relativeToData(paths, partial)}`)
        return null
      }
      renameSync(partial, output)
      converted++
      log(`  ${where}: ${sourcePath} -> ${relativeToData(paths, output)} in ${conversionSeconds} s`)
    }

    return {
      mediaId: item.id,
      title: item.title,
      source: {path: sourcePath, filename, sha1, bytes: statSync(input).size, probe: sourceProbe},
      output: {
        path: relativeToData(paths, output),
        filename: outputFilename,
        sha1: checked.sha1,
        bytes: statSync(output).size,
        summary: checked.summary,
      },
      frames: {input: await countVideoFrames(input, sourceProbe), output: checked.summary.videoFrames},
      ...(checked.deviation
        ? {deviation: {checks: checked.deviation.checks, problems: checked.problems.map((p) => `${p.check}: ${p.message}`), explanation: checked.deviation.explanation}}
        : {}),
      settingsVersion: SETTINGS_VERSION,
      preset,
      ffmpegArgs: template,
      ffmpeg: reuse ? before!.ffmpeg : ffmpeg,
      cpus: reuse ? before!.cpus : cpus,
      convertedAt,
      conversionSeconds,
      verifiedAt: new Date().toISOString(),
    }
  })

  for (const deviation of CONVERSION_DEVIATIONS) {
    if (!usedDeviations.has(deviation)) {
      failures.push(`src/conversion-deviations.ts lists media ${deviation.mediaId} (${deviation.checks.join(', ')}), but no conversion matches it any more; remove the entry`)
    }
  }
  if (failures.length) {
    throw new Error(`convert: ${failures.length} problem(s) with the MP4s:\n- ${failures.join('\n- ')}`)
  }
  const videos = results.filter((r): r is ConvertedVideo => r !== null)
  const map: Mp4Map = {
    settingsVersion: SETTINGS_VERSION,
    preset,
    updatedAt: new Date().toISOString(),
    videos: Object.fromEntries(videos.map((v) => [String(v.mediaId), v])),
  }
  writeJson(mp4MapPath(paths), map)
  writeSizeReport(paths, map, {ffmpeg, ffprobe})
  const before = videos.reduce((sum, v) => sum + v.source.bytes, 0)
  const after = videos.reduce((sum, v) => sum + v.output.bytes, 0)
  const deviations = videos.filter((v) => v.deviation).map((v) => v.mediaId)
  log(
    `convert: ${videos.length - deviations.length} MP4s pass every check` +
      `${deviations.length ? `, ${deviations.length} only with a known deviation (media ${deviations.join(', ')})` : ''}` +
      ` (${converted} converted now, ${videos.length - converted} reused); ${mib(before)} -> ${mib(after)}`,
  )
  return map
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function writeSizeReport(paths: DataPaths, map: Mp4Map, tools: {ffmpeg: string; ffprobe: string}): void {
  const videos = Object.values(map.videos).sort((a, b) => a.mediaId - b.mediaId)
  const before = videos.reduce((sum, v) => sum + v.source.bytes, 0)
  const after = videos.reduce((sum, v) => sum + v.output.bytes, 0)
  writeJson(path.join(paths.reports, 'wp3', 'video-mp4.json'), {...map, tools, totals: {sourceBytes: before, outputBytes: after}})
  const size = (v: {width: number; height: number}) => `${v.width}x${v.height}`
  const rows = videos.map((v) => {
    const p = v.source.probe
    const o = v.output.summary
    return `| ${v.mediaId} | \`${v.source.filename}\` | ${p.video.codec} ${size(p.video)}${p.video.rotation ? ` rot ${p.video.rotation}` : ''} | ${p.audio ? `${p.audio.codec} ${p.audio.channels} ch` : 'none'} | ${mib(v.source.bytes)} | ${size(o)} | ${o.audioCodec ? `${o.audioCodec} ${o.audioChannels} ch` : 'none'} | ${mib(v.output.bytes)} | ${((v.output.bytes / v.source.bytes) * 100).toFixed(0)} % | ${p.mappedDurationSeconds.toFixed(3)} / ${o.durationSeconds.toFixed(3)} | ${v.frames.input} / ${v.frames.output} | ${v.deviation ? `known deviation: ${v.deviation.checks.join(', ')}` : 'all pass'} |`
  })
  const md = [
    '# Wagtail videos converted to MP4',
    '',
    `Settings \`${map.settingsVersion}\`, preset \`${map.preset}\`. ${tools.ffmpeg}. ${tools.ffprobe}.`,
    '',
    `${videos.length} videos: ${mib(before)} before, ${mib(after)} after (${((after / before) * 100).toFixed(0)} %).`,
    '',
    '| Media | Original | Video in | Audio in | Bytes in | Size out | Audio out | Bytes out | Out/in | Duration in / out (s) | Frames in / out | Checks |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    ...videos.filter((v) => v.deviation).flatMap((v) => [`Media ${v.mediaId}: ${v.deviation!.problems.join('; ')}. ${v.deviation!.explanation}`, '']),
  ].join('\n')
  writeText(path.join(paths.reports, 'wp3', 'video-mp4.md'), md)
}
