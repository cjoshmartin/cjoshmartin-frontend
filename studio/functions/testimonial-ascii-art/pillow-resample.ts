/**
 * Exact port of Pillow's bicubic `Image.resize(size)` for 8-bit RGB images
 * (Pillow 13.0.0, src/libImaging/Resample.c: precompute_coeffs, normalize_coeffs_8bpc,
 * ImagingResampleHorizontal_8bpc, ImagingResampleVertical_8bpc, ImagingResampleInner).
 *
 * ascii-magic calls `image.resize((columns, rows))` with Pillow's default filter, which is
 * BICUBIC (a = -0.5, support 2) for RGB images. Pillow resamples in two separable passes
 * with coefficients in 22-bit fixed point and rounds to 8 bits after each pass; this port
 * reproduces the same coefficients, pass order, rounding and clipping, so the output bytes
 * are identical to Pillow's for the same input bytes.
 */

/** 32 - 8 - 2: 8 bits for the result and 2 extra bits for overflow (Resample.c). */
const PRECISION_BITS = 22
const BICUBIC_SUPPORT = 2.0

function bicubicFilter(x: number): number {
  const a = -0.5
  if (x < 0.0) x = -x
  if (x < 1.0) return ((a + 2.0) * x - (a + 3.0)) * x * x + 1
  if (x < 2.0) return (((x - 5) * x + 8) * x - 4) * a
  return 0.0
}

interface Coefficients {
  ksize: number
  /** Pairs of (first source index, number of source pixels) per output pixel. */
  bounds: Int32Array
  /** Fixed-point coefficients, ksize per output pixel (normalize_coeffs_8bpc). */
  kk: Int32Array
}

/** precompute_coeffs + normalize_coeffs_8bpc. `in0`/`in1` are C floats in Pillow. */
function precomputeCoeffs(inSize: number, in0: number, in1: number, outSize: number): Coefficients {
  const scale = Math.fround(Math.fround(in1) - Math.fround(in0)) / outSize
  let filterscale = scale
  if (filterscale < 1.0) filterscale = 1.0
  const support = BICUBIC_SUPPORT * filterscale
  const ksize = Math.ceil(support) * 2 + 1
  const prekk = new Float64Array(outSize * ksize)
  const bounds = new Int32Array(outSize * 2)
  const invFilterscale = 1.0 / filterscale
  const start = Math.fround(in0)

  for (let xx = 0; xx < outSize; xx++) {
    const center = start + (xx + 0.5) * scale
    let ww = 0.0
    // C casts truncate toward zero.
    let xmin = Math.trunc(center - support + 0.5)
    if (xmin < 0) xmin = 0
    let xmax = Math.trunc(center + support + 0.5)
    if (xmax > inSize) xmax = inSize
    xmax -= xmin
    const offset = xx * ksize
    for (let x = 0; x < xmax; x++) {
      const w = bicubicFilter((x + xmin - center + 0.5) * invFilterscale)
      prekk[offset + x] = w
      ww += w
    }
    if (ww !== 0.0) {
      for (let x = 0; x < xmax; x++) prekk[offset + x] /= ww
    }
    bounds[xx * 2] = xmin
    bounds[xx * 2 + 1] = xmax
  }

  const kk = new Int32Array(outSize * ksize)
  const one = 1 << PRECISION_BITS
  for (let i = 0; i < kk.length; i++) {
    kk[i] = prekk[i] < 0 ? Math.trunc(-0.5 + prekk[i] * one) : Math.trunc(0.5 + prekk[i] * one)
  }
  return {ksize, bounds, kk}
}

/** clip8: `clip8_lookups[in >> PRECISION_BITS]`, i.e. arithmetic shift then clamp to 0..255. */
function clip8(value: number): number {
  const shifted = value >> PRECISION_BITS
  return shifted < 0 ? 0 : shifted > 255 ? 255 : shifted
}

const HALF = 1 << (PRECISION_BITS - 1)

function resampleHorizontal(
  input: Uint8Array,
  inWidth: number,
  outWidth: number,
  outHeight: number,
  rowOffset: number,
  {ksize, bounds, kk}: Coefficients,
): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight * 3)
  for (let yy = 0; yy < outHeight; yy++) {
    const lineIn = (yy + rowOffset) * inWidth * 3
    const lineOut = yy * outWidth * 3
    for (let xx = 0; xx < outWidth; xx++) {
      const xmin = bounds[xx * 2]
      const xmax = bounds[xx * 2 + 1]
      const k = xx * ksize
      let ss0 = HALF
      let ss1 = HALF
      let ss2 = HALF
      for (let x = 0; x < xmax; x++) {
        const p = lineIn + (x + xmin) * 3
        const c = kk[k + x]
        ss0 += input[p] * c
        ss1 += input[p + 1] * c
        ss2 += input[p + 2] * c
      }
      out[lineOut + xx * 3] = clip8(ss0)
      out[lineOut + xx * 3 + 1] = clip8(ss1)
      out[lineOut + xx * 3 + 2] = clip8(ss2)
    }
  }
  return out
}

function resampleVertical(
  input: Uint8Array,
  width: number,
  outHeight: number,
  {ksize, bounds, kk}: Coefficients,
): Uint8Array {
  const out = new Uint8Array(width * outHeight * 3)
  for (let yy = 0; yy < outHeight; yy++) {
    const k = yy * ksize
    const ymin = bounds[yy * 2]
    const ymax = bounds[yy * 2 + 1]
    for (let xx = 0; xx < width; xx++) {
      let ss0 = HALF
      let ss1 = HALF
      let ss2 = HALF
      for (let y = 0; y < ymax; y++) {
        const p = ((y + ymin) * width + xx) * 3
        const c = kk[k + y]
        ss0 += input[p] * c
        ss1 += input[p + 1] * c
        ss2 += input[p + 2] * c
      }
      const o = (yy * width + xx) * 3
      out[o] = clip8(ss0)
      out[o + 1] = clip8(ss1)
      out[o + 2] = clip8(ss2)
    }
  }
  return out
}

/**
 * `Image.resize((outWidth, outHeight))` with the default BICUBIC filter for an RGB image.
 * `rgb` is row-major, 3 bytes per pixel. Returns a new array of outWidth * outHeight * 3 bytes.
 */
export function pillowResizeBicubic(
  rgb: Uint8Array,
  width: number,
  height: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  for (const [name, value] of Object.entries({width, height, outWidth, outHeight})) {
    if (!Number.isInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive integer, got ${value}`)
  }
  if (rgb.length !== width * height * 3) {
    throw new RangeError(
      `expected ${width * height * 3} bytes for ${width}x${height} RGB, got ${rgb.length}`,
    )
  }
  // Image.resize: same size and full box -> copy.
  if (width === outWidth && height === outHeight) return rgb.slice()

  // With the default box (0, 0, width, height), Pillow's
  // `xsize != imIn->xsize || box[0] || box[2] != xsize` reduces to a size comparison.
  const needHorizontal = outWidth !== width
  const needVertical = outHeight !== height
  // "If height is being scaled down more than twice the amount the width is,
  // run the vertical pass first" (Pillow >= 9.x).
  const horizontalFirst = !(height - outHeight > 0 && height - outHeight > (width - outWidth) * 2)

  let vert: Coefficients | null = null
  let horiz: Coefficients | null = null
  let yboxFirst = 0
  let yboxLast = height
  if ((needHorizontal && horizontalFirst) || needVertical) {
    vert = precomputeCoeffs(height, 0, height, outHeight)
  }
  if (needHorizontal) {
    if (horizontalFirst && vert) {
      yboxFirst = vert.bounds[0]
      yboxLast = vert.bounds[outHeight * 2 - 2] + vert.bounds[outHeight * 2 - 1]
      if (yboxFirst !== 0) {
        for (let i = 0; i < outHeight; i++) vert.bounds[i * 2] -= yboxFirst
      }
    }
    horiz = precomputeCoeffs(width, 0, width, outWidth)
  }

  let current = rgb
  let currentWidth = width
  if (horizontalFirst) {
    if (needHorizontal && horiz) {
      current = resampleHorizontal(
        current,
        currentWidth,
        outWidth,
        yboxLast - yboxFirst,
        yboxFirst,
        horiz,
      )
      currentWidth = outWidth
    }
    if (needVertical && vert) {
      current = resampleVertical(current, currentWidth, outHeight, vert)
    }
  } else {
    if (needVertical && vert) {
      current = resampleVertical(current, currentWidth, outHeight, vert)
    }
    if (needHorizontal && horiz) {
      current = resampleHorizontal(current, currentWidth, outWidth, outHeight, 0, horiz)
      currentWidth = outWidth
    }
  }
  return current
}
