/**
 * Pure helpers for the `video` object (video contract v2 in docs/sanity-migration/schema-contract.md).
 * No Studio dependencies, so they run in validation, previews, tests and `sanity documents validate`.
 */
import {RETRY_DELAY_SECONDS, STALE_PROCESSING_SECONDS} from '../../functions/video-to-mp4/trigger'
import type {VideoConversionStatus} from '../constants'

export interface VideoConversionValue {
  status?: VideoConversionStatus | string
  message?: string
  sourceAssetId?: string
  outputAssetId?: string
  settingsVersion?: string
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
  | {kind: 'ready'}
  | {kind: 'converting'}
  | {kind: 'waiting'; message: string}
  | {kind: 'failed'; message: string}

/**
 * Where the video of `fileAssetId` stands. A `failed` or `pending` status only counts when it is
 * about the current file (`conversion.sourceAssetId`); after the editor picks another file the old
 * status no longer applies and the new file waits for conversion. `pending` with a message is a
 * problem that was not the video's fault; the converter retries it (`waiting`).
 */
export function videoConversionState(
  fileAssetId: string | undefined,
  conversion: VideoConversionValue | undefined,
): VideoConversionState {
  if (!fileAssetId) return {kind: 'empty'}
  if (fileAssetId === conversion?.outputAssetId) return {kind: 'ready'}
  if (conversion?.sourceAssetId === fileAssetId) {
    if (conversion.status === 'failed') {
      return {
        kind: 'failed',
        message: conversion.message?.trim() || 'no error message was recorded',
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

function ageSeconds(time: string | undefined, now: Date): number {
  const parsed = typeof time === 'string' ? Date.parse(time) : Number.NaN
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : (now.getTime() - parsed) / 1000
}

/**
 * Why the converter should be started again for this block, or null. The video-to-mp4 Function
 * only runs on a document event, and nothing sends one when a block is stuck:
 * - `stale-processing`: a run marked it `processing` more than STALE_PROCESSING_SECONDS ago and
 *   died (out of memory, or killed by the platform) without recording a result;
 * - `retry-due`: a retryable problem (`pending` for the current file) is older than
 *   RETRY_DELAY_SECONDS;
 * - `never-started`: the file needs conversion, the converter never wrote a status for it, and the
 *   document has not changed for STALE_PROCESSING_SECONDS (the event was missed, for example while
 *   the Function was being redeployed).
 * A failed conversion is never retried this way: it would fail the same way.
 */
export function videoConversionNudge(
  value: VideoValue | undefined,
  documentUpdatedAt: string | undefined,
  now: Date,
): 'stale-processing' | 'retry-due' | 'never-started' | null {
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
      return null
    default:
      return ageSeconds(documentUpdatedAt, now) > STALE_PROCESSING_SECONDS ? 'never-started' : null
  }
}

/**
 * The `conversion` written to start the video-to-mp4 Function again: `pending` for the current
 * file. A stuck mark keeps its `updatedAt` (old enough that the Function's filter matches it); a
 * block the Function never started gets a fresh object without one.
 */
export function nudgedConversion(
  block: VideoValue,
  reason: NonNullable<ReturnType<typeof videoConversionNudge>>,
  now: Date,
): VideoConversionValue {
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
