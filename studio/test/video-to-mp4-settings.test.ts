/**
 * Unit tests for functions/video-to-mp4/settings.ts (no ffmpeg needed). The scale filter is
 * checked by evaluating its own `w` and `h` expressions with a small evaluator for the subset of
 * ffmpeg's expression language it uses, so the tests follow the real filter string, not a copy.
 * video-to-mp4-ffmpeg.integration.ts runs the same arguments through a real ffmpeg.
 */
import assert from 'node:assert/strict'
import {describe, it} from 'node:test'

import {
  AUDIO_BITRATE,
  buildFfmpegArgs,
  convertedFilename,
  CONVERTED_ASSET_SOURCE_NAME,
  CRF,
  DEFAULT_PRESET,
  expectedOutputSize,
  isX264Preset,
  MAX_DIMENSION,
  OUTPUT_MIME_TYPE,
  SETTINGS_VERSION,
  VIDEO_FILTER,
  X264_PRESETS,
} from '../functions/video-to-mp4/settings'

/** Evaluates `if`, `gte`, `min`, `max`, `trunc`, `iw`, `ih`, numbers and `+ - * /` like ffmpeg's eval. */
function evaluateExpression(source: string, variables: Record<string, number>): number {
  const tokens = source.match(/\d+(?:\.\d+)?|[A-Za-z_]\w*|[-+*/(),]/g) ?? []
  if (tokens.join('') !== source.replace(/\s+/g, '')) {
    throw new Error(`Unsupported characters in expression: ${source}`)
  }
  let position = 0
  const peek = () => tokens[position]
  const take = (expected?: string) => {
    const token = tokens[position++]
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`Expected ${expected ?? 'a token'} at ${position - 1} in ${source}`)
    }
    return token
  }
  const functions: Record<string, (args: number[]) => number> = {
    if: ([condition, whenTrue, whenFalse]) => (condition !== 0 ? whenTrue : whenFalse),
    gte: ([a, b]) => (a >= b ? 1 : 0),
    min: ([a, b]) => Math.min(a, b),
    max: ([a, b]) => Math.max(a, b),
    trunc: ([a]) => Math.trunc(a),
  }
  const factor = (): number => {
    const token = take()
    if (token === '-') return -factor()
    if (token === '(') {
      const value = sum()
      take(')')
      return value
    }
    if (/^\d/.test(token)) return Number(token)
    if (peek() === '(') {
      const fn = functions[token]
      if (!fn) throw new Error(`Unknown function ${token}`)
      take('(')
      const args = [sum()]
      while (peek() === ',') {
        take(',')
        args.push(sum())
      }
      take(')')
      return fn(args)
    }
    if (!(token in variables)) throw new Error(`Unknown variable ${token}`)
    return variables[token]
  }
  const product = (): number => {
    let value = factor()
    while (peek() === '*' || peek() === '/') {
      value = take() === '*' ? value * factor() : value / factor()
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (peek() === '+' || peek() === '-') {
      value = take() === '+' ? value + product() : value - product()
    }
    return value
  }
  const result = sum()
  if (position !== tokens.length) throw new Error(`Trailing tokens in ${source}`)
  return result
}

/** Output size the scale filter in VIDEO_FILTER produces for a displayed input size. */
function filterOutputSize(width: number, height: number) {
  const match = /^scale=w='([^']+)':h='([^']+)':out_range=tv,format=yuv420p$/.exec(VIDEO_FILTER)
  if (!match) throw new Error(`Unexpected VIDEO_FILTER shape: ${VIDEO_FILTER}`)
  const variables = {iw: width, ih: height}
  return {
    width: evaluateExpression(match[1], variables),
    height: evaluateExpression(match[2], variables),
  }
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

describe('settings constants', () => {
  it('matches the video contract v2', () => {
    assert.equal(SETTINGS_VERSION, 'h264-crf23-max1920-v1')
    assert.equal(MAX_DIMENSION, 1920)
    assert.equal(CRF, 23)
    assert.equal(AUDIO_BITRATE, '128k')
    assert.equal(OUTPUT_MIME_TYPE, 'video/mp4')
    assert.equal(CONVERTED_ASSET_SOURCE_NAME, 'video-to-mp4')
    assert.equal(DEFAULT_PRESET, 'medium')
  })
})

describe('buildFfmpegArgs', () => {
  it('builds the exact v1 argument list for a video with audio', () => {
    // If this changes, the output files change: bump SETTINGS_VERSION in the same commit.
    assert.deepEqual(
      buildFfmpegArgs({input: '/in/IMG_0169.MOV', output: '/out/a.mp4', hasAudio: true}),
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-autorotate',
        '-i',
        '/in/IMG_0169.MOV',
        '-map',
        '0:V:0',
        '-map',
        '0:a:0',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-ac',
        '2',
        '-vf',
        VIDEO_FILTER,
        '-c:v',
        'libx264',
        '-profile:v',
        'high',
        '-pix_fmt',
        'yuv420p',
        '-crf',
        '23',
        '-preset',
        'medium',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        '/out/a.mp4',
      ],
    )
  })

  it('maps no audio and adds -an when the input has no audio', () => {
    const args = buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: false})
    assert.ok(args.includes('-an'))
    assert.ok(!args.includes('0:a:0'))
    assert.equal(valueAfter(args, '-c:a'), undefined)
    assert.equal(valueAfter(args, '-b:a'), undefined)
    assert.equal(valueAfter(args, '-ac'), undefined)
    // The video settings are the same with and without audio.
    const withAudio = buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: true})
    for (const flag of ['-vf', '-c:v', '-profile:v', '-pix_fmt', '-crf', '-preset', '-movflags']) {
      assert.equal(valueAfter(args, flag), valueAfter(withAudio, flag), flag)
    }
  })

  it('maps only the first real video stream and the first audio stream', () => {
    const args = buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: true})
    const maps = args.flatMap((arg, index) => (arg === '-map' ? [args[index + 1]] : []))
    assert.deepEqual(maps, ['0:V:0', '0:a:0'])
  })

  it('autorotates the input, strips metadata and chapters, and writes a faststart MP4', () => {
    const args = buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: false})
    assert.ok(args.indexOf('-autorotate') < args.indexOf('-i'), '-autorotate is an input option')
    assert.equal(valueAfter(args, '-map_metadata'), '-1')
    assert.equal(valueAfter(args, '-map_chapters'), '-1')
    assert.equal(valueAfter(args, '-movflags'), '+faststart')
    assert.equal(valueAfter(args, '-f'), 'mp4')
    assert.equal(args.at(-1), 'out.mp4')
  })

  it('uses the medium preset by default and passes another allowed preset through', () => {
    const byDefault = buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: true})
    assert.equal(valueAfter(byDefault, '-preset'), 'medium')
    for (const preset of X264_PRESETS) {
      const args = buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: true, preset})
      assert.equal(valueAfter(args, '-preset'), preset)
      assert.equal(args.filter((arg) => arg === '-preset').length, 1)
    }
  })

  it('rejects ultrafast and unknown presets', () => {
    // ultrafast output is Constrained Baseline, not High profile.
    assert.equal(isX264Preset('ultrafast'), false)
    for (const preset of ['ultrafast', 'Medium', '', 'fastest']) {
      assert.throws(
        () =>
          buildFfmpegArgs({
            input: 'in.mov',
            output: 'out.mp4',
            hasAudio: true,
            preset: preset as never,
          }),
        /preset must be one of/,
      )
    }
  })

  it('rejects missing paths, an output that ffmpeg would read as an option, and a non-boolean hasAudio', () => {
    assert.throws(() => buildFfmpegArgs({input: '', output: 'out.mp4', hasAudio: true}), /input/)
    assert.throws(() => buildFfmpegArgs({input: 'in.mov', output: '', hasAudio: true}), /output/)
    assert.throws(
      () => buildFfmpegArgs({input: 'in.mov', output: '-y', hasAudio: true}),
      /must not start with "-"/,
    )
    assert.throws(
      () => buildFfmpegArgs({input: 'in.mov', output: 'out.mp4', hasAudio: 'yes' as never}),
      /hasAudio must be a boolean/,
    )
  })

  it('accepts an https URL as input', () => {
    const url = 'https://cdn.sanity.io/files/j3vdh6ti/production/abc.mov'
    assert.equal(
      valueAfter(buildFfmpegArgs({input: url, output: '/tmp/o.mp4', hasAudio: true}), '-i'),
      url,
    )
  })
})

describe('scale filter', () => {
  const cases: Array<[string, [number, number], [number, number]]> = [
    ['4K landscape', [3840, 2160], [1920, 1080]],
    ['landscape screen recording', [3420, 2080], [1920, 1166]],
    ['landscape exactly at the limit', [1920, 1080], [1920, 1080]],
    ['iPhone 4:3 landscape', [1920, 1440], [1920, 1440]],
    ['4K portrait', [2160, 3840], [1080, 1920]],
    ['portrait taller than the limit', [1080, 2400], [864, 1920]],
    ['portrait with an odd aspect ratio', [918, 2066], [852, 1920]],
    ['rotated iPhone video (displayed size)', [1440, 1920], [1440, 1920]],
    ['portrait exactly at the limit', [886, 1920], [886, 1920]],
    ['small landscape', [640, 360], [640, 360]],
    ['small portrait', [720, 1280], [720, 1280]],
    ['small with odd sides', [641, 361], [640, 360]],
    ['odd height, no downscale', [1000, 599], [1000, 598]],
    ['square above the limit', [2000, 2000], [1920, 1920]],
    ['tiny', [3, 3], [2, 2]],
    ['1 px, raised to the 2 px minimum', [1, 1], [2, 2]],
    ['aspect ratio beyond 960:1', [8000, 3], [1920, 2]],
  ]

  for (const [name, [width, height], [expectedWidth, expectedHeight]] of cases) {
    it(`${name}: ${width}x${height} -> ${expectedWidth}x${expectedHeight}`, () => {
      const expected = {width: expectedWidth, height: expectedHeight}
      assert.deepEqual(filterOutputSize(width, height), expected)
      assert.deepEqual(expectedOutputSize({width, height}), expected)
    })
  }

  it('never upscales, keeps sides even and within the limit, and keeps the aspect ratio', () => {
    // Deterministic pseudo-random sizes (xorshift32), including odd sizes and extreme ratios.
    let state = 20261126
    const next = (max: number) => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return 1 + ((state >>> 0) % max)
    }
    for (let i = 0; i < 5000; i++) {
      const width = next(8000)
      const height = next(i % 10 === 0 ? 8 : 8000)
      const out = filterOutputSize(width, height)
      const size = `${width}x${height}`
      assert.deepEqual(expectedOutputSize({width, height}), out, size)

      const landscape = width >= height
      const [inLong, inShort] = landscape ? [width, height] : [height, width]
      const [outLong, outShort] = landscape ? [out.width, out.height] : [out.height, out.width]
      assert.equal(out.width % 2, 0, `${size}: even width`)
      assert.equal(out.height % 2, 0, `${size}: even height`)
      // Only a side below the 2 px minimum may grow, and only to 2 px.
      assert.ok(
        out.width <= Math.max(width, 2) && out.height <= Math.max(height, 2),
        `${size}: no upscaling`,
      )
      assert.ok(Math.max(out.width, out.height) <= MAX_DIMENSION, `${size}: limit`)
      assert.equal(outLong, Math.max(2, 2 * Math.trunc(Math.min(inLong, MAX_DIMENSION) / 2)), size)
      // The short side is the exact proportional size rounded down to an even number.
      const exactShort = (Math.min(inLong, MAX_DIMENSION) * inShort) / inLong
      if (exactShort >= 2) {
        assert.ok(outShort <= exactShort && outShort > exactShort - 2, `${size}: aspect`)
      } else {
        assert.equal(outShort, 2, `${size}: minimum`)
      }
    }
  })

  it('rejects sizes that are not positive integers', () => {
    assert.throws(
      () => expectedOutputSize({width: 0, height: 10}),
      /width must be a positive integer/,
    )
    assert.throws(
      () => expectedOutputSize({width: 10, height: 1.5}),
      /height must be a positive integer/,
    )
  })
})

describe('convertedFilename', () => {
  it('replaces the extension with .mp4', () => {
    assert.equal(convertedFilename('IMG_0169.MOV', 'file-x-mov'), 'IMG_0169.mp4')
    assert.equal(convertedFilename('clip.mp4', 'file-x-mp4'), 'clip.mp4')
    assert.equal(
      convertedFilename('yt1s.com_-_Squid_Game.mp4.webm', 'file-x-webm'),
      'yt1s.com_-_Squid_Game.mp4.mp4',
    )
    assert.equal(
      convertedFilename('Screen_Recording_2025-05-05_at_1.57.42PM.mov', 'f'),
      'Screen_Recording_2025-05-05_at_1.57.42PM.mp4',
    )
  })

  it('keeps names without an extension and treats a leading dot as part of the name', () => {
    assert.equal(convertedFilename('recording', 'f'), 'recording.mp4')
    assert.equal(convertedFilename('.hidden', 'f'), '.hidden.mp4')
    assert.equal(convertedFilename('.mov.', 'f'), '.mov.mp4')
  })

  it('falls back to the given base name when there is no usable file name', () => {
    assert.equal(convertedFilename(undefined, 'file-abc-mov'), 'file-abc-mov.mp4')
    assert.equal(convertedFilename(null, 'file-abc-mov'), 'file-abc-mov.mp4')
    assert.equal(convertedFilename('   ', 'file-abc-mov'), 'file-abc-mov.mp4')
    assert.throws(() => convertedFilename(undefined, ' '), /fallbackBaseName/)
  })
})
