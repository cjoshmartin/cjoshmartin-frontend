/**
 * The file link annotation accepts PDF documents only: no Function strips file assets, so a photo
 * or video attached as a file would be served with its location.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {FILE_LINK_ACCEPT, fileLinkProblem} from '../schemaTypes/shared/validation'

describe('file links', () => {
  it('accept PDF documents', () => {
    assert.equal(FILE_LINK_ACCEPT, '.pdf,application/pdf')
    assert.equal(fileLinkProblem('file-1111111111111111111111111111111111111111-pdf'), null)
    assert.equal(fileLinkProblem('file-1111111111111111111111111111111111111111-PDF'), null)
  })

  it('refuse photos, videos and anything else, and an empty link', () => {
    for (const extension of ['jpg', 'mov', 'mp4', 'heic', 'zip', 'stl']) {
      assert.match(fileLinkProblem(`file-1111111111111111111111111111111111111111-${extension}`) ?? '', /Only PDF documents/, extension)
    }
    assert.equal(fileLinkProblem(undefined), 'Upload or select a file')
    assert.match(fileLinkProblem('image-1111111111111111111111111111111111111111-8x8-jpg') ?? '', /not a file asset/)
  })
})
