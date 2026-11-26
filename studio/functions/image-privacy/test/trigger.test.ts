/**
 * The image-privacy event filter (evaluated with groq-js, which follows `asset->` within the test
 * dataset like the deployed filter does) against the TypeScript rule, and the watched fields
 * against the Studio schema.
 */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {IMAGE_STRIP_VERSION} from '../../privacy/constants'
import {
  assetNeedsWork,
  IMAGE_FIELDS_BY_TYPE,
  IMAGE_PRIVACY_FILTER,
  imageAssetIds,
  referencePaths,
  RETRY_DELAY_SECONDS,
  STALE_PROCESSING_SECONDS,
  type ImageAssetDocument,
} from '../trigger'

const NOW = new Date('2026-11-26T12:00:00Z')
const ASSET = 'image-1111111111111111111111111111111111111111-8x8-jpg'
const image = (ref: string, extra: Record<string, unknown> = {}) => ({_type: 'imageWithAlt', asset: {_type: 'reference', _ref: ref}, ...extra})
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()

function asset(privacy?: Record<string, unknown>, createdAt = '2026-11-26T11:00:00Z'): ImageAssetDocument {
  return {_id: ASSET, _type: 'sanity.imageAsset', _rev: 'r', _createdAt: createdAt, ...(privacy ? {privacy} : {})}
}

async function filterMatches(doc: Record<string, unknown>, assets: unknown[], dataset = 'staging'): Promise<boolean> {
  const result = await evaluate(parse(`*[_id == $id && ${IMAGE_PRIVACY_FILTER}]._id`), {
    dataset: [doc, ...assets],
    params: {id: doc._id},
    sanity: {projectId: 'j3vdh6ti', dataset},
    timestamp: NOW,
  })
  return ((await result.get()) as string[]).length === 1
}

const post = (fields: Record<string, unknown>) => ({_id: 'drafts.blogPost-1', _type: 'blogPost', title: 'T', ...fields})

describe('which assets need work', () => {
  const cases: [string, ImageAssetDocument, boolean][] = [
    ['never checked', asset(), true],
    ['clean with the current version', asset({status: 'clean', version: IMAGE_STRIP_VERSION}), false],
    ['stripped with the current version', asset({status: 'stripped', version: IMAGE_STRIP_VERSION}), false],
    ['failed with the current version', asset({status: 'failed', version: IMAGE_STRIP_VERSION}), false],
    ['clean with an older version', asset({status: 'clean', version: 'image-strip-v0'}), true],
    ['replaced (a document still uses the upload)', asset({status: 'replaced', version: IMAGE_STRIP_VERSION}), true],
    ['processing, fresh', asset({status: 'processing', updatedAt: ago(60)}), false],
    ['processing, stale', asset({status: 'processing', updatedAt: ago(STALE_PROCESSING_SECONDS + 1)}), true],
    ['pending, fresh', asset({status: 'pending', updatedAt: ago(60)}), false],
    ['pending, due', asset({status: 'pending', updatedAt: ago(RETRY_DELAY_SECONDS + 1)}), true],
    ['uploaded before UPLOADED_SINCE (the migration privacy step handles it)', asset(undefined, '2026-11-25T20:28:06Z'), false],
  ]
  for (const [name, a, needs] of cases) {
    it(name, async () => {
      assert.equal(assetNeedsWork(a, NOW), needs, 'TypeScript rule')
      assert.equal(await filterMatches(post({contentImage: image(ASSET)}), [a]), needs, 'event filter')
    })
  }

  it('ignores missing assets and file assets', async () => {
    assert.equal(assetNeedsWork(null, NOW), false)
    assert.equal(await filterMatches(post({contentImage: image(ASSET)}), []), false)
    const fileAsset = {_id: 'file-1-mov', _type: 'sanity.fileAsset'}
    assert.equal(await filterMatches(post({contentImage: image('file-1-mov')}), [fileAsset]), false)
  })
})

describe('event filter scope', () => {
  it('watches exactly the image-bearing fields of the Studio schema (schema.json)', () => {
    const schema = JSON.parse(readFileSync(new URL('../../../schema.json', import.meta.url), 'utf8')) as {
      name: string
      type: string
      attributes?: Record<string, {value?: unknown}>
    }[]
    const fromSchema: Record<string, string[]> = {}
    for (const type of schema) {
      if (type.type !== 'document') continue
      for (const [field, attribute] of Object.entries(type.attributes ?? {})) {
        const text = JSON.stringify(attribute.value)
        if (/sanity\.imageAsset\.reference|"imageWithAlt"|"imageBlock"|"blockContent"/.test(text)) {
          fromSchema[type.name] = [...(fromSchema[type.name] ?? []), field].sort()
        }
      }
    }
    const watched = Object.fromEntries(Object.entries(IMAGE_FIELDS_BY_TYPE).map(([t, f]) => [t, [...f].sort()]))
    assert.deepEqual(watched, fromSchema)
  })

  it('matches an unchecked image in every watched field', async () => {
    for (const [type, fields] of Object.entries(IMAGE_FIELDS_BY_TYPE)) {
      for (const field of fields as readonly string[]) {
        const value = ['heroMedia', 'body', 'bio', 'description'].includes(field)
          ? [{_type: 'block', _key: 't', children: []}, {...image(ASSET), _type: field === 'heroMedia' ? 'imageWithAlt' : 'imageBlock', _key: 'i'}]
          : image(ASSET)
        const doc = {_id: `drafts.${type}-x`, _type: type, [field]: value}
        assert.equal(await filterMatches(doc, [asset()]), true, `${type}.${field}`)
        assert.deepEqual(imageAssetIds(doc), [ASSET], `${type}.${field}`)
      }
    }
  })

  it('ignores other types, other datasets and documents without images', async () => {
    assert.equal(await filterMatches({_id: 'm', _type: 'medium', image: image(ASSET)}, [asset()]), false)
    assert.equal(await filterMatches(post({contentImage: image(ASSET)}), [asset()], 'other'), false)
    assert.equal(await filterMatches(post({heroMedia: [{_type: 'youtube', _key: 'y', url: 'x'}]}), []), false)
  })
})

describe('referencePaths', () => {
  it('finds every reference, by _key in arrays, without touching crop, hotspot or alt', () => {
    const doc = {
      _id: 'drafts.project-1',
      _type: 'project',
      contentImage: image(ASSET, {crop: {top: 0.1}, hotspot: {x: 0.5}, alt: 'a'}),
      heroMedia: [image(ASSET, {_key: 'h1'}), {_type: 'youtube', _key: 'y'}],
      body: [{_type: 'imageBlock', _key: 'b"1', asset: {_type: 'reference', _ref: ASSET}, layout: 'left'}],
      seo: {og: [image(ASSET)]},
      other: image('image-2-8x8-png'),
    }
    assert.deepEqual(referencePaths(doc, ASSET), [
      'contentImage.asset._ref',
      'heroMedia[_key=="h1"].asset._ref',
      'body[_key=="b\\"1"].asset._ref',
      'seo.og[0].asset._ref',
    ])
  })
})

describe('rawImageUrl', () => {
  it('asks the image CDN for the stored file, not its re-encoded rendition', async () => {
    const {rawImageUrl} = await import('../sanity')
    assert.equal(
      rawImageUrl('https://cdn.sanity.io/images/p/staging/abc-8x8.jpg'),
      'https://cdn.sanity.io/images/p/staging/abc-8x8.jpg?dlRaw=',
    )
  })
})
