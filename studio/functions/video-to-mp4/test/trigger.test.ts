/**
 * The event filter (evaluated with groq-js, the GROQ implementation the Functions tooling uses)
 * and the TypeScript rule in trigger.ts must agree on every case, must agree with the Studio's
 * videoNeedsConversion, and every patch the Function writes must stop the filter from matching
 * (no loops).
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {videoNeedsConversion} from '../../../schemaTypes/shared/video-conversion'
import {processingOps, resultOps, type ConversionResult} from '../patches'
import {SETTINGS_VERSION} from '../settings'
import {
  findPendingVideos,
  isPendingVideo,
  needsConversion,
  nextPendingVideo,
  PENDING_VIDEO_PREDICATE,
  STALE_PROCESSING_SECONDS,
  VIDEO_FIELDS_BY_TYPE,
  VIDEO_TO_MP4_FILTER,
  VIDEO_TO_MP4_PROJECTION,
  videoBlocks,
  type VideoBlock,
} from '../trigger'
import {applyPatch} from './memory-store'

const NOW = new Date('2026-11-26T12:00:00.000Z')
const MOV = 'file-1111111111111111111111111111111111111111-mov'
const MP4 = 'file-2222222222222222222222222222222222222222-mp4'
const WEBM = 'file-3333333333333333333333333333333333333333-webm'

type Doc = Record<string, unknown> & {_id: string; _type: string}

const file = (ref: string) => ({_type: 'file', asset: {_type: 'reference', _ref: ref}})
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()
const video = (key: string, fields: Partial<VideoBlock> = {}): VideoBlock => ({
  _type: 'video',
  _key: key,
  ...fields,
})
const textBlock = (key: string) => ({
  _type: 'block',
  _key: key,
  children: [{_type: 'span', _key: `${key}s`, text: 'Hello', marks: []}],
  markDefs: [],
  style: 'normal',
})
const post = (body: unknown[], id = 'drafts.blogPost-1', type = 'blogPost'): Doc => ({
  _id: id,
  _type: type,
  body,
})

async function filterMatches(doc: Doc, dataset = 'staging', now = NOW): Promise<boolean> {
  const tree = parse(`*[${VIDEO_TO_MP4_FILTER}]._id`)
  const result = await (
    await evaluate(tree, {dataset: [doc], sanity: {projectId: 'j3vdh6ti', dataset}, timestamp: now})
  ).get()
  return (result as string[]).includes(doc._id)
}

async function groqPendingKeys(blocks: unknown[], now = NOW): Promise<string[]> {
  const tree = parse(`$blocks[${PENDING_VIDEO_PREDICATE}]._key`)
  return (await (await evaluate(tree, {params: {blocks}, timestamp: now})).get()) as string[]
}

const blockCases: {name: string; block: VideoBlock; pending: boolean; needs: boolean}[] = [
  {name: 'no file yet', block: video('a'), pending: false, needs: false},
  {
    name: 'upload in progress (Studio placeholder, no asset)',
    block: video('a', {file: {_type: 'file', _upload: {progress: 40}}}),
    pending: false,
    needs: false,
  },
  {
    name: 'new upload, no conversion',
    block: video('a', {file: file(MOV)}),
    pending: true,
    needs: true,
  },
  {
    name: 'status pending',
    block: video('a', {file: file(MOV), conversion: {status: 'pending'}}),
    pending: true,
    needs: true,
  },
  {
    name: 'converted',
    block: video('a', {
      file: file(MP4),
      original: file(MOV),
      conversion: {
        status: 'ready',
        sourceAssetId: MOV,
        outputAssetId: MP4,
        settingsVersion: SETTINGS_VERSION,
      },
    }),
    pending: false,
    needs: false,
  },
  {
    name: 'converted, then the editor replaced the file',
    block: video('a', {
      file: file(WEBM),
      original: file(MOV),
      conversion: {status: 'ready', sourceAssetId: MOV, outputAssetId: MP4},
    }),
    pending: true,
    needs: true,
  },
  {
    name: 'fresh processing of the current file',
    block: video('a', {
      file: file(MOV),
      conversion: {status: 'processing', sourceAssetId: MOV, updatedAt: ago(30)},
    }),
    pending: false,
    needs: true,
  },
  {
    name: 'processing just inside the stale limit',
    block: video('a', {
      file: file(MOV),
      conversion: {
        status: 'processing',
        sourceAssetId: MOV,
        updatedAt: ago(STALE_PROCESSING_SECONDS - 1),
      },
    }),
    pending: false,
    needs: true,
  },
  {
    name: 'stale processing (older than timeout + 5 min)',
    block: video('a', {
      file: file(MOV),
      conversion: {
        status: 'processing',
        sourceAssetId: MOV,
        updatedAt: ago(STALE_PROCESSING_SECONDS + 1),
      },
    }),
    pending: true,
    needs: true,
  },
  {
    name: 'processing without updatedAt',
    block: video('a', {file: file(MOV), conversion: {status: 'processing', sourceAssetId: MOV}}),
    pending: true,
    needs: true,
  },
  {
    name: 'processing with an unreadable updatedAt',
    block: video('a', {
      file: file(MOV),
      conversion: {status: 'processing', sourceAssetId: MOV, updatedAt: 'yesterday'},
    }),
    pending: true,
    needs: true,
  },
  {
    name: 'processing of an earlier file (replaced mid-conversion)',
    block: video('a', {
      file: file(WEBM),
      conversion: {status: 'processing', sourceAssetId: MOV, updatedAt: ago(10)},
    }),
    pending: true,
    needs: true,
  },
  {
    name: 'failed for the current file with the current settings',
    block: video('a', {
      file: file(MOV),
      conversion: {
        status: 'failed',
        sourceAssetId: MOV,
        settingsVersion: SETTINGS_VERSION,
        message: 'x',
      },
    }),
    pending: false,
    needs: true,
  },
  {
    name: 'failed with older settings (retried once with the new ones)',
    block: video('a', {
      file: file(MOV),
      conversion: {status: 'failed', sourceAssetId: MOV, settingsVersion: 'h264-old', message: 'x'},
    }),
    pending: true,
    needs: true,
  },
  {
    name: 'failed for an earlier file',
    block: video('a', {
      file: file(WEBM),
      conversion: {status: 'failed', sourceAssetId: MOV, settingsVersion: SETTINGS_VERSION},
    }),
    pending: true,
    needs: true,
  },
]

describe('pending video rule', () => {
  for (const {name, block, pending, needs} of blockCases) {
    it(`${name}: pending ${pending}`, async () => {
      assert.equal(isPendingVideo(block, NOW), pending, 'TypeScript rule')
      assert.deepEqual(await groqPendingKeys([block]), pending ? ['a'] : [], 'GROQ predicate')
      assert.equal(await filterMatches(post([block])), pending, 'event filter')
      assert.equal(needsConversion(block), needs, 'needsConversion')
      assert.equal(videoNeedsConversion(block as never), needs, 'Studio videoNeedsConversion')
    })
  }
})

describe('event filter scope', () => {
  const pendingBlock = video('v', {file: file(MOV)})

  it('matches every rich-text field that offers the video block', async () => {
    for (const [type, fields] of Object.entries(VIDEO_FIELDS_BY_TYPE)) {
      for (const field of fields) {
        const doc: Doc = {
          _id: `drafts.${type}-x`,
          _type: type,
          [field]: [textBlock('t'), pendingBlock],
        }
        assert.equal(await filterMatches(doc), true, `${type}.${field}`)
        assert.equal(nextPendingVideo(doc, NOW)?.field, field)
      }
    }
  })

  it('ignores other fields, other types and other datasets', async () => {
    assert.equal(await filterMatches({_id: 'p', _type: 'project', bio: [pendingBlock]}), false)
    assert.equal(await filterMatches({_id: 's', _type: 'service', body: [pendingBlock]}), false)
    assert.equal(await filterMatches({_id: 'm', _type: 'medium', body: [pendingBlock]}), false)
    assert.equal(await filterMatches(post([pendingBlock]), 'production'), true)
    assert.equal(await filterMatches(post([pendingBlock]), 'scratch'), false)
    assert.deepEqual(videoBlocks({_id: 'm', _type: 'medium', body: [pendingBlock]}), [])
  })

  it('ignores documents without video blocks or with a non-array body', async () => {
    assert.equal(await filterMatches(post([textBlock('t')])), false)
    assert.equal(await filterMatches({_id: 'x', _type: 'blogPost', body: 'not an array'}), false)
    assert.equal(await filterMatches({_id: 'x', _type: 'blogPost'}), false)
  })

  it('picks the first pending block in document order, one per run', () => {
    const doc = post([
      video('done', {
        file: file(MP4),
        conversion: {status: 'ready', sourceAssetId: MOV, outputAssetId: MP4},
      }),
      textBlock('t'),
      video('second', {file: file(WEBM)}),
      video('third', {file: file(MOV)}),
    ])
    assert.deepEqual(
      findPendingVideos(doc, NOW).map((v) => v.key),
      ['second', 'third'],
    )
    assert.equal(nextPendingVideo(doc, NOW)?.key, 'second')
  })

  it('projects only the ids the handler needs', async () => {
    const doc = {...post([pendingBlock]), _rev: 'r1', title: 'x'}
    const tree = parse(`*[_id == $id][0]${VIDEO_TO_MP4_PROJECTION}`)
    const data = await (await evaluate(tree, {dataset: [doc], params: {id: doc._id}})).get()
    assert.deepEqual(data, {_id: doc._id, _type: 'blogPost', _rev: 'r1'})
  })
})

describe("no loops: the Function's own patches stop the filter", () => {
  const location = {field: 'body', key: 'v'}
  const start = post([video('v', {file: file(MOV)})])

  it('after the processing mark', async () => {
    const ops = processingOps(
      {...location, block: video('v', {file: file(MOV)})},
      MOV,
      'Converting',
      NOW,
    )
    const marked = applyPatch(start, ops)
    assert.equal(await filterMatches(marked), false)
    // ... until the mark is stale.
    const later = new Date(NOW.getTime() + (STALE_PROCESSING_SECONDS + 1) * 1000)
    assert.equal(await filterMatches(marked, 'staging', later), true)
  })

  it('after ready and after failed', async () => {
    const ready: ConversionResult = {
      status: 'ready',
      fileAssetId: MOV,
      sourceAssetId: MOV,
      outputAssetId: MP4,
      original: 'current-file',
      message: 'ok',
    }
    const failed: ConversionResult = {status: 'failed', fileAssetId: MOV, message: 'broken'}
    const block = video('v', {file: file(MOV)})
    const converted = applyPatch(start, resultOps({...location, block}, ready, NOW))
    const broken = applyPatch(start, resultOps({...location, block}, failed, NOW))
    assert.equal(await filterMatches(converted), false)
    assert.equal(await filterMatches(broken), false)
    // Much later edits do not retry a failure either.
    const nextYear = new Date(NOW.getTime() + 365 * 24 * 3600 * 1000)
    assert.equal(await filterMatches(broken, 'staging', nextYear), false)
    assert.equal(videoNeedsConversion((converted.body as VideoBlock[])[0] as never), false)
  })
})
