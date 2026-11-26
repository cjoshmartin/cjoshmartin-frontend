/**
 * Pure helpers for the `video` object (video contract v2 in docs/sanity-migration/schema-contract.md).
 * No Studio dependencies, so they run in validation, previews, tests and `sanity documents validate`.
 */
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
  {kind: 'empty'} | {kind: 'ready'} | {kind: 'converting'} | {kind: 'failed'; message: string}

/**
 * Where the video of `fileAssetId` stands. A `failed` status only counts when it is about the
 * current file (`conversion.sourceAssetId`); after the editor picks another file the old failure
 * no longer applies and the new file waits for conversion.
 */
export function videoConversionState(
  fileAssetId: string | undefined,
  conversion: VideoConversionValue | undefined,
): VideoConversionState {
  if (!fileAssetId) return {kind: 'empty'}
  if (fileAssetId === conversion?.outputAssetId) return {kind: 'ready'}
  if (conversion?.status === 'failed' && conversion.sourceAssetId === fileAssetId) {
    return {kind: 'failed', message: conversion.message?.trim() || 'no error message was recorded'}
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
    case 'failed':
      return `Conversion failed: ${state.message}`
  }
}
