import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {buildImportRecord, contentHash, updateRecordAfterPatch, type StoredDocument} from '../src/import-guard'
import {assetIdWithSha1, strippedMarker} from '../src/privacy/marker'
import {PRIVACY_LINK_KEY_ENV, uploadDigest} from '../../../studio/functions/privacy/provenance'

// The key the markers' digests are made with (secrets.env in a real run).
const TEST_KEY = '5a'.repeat(32)
process.env[PRIVACY_LINK_KEY_ENV] = TEST_KEY
import {applyReplacementSet, findAssetIdOccurrences, replacementSet} from '../src/privacy/repoint'
import {classifyTag, findDataTracks, findPersonalTags, findStlHeaderFindings, parseTagKey, readStlHeader} from '../src/privacy/rules'
import {removedNames, withStrippedCopy, type PrivacyMap} from '../src/privacy/copies'
import {bucketOrigin, descriptiveFields, extractOptionsFor, personalMetadataExifKeys, referencesByAsset, type AssetDocument} from '../src/steps/privacy'

describe('personal metadata rules', () => {
  it('reads keys with and without a separate family 1 group', () => {
    assert.deepEqual(parseTagKey('EXIF:GPS:Main:GPSLatitude'), {family0: 'EXIF', family1: 'GPS', family3: 'Main', name: 'GPSLatitude'})
    assert.deepEqual(parseTagKey('Composite:Main:GPSPosition'), {family0: 'Composite', family1: 'Composite', family3: 'Main', name: 'GPSPosition'})
    assert.equal(parseTagKey('SourceFile'), null)
  })

  it('finds location, maker notes, identifiers and people', () => {
    const cases: [string, ReturnType<typeof classifyTag>][] = [
      ['EXIF:GPS:Main:GPSAltitude', 'location'],
      ['Composite:Main:GPSPosition', 'location'],
      ['XMP:XMP-exif:Main:GPSLatitude', 'location'],
      ['QuickTime:Keys:Main:GPSCoordinates', 'location'],
      ['QuickTime:Keys:Main:LocationAccuracyHorizontal', 'location'],
      ['QuickTime:ItemList:Main:GPSCoordinates', 'location'],
      ['QuickTime:Track3:Doc12:GPSLatitude', 'location'],
      ['XMP:XMP-photoshop:Main:City', 'location'],
      ['IPTC:IPTC:Main:Sub-location', 'location'],
      ['MakerNotes:Apple:Main:AEMatrix', 'maker-notes'],
      ['EXIF:ExifIFD:Main:MakerNoteUnknown', 'maker-notes'],
      ['EXIF:ExifIFD:Main:ImageUniqueID', 'identifier'],
      ['EXIF:ExifIFD:Main:BodySerialNumber', 'identifier'],
      ['EXIF:ExifIFD:Main:LensSerialNumber', 'identifier'],
      ['EXIF:ExifIFD:Main:OwnerName', 'identifier'],
      ['XMP:XMP-mwg-rs:Main:RegionAreaH', 'person'],
      ['XMP:XMP-mwg-rs:Main:RegionExtensionsFaceID', 'person'],
      ['QuickTime:UserData:Main:Author', 'person'],
      ['QuickTime:Keys:Main:Copyright', 'person'],
      ['EXIF:IFD0:Main:Artist', 'person'],
      ['XMP:XMP-dc:Main:Creator', 'person'],
      ['IPTC:IPTC:Main:By-line', 'person'],
    ]
    for (const [key, category] of cases) assert.equal(classifyTag(key), category, key)
  })

  it('finds the device, capture times, comments and editing ids (rules version 2)', () => {
    const cases: [string, unknown, ReturnType<typeof classifyTag>][] = [
      ['EXIF:IFD0:Main:Make', 'Apple', 'device'],
      ['EXIF:IFD0:Main:Model', 'iPhone', 'device'],
      ['EXIF:IFD0:Main:Software', '17.4', 'device'],
      ['EXIF:IFD0:Main:HostComputer', 'iPhone', 'device'],
      ['EXIF:ExifIFD:Main:LensModel', 'x', 'device'],
      ['XMP:XMP-xmp:Main:CreatorTool', 'x', 'device'],
      ['QuickTime:Keys:Main:Model', 'MacBookPro18,1', 'device'],
      ['QuickTime:Keys:Main:AndroidVersion', '14', 'device'],
      ['EXIF:ExifIFD:Main:DateTimeOriginal', '2024:05:17 15:15:48', 'capture-time'],
      ['EXIF:ExifIFD:Main:OffsetTimeOriginal', '+08:00', 'capture-time'],
      ['QuickTime:Keys:Main:CreationDate', '2025:05:05 14:19:49+08:00', 'capture-time'],
      ['QuickTime:QuickTime:Main:CreateDate', '2025:05:05 06:19:49', 'capture-time'],
      ['PNG:PNG:Main:ModifyDate', '2024:05:17 15:15:48', 'capture-time'],
      ['EXIF:ExifIFD:Main:UserComment', 'Screenshot', 'comment'],
      ['File:File:Main:Comment', 'x', 'comment'],
      ['XMP:XMP-xmpMM:Main:DocumentID', 'x', 'identifier'],
    ]
    for (const [key, value, category] of cases) assert.equal(classifyTag(key, value), category, key)
  })

  it('keeps orientation, colour, technical data, zero QuickTime times and what describes a PDF or an ICC profile', () => {
    for (const [key, value] of [
      ['EXIF:IFD0:Main:Orientation', 6],
      ['EXIF:ExifIFD:Main:ColorSpace', 'Uncalibrated'],
      ['ICC_Profile:Main:ProfileDescription', 'Display P3'],
      ['ICC_Profile:Main:ProfileCopyright', 'Copyright Apple Inc., 2017'],
      ['ICC_Profile:ICC-header:Main:ProfileCreator', 'Apple Computer Inc.'],
      ['ICC_Profile:ICC-header:Main:DeviceModel', 'appl'],
      ['ICC_Profile:ICC-header:Main:ProfileDateTime', '2017:07:07 13:22:32'],
      ['QuickTime:QuickTime:Main:CreateDate', '0000:00:00 00:00:00'],
      ['QuickTime:Track1:Main:TrackCreateDate', '0000:00:00 00:00:00'],
      ['QuickTime:ItemList:Main:Encoder', 'Lavf61.1.100'],
      ['QuickTime:Track1:Main:CompressorName', 'HEVC'],
      ['PDF:Main:Creator', 'Mozilla/5.0'],
      ['PDF:Main:Producer', 'Skia/PDF m137'],
      ['PDF:Main:CreateDate', '2025:01:01 00:00:00'],
      ['QuickTime:Track1:Main:HandlerDescription', 'Core Media Video'],
      ['QuickTime:Track1:Main:VideoOrientation', 'Rotate 90 CW'],
      ['File:System:Main:FileName', 'x.jpg'],
      ['ExifTool:Main:ExifToolVersion', 13.55],
    ] as const) {
      assert.equal(classifyTag(key, value), null, key)
    }
  })

  it('lists the personal tags of a scan in key order', () => {
    const findings = findPersonalTags({SourceFile: 'x', 'EXIF:IFD0:Main:Make': 'Apple', 'MakerNotes:Apple:Main:RunTimeFlags': 1, 'EXIF:GPS:Main:GPSLatitude': 1, 'EXIF:IFD0:Main:Orientation': 6})
    assert.deepEqual(findings, [
      {tag: 'EXIF:GPS:Main:GPSLatitude', category: 'location'},
      {tag: 'EXIF:IFD0:Main:Make', category: 'device'},
      {tag: 'MakerNotes:Apple:Main:RunTimeFlags', category: 'maker-notes'},
    ])
  })

  it('counts every track that is not video or audio', () => {
    assert.deepEqual(
      findDataTracks([
        {index: 1, handler: 'vide', sampleEntry: 'hvc1'},
        {index: 2, handler: 'soun', sampleEntry: 'mp4a'},
        {index: 3, handler: 'meta', sampleEntry: 'mebx'},
        {index: 4, handler: 'tmcd', sampleEntry: 'tmcd'},
      ]),
      [
        {tag: 'Track3:meta/mebx', category: 'data-track'},
        {tag: 'Track4:tmcd/tmcd', category: 'data-track'},
      ],
    )
  })

  it('accepts only blank or known STL headers', () => {
    const binary = (header: string, facets = 1) => {
      const head = Buffer.alloc(84, 0x20)
      head.write(header, 0, 'latin1')
      head.writeUInt32LE(facets, 80)
      return {head, size: 84 + 50 * facets}
    }
    const atf = binary('STLB ATF 12.20.1.177 COLOR=\xa0\xa0\xa0\xff')
    assert.deepEqual(findStlHeaderFindings(readStlHeader(atf.head, atf.size)), [])
    const blank = binary('')
    assert.deepEqual(findStlHeaderFindings(readStlHeader(blank.head, blank.size)), [])
    const named = binary('Exported by jane.doe from C:\\Users\\jane')
    assert.deepEqual(findStlHeaderFindings(readStlHeader(named.head, named.size)), [{tag: 'STL:Header:Main:BinaryHeader', category: 'person'}])
    const ascii = Buffer.from('solid part_by_jane\nfacet normal 0 0 1\n')
    assert.deepEqual(findStlHeaderFindings(readStlHeader(ascii, ascii.length)), [{tag: 'STL:Header:Main:SolidName', category: 'person'}])
    const anonymous = Buffer.from('solid\nfacet normal 0 0 1\n')
    assert.deepEqual(findStlHeaderFindings(readStlHeader(anonymous, anonymous.length)), [])
  })

  it('reads Sanity metadata.exif keys with the same rules', () => {
    assert.deepEqual(
      personalMetadataExifKeys({_type: 'sanity.imageExifMetadata', LensModel: 'x', BodySerialNumber: '1', DateTimeOriginal: '2024:05:17 15:15:48', ColorSpace: 1}),
      ['BodySerialNumber', 'DateTimeOriginal', 'LensModel'],
    )
    assert.deepEqual(personalMetadataExifKeys(undefined), [])
  })
})

describe('stripped copies in the plan', () => {
  const map: PrivacyMap = {
    rulesVersion: 'personal-metadata-v2',
    tools: {exiftool: '', ffprobe: '', magick: ''},
    updatedAt: '',
    bucket: {},
    copies: {
      ['a'.repeat(40)]: {
        originalSha1: 'a'.repeat(40),
        originalFilename: 'IMG_0001.MOV',
        kind: 'video',
        file: 'stripped/aaa/IMG_0001.MOV',
        sha1: 'b'.repeat(40),
        size: 1,
        findings: [],
        removed: ['moov/meta'],
        method: {tool: 'isobmff', removals: [{what: 'moov/meta', bytes: 10}], changedRanges: [[0, 10]], unreferenced: {bytes: 0, nonZeroBytes: 0}},
        verification: {streams: [], removedStreams: [], removedFormatTags: [], removedStreamTags: [], sideData: []},
        strippedAt: '',
        verifiedAt: '',
      },
    },
  }

  it('uploads the copy, whose source never links to the unstripped bucket object', () => {
    const planned = {sha1: 'a'.repeat(40), source: {name: 'wagtail', id: 'media-1', url: 'https://storage.googleapis.com/images-for-cms/media/IMG_0001.MOV'}}
    assert.deepEqual(withStrippedCopy(planned, map), {
      sha1: 'b'.repeat(40),
      source: {name: 'wagtail', id: 'media-1'},
      strippedCopy: {originalSha1: 'a'.repeat(40), file: 'stripped/aaa/IMG_0001.MOV'},
    })
    const clean = {sha1: 'c'.repeat(40), source: {name: 'wagtail', id: 'media-2', url: 'https://storage.googleapis.com/images-for-cms/media/x.mp4'}}
    assert.deepEqual(withStrippedCopy(clean, map), clean, 'a file without personal metadata keeps its bucket URL (same bytes)')
  })

  it('names what the strippers removed', () => {
    assert.deepEqual(removedNames({tool: 'image-strip', version: 'image-strip-v1', removed: ['EXIF: Make, GPS', 'XMP']}), ['EXIF: Make, GPS', 'XMP'])
    assert.deepEqual(removedNames(map.copies['a'.repeat(40)]!.method), ['moov/meta'])
  })

  it('finds the bucket original of an asset and of a copy an earlier rule version made', () => {
    const bucket = new Map([['a'.repeat(40), {sha1: 'a'.repeat(40), path: 'media/IMG_0001.MOV'}]])
    const original = {_id: `file-${'a'.repeat(40)}-mov`, sha1hash: 'a'.repeat(40)}
    assert.deepEqual(bucketOrigin(original, bucket), {sha1: 'a'.repeat(40), path: 'media/IMG_0001.MOV'})
    const v1Copy = {
      _id: `file-${'d'.repeat(40)}-mov`,
      sha1hash: 'd'.repeat(40),
      source: {name: 'wagtail', id: 'media-1'},
      privacy: {status: 'stripped', strippedFrom: `file-${'a'.repeat(40)}-mov`},
    }
    assert.deepEqual(bucketOrigin(v1Copy, bucket), {sha1: 'a'.repeat(40), path: 'media/IMG_0001.MOV'}, 'a round-1 copy names its upload')
    const digestCopy = {...v1Copy, privacy: {status: 'stripped', strippedFromDigest: uploadDigest(`file-${'a'.repeat(40)}-mov`, TEST_KEY)}}
    assert.deepEqual(bucketOrigin(digestCopy, bucket), {sha1: 'a'.repeat(40), path: 'media/IMG_0001.MOV'}, 'a copy with the digest is matched by it')
    assert.equal(bucketOrigin({...digestCopy, privacy: {status: 'stripped', strippedFromDigest: uploadDigest(`file-${'a'.repeat(40)}-mov`, '6b'.repeat(32))}}, bucket), null, 'another key matches nothing')
    assert.equal(bucketOrigin({...v1Copy, source: {name: 'image-privacy', id: 'x'}}, bucket), null, 'a Function copy is not the migration\'s')
    assert.equal(bucketOrigin({_id: `file-${'e'.repeat(40)}-mov`, sha1hash: 'e'.repeat(40)}, bucket), null)
  })
})

describe('moving asset ids', () => {
  const old = 'image-1111111111111111111111111111111111111111-10x10-jpg'
  const video = 'file-2222222222222222222222222222222222222222-mov'
  const replacements = new Map([
    [old, 'image-3333333333333333333333333333333333333333-10x10-jpg'],
    [video, 'file-4444444444444444444444444444444444444444-mov'],
  ])
  const ids = new Set(replacements.keys())

  it('finds references and the contract fields, and keeps everything around them', () => {
    const doc = {
      _id: 'testimonial-1',
      _type: 'testimonial',
      asciiArtSource: old,
      image: {_type: 'image', asset: {_type: 'reference', _ref: old}, crop: {top: 0.1}, hotspot: {x: 0.5}, alt: 'A'},
      body: [
        {_type: 'imageBlock', _key: 'a1', asset: {_type: 'reference', _ref: old}, caption: 'C'},
        {
          _type: 'video',
          _key: 'v1',
          file: {_type: 'file', asset: {_type: 'reference', _ref: 'file-mp4'}},
          original: {_type: 'file', asset: {_type: 'reference', _ref: video}},
          conversion: {status: 'ready', sourceAssetId: video, outputAssetId: 'file-mp4'},
        },
      ],
    }
    const {known, unknown} = findAssetIdOccurrences(doc, ids)
    assert.deepEqual(unknown, [])
    assert.deepEqual(known.map((o) => `${o.kind} ${o.path}`).sort(), [
      'asciiArtSource asciiArtSource',
      'conversion body[_key=="v1"].conversion.sourceAssetId',
      'reference body[_key=="a1"].asset._ref',
      'reference body[_key=="v1"].original.asset._ref',
      'reference image.asset._ref',
    ])
    const after = applyReplacementSet(doc, replacementSet(known, replacements))
    assert.equal(after.image.asset._ref, replacements.get(old))
    assert.deepEqual(after.image.crop, {top: 0.1})
    assert.equal(after.image.alt, 'A')
    assert.equal(after.body[0]!.caption, 'C')
    assert.equal(after.asciiArtSource, replacements.get(old))
    const block = after.body[1] as (typeof doc.body)[1] & {original: {asset: {_ref: string}}; conversion: {sourceAssetId: string; outputAssetId: string}; file: {asset: {_ref: string}}}
    assert.equal(block.original.asset._ref, replacements.get(video))
    assert.equal(block.conversion.sourceAssetId, replacements.get(video))
    assert.equal(block.conversion.outputAssetId, 'file-mp4')
    assert.equal(block.file.asset._ref, 'file-mp4')
    assert.deepEqual(findAssetIdOccurrences(after, ids), {known: [], unknown: [], provenance: []})
    // The input is not changed.
    assert.equal(doc.image.asset._ref, old)
  })

  it('moves the source of an MP4 asset and reports ids in fields it does not know', () => {
    const mp4 = {_id: 'file-mp4', _type: 'sanity.fileAsset', source: {name: 'video-to-mp4', id: video}, note: video}
    const {known, unknown} = findAssetIdOccurrences(mp4, ids)
    assert.deepEqual(known.map((o) => `${o.kind} ${o.path}`), ['source source.id'])
    assert.deepEqual(unknown.map((o) => o.path), ['note'])
    // A content document's `source` field is not an asset source.
    assert.deepEqual(findAssetIdOccurrences({_id: 'redirect-1', _type: 'redirect', source: {id: video}}, ids).unknown.map((o) => o.path), ['source.id'])
  })

  it('leaves the provenance of a stripped copy alone: it names the deleted upload on purpose', () => {
    const copy = {_id: 'file-copy', _type: 'sanity.fileAsset', privacy: {status: 'stripped', strippedFrom: video}}
    const found = findAssetIdOccurrences(copy, ids)
    assert.deepEqual(found.known, [])
    assert.deepEqual(found.unknown, [])
    assert.deepEqual(found.provenance, [{path: 'privacy.strippedFrom', id: video, kind: 'provenance'}])
  })

  it('maps references to the documents that hold them', () => {
    const refs = referencesByAsset([
      {_id: 'a', _type: 'x', image: {asset: {_ref: old}}, gallery: [{_key: 'k', asset: {_ref: old}}]},
      {_id: 'b', _type: 'x', file: {asset: {_ref: video}}},
    ])
    assert.deepEqual(refs.get(old), ['a'])
    assert.deepEqual(refs.get(video), ['b'])
  })
})

describe('the privacy field and copied asset fields', () => {
  it('derives the replaced asset id from the copy id', () => {
    assert.equal(assetIdWithSha1(`image-${'b'.repeat(40)}-3024x4032-jpg`, 'b'.repeat(40), 'a'.repeat(40)), `image-${'a'.repeat(40)}-3024x4032-jpg`)
    assert.equal(assetIdWithSha1(`file-${'b'.repeat(40)}-mov`, 'b'.repeat(40), 'a'.repeat(40)), `file-${'a'.repeat(40)}-mov`)
    assert.throws(() => assetIdWithSha1(`file-${'b'.repeat(40)}-mov`, 'c'.repeat(40), 'a'.repeat(40)), /not an asset id/)
  })

  it('writes the same marker for the same copy', () => {
    const facts = {kind: 'image' as const, removed: ['EXIF GPS'], uploadId: `image-${'c'.repeat(40)}-10x10-jpg`, strippedAt: '2026-11-26T11:20:00.000Z'}
    const marker = strippedMarker(facts)
    assert.equal(marker.status, 'stripped')
    assert.equal(marker.strippedFromDigest, uploadDigest(facts.uploadId, TEST_KEY))
    assert.ok(!JSON.stringify(marker).includes('c'.repeat(40)), 'the marker never names the upload (its id is its CDN URL)')
    assert.equal(marker.updatedAt, facts.strippedAt)
    assert.deepEqual(strippedMarker(facts), marker)
  })

  const asset = (fields: Partial<AssetDocument>): AssetDocument => ({_id: 'image-a', _type: 'sanity.imageAsset', _rev: 'r', sha1hash: 'a', ...fields})

  it('carries over the descriptive fields and refuses fields it does not know', () => {
    assert.deepEqual(descriptiveFields(asset({title: 'T', source: {name: 'wagtail', id: 'image:1'}, url: 'u', privacy: {status: 'replaced'}})), {title: 'T', source: {name: 'wagtail', id: 'image:1'}})
    assert.deepEqual(
      descriptiveFields(asset({source: {name: 'wagtail', id: 'image:1', url: 'https://storage.googleapis.com/images-for-cms/original_images/x.jpg'}})),
      {source: {name: 'wagtail', id: 'image:1'}},
      'the copy does not link to the unstripped bucket object',
    )
    assert.throws(() => descriptiveFields(asset({custom: 1})), /custom/)
  })

  it('extracts the same image metadata again, never exif or location', () => {
    assert.deepEqual(extractOptionsFor(asset({metadata: {_type: 'sanity.imageMetadata', blurHash: 'x', lqip: 'y', palette: {}, dimensions: {}, hasAlpha: false, isOpaque: true, location: {}, exif: {}}})), ['blurhash', 'lqip', 'palette'])
    assert.deepEqual(extractOptionsFor(asset({metadata: {thumbHash: 'z'}})), ['thumbhash'])
    assert.throws(() => extractOptionsFor(asset({metadata: {embedding: []}})), /embedding/)
  })
})

describe('updateRecordAfterPatch', () => {
  const before: StoredDocument[] = [
    {_id: 'project-7', _type: 'project', _rev: 'r1', image: {asset: {_ref: 'old'}}},
    {_id: 'project-8', _type: 'project', _rev: 'r1', image: {asset: {_ref: 'old'}}, title: 'edited in the Studio'},
  ]
  const imported: StoredDocument[] = [
    {_id: 'project-7', _type: 'project', image: {asset: {_ref: 'old'}}},
    {_id: 'project-8', _type: 'project', image: {asset: {_ref: 'old'}}},
  ]
  const record = buildImportRecord({
    dataset: 'staging',
    source: 'import',
    ndjsonSha256: 'old-ndjson',
    expected: imported,
    stored: imported.map((d) => ({...d, _rev: 'r0'})),
  })
  // project-8 was changed in the Studio after the import (r1, other content).
  const expected: StoredDocument[] = [
    {_id: 'project-7', _type: 'project', image: {asset: {_ref: 'new'}}},
    {_id: 'project-8', _type: 'project', image: {asset: {_ref: 'new'}}},
  ]
  const after: StoredDocument[] = [
    {_id: 'project-7', _type: 'project', _rev: 'r2', image: {asset: {_ref: 'new'}}},
    {_id: 'project-8', _type: 'project', _rev: 'r2', image: {asset: {_ref: 'new'}}, title: 'edited in the Studio'},
  ]

  it('moves unchanged documents to their patched revision and keeps Studio edits visible', () => {
    // project-7 is unchanged since the import: its content hash matches the record.
    const update = updateRecordAfterPatch({record, before, after, expected, ndjsonSha256: 'new-ndjson'})
    assert.deepEqual(update.updated, ['project-7'])
    assert.deepEqual(update.record.documents['project-7'], {rev: 'r2', contentHash: contentHash(expected[0]!)})
    assert.deepEqual(update.record.documents['project-8'], record.documents['project-8'])
    assert.deepEqual(update.kept, [{id: 'project-8', reason: 'it was edited in the Studio before the patch'}])
    // Not every recorded document equals the new NDJSON, so the record keeps the old NDJSON's hash.
    assert.equal(update.record.ndjsonSha256, 'old-ndjson')
  })

  it('takes the new NDJSON hash when every recorded document equals it', () => {
    const clean = before.map((d) => ({...d, title: undefined}))
    const update = updateRecordAfterPatch({record, before: clean, after: after.map((d) => ({...d, title: undefined})), expected, ndjsonSha256: 'new-ndjson'})
    assert.deepEqual(update.updated, ['project-7', 'project-8'])
    assert.equal(update.record.ndjsonSha256, 'new-ndjson')
  })
})

describe('pointers to missing assets', () => {
  it('finds asset ids of missing assets in any string, never the present ones or digests', async () => {
    const {danglingAssetPointers} = await import('../src/privacy/pointers')
    const present = `file-${'1'.repeat(40)}-mov`
    const missing = `image-${'2'.repeat(40)}-3024x4032-jpg`
    const docs = [
      {_id: present, _type: 'sanity.fileAsset', privacy: {status: 'stripped', strippedFromDigest: uploadDigest(missing, TEST_KEY)}},
      {_id: 'blogPost-1', _type: 'blogPost', body: [{_type: 'video', conversion: {sourceAssetId: `file-${'3'.repeat(40)}-mov`}, file: {asset: {_ref: present}}}], note: `see ${missing} here`},
    ]
    assert.deepEqual(danglingAssetPointers(docs, new Set([present])), [
      {documentId: 'blogPost-1', path: 'body[].conversion.sourceAssetId', sha1Prefix: '333333333333'},
      {documentId: 'blogPost-1', path: 'note', sha1Prefix: '222222222222'},
    ])
  })
})
