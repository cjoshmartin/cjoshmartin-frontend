import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {buildImportRecord, contentHash, updateRecordAfterPatch, type StoredDocument} from '../src/import-guard'
import {describeBoxes, listTracks, parseBoxes, stripIsobmff, UnsupportedFileError} from '../src/privacy/isobmff'
import {assetIdWithSha1, strippedMarker} from '../src/privacy/marker'
import {applyReplacementSet, findAssetIdOccurrences, replacementSet} from '../src/privacy/repoint'
import {classifyTag, findDataTracks, findPersonalTags, findStlHeaderFindings, parseTagKey, readStlHeader} from '../src/privacy/rules'
import {imageDeletionArgs} from '../src/privacy/image'
import {removedNames} from '../src/privacy/copies'
import {descriptiveFields, extractOptionsFor, personalMetadataExifKeys, referencesByAsset, type AssetDocument} from '../src/steps/privacy'

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

  it('keeps orientation, colour, device type, software, times and application names', () => {
    for (const key of [
      'EXIF:IFD0:Main:Orientation',
      'ICC_Profile:Main:ProfileDescription',
      'ICC_Profile:Main:ProfileCopyright',
      'ICC_Profile:ICC-header:Main:ProfileCreator',
      'ICC_Profile:ICC-header:Main:DeviceModel',
      'EXIF:IFD0:Main:Make',
      'EXIF:IFD0:Main:Model',
      'EXIF:IFD0:Main:Software',
      'EXIF:ExifIFD:Main:DateTimeOriginal',
      'EXIF:ExifIFD:Main:UserComment',
      'XMP:XMP-xmp:Main:CreatorTool',
      'XMP:XMP-xmpMM:Main:DocumentID',
      'PDF:Main:Creator',
      'QuickTime:Track1:Main:HandlerDescription',
      'QuickTime:Track1:Main:VideoOrientation',
      'File:System:Main:FileName',
      'ExifTool:Main:ExifToolVersion',
    ]) {
      assert.equal(classifyTag(key), null, key)
    }
  })

  it('lists the personal tags of a scan in key order', () => {
    const findings = findPersonalTags({SourceFile: 'x', 'EXIF:IFD0:Main:Make': 'Apple', 'MakerNotes:Apple:Main:RunTimeFlags': 1, 'EXIF:GPS:Main:GPSLatitude': 1})
    assert.deepEqual(findings, [
      {tag: 'EXIF:GPS:Main:GPSLatitude', category: 'location'},
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
    assert.deepEqual(personalMetadataExifKeys({_type: 'sanity.imageExifMetadata', LensModel: 'x', BodySerialNumber: '1', DateTimeOriginal: 'y'}), ['BodySerialNumber'])
    assert.deepEqual(personalMetadataExifKeys(undefined), [])
  })
})

describe('imageDeletionArgs', () => {
  it('deletes whole groups for GPS, maker notes and regions and single tags otherwise', () => {
    const args = imageDeletionArgs([
      {tag: 'EXIF:GPS:Main:GPSLatitude', category: 'location'},
      {tag: 'EXIF:GPS:Main:GPSLongitude', category: 'location'},
      {tag: 'Composite:Main:GPSPosition', category: 'location'},
      {tag: 'MakerNotes:Apple:Main:RunTimeFlags', category: 'maker-notes'},
      {tag: 'XMP:XMP-mwg-rs:Main:RegionAreaH', category: 'person'},
      {tag: 'EXIF:ExifIFD:Main:ImageUniqueID', category: 'identifier'},
    ])
    assert.deepEqual(args, ['-ExifIFD:ImageUniqueID=', '-GPS:all=', '-MakerNotes:all=', '-XMP-mwg-rs:all='])
    assert.deepEqual(removedNames({tool: 'exiftool', deletions: args, warnings: []}), ['ExifIFD ImageUniqueID', 'EXIF GPS', 'maker notes', 'XMP-mwg-rs (all)'])
  })

  it('refuses tags inside embedded documents, which exiftool cannot delete in place', () => {
    assert.throws(() => imageDeletionArgs([{tag: 'EXIF:GPS:Doc2:GPSLatitude', category: 'location'}]), /embedded document/)
  })
})

/** An ISO BMFF box. */
function box(type: string, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat(payload)
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + body.length, 0)
  header.write(type, 4, 'latin1')
  return Buffer.concat([header, body])
}
function fullBox(type: string, ...payload: Buffer[]): Buffer {
  return box(type, Buffer.alloc(4), ...payload)
}
function u32(...values: number[]): Buffer {
  const b = Buffer.alloc(4 * values.length)
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4))
  return b
}

/** A track with one chunk at `offset` holding samples of the given sizes. */
function trak(id: number, handler: string, entry: string, offset: number, sampleSizes: number[], extra: Buffer[] = []): Buffer {
  const tkhd = fullBox('tkhd', u32(0, 0, id, 0, 0), Buffer.alloc(60))
  const hdlr = fullBox('hdlr', u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12))
  const stsd = fullBox('stsd', u32(1), box(entry, Buffer.alloc(8)))
  const stsc = fullBox('stsc', u32(1, 1, sampleSizes.length, 1))
  const stsz = fullBox('stsz', u32(0, sampleSizes.length, ...sampleSizes))
  const stco = fullBox('stco', u32(1, offset))
  const stbl = box('stbl', stsd, fullBox('stts', u32(0)), stsc, stsz, stco)
  return box('trak', tkhd, ...extra, box('mdia', fullBox('mdhd', Buffer.alloc(20)), hdlr, box('minf', stbl)))
}

/**
 * ftyp, then mdat with a 4-byte video sample, a 6-byte metadata sample and a 3-byte audio sample,
 * then moov with the three tracks and a udta with a location atom.
 */
function sampleMovie(options: {tref?: Buffer; topLevel?: Buffer} = {}): {file: Buffer; video: [number, number]; meta: [number, number]; audio: [number, number]} {
  const ftyp = box('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1'))
  const samples = Buffer.from([1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 5, 6, 7])
  const mdatStart = ftyp.length + 8
  const video: [number, number] = [mdatStart, mdatStart + 4]
  const meta: [number, number] = [mdatStart + 4, mdatStart + 10]
  const audio: [number, number] = [mdatStart + 10, mdatStart + 13]
  const mdat = box('mdat', samples)
  const moov = box(
    'moov',
    fullBox('mvhd', Buffer.alloc(96)),
    trak(1, 'vide', 'hvc1', video[0], [4], options.tref ? [options.tref] : []),
    trak(2, 'meta', 'mebx', meta[0], [6]),
    trak(3, 'soun', 'mp4a', audio[0], [3], [box('udta', box('name', Buffer.from('Mono')))]),
    box('udta', box('\xa9xyz', Buffer.from('+00.0000+000.0000/'))),
    box('meta', Buffer.alloc(16)),
  )
  return {file: Buffer.concat([ftyp, mdat, moov, ...(options.topLevel ? [options.topLevel] : [])]), video, meta, audio}
}

describe('stripIsobmff', () => {
  it('removes metadata boxes and data tracks in place and zeroes their samples', () => {
    const {file, video, meta, audio} = sampleMovie()
    assert.deepEqual(listTracks(file).map((t) => `${t.id}:${t.handler}/${t.sampleEntry}`), ['1:vide/hvc1', '2:meta/mebx', '3:soun/mp4a'])
    const result = stripIsobmff(file)
    assert.equal(result.output.length, file.length)
    assert.deepEqual(result.keptTracks, [{id: 1, handler: 'vide'}, {id: 3, handler: 'soun'}])
    assert.deepEqual(result.removedTracks, [{id: 2, handler: 'meta', sampleEntry: 'mebx'}])
    assert.equal(result.zeroedSampleBytes, 6)
    assert.deepEqual([...result.output.subarray(...video)], [1, 2, 3, 4])
    assert.deepEqual([...result.output.subarray(...meta)], [0, 0, 0, 0, 0, 0])
    assert.deepEqual([...result.output.subarray(...audio)], [5, 6, 7])
    assert.deepEqual(listTracks(result.output).map((t) => t.handler), ['vide', 'soun'])
    const tree = describeBoxes(result.output).join('\n')
    assert.doesNotMatch(tree, /udta|meta|xyz/)
    assert.ok(!result.output.includes(Buffer.from('+00.0000')), 'the location text is gone')
    // Nothing outside the reported ranges changed.
    let at = 0
    for (const [start, end] of [...result.changedRanges, [file.length, file.length]]) {
      assert.ok(file.subarray(at, start).equals(result.output.subarray(at, start)))
      at = end
    }
    // Stripping the result again changes nothing more.
    assert.ok(stripIsobmff(result.output).output.equals(result.output))
  })

  it('refuses boxes it does not know rather than keeping them', () => {
    const {file} = sampleMovie({topLevel: box('junk', Buffer.from('owner: someone'))})
    assert.throws(() => stripIsobmff(file), (error: unknown) => error instanceof UnsupportedFileError && /unknown top-level box "junk"/.test(error.message))
  })

  it('removes a kept track\'s reference that only points at removed tracks', () => {
    const {file} = sampleMovie({tref: box('tref', box('tmcd', u32(2)))})
    const result = stripIsobmff(file)
    assert.ok(result.removals.some((r) => r.what === 'moov/trak[1] (vide)/tref (to removed tracks 2)'))
    assert.doesNotMatch(describeBoxes(result.output).join('\n'), /tref|tmcd/)
  })

  it('refuses a reference box that points at kept and removed tracks', () => {
    const {file} = sampleMovie({tref: box('tref', box('cdsc', u32(2, 3)))})
    assert.throws(() => stripIsobmff(file), /references the removed track\(s\) 2 and kept ones/)
  })

  it('parses 64-bit box sizes', () => {
    const large = Buffer.alloc(24)
    large.writeUInt32BE(1, 0)
    large.write('free', 4, 'latin1')
    large.writeBigUInt64BE(24n, 8)
    assert.deepEqual(parseBoxes(large, 0, large.length), [{type: 'free', start: 0, headerSize: 16, end: 24}])
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
    const facts = {kind: 'image' as const, removed: ['EXIF GPS'], strippedFrom: 'image-x', strippedAt: '2026-11-26T11:20:00.000Z'}
    const marker = strippedMarker(facts)
    assert.equal(marker.status, 'stripped')
    assert.equal(marker.strippedFrom, 'image-x')
    assert.equal(marker.updatedAt, facts.strippedAt)
    assert.deepEqual(strippedMarker(facts), marker)
  })

  const asset = (fields: Partial<AssetDocument>): AssetDocument => ({_id: 'image-a', _type: 'sanity.imageAsset', _rev: 'r', sha1hash: 'a', ...fields})

  it('carries over the descriptive fields and refuses fields it does not know', () => {
    assert.deepEqual(descriptiveFields(asset({title: 'T', source: {name: 'wagtail', id: 'image:1'}, url: 'u', privacy: {status: 'replaced'}})), {title: 'T', source: {name: 'wagtail', id: 'image:1'}})
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
