import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {test} from 'node:test'

import {computeFingerprint} from '../lib/fingerprint.mjs'
import {buildDataset} from './helpers.mjs'

function shuffled(items, seed) {
  const copy = [...items]
  let state = seed
  for (let index = copy.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2 ** 31
    const swap = state % (index + 1)
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

test('fingerprint is sha256 of sorted "<_id>:<_rev>\\n" lines', () => {
  const expected = createHash('sha256').update('a:1\nb:2\n').digest('hex')
  assert.equal(computeFingerprint([{_id: 'b', _rev: '2'}, {_id: 'a', _rev: '1'}]), expected)
})

test('fingerprint does not depend on document order', () => {
  const {documents} = buildDataset()
  const reference = computeFingerprint(documents)
  for (const seed of [1, 2, 3, 42, 1234]) {
    assert.equal(computeFingerprint(shuffled(documents, seed)), reference)
  }
  assert.equal(computeFingerprint([...documents].reverse()), reference)
})

test('fingerprint ignores document content other than _id and _rev', () => {
  const {documents} = buildDataset()
  const changedContent = documents.map((doc) => (doc._id === 'person-1' ? {...doc, firstName: 'Changed'} : doc))
  assert.equal(computeFingerprint(changedContent), computeFingerprint(documents))
})

test('fingerprint changes when a document is edited, added or deleted', () => {
  const {documents} = buildDataset()
  const base = computeFingerprint(documents)
  const edited = documents.map((doc) => (doc._id === 'drafts.blogPost-7' ? {...doc, _rev: 'b3'} : doc))
  assert.notEqual(computeFingerprint(edited), base)
  assert.notEqual(computeFingerprint([...documents, {_id: 'service-1', _type: 'service', _rev: 's1'}]), base)
  assert.notEqual(computeFingerprint(documents.filter((doc) => doc._id !== 'person-1')), base)
})

test('fingerprint covers drafts, release versions, system and asset documents', () => {
  const {documents} = buildDataset()
  const base = computeFingerprint(documents)
  for (const id of ['drafts.blogPost-7', 'versions.rSpring.blogPost-7', '_.groups.administrator', documents.find((d) => d._type === 'sanity.imageAsset')._id]) {
    assert.notEqual(computeFingerprint(documents.filter((doc) => doc._id !== id)), base, `removing ${id} must change the fingerprint`)
  }
})

test('fingerprint rejects malformed input', () => {
  assert.throws(() => computeFingerprint([{_id: 'a', _rev: '1'}, {_id: 'a', _rev: '2'}]), /more than once/)
  assert.throws(() => computeFingerprint([{_id: 'a'}]), /no string _rev/)
  assert.throws(() => computeFingerprint([{_rev: '1'}]), /without a string _id/)
})
