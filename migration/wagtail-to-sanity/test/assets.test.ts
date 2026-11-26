import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {differingMetadata, findAssetMetadataEdits, type AssetMap, type ExistingAsset, type PlannedAsset} from '../src/steps/assets'

const photo: PlannedAsset = {
  type: 'image',
  sha1: 'aaa',
  paths: ['original_images/photo.jpg'],
  primaryPath: 'original_images/photo.jpg',
  originalFilename: 'photo.jpg',
  title: 'Photo',
  description: 'A photo',
  source: {name: 'wagtail', id: 'image:1', url: 'https://storage.googleapis.com/bucket/original_images/photo.jpg'},
  records: ['image:1'],
}
const manual: PlannedAsset = {
  type: 'file',
  sha1: 'bbb',
  paths: ['documents/manual.pdf'],
  primaryPath: 'documents/manual.pdf',
  originalFilename: 'manual.pdf',
  title: 'Manual',
  source: {name: 'wagtail', id: 'document:2', url: 'https://storage.googleapis.com/bucket/documents/manual.pdf'},
  records: ['document:2'],
}

function stored(asset: PlannedAsset, id: string, changes: Partial<ExistingAsset> = {}): ExistingAsset {
  return {
    _id: id,
    _type: asset.type === 'image' ? 'sanity.imageAsset' : 'sanity.fileAsset',
    sha1hash: asset.sha1,
    title: asset.title,
    ...(asset.description ? {description: asset.description} : {}),
    originalFilename: asset.originalFilename,
    source: {...asset.source},
    ...changes,
  }
}

function byKey(...assets: ExistingAsset[]): Map<string, ExistingAsset> {
  return new Map(assets.map((a) => [`${a._type === 'sanity.imageAsset' ? 'image' : 'file'}:${a.sha1hash}`, a]))
}

/** The map a previous run wrote, holding `assets` as it left them. */
function record(assets: [PlannedAsset, string][]): AssetMap {
  return {
    dataset: 'staging',
    files: {},
    images: {},
    documents: {},
    mediaThumbnails: {},
    assets: Object.fromEntries(assets.map(([asset, assetId]) => [assetId, {...asset, assetId}])),
  }
}

const PHOTO_ID = 'image-aaa-800x600-jpg'
const MANUAL_ID = 'file-bbb-pdf'

describe('differingMetadata', () => {
  it('compares only the fields the step sets, treating missing and null alike', () => {
    assert.deepEqual(differingMetadata(stored(photo, PHOTO_ID), photo), [])
    assert.deepEqual(differingMetadata(stored(manual, MANUAL_ID, {description: null as unknown as undefined}), manual), [])
    assert.deepEqual(
      differingMetadata(stored(photo, PHOTO_ID, {title: 'Renamed', source: {...photo.source, url: 'https://elsewhere'}}), photo),
      ['title', 'source'],
    )
    assert.deepEqual(differingMetadata(stored(photo, PHOTO_ID, {description: undefined}), photo), ['description'])
  })
})

describe('findAssetMetadataEdits', () => {
  const previous = record([
    [photo, PHOTO_ID],
    [manual, MANUAL_ID],
  ])

  it('finds nothing when the dataset holds what the plan sets, or nothing yet', () => {
    assert.deepEqual(findAssetMetadataEdits([photo, manual], byKey(stored(photo, PHOTO_ID), stored(manual, MANUAL_ID)), previous), [])
    assert.deepEqual(findAssetMetadataEdits([photo, manual], byKey(), previous), [])
    assert.deepEqual(findAssetMetadataEdits([photo, manual], byKey(), null), [])
  })

  it('reports metadata that changed since the last run', () => {
    const existing = byKey(stored(photo, PHOTO_ID, {title: 'Edited in the Studio'}), stored(manual, MANUAL_ID, {description: 'Added later'}))
    assert.deepEqual(findAssetMetadataEdits([photo, manual], existing, previous), [
      {assetId: MANUAL_ID, fields: ['description'], reason: 'changed since the last run'},
      {assetId: PHOTO_ID, fields: ['title'], reason: 'changed since the last run'},
    ])
  })

  it('lets the migration update its own metadata when its plan changed', () => {
    const renamed = {...photo, title: 'Photo, renamed in the export'}
    assert.deepEqual(findAssetMetadataEdits([renamed], byKey(stored(photo, PHOTO_ID)), previous), [])
  })

  it('reports an existing asset the last run did not set', () => {
    const onlyManual = record([[manual, MANUAL_ID]])
    assert.deepEqual(findAssetMetadataEdits([photo], byKey(stored(photo, PHOTO_ID, {title: 'Uploaded by an editor'})), onlyManual), [
      {assetId: PHOTO_ID, fields: ['title'], reason: 'not set by this migration'},
    ])
  })

  it('without a record, adopts assets others uploaded but not ones a run of this migration wrote', () => {
    const fromWp2 = stored(photo, PHOTO_ID, {title: undefined, description: undefined, source: undefined, originalFilename: 'upload.jpg'})
    assert.deepEqual(findAssetMetadataEdits([photo], byKey(fromWp2), null), [])
    const fromEarlierRun = stored(manual, MANUAL_ID, {title: 'Edited after a run whose record is lost'})
    assert.deepEqual(findAssetMetadataEdits([manual], byKey(fromEarlierRun), null), [
      {assetId: MANUAL_ID, fields: ['title'], reason: 'set by a run that left no record'},
    ])
  })
})
