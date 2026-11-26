/**
 * The upload-privacy event filter (groq-js in delta mode, with the before and after documents the
 * deployed Function gets) and the sweep query (groq-js over a dataset).
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {evaluate, parse} from 'groq-js'

import {IMAGE_STRIP_VERSION, VIDEO_STRIP_VERSION} from '../../privacy/constants'
import {GRACE_SECONDS, RETRY_DELAY_SECONDS, SWEEP_QUERY, sweepParams, UPLOAD_PRIVACY_FILTER, UPLOAD_PRIVACY_PROJECTION} from '../trigger'

const NOW = new Date('2026-11-27T12:00:00Z')
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString()

async function matches(before: Record<string, unknown> | null, after: Record<string, unknown> | null, dataset = 'staging'): Promise<boolean> {
  const result = await evaluate(parse(UPLOAD_PRIVACY_FILTER, {mode: 'delta'}), {before, after, sanity: {projectId: 'j3vdh6ti', dataset}, timestamp: NOW})
  return (await result.get()) === true
}

const image = (extra: Record<string, unknown> = {}) => ({
  _id: 'image-1111111111111111111111111111111111111111-8x8-jpg',
  _type: 'sanity.imageAsset',
  _createdAt: ago(10),
  ...extra,
})

describe('which events start the Function', () => {
  it('starts for a new upload nobody checked yet', async () => {
    assert.equal(await matches(null, image()), true)
    assert.equal(await matches(null, image({_type: 'sanity.fileAsset', _id: 'file-1111111111111111111111111111111111111111-mov', mimeType: 'video/quicktime'})), true)
    assert.equal(await matches(null, image({source: {name: 'api-client', id: 'x'}})), true)
  })

  it('not for uploads the migration or a Function made, checked ones or old ones', async () => {
    for (const name of ['wagtail', 'image-privacy', 'video-to-mp4-original', 'video-to-mp4']) {
      assert.equal(await matches(null, image({source: {name, id: 'x'}})), false, name)
    }
    assert.equal(await matches(null, image({privacy: {status: 'stripped', version: IMAGE_STRIP_VERSION}})), false)
    assert.equal(await matches(null, image({_createdAt: '2026-11-25T20:00:00Z'})), false)
    assert.equal(await matches(image(), image({title: 'x'})), false, 'an update of the asset')
    assert.equal(await matches(null, image(), 'other'), false, 'another dataset')
  })

  it('starts when a content document, draft or release version is deleted', async () => {
    assert.equal(await matches({_id: 'drafts.blogPost-1', _type: 'blogPost'}, null), true)
    assert.equal(await matches({_id: 'versions.r1.project-1', _type: 'project'}, null), true)
    assert.equal(await matches({_id: 'testimonial-1', _type: 'testimonial'}, null), true)
    assert.equal(await matches(image(), null), false, 'a deleted asset')
    assert.equal(await matches({_id: 'drafts.blogPost-1', _type: 'blogPost'}, {_id: 'drafts.blogPost-1', _type: 'blogPost', title: 'x'}), false, 'an edit')
  })

  it('projects the operation, id and type for create and delete', async () => {
    const tree = parse(UPLOAD_PRIVACY_PROJECTION, {mode: 'delta'})
    const created = await (await evaluate(tree, {before: null, after: image(), timestamp: NOW})).get()
    assert.deepEqual(created, {operation: 'create', id: image()._id, type: 'sanity.imageAsset'})
    const deleted = await (await evaluate(tree, {before: {_id: 'drafts.blogPost-1', _type: 'blogPost'}, after: null, timestamp: NOW})).get()
    assert.deepEqual(deleted, {operation: 'delete', id: 'drafts.blogPost-1', type: 'blogPost'})
  })
})

describe('the sweep', () => {
  it('finds unused uploads that still have their metadata, oldest first', async () => {
    const id = (n: number, ext = 'jpg') => `${ext === 'jpg' ? 'image' : 'file'}-${String(n).repeat(40)}-${ext === 'jpg' ? '8x8-jpg' : ext}`
    const old = GRACE_SECONDS + 30
    const dataset = [
      {_id: id(1), _type: 'sanity.imageAsset', _createdAt: ago(old + 5)},
      {_id: id(2), _type: 'sanity.imageAsset', _createdAt: ago(old), privacy: {status: 'replaced', version: IMAGE_STRIP_VERSION}},
      {_id: id(4, 'mov'), _type: 'sanity.fileAsset', _createdAt: ago(old), mimeType: 'video/quicktime'},
      {_id: id(4), _type: 'sanity.imageAsset', _createdAt: ago(old), privacy: {status: 'pending', version: IMAGE_STRIP_VERSION, updatedAt: ago(RETRY_DELAY_SECONDS + 1)}},
      // Not candidates:
      {_id: id(5), _type: 'sanity.imageAsset', _createdAt: ago(10)},
      {_id: id(6), _type: 'sanity.imageAsset', _createdAt: ago(old), privacy: {status: 'clean', version: IMAGE_STRIP_VERSION}},
      {_id: id(7), _type: 'sanity.imageAsset', _createdAt: ago(old), privacy: {status: 'pending', version: IMAGE_STRIP_VERSION, updatedAt: ago(60)}},
      {_id: id(8, 'pdf'), _type: 'sanity.fileAsset', _createdAt: ago(old), mimeType: 'application/pdf'},
      {_id: id(9), _type: 'sanity.imageAsset', _createdAt: ago(old), source: {name: 'image-privacy', id: 'x'}},
      {_id: id(1, 'mov'), _type: 'sanity.fileAsset', _createdAt: ago(old), mimeType: 'video/quicktime', privacy: {status: 'stripped', version: VIDEO_STRIP_VERSION}},
      {_id: id(2, 'mov'), _type: 'sanity.fileAsset', _createdAt: ago(old), mimeType: 'video/quicktime'},
      {_id: id(3, 'mov'), _type: 'sanity.fileAsset', _createdAt: '2026-11-25T20:00:00Z', mimeType: 'video/quicktime'},
      {_id: 'drafts.blogPost-1', _type: 'blogPost', body: [{_type: 'video', _key: 'v', file: {asset: {_type: 'reference', _ref: id(2, 'mov')}}}]},
    ]
    const result = await evaluate(parse(SWEEP_QUERY), {dataset, params: sweepParams([id(4)]), timestamp: NOW})
    assert.deepEqual(await result.get(), [id(1), id(2), id(4, 'mov')], 'id(4) is the event\'s own upload, excluded')
  })
})
