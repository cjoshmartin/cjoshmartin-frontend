/**
 * Patch paths and values the Function writes, and the per-upload lease rules.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  blockPath,
  documentResultOps,
  leaseHeldByOther,
  LEASE_SECONDS,
  MAX_MESSAGE_LENGTH,
  newLease,
  processingOps,
  resultOps,
  truncateMessage,
  type ConversionResult,
} from '../patches'
import {SETTINGS_VERSION} from '../settings'
import {STALE_PROCESSING_SECONDS, type VideoBlock} from '../trigger'
import {applyPatch} from './memory-store'

const NOW = new Date('2026-11-26T12:00:00.000Z')
const MOV = 'file-1111111111111111111111111111111111111111-mov'
const MP4 = 'file-2222222222222222222222222222222222222222-mp4'
const file = (ref: string) => ({_type: 'file', asset: {_type: 'reference', _ref: ref}})
const located = (block: VideoBlock, field = 'body') => ({field, key: block._key, block})

describe('blockPath', () => {
  it('addresses a block by _key, JSON-quoting the key', () => {
    assert.equal(blockPath('body', 'a1b2', 'conversion'), 'body[_key=="a1b2"].conversion')
    assert.equal(blockPath('bio', 'we"ird.key'), 'bio[_key=="we\\"ird.key"]')
    assert.throws(() => blockPath('body]; drop', 'x'), TypeError)
  })
})

describe('processingOps', () => {
  it('writes processing with source, settings version and time', () => {
    const ops = processingOps(
      located({_type: 'video', _key: 'v', file: file(MOV)}),
      MOV,
      'Converting to MP4.',
      NOW,
    )
    assert.deepEqual(ops, {
      set: {
        'body[_key=="v"].conversion': {
          status: 'processing',
          message: 'Converting to MP4.',
          sourceAssetId: MOV,
          settingsVersion: SETTINGS_VERSION,
          updatedAt: NOW.toISOString(),
        },
      },
    })
  })

  it('removes an original that belongs to an earlier file, keeps one for the same file', () => {
    const replaced = processingOps(
      located({
        _type: 'video',
        _key: 'v',
        file: file(MOV),
        original: file('file-9999999999999999999999999999999999999999-webm'),
      }),
      MOV,
      'x',
      NOW,
    )
    assert.deepEqual(replaced.unset, ['body[_key=="v"].original'])
    const same = processingOps(
      located({_type: 'video', _key: 'v', file: file(MOV), original: file(MOV)}),
      MOV,
      'x',
      NOW,
    )
    assert.equal(same.unset, undefined)
  })
})

describe('resultOps', () => {
  const block: VideoBlock = {_type: 'video', _key: 'v', file: {...file(MOV), extra: 'kept'}}
  const ready: ConversionResult = {
    status: 'ready',
    fileAssetId: MOV,
    sourceAssetId: MOV,
    outputAssetId: MP4,
    original: 'current-file',
    settingsVersion: SETTINGS_VERSION,
    originalStripped: false,
    message: 'Converted',
  }

  it("ready: file is the MP4, original the block's own file value, conversion complete", () => {
    const doc = {_id: 'd', _type: 'blogPost', body: [block]}
    const after = applyPatch(doc, resultOps(located(block), ready, NOW))
    assert.deepEqual(after.body[0], {
      _type: 'video',
      _key: 'v',
      file: file(MP4),
      original: {...file(MOV), extra: 'kept'},
      conversion: {
        status: 'ready',
        message: 'Converted',
        sourceAssetId: MOV,
        outputAssetId: MP4,
        originalStripped: false,
        settingsVersion: SETTINGS_VERSION,
        updatedAt: NOW.toISOString(),
      },
    })
  })

  it('ready with a stripped original: original is the copy, conversion records the strip version', () => {
    const doc = {_id: 'd', _type: 'blogPost', body: [block]}
    const stripped = 'file-aaaa111111111111111111111111111111111111-mov'
    const result: ConversionResult = {
      ...ready,
      sourceAssetId: stripped,
      original: {assetId: stripped},
      originalStripped: true,
      stripVersion: 'video-strip-v1',
      deleteUpload: MOV,
    }
    const after = applyPatch(doc, resultOps(located(block), result, NOW))
    assert.deepEqual(after.body[0].original, file(stripped))
    assert.deepEqual(after.body[0].conversion, {
      status: 'ready',
      message: 'Converted',
      sourceAssetId: stripped,
      outputAssetId: MP4,
      originalStripped: true,
      stripVersion: 'video-strip-v1',
      settingsVersion: SETTINGS_VERSION,
      updatedAt: NOW.toISOString(),
    })
  })

  it('failed: only conversion changes', () => {
    const failed: ConversionResult = {status: 'failed', fileAssetId: MOV, message: 'bad'}
    assert.deepEqual(resultOps(located(block), failed, NOW), {
      set: {
        'body[_key=="v"].conversion': {
          status: 'failed',
          message: 'bad',
          sourceAssetId: MOV,
          settingsVersion: SETTINGS_VERSION,
          updatedAt: NOW.toISOString(),
        },
      },
    })
  })

  it('ready records the settings version the result names', () => {
    const ops = resultOps(located(block), {...ready, settingsVersion: 'h264-older'}, NOW)
    const conversion = ops.set?.['body[_key=="v"].conversion'] as {settingsVersion?: string}
    assert.equal(conversion.settingsVersion, 'h264-older')
  })

  it('retry: conversion becomes pending with the message, file stays', () => {
    const retry: ConversionResult = {status: 'retry', fileAssetId: MOV, message: 'later'}
    assert.deepEqual(resultOps(located(block), retry, NOW), {
      set: {
        'body[_key=="v"].conversion': {
          status: 'pending',
          message: 'later',
          sourceAssetId: MOV,
          settingsVersion: SETTINGS_VERSION,
          updatedAt: NOW.toISOString(),
        },
      },
    })
  })

  it('restart: file becomes the original, conversion and original are removed', () => {
    const restart: ConversionResult = {
      status: 'restart',
      fileAssetId: MP4,
      originalAssetId: MOV,
      message: 'old settings',
    }
    assert.deepEqual(
      resultOps(located({_type: 'video', _key: 'v', file: file(MP4)}), restart, NOW),
      {
        set: {'body[_key=="v"].file': file(MOV)},
        unset: ['body[_key=="v"].conversion', 'body[_key=="v"].original'],
      },
    )
  })

  it('adopted MP4 without an existing original unsets original', () => {
    const adopted: ConversionResult = {
      ...ready,
      fileAssetId: MP4,
      outputAssetId: MP4,
      original: null,
    }
    const ops = resultOps(located({_type: 'video', _key: 'v', file: file(MP4)}), adopted, NOW)
    assert.deepEqual(ops.unset, ['body[_key=="v"].original'])
  })

  it('documentResultOps gives a failure only to the origin block and waiting blocks', () => {
    const failed: ConversionResult = {status: 'failed', fileAssetId: MOV, message: 'bad'}
    const doc = {
      _id: 'drafts.p',
      _type: 'project',
      body: [
        {_type: 'video', _key: 'origin', file: file(MOV)},
        {
          _type: 'video',
          _key: 'waiting',
          file: file(MOV),
          conversion: {status: 'processing', sourceAssetId: MOV},
        },
        {_type: 'video', _key: 'untouched', file: file(MOV)},
        {_type: 'video', _key: 'other', file: file(MP4), conversion: {outputAssetId: MP4}},
      ],
    }
    const ops = documentResultOps(
      doc,
      failed,
      {documentId: 'drafts.p', field: 'body', key: 'origin'},
      NOW,
    )
    assert.deepEqual(Object.keys(ops?.set ?? {}).sort(), [
      'body[_key=="origin"].conversion',
      'body[_key=="waiting"].conversion',
    ])
    const retryOps = documentResultOps(
      doc,
      {status: 'retry', fileAssetId: MOV, message: 'later'},
      {documentId: 'drafts.p', field: 'body', key: 'origin'},
      NOW,
    )
    assert.deepEqual(Object.keys(retryOps?.set ?? {}).sort(), [
      'body[_key=="origin"].conversion',
      'body[_key=="waiting"].conversion',
    ])
    // Written once: a block already waiting to retry is left alone.
    const retried = applyPatch(doc, retryOps!)
    assert.equal(
      documentResultOps(
        retried,
        {status: 'retry', fileAssetId: MOV, message: 'later'},
        {documentId: 'drafts.p', field: 'body', key: 'origin'},
        NOW,
      ),
      null,
    )
    const readyOps = documentResultOps(
      doc,
      {
        status: 'ready',
        fileAssetId: MOV,
        sourceAssetId: MOV,
        outputAssetId: MP4,
        original: 'current-file',
        settingsVersion: SETTINGS_VERSION,
        originalStripped: false,
        message: '',
      },
      {documentId: 'x', field: 'body', key: 'k'},
      NOW,
    )
    assert.equal(Object.keys(readyOps?.set ?? {}).filter((k) => k.endsWith('.file')).length, 3)
  })

  it('truncates long messages to one line', () => {
    const long = `line one\n${'x'.repeat(2000)}`
    const message = truncateMessage(long)
    assert.equal(message.length, MAX_MESSAGE_LENGTH)
    assert.ok(message.startsWith('line one x'))
    assert.ok(message.endsWith('...'))
  })
})

describe('lease', () => {
  it('lasts as long as a fresh processing status', () => {
    assert.equal(LEASE_SECONDS, STALE_PROCESSING_SECONDS)
    const lease = newLease('run-a', 'drafts.d', NOW)
    assert.equal(Date.parse(lease.expiresAt) - NOW.getTime(), LEASE_SECONDS * 1000)
  })

  it('blocks other runs until it expires, never its own holder', () => {
    const lease = newLease('run-a', 'drafts.d', NOW)
    assert.equal(leaseHeldByOther(lease, 'run-b', NOW), true)
    assert.equal(leaseHeldByOther(lease, 'run-a', NOW), false)
    const after = new Date(NOW.getTime() + LEASE_SECONDS * 1000 + 1)
    assert.equal(leaseHeldByOther(lease, 'run-b', after), false)
  })

  it('ignores missing or malformed leases', () => {
    assert.equal(leaseHeldByOther(undefined, 'run-b', NOW), false)
    assert.equal(leaseHeldByOther({holder: 'run-a'}, 'run-b', NOW), false)
    assert.equal(leaseHeldByOther({holder: 'run-a', expiresAt: 'soon'}, 'run-b', NOW), false)
    assert.equal(leaseHeldByOther('locked', 'run-b', NOW), false)
  })
})
