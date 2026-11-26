/**
 * Pure helpers for the `video` object (video contract v2 in docs/sanity-migration/schema-contract.md).
 * No Studio dependencies, so they run in validation, previews, tests and `sanity documents validate`.
 * Only type imports: migration/verify loads this file with Node's own type stripping, which cannot
 * resolve extensionless imports.
 */
import type {VideoConversionStatus} from '../constants'

/**
 * How old a `processing` mark must be before the video-to-mp4 Function treats it as a dead run.
 * Equal to STALE_PROCESSING_SECONDS in functions/video-to-mp4/trigger.ts (a test checks it).
 */
export const STALE_PROCESSING_SECONDS = 20 * 60

/**
 * How long a retryable `pending` waits before the Function tries again. Equal to
 * RETRY_DELAY_SECONDS in functions/video-to-mp4/trigger.ts (a test checks it).
 */
export const RETRY_DELAY_SECONDS = 10 * 60

export interface VideoConversionValue {
  status?: VideoConversionStatus | string
  message?: string
  sourceAssetId?: string
  outputAssetId?: string
  settingsVersion?: string
  /** True when `original` is the upload's copy without location and personal metadata. */
  originalStripped?: boolean
  stripVersion?: string
  updatedAt?: string
}

/** A `file` field value: `{_type: "file", asset: {_type: "reference", _ref: "file-..."}}`. */
export interface FileValue {
  asset?: {_ref?: string}
}

export interface VideoValue {
  file?: FileValue
  original?: FileValue
  conversion?: VideoConversionValue
}

/**
 * The contract's definition: a video needs conversion when `file` has an asset that is not the
 * MP4 the converter produced last (`conversion.outputAssetId`).
 */
export function videoNeedsConversion(value: VideoValue | undefined): boolean {
  const fileAssetId = value?.file?.asset?._ref
  return Boolean(fileAssetId) && fileAssetId !== value?.conversion?.outputAssetId
}

export type VideoConversionState =
  | {kind: 'empty'}
  /**
   * The video-to-mp4 Function could not remove the location and personal metadata from the upload,
   * so it took the upload out of the block and deleted it; `message` says why and what to do.
   */
  | {kind: 'removed'; message: string}
  | {kind: 'ready'}
  | {kind: 'converting'}
  | {kind: 'waiting'; message: string}
  | {kind: 'failed'; message: string}

/**
 * Whether a `failed` conversion is final: only for the settings it failed with. The video-to-mp4
 * Function converts the file again under any other SETTINGS_VERSION (isFailedForCurrentFile in
 * functions/video-to-mp4/trigger.ts), on the next event of its document. `currentSettingsVersion`
 * is SETTINGS_VERSION from functions/video-to-mp4/settings.ts; callers pass it in because this
 * module has no runtime imports.
 */
function isFinalFailure(conversion: VideoConversionValue, currentSettingsVersion: string): boolean {
  return conversion.status === 'failed' && conversion.settingsVersion === currentSettingsVersion
}

/**
 * Where the video of `fileAssetId` stands. A `failed` or `pending` status only counts when it is
 * about the current file (`conversion.sourceAssetId`); after the editor picks another file the old
 * status no longer applies and the new file waits for conversion. `pending` with a message is a
 * problem that was not the video's fault; the converter retries it (`waiting`). `failed` under
 * other settings than `currentSettingsVersion` is retried with the current settings (`waiting`).
 */
export function videoConversionState(
  fileAssetId: string | undefined,
  conversion: VideoConversionValue | undefined,
  currentSettingsVersion: string,
): VideoConversionState {
  if (!fileAssetId) {
    // The Function's removal of an unstrippable upload: `failed` without a file and without the
    // upload's id. A failure the editor cleared by removing the file keeps its sourceAssetId.
    const message = conversion?.message?.trim()
    if (conversion?.status === 'failed' && !conversion.sourceAssetId && message) return {kind: 'removed', message}
    return {kind: 'empty'}
  }
  if (fileAssetId === conversion?.outputAssetId) return {kind: 'ready'}
  if (conversion?.sourceAssetId === fileAssetId) {
    if (conversion.status === 'failed') {
      const message = conversion.message?.trim() || 'no error message was recorded'
      if (isFinalFailure(conversion, currentSettingsVersion)) return {kind: 'failed', message}
      return {
        kind: 'waiting',
        message: `it failed with older settings (${
          conversion.settingsVersion?.trim() || 'no settings version was recorded'
        }) and is converted again with the current settings. The last error: ${message}`,
      }
    }
    if (conversion.status === 'pending' && conversion.message?.trim()) {
      return {kind: 'waiting', message: conversion.message.trim()}
    }
  }
  return {kind: 'converting'}
}

/** One-line status shown in the Studio preview of a video block. */
export function videoConversionLabel(state: VideoConversionState): string {
  switch (state.kind) {
    case 'empty':
      return 'No video file'
    case 'removed':
      return `Upload removed: ${state.message}`
    case 'ready':
      return 'Ready'
    case 'converting':
      return 'Converting to MP4...'
    case 'waiting':
      return `Waiting to retry the conversion: ${state.message}`
    case 'failed':
      return `Conversion failed: ${state.message}`
  }
}

/**
 * What the block keeps as its original (shown after "Ready" in the Studio preview): `stripped` when
 * it is a copy without location and personal metadata (`conversion.originalStripped`, written by
 * the video-to-mp4 Function, or `privacy.status` "stripped" on the original's asset, written by the
 * Function and by the migration's privacy step), `unstripped` for an original from before
 * stripping existed, `none` without an original.
 */
export function videoOriginalState(
  conversion: VideoConversionValue | undefined,
  originalAssetId: string | undefined,
  originalPrivacyStatus?: string,
): 'stripped' | 'unstripped' | 'none' {
  if (!originalAssetId) return 'none'
  return conversion?.originalStripped === true || originalPrivacyStatus === 'stripped' ? 'stripped' : 'unstripped'
}

/** The preview subtitle: the conversion status, and for a ready block what its original is. */
export function videoPreviewSubtitle(
  state: VideoConversionState,
  original: 'stripped' | 'unstripped' | 'none',
): string {
  const label = videoConversionLabel(state)
  if (state.kind !== 'ready' || original === 'none') return label
  return original === 'stripped'
    ? `${label}. Original kept without location data`
    : `${label}. The original upload still has its metadata`
}

function ageSeconds(time: string | undefined, now: Date): number {
  const parsed = typeof time === 'string' ? Date.parse(time) : Number.NaN
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : (now.getTime() - parsed) / 1000
}

export type VideoConversionNudgeReason =
  'stale-processing' | 'retry-due' | 'never-started' | 'settings-changed'

/**
 * Why the converter should be started again for this block, or null. The video-to-mp4 Function
 * only runs on a document event, and nothing sends one when a block is stuck:
 * - `stale-processing`: a run marked it `processing` more than STALE_PROCESSING_SECONDS ago and
 *   died (out of memory, or killed by the platform) without recording a result;
 * - `retry-due`: a retryable problem (`pending` for the current file) is older than
 *   RETRY_DELAY_SECONDS;
 * - `never-started`: the file needs conversion, the converter never wrote a status for it, and the
 *   document has not changed for STALE_PROCESSING_SECONDS (the event was missed, for example while
 *   the Function was being redeployed);
 * - `settings-changed`: the conversion failed under other settings than `currentSettingsVersion`
 *   (the Function retries those) and the failure is older than RETRY_DELAY_SECONDS.
 * A failure under the current settings is never retried this way: it would fail the same way.
 */
export function videoConversionNudge(
  value: VideoValue | undefined,
  documentUpdatedAt: string | undefined,
  now: Date,
  currentSettingsVersion: string,
): VideoConversionNudgeReason | null {
  if (!videoNeedsConversion(value)) return null
  const fileAssetId = value?.file?.asset?._ref
  const conversion = value?.conversion
  if (conversion?.sourceAssetId !== fileAssetId) {
    return ageSeconds(documentUpdatedAt, now) > STALE_PROCESSING_SECONDS ? 'never-started' : null
  }
  switch (conversion?.status) {
    case 'processing':
      return ageSeconds(conversion.updatedAt, now) > STALE_PROCESSING_SECONDS
        ? 'stale-processing'
        : null
    case 'pending':
      return ageSeconds(conversion.updatedAt, now) > RETRY_DELAY_SECONDS ? 'retry-due' : null
    case 'failed':
      if (isFinalFailure(conversion, currentSettingsVersion)) return null
      return ageSeconds(conversion.updatedAt, now) > RETRY_DELAY_SECONDS ? 'settings-changed' : null
    default:
      return ageSeconds(documentUpdatedAt, now) > STALE_PROCESSING_SECONDS ? 'never-started' : null
  }
}

/**
 * The `conversion` written to start the video-to-mp4 Function again: `pending` for the current
 * file. A stuck mark keeps its `updatedAt` (old enough that the Function's filter matches it); a
 * block the Function never started gets a fresh object without one.
 *
 * A failure under older settings (`settings-changed`) stays `failed`, and only its `updatedAt`
 * moves to `now`. The write is the event, and the Function decides with its own SETTINGS_VERSION:
 * while the Studio and the Function are deployed with different settings, a block is neither
 * converted again with the settings it already failed with nor nudged more than once per
 * RETRY_DELAY_SECONDS.
 */
export function nudgedConversion(
  block: VideoValue,
  reason: VideoConversionNudgeReason,
  now: Date,
): VideoConversionValue {
  if (reason === 'settings-changed') return {...block.conversion, updatedAt: now.toISOString()}
  const fileAssetId = block.file?.asset?._ref
  const message = `Retry requested by the Studio at ${now.toISOString()} (${
    reason === 'stale-processing'
      ? 'the last conversion stopped without a result'
      : reason === 'retry-due'
        ? 'the retry was due'
        : 'the conversion never started'
  }).`
  if (reason === 'never-started') return {status: 'pending', sourceAssetId: fileAssetId, message}
  return {...block.conversion, status: 'pending', sourceAssetId: fileAssetId, message}
}
