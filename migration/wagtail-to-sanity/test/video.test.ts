import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {after, describe, it} from 'node:test'

import {SETTINGS_VERSION} from '../../../studio/functions/video-to-mp4/settings'
import {CONVERSION_DEVIATIONS, matchingDeviation} from '../src/conversion-deviations'
import {findAssetMetadataEdits, type ExistingAsset} from '../src/steps/assets'
import {argsTemplate, type ConvertedVideo} from '../src/steps/convert'
import {conversionsOf, originalMimeType, plannedMp4, plannedOriginal, type StoredFileAsset} from '../src/steps/videos'
import {
  conversionArgs,
  displayedSize,
  primaryVideoStream,
  streamRotation,
  summarizeInput,
  topLevelBoxes,
  type ProbeResult,
} from '../src/video/ffmpeg'

/** ffprobe output of IMG_3239.MOV (media 10): audio first, rotated video, two data streams. */
const iphoneProbe: ProbeResult = {
  format: {format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '15.880000'},
  streams: [
    {index: 0, codec_type: 'audio', codec_name: 'aac', channels: 1, duration: '15.878345'},
    {index: 1, codec_type: 'video', codec_name: 'h264', width: 1920, height: 1440, pix_fmt: 'yuvj420p', duration: '15.880000', side_data_list: [{side_data_type: 'Display Matrix', rotation: -90}]},
    {index: 2, codec_type: 'data', duration: '15.880000'},
    {index: 3, codec_type: 'data', duration: '15.880000'},
  ],
}

describe('probe helpers', () => {
  it('reads the rotation from the display matrix, else from the rotate tag', () => {
    assert.equal(streamRotation(iphoneProbe.streams[1]!), -90)
    assert.equal(streamRotation({index: 0, tags: {rotate: '180'}}), 180)
    assert.equal(streamRotation({index: 0}), 0)
  })

  it('swaps width and height for quarter turns only', () => {
    assert.deepEqual(displayedSize(iphoneProbe.streams[1]!), {width: 1440, height: 1920})
    assert.deepEqual(displayedSize({index: 0, width: 1920, height: 1080, side_data_list: [{rotation: 180}]}), {width: 1920, height: 1080})
    assert.deepEqual(displayedSize({index: 0, width: 1920, height: 1080, side_data_list: [{rotation: 270}]}), {width: 1080, height: 1920})
    assert.throws(() => displayedSize({index: 0, width: 10, height: 10, side_data_list: [{rotation: 45}]}), /unsupported rotation/)
    assert.throws(() => displayedSize({index: 0}), /no width or height/)
  })

  it('picks the video stream ffmpeg maps with 0:V:0, skipping cover art', () => {
    const withCover: ProbeResult = {
      format: {duration: '1'},
      streams: [
        {index: 0, codec_type: 'video', codec_name: 'mjpeg', width: 300, height: 300, disposition: {attached_pic: 1}},
        {index: 1, codec_type: 'video', codec_name: 'h264', width: 640, height: 360},
      ],
    }
    assert.equal(primaryVideoStream(withCover)?.index, 1)
  })

  it('summarizes the streams the conversion keeps and drops', () => {
    const summary = summarizeInput(iphoneProbe, 'media/IMG_3239.MOV')
    assert.equal(summary.video.index, 1)
    assert.deepEqual(summary.video.displayed, {width: 1440, height: 1920})
    assert.deepEqual(summary.audio, {index: 0, codec: 'aac', channels: 1, durationSeconds: 15.878345})
    assert.equal(summary.mappedDurationSeconds, 15.88)
    assert.deepEqual(summary.droppedStreams, ['2:data', '3:data'])
  })

  it('falls back to the file duration for streams without one', () => {
    const summary = summarizeInput({format: {duration: '4.5'}, streams: [{index: 0, codec_type: 'video', width: 640, height: 320}]}, 'x.webm')
    assert.equal(summary.video.durationSeconds, 4.5)
    assert.equal(summary.audio, null)
    assert.equal(summary.mappedDurationSeconds, 4.5)
  })
})

describe('conversionArgs', () => {
  it('is the settings module arguments with ffmpeg logging limited to errors', () => {
    const args = conversionArgs({input: '/in/a.mov', output: '/out/a.mp4', preset: 'medium', hasAudio: true})
    assert.deepEqual(args.slice(0, 2), ['-loglevel', 'error'])
    assert.equal(args.at(-1), '/out/a.mp4')
    assert.ok(args.includes('libx264'))
    assert.deepEqual(argsTemplate(args, '/in/a.mov', '/out/a.mp4').filter((a) => a.startsWith('<')), ['<input>', '<output>'])
  })
})

describe('topLevelBoxes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'boxes-'))
  after(() => rmSync(dir, {recursive: true, force: true}))
  const box = (type: string, payload: number) => {
    const b = Buffer.alloc(8 + payload)
    b.writeUInt32BE(8 + payload, 0)
    b.write(type, 4, 'latin1')
    return b
  }

  it('lists boxes in file order, including 64-bit sizes and a last box that runs to the end', () => {
    const large = Buffer.alloc(16 + 4)
    large.writeUInt32BE(1, 0)
    large.write('mdat', 4, 'latin1')
    large.writeBigUInt64BE(20n, 8)
    const toEnd = Buffer.alloc(12)
    toEnd.writeUInt32BE(0, 0)
    toEnd.write('free', 4, 'latin1')
    const file = path.join(dir, 'a.mp4')
    writeFileSync(file, Buffer.concat([box('ftyp', 8), box('moov', 20), large, toEnd]))
    return topLevelBoxes(file).then((boxes) => assert.deepEqual(boxes, ['ftyp', 'moov', 'mdat', 'free']))
  })

  it('fails on a box that claims more bytes than the file has', async () => {
    const bad = box('moov', 4)
    bad.writeUInt32BE(100, 0)
    const file = path.join(dir, 'bad.mp4')
    writeFileSync(file, Buffer.concat([box('ftyp', 8), bad]))
    await assert.rejects(topLevelBoxes(file), /invalid size 100/)
  })
})

describe('video assets', () => {
  const video = {
    mediaId: 7,
    title: 'IMG_3151',
    source: {path: 'media/IMG_3151.MOV', filename: 'IMG_3151.MOV', sha1: 'aaa', bytes: 1},
    output: {path: 'video-mp4/media-7/IMG_3151.mp4', filename: 'IMG_3151.mp4', sha1: 'bbb', bytes: 1},
    settingsVersion: SETTINGS_VERSION,
  } as unknown as ConvertedVideo

  it('plans the original with its Wagtail source and the MP4 with the video-to-mp4 source', () => {
    assert.deepEqual(plannedOriginal(video).source, {name: 'wagtail', id: 'media-7', url: 'https://storage.googleapis.com/images-for-cms/media/IMG_3151.MOV'})
    const mp4 = plannedMp4(video, {_id: 'file-aaa-mov', originalFilename: 'IMG_3151.MOV'}, 'bbb')
    assert.deepEqual(mp4.source, {name: 'video-to-mp4', id: 'file-aaa-mov'})
    assert.equal(mp4.originalFilename, 'IMG_3151.mp4')
    assert.equal(mp4.sha1, 'bbb')
  })

  it('names the MP4 after the original asset id when the original has no file name', () => {
    assert.equal(plannedMp4(video, {_id: 'file-aaa-mov'}, 'bbb').originalFilename, 'file-aaa-mov.mp4')
  })

  it('finds earlier conversions of an original by source only', () => {
    const assets: StoredFileAsset[] = [
      {_id: 'file-1-mp4', _type: 'sanity.fileAsset', sha1hash: '1', source: {name: 'video-to-mp4', id: 'file-aaa-mov'}},
      {_id: 'file-2-mp4', _type: 'sanity.fileAsset', sha1hash: '2', source: {name: 'video-to-mp4', id: 'file-ccc-mov'}},
      {_id: 'file-3-mp4', _type: 'sanity.fileAsset', sha1hash: '3', source: {name: 'wagtail', id: 'file-aaa-mov'}},
    ]
    assert.deepEqual(conversionsOf(assets, 'file-aaa-mov').map((a) => a._id), ['file-1-mp4'])
  })

  it('gives the original the MIME type a browser reports for its extension', () => {
    assert.equal(originalMimeType('IMG_3151.MOV'), 'video/quicktime')
    assert.equal(originalMimeType('deep_linking.MP4'), 'video/mp4')
    assert.equal(originalMimeType('yt1s.com_-_Squid_Game.mp4.webm'), 'video/webm')
    assert.throws(() => originalMimeType('clip.avi'), /no MIME type known/)
  })

  it('refuses to overwrite metadata someone changed since the last run, and adopts the rest', () => {
    const original = plannedOriginal(video)
    const recorded = {...original, assetId: 'file-aaa-mov'}
    const edited: ExistingAsset = {_id: 'file-aaa-mov', _type: 'sanity.fileAsset', sha1hash: 'aaa', ...original, title: 'Renamed in the Studio'}
    const edits = findAssetMetadataEdits([original], new Map([['file:aaa', edited]]), {assets: {'file-aaa-mov': recorded}})
    assert.deepEqual(edits, [{assetId: 'file-aaa-mov', fields: ['title'], reason: 'changed since the last run'}])
    const unchanged: ExistingAsset = {_id: 'file-aaa-mov', _type: 'sanity.fileAsset', sha1hash: 'aaa', ...original}
    assert.deepEqual(findAssetMetadataEdits([original], new Map([['file:aaa', unchanged]]), {assets: {'file-aaa-mov': recorded}}), [])
  })
})

describe('matchingDeviation', () => {
  const listed = CONVERSION_DEVIATIONS[0]!
  const problems = listed.checks.map((check) => ({check, message: 'measured'}))
  const conversion = {mediaId: listed.mediaId, sourceSha1: listed.sourceSha1, settingsVersion: listed.settingsVersion, outputSha1: listed.outputSha1, problems}

  it('explains exactly the listed failing checks of exactly the listed bytes', () => {
    assert.equal(matchingDeviation(conversion), listed)
    assert.equal(matchingDeviation({...conversion, problems: [...problems, ...problems]}), listed, 'several messages per check')
  })

  it('explains nothing else', () => {
    assert.equal(matchingDeviation({...conversion, outputSha1: 'other'}), undefined)
    assert.equal(matchingDeviation({...conversion, sourceSha1: 'other'}), undefined)
    assert.equal(matchingDeviation({...conversion, settingsVersion: 'h264-crf23-max1920-v2'}), undefined)
    assert.equal(matchingDeviation({...conversion, mediaId: listed.mediaId + 1}), undefined)
    assert.equal(matchingDeviation({...conversion, problems: [...problems, {check: 'profile', message: 'Main'}]}), undefined)
    assert.equal(matchingDeviation({...conversion, problems: problems.slice(1)}), undefined)
  })
})
