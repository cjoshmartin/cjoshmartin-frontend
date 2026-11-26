/**
 * The video block's conversion state (schemaTypes/shared/video-conversion.ts): the contract's
 * "needs conversion" rule and the status line the Studio preview shows.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {
  RETRY_DELAY_SECONDS as FUNCTION_RETRY_DELAY_SECONDS,
  STALE_PROCESSING_SECONDS as FUNCTION_STALE_PROCESSING_SECONDS,
  VIDEO_TO_MP4_FILTER,
} from '../functions/video-to-mp4/trigger'
import {
  RETRY_DELAY_SECONDS,
  STALE_PROCESSING_SECONDS,
  nudgedConversion,
  videoConversionLabel,
  videoConversionNudge,
  videoConversionState,
  videoNeedsConversion,
  type VideoValue,
} from '../schemaTypes/shared/video-conversion'

const ORIGINAL = 'file-1111111111111111111111111111111111111111-mov'
const MP4 = 'file-2222222222222222222222222222222222222222-mp4'
const REPLACEMENT = 'file-3333333333333333333333333333333333333333-webm'

const file = (ref: string) => ({_type: 'file', asset: {_type: 'reference', _ref: ref}})

describe('the module itself', () => {
  it('has only type imports, so Node can load it with its own type stripping (migration/verify)', () => {
    const source = readFileSync(
      new URL('../schemaTypes/shared/video-conversion.ts', import.meta.url),
      'utf8',
    )
    const imports = source.split('\n').filter((line) => /^import\b/.test(line))
    assert.ok(imports.length > 0)
    for (const line of imports) assert.match(line, /^import type /, line)
  })

  it("uses the Function's timing", () => {
    assert.equal(STALE_PROCESSING_SECONDS, FUNCTION_STALE_PROCESSING_SECONDS)
    assert.equal(RETRY_DELAY_SECONDS, FUNCTION_RETRY_DELAY_SECONDS)
  })
})

describe('videoNeedsConversion', () => {
  it('is false without a file', () => {
    assert.equal(videoNeedsConversion(undefined), false)
    assert.equal(videoNeedsConversion({}), false)
    assert.equal(videoNeedsConversion({file: {}}), false)
  })

  it('is true for a new upload that has not been converted', () => {
    assert.equal(videoNeedsConversion({file: file(ORIGINAL)}), true)
    assert.equal(
      videoNeedsConversion({
        file: file(ORIGINAL),
        conversion: {status: 'processing', sourceAssetId: ORIGINAL},
      }),
      true,
    )
  })

  it('is false once file points at the converted MP4', () => {
    const converted: VideoValue = {
      file: file(MP4),
      original: file(ORIGINAL),
      conversion: {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4},
    }
    assert.equal(videoNeedsConversion(converted), false)
  })

  it('is true again when the editor replaces a converted video', () => {
    assert.equal(
      videoNeedsConversion({
        file: file(REPLACEMENT),
        original: file(ORIGINAL),
        conversion: {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4},
      }),
      true,
    )
  })
})

describe('videoConversionState and videoConversionLabel', () => {
  const label = (fileAssetId: string | undefined, conversion?: VideoValue['conversion']) =>
    videoConversionLabel(videoConversionState(fileAssetId, conversion))

  it('shows that there is no file', () => {
    assert.equal(label(undefined), 'No video file')
  })

  it('shows "Converting to MP4..." while the file waits for or is in conversion', () => {
    assert.equal(label(ORIGINAL), 'Converting to MP4...')
    assert.equal(
      label(ORIGINAL, {status: 'pending', sourceAssetId: ORIGINAL}),
      'Converting to MP4...',
    )
    assert.equal(
      label(ORIGINAL, {status: 'processing', sourceAssetId: ORIGINAL}),
      'Converting to MP4...',
    )
  })

  it('shows "Ready" when file is the converted MP4', () => {
    assert.equal(
      label(MP4, {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4}),
      'Ready',
    )
  })

  it('shows the failure message for the current file', () => {
    assert.equal(
      label(ORIGINAL, {
        status: 'failed',
        sourceAssetId: ORIGINAL,
        message: 'ffmpeg exited with code 1',
      }),
      'Conversion failed: ffmpeg exited with code 1',
    )
    assert.equal(
      label(ORIGINAL, {status: 'failed', sourceAssetId: ORIGINAL, message: '  '}),
      'Conversion failed: no error message was recorded',
    )
  })

  it('ignores a failure or a ready MP4 that belongs to a file the editor has since replaced', () => {
    assert.equal(
      label(REPLACEMENT, {status: 'failed', sourceAssetId: ORIGINAL, message: 'old error'}),
      'Converting to MP4...',
    )
    assert.equal(
      label(REPLACEMENT, {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4}),
      'Converting to MP4...',
    )
  })
})

describe('waiting to retry', () => {
  it('shows the retry message of a pending conversion of the current file', () => {
    assert.equal(
      videoConversionLabel(
        videoConversionState(ORIGINAL, {
          status: 'pending',
          sourceAssetId: ORIGINAL,
          message: 'Could not convert yet: the download failed.',
        }),
      ),
      'Waiting to retry the conversion: Could not convert yet: the download failed.',
    )
  })
})

describe('videoConversionNudge and nudgedConversion', () => {
  const NOW = new Date('2026-11-26T12:00:00.000Z')
  const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()
  const RECENT = ago(60)
  const LONG_AGO = ago(STALE_PROCESSING_SECONDS + 60)

  async function functionFilterMatches(block: VideoValue): Promise<boolean> {
    const doc = {
      _id: 'drafts.blogPost-1',
      _type: 'blogPost',
      body: [{_type: 'video', _key: 'v', ...block}],
    }
    const result = await (
      await evaluate(parse(`*[${VIDEO_TO_MP4_FILTER}]._id`), {
        dataset: [doc],
        sanity: {projectId: 'j3vdh6ti', dataset: 'staging'},
        timestamp: NOW,
      })
    ).get()
    return (result as string[]).length === 1
  }

  const cases: {name: string; block: VideoValue; updatedAt: string; reason: string | null}[] = [
    {
      name: 'converted',
      block: {
        file: file(MP4),
        conversion: {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4},
      },
      updatedAt: LONG_AGO,
      reason: null,
    },
    {
      name: 'processing, fresh',
      block: {
        file: file(ORIGINAL),
        conversion: {status: 'processing', sourceAssetId: ORIGINAL, updatedAt: ago(60)},
      },
      updatedAt: LONG_AGO,
      reason: null,
    },
    {
      name: 'processing, dead run',
      block: {
        file: file(ORIGINAL),
        conversion: {
          status: 'processing',
          sourceAssetId: ORIGINAL,
          updatedAt: ago(STALE_PROCESSING_SECONDS + 1),
        },
      },
      updatedAt: LONG_AGO,
      reason: 'stale-processing',
    },
    {
      name: 'pending retry, not due',
      block: {
        file: file(ORIGINAL),
        conversion: {
          status: 'pending',
          sourceAssetId: ORIGINAL,
          updatedAt: ago(RETRY_DELAY_SECONDS - 5),
          message: 'x',
        },
      },
      updatedAt: LONG_AGO,
      reason: null,
    },
    {
      name: 'pending retry, due',
      block: {
        file: file(ORIGINAL),
        conversion: {
          status: 'pending',
          sourceAssetId: ORIGINAL,
          updatedAt: ago(RETRY_DELAY_SECONDS + 5),
          message: 'x',
        },
      },
      updatedAt: LONG_AGO,
      reason: 'retry-due',
    },
    {
      name: 'failed',
      block: {
        file: file(ORIGINAL),
        conversion: {status: 'failed', sourceAssetId: ORIGINAL, updatedAt: LONG_AGO, message: 'x'},
      },
      updatedAt: LONG_AGO,
      reason: null,
    },
    {
      name: 'new upload, just saved',
      block: {file: file(ORIGINAL)},
      updatedAt: RECENT,
      reason: null,
    },
    {
      name: 'new upload, never started',
      block: {file: file(ORIGINAL)},
      updatedAt: LONG_AGO,
      reason: 'never-started',
    },
    {
      name: 'replaced file, never started',
      block: {
        file: file(REPLACEMENT),
        conversion: {status: 'processing', sourceAssetId: ORIGINAL, updatedAt: ago(30)},
      },
      updatedAt: LONG_AGO,
      reason: 'never-started',
    },
  ]

  for (const {name, block, updatedAt, reason} of cases) {
    it(`${name}: ${reason ?? 'no nudge'}`, async () => {
      const found = videoConversionNudge(block, updatedAt, NOW)
      assert.equal(found, reason)
      if (!found) return
      // The nudge is an event the Function's filter matches, so the conversion starts again.
      const nudged = {...block, conversion: nudgedConversion(block, found, NOW)}
      assert.equal(nudged.conversion.status, 'pending')
      assert.equal(nudged.conversion.sourceAssetId, block.file?.asset?._ref)
      assert.equal(await functionFilterMatches(nudged), true)
    })
  }
})
