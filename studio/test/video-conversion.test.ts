/**
 * The video block's conversion state (schemaTypes/shared/video-conversion.ts): the contract's
 * "needs conversion" rule and the status line the Studio preview shows.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {SETTINGS_VERSION} from '../functions/video-to-mp4/settings'
import {
  RETRY_DELAY_SECONDS as FUNCTION_RETRY_DELAY_SECONDS,
  STALE_PROCESSING_SECONDS as FUNCTION_STALE_PROCESSING_SECONDS,
  VIDEO_TO_MP4_FILTER,
  isFailedForCurrentFile,
  isPendingVideo,
} from '../functions/video-to-mp4/trigger'
import {
  RETRY_DELAY_SECONDS,
  STALE_PROCESSING_SECONDS,
  nudgedConversion,
  videoConversionLabel,
  videoConversionNudge,
  videoConversionState,
  videoNeedsConversion,
  videoOriginalState,
  videoPreviewSubtitle,
  type VideoValue,
} from '../schemaTypes/shared/video-conversion'

const ORIGINAL = 'file-1111111111111111111111111111111111111111-mov'
const MP4 = 'file-2222222222222222222222222222222222222222-mp4'
const REPLACEMENT = 'file-3333333333333333333333333333333333333333-webm'
/** A settings version other than the current one, as after a SETTINGS_VERSION bump. */
const OLD_SETTINGS = 'h264-crf23-max1920-v1'

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
    videoConversionLabel(videoConversionState(fileAssetId, conversion, SETTINGS_VERSION))

  it('shows that there is no file', () => {
    assert.equal(label(undefined), 'No video file')
  })

  it("shows why the Function took an upload out of the block (its location data could not be removed)", () => {
    const message = 'The video is too large. The upload was removed from this block and deleted: a file whose location data cannot be removed is not kept in the public dataset. Upload another file.'
    const state = videoConversionState(undefined, {status: 'failed', message, settingsVersion: SETTINGS_VERSION}, SETTINGS_VERSION)
    assert.deepEqual(state, {kind: 'removed', message})
    assert.equal(videoConversionLabel(state), `Upload removed: ${message}`)
    assert.equal(videoNeedsConversion({conversion: {status: 'failed', message}}), false, 'nothing to convert, so no nudge and no run')
    // A failure the editor cleared by removing the file still names that file: just empty.
    assert.deepEqual(videoConversionState(undefined, {status: 'failed', message: 'bad', sourceAssetId: 'file-x-mov'}, SETTINGS_VERSION), {kind: 'empty'})
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

  it('shows the failure message for the current file and settings', () => {
    assert.equal(
      label(ORIGINAL, {
        status: 'failed',
        sourceAssetId: ORIGINAL,
        settingsVersion: SETTINGS_VERSION,
        message: 'ffmpeg exited with code 1',
      }),
      'Conversion failed: ffmpeg exited with code 1',
    )
    assert.equal(
      label(ORIGINAL, {
        status: 'failed',
        sourceAssetId: ORIGINAL,
        settingsVersion: SETTINGS_VERSION,
        message: '  ',
      }),
      'Conversion failed: no error message was recorded',
    )
  })

  it('shows a failure under other settings as waiting, because the Function converts it again', () => {
    assert.equal(
      label(ORIGINAL, {
        status: 'failed',
        sourceAssetId: ORIGINAL,
        settingsVersion: OLD_SETTINGS,
        message: 'ffmpeg exited with code 1',
      }),
      `Waiting to retry the conversion: it failed with older settings (${OLD_SETTINGS}) and is converted again with the current settings. The last error: ffmpeg exited with code 1`,
    )
    assert.equal(
      label(ORIGINAL, {status: 'failed', sourceAssetId: ORIGINAL, message: 'x'}),
      'Waiting to retry the conversion: it failed with older settings (no settings version was recorded) and is converted again with the current settings. The last error: x',
    )
  })

  it("counts a failure as final exactly when the Function's rule does", () => {
    for (const settingsVersion of [SETTINGS_VERSION, OLD_SETTINGS, undefined]) {
      for (const sourceAssetId of [ORIGINAL, REPLACEMENT]) {
        const conversion = {status: 'failed', sourceAssetId, settingsVersion, message: 'x'}
        const block = {_type: 'video' as const, _key: 'v', file: file(ORIGINAL), conversion}
        assert.equal(
          videoConversionState(ORIGINAL, conversion, SETTINGS_VERSION).kind === 'failed',
          isFailedForCurrentFile(block),
          JSON.stringify(conversion),
        )
      }
    }
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
        videoConversionState(
          ORIGINAL,
          {
            status: 'pending',
            sourceAssetId: ORIGINAL,
            message: 'Could not convert yet: the download failed.',
          },
          SETTINGS_VERSION,
        ),
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
      name: 'failed with the current settings',
      block: {
        file: file(ORIGINAL),
        conversion: {
          status: 'failed',
          sourceAssetId: ORIGINAL,
          settingsVersion: SETTINGS_VERSION,
          updatedAt: LONG_AGO,
          message: 'x',
        },
      },
      updatedAt: LONG_AGO,
      reason: null,
    },
    {
      name: 'failed with older settings, long ago',
      block: {
        file: file(ORIGINAL),
        conversion: {
          status: 'failed',
          sourceAssetId: ORIGINAL,
          settingsVersion: OLD_SETTINGS,
          updatedAt: ago(RETRY_DELAY_SECONDS + 5),
          message: 'x',
        },
      },
      updatedAt: LONG_AGO,
      reason: 'settings-changed',
    },
    {
      name: 'failed with older settings, nudged less than the retry delay ago',
      block: {
        file: file(ORIGINAL),
        conversion: {
          status: 'failed',
          sourceAssetId: ORIGINAL,
          settingsVersion: OLD_SETTINGS,
          updatedAt: ago(RETRY_DELAY_SECONDS - 5),
          message: 'x',
        },
      },
      updatedAt: LONG_AGO,
      reason: null,
    },
    {
      name: 'failed without a settings version',
      block: {
        file: file(ORIGINAL),
        conversion: {status: 'failed', sourceAssetId: ORIGINAL, message: 'x'},
      },
      updatedAt: LONG_AGO,
      reason: 'settings-changed',
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
      const found = videoConversionNudge(block, updatedAt, NOW, SETTINGS_VERSION)
      assert.equal(found, reason)
      if (!found) return
      // The nudge is an event the Function's filter matches, so the conversion starts again.
      const nudged = {...block, conversion: nudgedConversion(block, found, NOW)}
      if (found === 'settings-changed') {
        // Only the time moves: the Function decides with its own settings version.
        assert.deepEqual(nudged.conversion, {...block.conversion, updatedAt: NOW.toISOString()})
      } else {
        assert.equal(nudged.conversion.status, 'pending')
      }
      assert.equal(nudged.conversion.sourceAssetId, block.file?.asset?._ref)
      assert.equal(await functionFilterMatches(nudged), true)
      // The handler applies the same rule in code.
      const handlerBlock = {
        _type: 'video' as const,
        _key: 'v',
        file: nudged.file && {...nudged.file},
        conversion: nudged.conversion,
      }
      assert.equal(isPendingVideo(handlerBlock, NOW), true)
      // Right after the nudge the block is not nudged again (a second tab, or the next check
      // before the Function has marked it processing, waits for RETRY_DELAY_SECONDS).
      if (found === 'settings-changed') {
        assert.equal(videoConversionNudge(nudged, NOW.toISOString(), NOW, SETTINGS_VERSION), null)
      }
    })
  }

  it('does not convert again a failure that the Function made with its own settings', async () => {
    // While the Studio is deployed with newer settings than the Function, the Studio sees the
    // Function's failure as older settings and nudges it; the Function's filter still skips it,
    // so it is not converted again with the settings it failed with.
    const failedByFunction: VideoValue = {
      file: file(ORIGINAL),
      conversion: {
        status: 'failed',
        sourceAssetId: ORIGINAL,
        settingsVersion: SETTINGS_VERSION,
        updatedAt: LONG_AGO,
        message: 'x',
      },
    }
    const studioSettings = 'h264-crf23-max1920-v99'
    const found = videoConversionNudge(failedByFunction, LONG_AGO, NOW, studioSettings)
    assert.equal(found, 'settings-changed')
    const nudged = {...failedByFunction, conversion: nudgedConversion(failedByFunction, found, NOW)}
    assert.equal(await functionFilterMatches(nudged), false)
  })
})

describe('videoOriginalState and videoPreviewSubtitle', () => {
  it('says whether a ready block keeps its original without location data', () => {
    const ready = {status: 'ready', sourceAssetId: ORIGINAL, outputAssetId: MP4}
    assert.equal(videoOriginalState({...ready, originalStripped: true}, ORIGINAL), 'stripped')
    assert.equal(videoOriginalState(ready, ORIGINAL), 'unstripped')
    assert.equal(videoOriginalState(ready, undefined), 'none')
    // A copy the migration's privacy step made: marked on its asset.
    assert.equal(videoOriginalState(ready, ORIGINAL, 'stripped'), 'stripped')
    assert.equal(videoPreviewSubtitle({kind: 'ready'}, 'stripped'), 'Ready. Original kept without location data')
    assert.equal(videoPreviewSubtitle({kind: 'ready'}, 'unstripped'), 'Ready. The original upload still has its metadata')
    assert.equal(videoPreviewSubtitle({kind: 'ready'}, 'none'), 'Ready')
    assert.equal(videoPreviewSubtitle({kind: 'converting'}, 'stripped'), 'Converting to MP4...')
  })
})
