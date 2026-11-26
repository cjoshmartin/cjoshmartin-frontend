import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  applyIsobmffPlan,
  bufferReader,
  checkStrippedIsobmff,
  describeBoxes,
  findMetadataSignatures,
  IsobmffUnsupportedError,
  listTracks,
  mergeRanges,
  parseBoxes,
  planIsobmffStrip,
  subtractRanges,
} from '../isobmff-video'

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

/** A self-contained data reference (`url ` with flag 1). */
const dinf = box('dinf', fullBox('dref', u32(1), box('url ', u32(1))))

/** A track with one chunk at `offset` holding samples of the given sizes; `time` is its creation time. */
function trak(id: number, handler: string, entry: string, offset: number, sampleSizes: number[], options: {extra?: Buffer[]; time?: number; dref?: Buffer} = {}): Buffer {
  const time = options.time ?? 0
  const tkhd = fullBox('tkhd', u32(time, time, id, 0, 0), Buffer.alloc(60))
  const mdhd = fullBox('mdhd', u32(time, time, 600, 0), Buffer.alloc(4))
  const hdlr = fullBox('hdlr', u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12))
  const stsd = fullBox('stsd', u32(1), box(entry, Buffer.alloc(8)))
  const stsc = fullBox('stsc', u32(1, 1, sampleSizes.length, 1))
  const stsz = fullBox('stsz', u32(0, sampleSizes.length, ...sampleSizes))
  const stco = fullBox('stco', u32(1, offset))
  const stbl = box('stbl', stsd, fullBox('stts', u32(0)), stsc, stsz, stco)
  return box('trak', tkhd, ...(options.extra ?? []), box('mdia', mdhd, hdlr, box('minf', options.dref ?? dinf, stbl)))
}

const LOCATION = '+12.3456+123.4567+010.000/'

/**
 * ftyp, then mdat with a 4-byte video sample, a 6-byte metadata sample, a 3-byte audio sample and
 * (unless `leftover` is false) an unreferenced draft movie header with a location, then moov with
 * the three tracks, creation times and a udta with a location atom.
 */
function sampleMovie(options: {tref?: Buffer; topLevel?: Buffer; leftover?: boolean; time?: number; dref?: Buffer} = {}) {
  const ftyp = box('ftyp', Buffer.from('qt  \0\0\0\0qt  ', 'latin1'))
  const hoov = options.leftover === false ? Buffer.alloc(0) : box('hoov', Buffer.from(`keys com.apple.quicktime.location.ISO6709 ${LOCATION}`, 'latin1'))
  const samples = Buffer.concat([Buffer.from([1, 2, 3, 4, 9, 9, 9, 9, 9, 9, 5, 6, 7]), hoov])
  const mdatStart = ftyp.length + 8
  const video: [number, number] = [mdatStart, mdatStart + 4]
  const meta: [number, number] = [mdatStart + 4, mdatStart + 10]
  const audio: [number, number] = [mdatStart + 10, mdatStart + 13]
  const leftover: [number, number] = [mdatStart + 13, mdatStart + 13 + hoov.length]
  const mdat = box('mdat', samples)
  const time = options.time ?? 0x12345678
  const moov = box(
    'moov',
    fullBox('mvhd', u32(time, time), Buffer.alloc(88)),
    trak(1, 'vide', 'hvc1', video[0], [4], {extra: options.tref ? [options.tref] : [], time, ...(options.dref ? {dref: options.dref} : {})}),
    trak(2, 'meta', 'mebx', meta[0], [6], {time}),
    trak(3, 'soun', 'mp4a', audio[0], [3], {extra: [box('udta', box('name', Buffer.from('Mono')))], time}),
    box('udta', box('\xa9xyz', Buffer.from(LOCATION))),
    box('meta', Buffer.alloc(16)),
  )
  return {file: Buffer.concat([ftyp, mdat, moov, ...(options.topLevel ? [options.topLevel] : [])]), video, meta, audio, leftover}
}

describe('planIsobmffStrip', () => {
  it('removes metadata boxes, data tracks, creation times and unreferenced mdat bytes in place', async () => {
    const {file, video, meta, audio, leftover} = sampleMovie()
    assert.deepEqual((await listTracks(bufferReader(file))).map((t) => `${t.id}:${t.handler}/${t.sampleEntry}`), ['1:vide/hvc1', '2:meta/mebx', '3:soun/mp4a'])
    assert.ok((await checkStrippedIsobmff(bufferReader(file))).length > 0, 'the input is not clean')
    const plan = await planIsobmffStrip(bufferReader(file))
    assert.equal(plan.personal, true)
    assert.deepEqual(plan.keptTracks.map((t) => t.id), [1, 3])
    assert.deepEqual(plan.removedTracks.map((t) => `${t.handler}/${t.sampleEntry}`), ['meta/mebx'])
    const leftoverNonZero = [...file.subarray(...leftover)].filter((b) => b !== 0).length
    assert.deepEqual(plan.unreferenced, {bytes: 6 + (leftover[1] - leftover[0]), nonZeroBytes: 6 + leftoverNonZero})
    const what = plan.removals.map((r) => r.what)
    for (const expected of ['moov/udta', 'moov/meta', 'track 2 (meta, mebx)', 'track 3 (soun)/udta', 'creation and modification times (5 headers)', 'samples of the removed tracks (zeroed in mdat)']) {
      assert.ok(what.includes(expected), `${expected} in ${what.join('; ')}`)
    }
    assert.ok(what.some((w) => w.startsWith('mdat bytes no track uses')), 'the leftover header is reported')
    const out = applyIsobmffPlan(file, plan)
    assert.equal(out.length, file.length)
    assert.deepEqual([...out.subarray(...video)], [1, 2, 3, 4])
    assert.deepEqual([...out.subarray(...meta)], [0, 0, 0, 0, 0, 0])
    assert.deepEqual([...out.subarray(...audio)], [5, 6, 7])
    assert.ok(out.subarray(...leftover).every((b) => b === 0), 'the leftover header is zeroed')
    assert.deepEqual((await listTracks(bufferReader(out))).map((t) => t.handler), ['vide', 'soun'])
    assert.doesNotMatch(describeBoxes(out).join('\n'), /udta|meta|xyz/)
    assert.ok(!Buffer.from(out).includes(Buffer.from('+12.3456')), 'the location text is gone')
    // Nothing outside the changed ranges changed, and the kept samples are not in them.
    let at = 0
    for (const [start, end] of [...plan.changedRanges, [file.length, file.length]]) {
      assert.ok(Buffer.from(file.subarray(at, start)).equals(Buffer.from(out.subarray(at, start))))
      at = end
    }
    assert.deepEqual(subtractRanges(plan.keptSampleRanges, plan.changedRanges), plan.keptSampleRanges)
    // The result is clean and planning it again removes nothing personal.
    assert.deepEqual(await checkStrippedIsobmff(bufferReader(out)), [])
    const again = await planIsobmffStrip(bufferReader(out))
    assert.equal(again.personal, false)
    assert.ok(Buffer.from(applyIsobmffPlan(out, again)).equals(Buffer.from(out)), 'stripping again changes nothing')
  })

  it('leaves a file with nothing personal alone', async () => {
    const {file} = sampleMovie()
    const clean = applyIsobmffPlan(file, await planIsobmffStrip(bufferReader(file)))
    const plan = await planIsobmffStrip(bufferReader(clean))
    assert.equal(plan.personal, false)
    assert.deepEqual(plan.removals.filter((r) => r.personal), [])
  })

  it('counts creation times alone as personal', async () => {
    const {file} = sampleMovie()
    const stripped = Buffer.from(applyIsobmffPlan(file, await planIsobmffStrip(bufferReader(file))))
    // Put a creation time back into mvhd (after its version and flags).
    const mvhd = stripped.indexOf(Buffer.from('mvhd'))
    stripped.writeUInt32BE(0x7654321, mvhd + 8)
    const plan = await planIsobmffStrip(bufferReader(stripped))
    assert.equal(plan.personal, true)
    assert.deepEqual(plan.removals.map((r) => r.what), ['creation and modification times (1 headers)'])
  })

  it('refuses boxes it does not know rather than keeping them', async () => {
    const {file} = sampleMovie({topLevel: box('junk', Buffer.from('owner: someone'))})
    await assert.rejects(planIsobmffStrip(bufferReader(file)), (error: unknown) => error instanceof IsobmffUnsupportedError && /unknown top-level box "junk"/.test(error.message))
    const fragment = sampleMovie({topLevel: box('moof', Buffer.alloc(8))})
    await assert.rejects(planIsobmffStrip(bufferReader(fragment.file)), /fragmented files are not supported/)
  })

  it('refuses a kept track whose samples are in another file', async () => {
    const external = box('dinf', fullBox('dref', u32(1), box('url ', u32(0), Buffer.from('file:///elsewhere.mov\0'))))
    const {file} = sampleMovie({dref: external})
    await assert.rejects(planIsobmffStrip(bufferReader(file)), /samples are in another file/)
  })

  it("removes a kept track's reference that only points at removed tracks", async () => {
    const {file} = sampleMovie({tref: box('tref', box('tmcd', u32(2)))})
    const plan = await planIsobmffStrip(bufferReader(file))
    assert.ok(plan.removals.some((r) => r.what === 'track 1 (vide)/tref to removed tracks' && !r.personal))
    assert.doesNotMatch(describeBoxes(applyIsobmffPlan(file, plan)).join('\n'), /tref|tmcd/)
  })

  it('refuses a reference box that points at kept and removed tracks', async () => {
    const {file} = sampleMovie({tref: box('tref', box('cdsc', u32(2, 3)))})
    await assert.rejects(planIsobmffStrip(bufferReader(file)), /references the removed track\(s\) 2 and kept ones/)
  })

  it('parses 64-bit box sizes', () => {
    const large = Buffer.alloc(24)
    large.writeUInt32BE(1, 0)
    large.write('free', 4, 'latin1')
    large.writeBigUInt64BE(24n, 8)
    assert.deepEqual(parseBoxes(large, 0, large.length), [{type: 'free', start: 0, headerSize: 16, end: 24}])
  })
})

describe('byte ranges and signatures', () => {
  it('merges and subtracts ranges', () => {
    assert.deepEqual(mergeRanges([[5, 7], [0, 2], [1, 3], [7, 8]]), [[0, 3], [5, 8]])
    assert.deepEqual(subtractRanges([[0, 10]], [[2, 3], [5, 7], [9, 12]]), [[0, 2], [3, 5], [7, 9]])
    assert.deepEqual(subtractRanges([[0, 4]], [[0, 4]]), [])
  })

  it('finds location and device signatures, never returning the bytes', () => {
    const text = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'))
    assert.deepEqual(findMetadataSignatures(text(`xx${LOCATION}yy`)), ['ISO 6709 coordinates'])
    assert.deepEqual(findMetadataSignatures(text('com.apple.quicktime.location.accuracy.horizontal')), ['com.apple.quicktime.location'])
    assert.deepEqual(findMetadataSignatures(text('com.apple.quicktime.model')), ['QuickTime key of the camera or device'])
    assert.deepEqual(findMetadataSignatures(text('\xa9xyz')), ['©xyz location atom'])
    assert.deepEqual(findMetadataSignatures(text('hvc1 avcC colr 1.0 +1 -2')), [])
  })
})
