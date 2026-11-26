import assert from 'node:assert/strict'
import {test} from 'node:test'

import {
  assetIdsInText,
  differingFields,
  exportFileName,
  exportPointer,
  isAssetId,
  prefix,
  summarize,
  unrewriteAssets,
  without,
  type SanityDoc,
} from '../src/recreate-lib'

// Fake ids: the sha1s below are not the hash of any real file.
const IMAGE = `image-${'a'.repeat(40)}-1200x800-jpg`
const FILE = `file-${'b'.repeat(40)}-mov`

const MP4 = `file-${'d'.repeat(40)}-mp4`

test('exportFileName follows @sanity/export generateFilename, including its .bin for digits', () => {
  assert.deepEqual(exportFileName(IMAGE), {folder: 'images', name: `${'a'.repeat(40)}-1200x800.jpg`})
  assert.deepEqual(exportFileName(FILE), {folder: 'files', name: `${'b'.repeat(40)}.mov`})
  assert.deepEqual(exportFileName(MP4), {folder: 'files', name: `${'d'.repeat(40)}-mp4.bin`})
  assert.throws(() => exportFileName('homePage'))
  assert.equal(exportPointer(MP4), `file@file://./files/${'d'.repeat(40)}-mp4.bin`)
})

test('unrewriteAssets writes the asset references back, nested and in arrays', () => {
  const pointers = new Map([IMAGE, FILE, MP4].map((id) => [exportPointer(id), id]))
  const exported = {
    _id: 'blogPost-1',
    _type: 'blogPost',
    contentImage: {_type: 'image', _sanityAsset: `image@file://./images/${'a'.repeat(40)}-1200x800.jpg`, alt: 'x', crop: {top: 0}},
    body: [
      {_key: 'k1', _type: 'video', file: {_type: 'file', _sanityAsset: `file@file://./files/${'d'.repeat(40)}-mp4.bin`}, original: {_type: 'file', _sanityAsset: `file@file://./files/${'b'.repeat(40)}.mov`}, conversion: {sourceAssetId: FILE}},
      {_key: 'k2', _type: 'block', children: []},
    ],
  }
  assert.deepEqual(unrewriteAssets(exported, pointers), {
    _id: 'blogPost-1',
    _type: 'blogPost',
    contentImage: {_type: 'image', alt: 'x', crop: {top: 0}, asset: {_ref: IMAGE, _type: 'reference'}},
    body: [
      {_key: 'k1', _type: 'video', file: {_type: 'file', asset: {_ref: MP4, _type: 'reference'}}, original: {_type: 'file', asset: {_ref: FILE, _type: 'reference'}}, conversion: {sourceAssetId: FILE}},
      {_key: 'k2', _type: 'block', children: []},
    ],
  })
  assert.throws(() => unrewriteAssets({x: {_sanityAsset: `image@file://./images/${'e'.repeat(40)}-1x1.png`}}, pointers))
})

test('summarize counts published, drafts and versions per type, and system documents apart', () => {
  const docs: SanityDoc[] = [
    {_id: 'blogPost-1', _type: 'blogPost'},
    {_id: 'drafts.blogPost-1', _type: 'blogPost'},
    {_id: 'versions.r1.blogPost-1', _type: 'blogPost'},
    {_id: IMAGE, _type: 'sanity.imageAsset', sha1hash: 'a'.repeat(40)},
    {_id: FILE, _type: 'sanity.fileAsset', sha1hash: 'b'.repeat(40)},
    {_id: '_.groups.public', _type: 'system.group'},
  ]
  const s = summarize(docs)
  assert.deepEqual(s.byType.blogPost, {published: 1, drafts: 1, versions: 1})
  assert.equal(s.byType['system.group'], undefined)
  assert.deepEqual(s.systemDocuments, ['_.groups.public'])
  assert.equal(s.images, 1)
  assert.equal(s.files, 1)
  assert.deepEqual(s.assetSha1s, ['a'.repeat(40), 'b'.repeat(40)])
})

test('differingFields compares values regardless of key order, and counts missing fields', () => {
  assert.deepEqual(differingFields({a: {x: 1, y: 2}, b: 1}, {b: 1, a: {y: 2, x: 1}}), [])
  assert.deepEqual(differingFields({a: 1, c: 3}, {a: 2, b: 2}), ['a', 'b', 'c'])
  assert.deepEqual(without({_rev: 'r', a: 1}, ['_rev']), {a: 1})
})

test('assetIdsInText finds asset ids in any inventory format; prefix shortens them', () => {
  const text = JSON.stringify({staging: [IMAGE], other: `x ${FILE} y`, notAnId: `image-${'c'.repeat(39)}-1x1-png`})
  assert.deepEqual([...assetIdsInText(text)].sort(), [FILE, IMAGE].sort())
  assert.equal(isAssetId(IMAGE), true)
  assert.equal(isAssetId('drafts.blogPost-1'), false)
  assert.equal(prefix(IMAGE), 'image-aaaaaaaa')
  assert.equal(prefix(FILE), 'file-bbbbbbbb')
})
