import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  buildImportRecord,
  contentHash,
  describeStudioEdits,
  findStudioEdits,
  hasStudioEdits,
  releaseVersionTarget,
  type ImportRecord,
  type StoredDocument,
} from '../src/import-guard'

const imported: StoredDocument[] = [
  {_id: 'blogPost-13', _type: 'blogPost', title: 'Interview practice', intro: 'x'},
  {_id: 'drafts.blogPost-17', _type: 'blogPost', title: 'Fixes to make'},
  {_id: 'project-43', _type: 'project', title: 'Frames'},
]

/** What the dataset returns right after the import: the same content plus system fields. */
function stored(docs: StoredDocument[], revPrefix = 'r1'): StoredDocument[] {
  return docs.map((doc) => ({...doc, _rev: `${revPrefix}-${doc._id}`, _createdAt: '2026-11-25T20:00:00Z', _updatedAt: '2026-11-25T20:00:00Z'}))
}

function record(): ImportRecord {
  return buildImportRecord({
    dataset: 'production',
    source: 'import',
    ndjsonSha256: 'abc',
    expected: imported,
    stored: stored(imported),
    recordedAt: '2026-11-25T20:01:00Z',
  })
}

describe('buildImportRecord', () => {
  it('records the revision and the content hash without system fields', () => {
    const r = record()
    assert.deepEqual(Object.keys(r.documents), ['blogPost-13', 'drafts.blogPost-17', 'project-43'])
    assert.equal(r.documents['blogPost-13']!.rev, 'r1-blogPost-13')
    assert.equal(r.documents['blogPost-13']!.contentHash, contentHash(imported[0]!))
    assert.equal(contentHash({...imported[0]!, _rev: 'other', _updatedAt: 'later'}), contentHash(imported[0]!))
  })

  it('refuses a dataset that does not hold exactly the expected documents', () => {
    const changed = stored(imported).map((doc) => (doc._id === 'project-43' ? {...doc, title: 'Edited'} : doc))
    assert.throws(() => buildImportRecord({dataset: 'p', source: 'baseline', ndjsonSha256: 'x', expected: imported, stored: changed}), /project-43 differs/)
    assert.throws(
      () => buildImportRecord({dataset: 'p', source: 'baseline', ndjsonSha256: 'x', expected: imported, stored: stored(imported).slice(1)}),
      /blogPost-13 is missing/,
    )
    const extra = [...stored(imported), {_id: 'drafts.project-43', _type: 'project', _rev: 'r9', title: 'Typing'}]
    assert.throws(() => buildImportRecord({dataset: 'p', source: 'baseline', ndjsonSha256: 'x', expected: imported, stored: extra}), /drafts\.project-43 is in the dataset but not expected/)
  })

  it('ignores documents that are not migration documents', () => {
    const withOthers = [...stored(imported), {_id: 'image-abc-1x1-jpg', _type: 'sanity.imageAsset', _rev: 'a'}, {_id: 'secrets.mux', _type: 'mux.apiKey', _rev: 'b'}]
    assert.equal(Object.keys(buildImportRecord({dataset: 'p', source: 'import', ndjsonSha256: 'x', expected: imported, stored: withOthers}).documents).length, 3)
  })
})

describe('findStudioEdits', () => {
  it('finds nothing when the dataset is as the import left it', () => {
    const edits = findStudioEdits(record(), stored(imported), [])
    assert.equal(hasStudioEdits(edits), false)
  })

  it('treats a new revision with the same content as unchanged', () => {
    const edits = findStudioEdits(record(), stored(imported, 'r2'), [])
    assert.equal(hasStudioEdits(edits), false)
  })

  it('finds an edited document', () => {
    const current = stored(imported).map((doc) => (doc._id === 'blogPost-13' ? {...doc, _rev: 'r2', intro: 'typo fixed'} : doc))
    const edits = findStudioEdits(record(), current, [])
    assert.deepEqual(edits, {changed: ['blogPost-13'], created: [], deleted: [], inReleases: []})
  })

  it('finds a migrated draft that an editor published (draft gone, published copy new)', () => {
    const current = stored(imported)
      .filter((doc) => doc._id !== 'drafts.blogPost-17')
      .concat({_id: 'blogPost-17', _type: 'blogPost', _rev: 'p1', title: 'Fixes to make'})
    const edits = findStudioEdits(record(), current, [])
    assert.deepEqual(edits.created, ['blogPost-17'])
    assert.deepEqual(edits.deleted, ['drafts.blogPost-17'])
    assert.match(describeStudioEdits(edits), /created since the last import.*blogPost-17/)
  })

  it('finds a draft an editor started and release versions of migration documents', () => {
    const current = [...stored(imported), {_id: 'drafts.project-43', _type: 'project', _rev: 'd1', title: 'Frames!'}]
    const edits = findStudioEdits(record(), current, ['versions.rSpring.blogPost-13', 'versions.rSpring.0c6f1e1e-new'])
    assert.deepEqual(edits.created, ['drafts.project-43'])
    assert.deepEqual(edits.inReleases, ['versions.rSpring.blogPost-13'])
  })

  it('ignores documents the Studio created with random ids', () => {
    const current = [...stored(imported), {_id: '0c6f1e1e-2b1c-4c4f-9a43-1f0e1c2b3d4e', _type: 'blogPost', _rev: 'n1'}]
    assert.equal(hasStudioEdits(findStudioEdits(record(), current, [])), false)
  })
})

describe('releaseVersionTarget', () => {
  it('returns the migration id a release version belongs to', () => {
    assert.equal(releaseVersionTarget('versions.r1.project-5'), 'project-5')
    assert.equal(releaseVersionTarget('versions.r1.drafts.project-5'), 'drafts.project-5')
    assert.equal(releaseVersionTarget('versions.r1.abc'), null)
    assert.equal(releaseVersionTarget('project-5'), null)
  })
})

describe('mux.videoAsset documents of earlier runs', () => {
  it('count as unchanged migration documents, so the import that prunes them is not refused', () => {
    const video = {_id: 'mux-video-1', _type: 'mux.videoAsset', assetId: 'a1', playbackId: 'p1', status: 'ready'}
    const withVideo = buildImportRecord({
      dataset: 'production',
      source: 'import',
      ndjsonSha256: 'abc',
      expected: [...imported, video],
      stored: stored([...imported, video]),
      recordedAt: '2026-11-25T23:10:22.976Z',
    })
    assert.equal(hasStudioEdits(findStudioEdits(withVideo, stored([...imported, video]), [])), false)
    // The record tracks it: a dataset without it shows it as deleted.
    assert.deepEqual(findStudioEdits(withVideo, stored(imported), []).deleted, ['mux-video-1'])
  })
})
