import assert from 'node:assert/strict'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {after, describe, it} from 'node:test'

import {comparable, countByType, differingFields, digest, extraMetadataKeys, portableTextHashes, type Doc} from '../src/comparison'
import {dataPaths} from '../src/config'
import {transform} from '../src/steps/transform'

describe('comparable', () => {
  const asset = (dataset: string, uploadId: string): Doc => ({
    _id: 'image-abc-10x10-png',
    _type: 'sanity.imageAsset',
    _rev: `rev-${dataset}`,
    _createdAt: '2026-11-25T20:00:00Z',
    _updatedAt: '2026-11-25T20:00:00Z',
    uploadId,
    sha1hash: 'abc',
    path: `images/j3vdh6ti/${dataset}/abc-10x10.png`,
    url: `https://cdn.sanity.io/images/j3vdh6ti/${dataset}/abc-10x10.png`,
    source: {name: 'wagtail', id: 'image:1'},
  })

  it('ignores system fields, the upload id and the dataset name in asset paths', () => {
    assert.deepEqual(comparable(asset('staging', 'u1'), 'staging'), comparable(asset('production', 'u2'), 'production'))
  })

  it('still sees a real asset difference', () => {
    const changed = {...asset('production', 'u2'), source: {name: 'wagtail', id: 'image:2'}}
    assert.deepEqual(differingFields(comparable(asset('staging', 'u1'), 'staging'), comparable(changed, 'production')), ['source'])
  })

  it('keeps uploadId, path and url of content documents', () => {
    const doc: Doc = {_id: 'flexPage-4', _type: 'flexPage', _rev: 'x', url: '/staging/', uploadId: 'u'}
    assert.deepEqual(comparable(doc, 'staging'), {_id: 'flexPage-4', _type: 'flexPage', url: '/staging/', uploadId: 'u'})
  })
})

describe('extraMetadataKeys', () => {
  const base = {_type: 'sanity.imageMetadata', lqip: 'data:x', blurHash: 'b', dimensions: {width: 1, height: 1}}

  it('names keys extracted on one side only when every shared key is equal', () => {
    assert.deepEqual(extraMetadataKeys({...base, thumbHash: 't'}, base), {onlyInA: ['thumbHash'], onlyInB: []})
    assert.deepEqual(extraMetadataKeys(base, {...base, exif: {}}), {onlyInA: [], onlyInB: ['exif']})
  })

  it('returns null for a changed shared key or equal metadata', () => {
    assert.equal(extraMetadataKeys({...base, thumbHash: 't'}, {...base, lqip: 'data:y'}), null)
    assert.equal(extraMetadataKeys(base, {...base}), null)
    assert.equal(extraMetadataKeys(undefined, base), null)
  })
})

describe('portableTextHashes', () => {
  const fields = {blogPost: ['body'], testimonial: ['body']}
  const docs: Doc[] = [
    {_id: 'blogPost-13', _type: 'blogPost', body: [{_type: 'block', _key: 'a', children: []}], title: 'x'},
    {_id: 'testimonial-1', _type: 'testimonial'},
    {_id: 'medium-3d-printing', _type: 'medium', body: [{_type: 'block'}]},
  ]

  it('hashes only the schema fields that are present, independent of key order', () => {
    const hashes = portableTextHashes(docs, fields)
    assert.deepEqual([...hashes.keys()], ['blogPost-13.body'])
    const reordered: Doc[] = [{_type: 'blogPost', _id: 'blogPost-13', body: [{children: [], _key: 'a', _type: 'block'}]}]
    assert.equal(digest(portableTextHashes(reordered, fields)), digest(hashes))
  })

  it('changes when a block changes', () => {
    const changed: Doc[] = [{_id: 'blogPost-13', _type: 'blogPost', body: [{_type: 'block', _key: 'b', children: []}]}]
    assert.notEqual(digest(portableTextHashes(changed, fields)), digest(portableTextHashes(docs, fields)))
  })
})

describe('countByType', () => {
  it('splits published documents, drafts and release versions', () => {
    assert.deepEqual(
      countByType([
        {_id: 'blogPost-1', _type: 'blogPost'},
        {_id: 'drafts.blogPost-1', _type: 'blogPost'},
        {_id: 'versions.r1.blogPost-1', _type: 'blogPost'},
        {_id: 'homePage', _type: 'homePage'},
      ]),
      {blogPost: {published: 1, drafts: 1, versions: 1}, homePage: {published: 1, drafts: 0, versions: 0}},
    )
  })
})

describe('transform', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wagtail-to-sanity-'))
  after(() => rmSync(root, {recursive: true, force: true}))

  it('refuses to write documents before the videos step has uploaded the MP4s of the dataset', async () => {
    const paths = dataPaths(root)
    await assert.rejects(transform(paths, 'production'), /videos-production\.json does not exist; run the convert and videos steps first/)
  })
})
